'use strict';
// Escalation / fan-out: cross-model escalation, parallel fan-out with quality-ranked
// aggregation, synchronous handoff, worktree isolation, and lineage context.
// Mixed into Orchestrator.prototype. Extracted from orchestrator.js (behavior-preserving).

const path = require('path');
const { spawnSync } = require('child_process');
const { STATE } = require('./state');
const { ESCALATION_ORDER } = require('./cli-config');
const { scoreResult } = require('./reliability');
const { MAX_CONCURRENT_SPAWNS, SPAWN_STAGGER_MS } = require('./constants');
module.exports = {
  // ── Synchronous Handoff ─────────────────────────────────────────────────

  /**
   * Blocking handoff: spawn a worker, wait for completion, return result.
   * Returns a Promise that resolves with the task result.
   * @param {Object} opts - same as spawnHeadless
   * @param {number} [opts.handoffTimeout=300000] - max wait time (5 min default)
   * @returns {Promise<{ok: boolean, result?: string, error?: string, taskId: string}>}
   */
  handoff(opts) {
    return new Promise((resolve) => {
      try {
        const task = this.spawnHeadless(opts);
        const maxWait = opts.handoffTimeout || 300000;
        const startTime = Date.now();

        const poll = setInterval(() => {
          const current = this.tasks.get(task.id);
          if (!current) {
            clearInterval(poll);
            resolve({ ok: false, error: 'Task disappeared', taskId: task.id });
            return;
          }
          if (current.state === STATE.COMPLETED) {
            clearInterval(poll);
            resolve({ ok: true, result: current.result, taskId: task.id });
          } else if (current.state === STATE.FAILED || current.state === STATE.CANCELLED || current.state === STATE.TIMEOUT) {
            clearInterval(poll);
            resolve({ ok: false, error: current.error || current.state, taskId: task.id });
          } else if (Date.now() - startTime > maxWait) {
            clearInterval(poll);
            this.cancelTask(task.id);
            resolve({ ok: false, error: `Handoff timed out after ${maxWait}ms`, taskId: task.id });
          }
        }, 500);
      } catch (e) {
        resolve({ ok: false, error: e.message, taskId: null });
      }
    });
  },

  // ── Worktree Isolation ──────────────────────────────────────────────────

  /**
   * Create a git worktree for a task, spawn the CLI in it.
   * @param {Object} opts - same as spawnHeadless plus:
   * @param {string} opts.repoPath - path to the git repo
   * @param {string} [opts.branch] - branch name (auto-generated if omitted)
   */
  spawnInWorktree({ repoPath, branch, ...opts }) {
    if (!repoPath) throw new Error('repoPath is required for worktree spawn');
    const taskId = opts.taskId || this._id();
    const branchName = branch || `orch/${taskId}`;
    const worktreePath = path.join(repoPath, '..', `.worktree-${taskId}`);

    try {
      // Create worktree with a new branch
      const result = spawnSync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
        cwd: repoPath,
        timeout: 10000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (result.error || result.status !== 0) {
        throw new Error((result.stderr || result.stdout || (result.error && result.error.message) || 'git worktree add failed').trim());
      }
    } catch (e) {
      throw new Error(`Failed to create worktree: ${e.message}`);
    }

    const task = this.spawnHeadless({ ...opts, cwd: worktreePath, taskId });
    task.worktree = { path: worktreePath, branch: branchName, repoPath };

    // Clean up worktree when task completes
    const origComplete = task.completedAt;
    const checkCleanup = setInterval(() => {
      const current = this.tasks.get(task.id);
      if (!current || (current.completedAt && current.completedAt !== origComplete)) {
        clearInterval(checkCleanup);
        // Don't auto-remove worktree; the results might need merging
        // Just broadcast that the worktree is available for review
        this.broadcast({
          type: 'orchestrator-event',
          event: 'worktree-ready',
          taskId: task.id,
          worktree: task.worktree,
          timestamp: Date.now(),
        });
      }
    }, 1000);

    return task;
  },

  /**
   * Clean up a task's worktree after results have been merged/reviewed.
   */
  cleanupWorktree(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.worktree) return { ok: false, error: 'Task has no worktree' };
    try {
      const removeResult = spawnSync('git', ['worktree', 'remove', task.worktree.path, '--force'], {
        cwd: task.worktree.repoPath,
        timeout: 10000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (removeResult.error || removeResult.status !== 0) {
        throw new Error((removeResult.stderr || removeResult.stdout || (removeResult.error && removeResult.error.message) || 'git worktree remove failed').trim());
      }
      // Delete the branch too
      try {
        spawnSync('git', ['branch', '-D', task.worktree.branch], {
          cwd: task.worktree.repoPath,
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
      } catch (_) {}
      delete task.worktree;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // ── Cross-Model Escalation ──────────────────────────────────────────────

  /**
   * Spawn a task with automatic escalation: tries cheapest CLI first,
   * escalates through the chain on failure until one succeeds or all fail.
   * @param {Object} opts - same as spawnHeadless, but `cli` is optional
   * @param {string} [opts.preferCli] - preferred CLI to start with (skips cheaper ones)
   * @returns {Task}
   */
  spawnWithEscalation({ preferCli, prompt, cwd, from, taskId }) {
    // Build escalation chain, filtering out unavailable CLIs
    let chain = [...ESCALATION_ORDER];
    if (preferCli && chain.includes(preferCli)) {
      // Start from the preferred CLI
      chain = chain.slice(chain.indexOf(preferCli));
    }
    chain = chain.filter(cli => this.circuitBreaker.isAvailable(cli));

    if (!chain.length) throw new Error('No CLIs available (all circuit-broken or not in escalation chain)');

    const cli = chain[0];
    const task = this.spawnHeadless({ cli, prompt, cwd, from, taskId });
    // Store the escalation chain on the task for use on failure
    task._escalationChain = chain.slice(1);
    task._escalationPrompt = prompt;
    task._escalationCwd = cwd;
    return task;
  },

  /** Called when a task fails; attempts escalation to next CLI */
  _tryEscalate(task) {
    if (!task._escalationChain || !task._escalationChain.length) return false;
    const nextCli = task._escalationChain.shift();
    if (!this.circuitBreaker.isAvailable(nextCli)) return this._tryEscalate(task); // skip broken CLIs

    this.broadcast({ type: 'orchestrator-event', event: 'task-escalate', taskId: task.id, from: task.cli, to: nextCli, timestamp: Date.now() });

    try {
      const classified = task.errorClassification || {};
      const checkpoint = this.checkpoints.get(task.id);
      const enhancedPrompt = classified.failover
        ? task._escalationPrompt
        : checkpoint
        ? `[Previous attempt by ${task.cli} produced partial results]:\n${checkpoint.partial.substring(0, 1000)}\n\n[Retry with ${nextCli}]:\n${task._escalationPrompt}`
        : task._escalationPrompt;

      const newTask = this.spawnHeadless({ cli: nextCli, prompt: enhancedPrompt, cwd: task._escalationCwd, from: task.from, taskId: task.id, space: task.space });
      // Transfer escalation chain to new attempt
      newTask._escalationChain = task._escalationChain;
      newTask._escalationPrompt = task._escalationPrompt;
      newTask._escalationCwd = task._escalationCwd;
      this.broadcast({
        type: 'orchestrator-event',
        event: 'provider-failover',
        taskId: task.id,
        from: task.cli,
        to: nextCli,
        reason: classified.failoverReason || 'provider error',
        errorSnippet: (classified.message || task.error || '').slice(0, 160),
        chainRemaining: (newTask._escalationChain || []).length,
        chain: (newTask._escalationChain || []).slice(),
        timestamp: Date.now(),
      });
      return true;
    } catch (_) {
      return this._tryEscalate(task); // try next in chain
    }
  },

  // ── Parallel Fan-Out with Staggered Spawning ────────────────────────────

  /**
   * Spawn multiple tasks in parallel with staggered starts and concurrency cap.
   * @param {Array<Object>} taskConfigs - array of spawnHeadless options
   * @param {Object} [opts]
   * @param {number} [opts.maxConcurrent=5] - max simultaneous tasks
   * @param {number} [opts.staggerMs=200] - delay between spawns
   * @param {boolean} [opts.aggregate=false] - aggregate results when all complete
   * @returns {{ tasks: Task[], aggregatePromise?: Promise }}
   */
  fanOut(taskConfigs, { maxConcurrent = MAX_CONCURRENT_SPAWNS, staggerMs = SPAWN_STAGGER_MS, aggregate = false } = {}) {
    const tasks = [];
    let spawned = 0;
    const queue = [...taskConfigs];

    const spawnNext = () => {
      while (queue.length > 0 && spawned < maxConcurrent) {
        const config = queue.shift();
        try {
          const task = this.spawnHeadless(config);
          tasks.push(task);
          spawned++;
        } catch (e) {
          tasks.push({ id: this._id(), state: STATE.FAILED, error: e.message, cli: config.cli });
        }
        if (queue.length > 0 && staggerMs > 0) {
          setTimeout(spawnNext, staggerMs);
          return;
        }
      }
    };
    spawnNext();

    // Watch for completions to release concurrency slots
    const releaseCheck = setInterval(() => {
      const running = tasks.filter(t => {
        const current = this.tasks.get(t.id);
        return current && (current.state === STATE.RUNNING || current.state === STATE.PENDING);
      }).length;
      spawned = running;
      if (queue.length > 0 && spawned < maxConcurrent) spawnNext();
      if (queue.length === 0 && running === 0) clearInterval(releaseCheck);
    }, 500);

    const result = { tasks: tasks.map(t => this._serializeTask(t) || t) };

    if (aggregate) {
      result.aggregatePromise = new Promise((resolve) => {
        const poll = setInterval(() => {
          const allDone = tasks.every(t => {
            const current = this.tasks.get(t.id);
            return !current || current.state === STATE.COMPLETED || current.state === STATE.FAILED || current.state === STATE.CANCELLED;
          });
          if (allDone) {
            clearInterval(poll);
            resolve(this._aggregateResults(tasks.map(t => t.id)));
          }
        }, 1000);
      });
    }

    return result;
  },

  // ── Quality-Ranked Result Aggregation ───────────────────────────────────

  /**
   * Aggregate results from multiple tasks, ranked by quality.
   * @param {string[]} taskIds
   * @returns {{ results: Array, bestResult: string, totalScore: number }}
   */
  _aggregateResults(taskIds) {
    const scored = [];
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (!task || task.state !== STATE.COMPLETED || !task.result) continue;
      scored.push({ taskId: id, cli: task.cli, result: task.result, score: scoreResult(task.result) });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      results: scored,
      bestResult: scored.length > 0 ? scored[0].result : null,
      bestCli: scored.length > 0 ? scored[0].cli : null,
      totalScore: scored.reduce((sum, s) => sum + s.score, 0),
    };
  },

  // ── Task Lineage Context ────────────────────────────────────────────────

  /**
   * Spawn a task with sibling/lineage awareness.
   * Each worker is told what other workers are doing for coordination.
   * @param {Object} opts - same as spawnHeadless plus:
   * @param {string} [opts.parentTaskId] - parent task that spawned this group
   * @param {string[]} [opts.siblingTaskIds] - IDs of sibling tasks running in parallel
   */
  spawnWithLineage({ parentTaskId, siblingTaskIds = [], ...opts }) {
    let lineageContext = '';
    if (parentTaskId) {
      const parent = this.tasks.get(parentTaskId);
      if (parent) lineageContext += `[Parent task]: ${parent.prompt.substring(0, 200)}\n`;
    }
    if (siblingTaskIds.length) {
      lineageContext += `[Sibling tasks running in parallel]:\n`;
      for (const sibId of siblingTaskIds) {
        const sib = this.tasks.get(sibId);
        if (sib) lineageContext += `- ${sib.cli || 'agent'}: ${sib.prompt.substring(0, 100)}\n`;
      }
      lineageContext += `Coordinate with siblings. Avoid duplicating their work.\n`;
    }

    const enhancedPrompt = lineageContext
      ? `${lineageContext}\n[Your task]:\n${opts.prompt}`
      : opts.prompt;

    return this.spawnHeadless({ ...opts, prompt: enhancedPrompt });
  },
};
