'use strict';
// Task store: CRUD, persistence, serialization, and the central task-update
// broadcaster. Mixed into Orchestrator.prototype (runs with the instance as `this`).
// Extracted from orchestrator.js (behavior-preserving).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STATE } = require('./state');
module.exports = {
  /** Persist all non-running tasks to disk */
  _saveTasks() {
    try {
      const serializable = [];
      for (const [, task] of this.tasks) {
        const { _proc, _timer, _pollInterval, _spawnOpts, _escalationChain, _escalationPrompt, _escalationCwd, _retryAttempt, ...safe } = task;
        serializable.push(safe);
      }
      fs.writeFileSync(this._tasksFile, JSON.stringify(serializable, null, 2));
    } catch (_) {}
  },

  /** Load tasks from disk on startup (skip running/pending since those processes are gone) */
  _loadTasks() {
    try {
      if (!fs.existsSync(this._tasksFile)) return;
      const data = JSON.parse(fs.readFileSync(this._tasksFile, 'utf8'));
      if (!Array.isArray(data)) return;
      for (const t of data) {
        // Running/pending/queued tasks from a previous session are dead; mark them failed
        if (t.state === STATE.RUNNING || t.state === STATE.PENDING || t.state === STATE.QUEUED) {
          t.state = STATE.FAILED;
          t.error = 'App was restarted while task was running';
          t.completedAt = t.completedAt || Date.now();
        }
        this.tasks.set(t.id, t);
      }
    } catch (_) {}
  },

  getTask(taskId) {
    return this._serializeTask(this.tasks.get(taskId));
  },

  listTasks({ state, from, cli, space, limit } = {}) {
    let tasks = [...this.tasks.values()];

    if (state) tasks = tasks.filter(t => t.state === state);
    if (from) tasks = tasks.filter(t => t.from === from);
    if (cli) tasks = tasks.filter(t => t.cli === cli);
    if (space !== undefined && space !== null && space !== '') {
      // '*' means "ignore space filter" - lets the UI default be "all tasks"
      // even when a space is active.
      if (space !== '*') tasks = tasks.filter(t => t.space === space);
    }

    // Most recent first
    tasks.sort((a, b) => b.createdAt - a.createdAt);

    if (limit) tasks = tasks.slice(0, limit);

    return tasks.map(t => this._serializeTask(t));
  },

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'Task not found' };
    if (task.state !== STATE.RUNNING && task.state !== STATE.PENDING) {
      return { ok: false, error: `Task is already ${task.state}` };
    }

    task.state = STATE.CANCELLED;
    task.completedAt = Date.now();

    // Clean up resources
    if (task._proc) {
      try { task._proc.kill('SIGTERM'); } catch (_) {}
      task._proc = null;
    }
    if (task._timer) clearTimeout(task._timer);
    if (task._pollInterval) clearInterval(task._pollInterval);

    this._broadcastTaskUpdate(task);
    return { ok: true };
  },

  // ── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Clean up all non-running tasks (completed, failed, cancelled, timed out).
   * Running and pending tasks are preserved unless forceAll is true.
   * @param {number} [maxAgeMs=0] — 0 = clean all non-running (default). Pass a positive value to only clean tasks older than that age.
   */
  cleanup(maxAgeMs = 0) {
    const now = Date.now();
    const forceAll = maxAgeMs === -1;  // -1 = cancel everything including running

    // Pass 1: cancel running/pending tasks if force-cleaning everything
    if (forceAll) {
      for (const [id, task] of this.tasks) {
        if (task.state === STATE.RUNNING || task.state === STATE.PENDING) {
          this.cancelTask(id);
        }
      }
    }

    // Pass 2: delete all non-running tasks (no age gate by default)
    const toDelete = [];
    for (const [id, task] of this.tasks) {
      if (task.state === STATE.RUNNING || task.state === STATE.PENDING) continue;
      if (maxAgeMs <= 0 || now - (task.completedAt || task.createdAt) > maxAgeMs) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      const task = this.tasks.get(id);
      if (task && task.resultFile) {
        try { if (fs.existsSync(task.resultFile)) fs.unlinkSync(task.resultFile); } catch (_) {}
      }
      this.tasks.delete(id);
    }
    if (toDelete.length > 0) this._saveTasks();
    return toDelete.length;
  },

  /** Delete a single task by ID (must not be running) */
  deleteTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'Task not found' };
    if (task.state === STATE.RUNNING || task.state === STATE.PENDING) {
      return { ok: false, error: 'Cannot delete a running task. Cancel it first.' };
    }
    if (task.resultFile) {
      try { if (fs.existsSync(task.resultFile)) fs.unlinkSync(task.resultFile); } catch (_) {}
    }
    this.tasks.delete(taskId);
    this._saveTasks();
    return { ok: true };
  },

  // ── Internals ────────────────────────────────────────────────────────────

  _id() {
    return crypto.randomBytes(6).toString('hex');
  },

  _createTask({ id, type, cli, prompt, from, timeout, targetTermId, model, space }) {
    const task = {
      id: id || this._id(),
      type,              // 'headless' | 'dispatch' | 'handoff'
      cli: cli || null,
      model: model || null,
      prompt,
      from,
      space: space || null,
      targetTermId: targetTermId || null,
      state: STATE.PENDING,
      result: null,
      error: null,
      errorClassification: null,
      resultFile: null,
      dependsOn: null,       // task IDs this depends on (DAG)
      worktree: null,        // { path, branch, repoPath } if using worktree isolation
      timeout: 0,  // Never timeout — AI runs as long as it needs
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      // Internal references (not serialized)
      _proc: null,
      _timer: null,
      _pollInterval: null,
    };
    this.tasks.set(task.id, task);
    return task;
  },

  _serializeTask(task) {
    if (!task) return null;
    const { _proc, _timer, _pollInterval, _spawnOpts, _retryAttempt, ...safe } = task;
    return safe;
  },

  _persistResult(task) {
    if (!task.result) return;
    const resultFile = path.join(this.workspaceDir, 'results', `${task.id}.md`);
    try {
      fs.writeFileSync(resultFile, task.result);
      task.resultFile = resultFile;
    } catch (_) {}
  },

  _broadcastTaskUpdate(task) {
    this._saveTasks();
    this.broadcast({
      type: 'orchestrator-event',
      event: 'task-update',
      task: this._serializeTask(task),
      timestamp: Date.now(),
    });

    // Release queued tasks whose dependencies are now met
    const taskFinished = task.state === STATE.COMPLETED || task.state === STATE.FAILED || task.state === STATE.TIMEOUT;
    if (taskFinished) this._releaseQueuedTasks();

    // Mind: completed tasks become conversation nodes in the shared brain.
    // This is the "shared consciousness" mechanic - what each CLI figures
    // out becomes available to every other CLI in the next session.
    if (task.state === STATE.COMPLETED && task.result && typeof this.saveTaskToMind === 'function') {
      try { this.saveTaskToMind(task); } catch (_) { /* never let Mind errors break orchestration */ }
    }

    // Track orchestration mode: active when any task is running
    const wasOrchestrating = this.orchestrating;
    const hasRunning = [...this.tasks.values()].some(t => t.state === STATE.RUNNING || t.state === STATE.PENDING || t.state === STATE.QUEUED);
    this.orchestrating = hasRunning;
    if (this.orchestrating !== wasOrchestrating) {
      this.broadcast({
        type: 'orchestrator-event',
        event: 'mode-change',
        orchestrating: this.orchestrating,
        timestamp: Date.now(),
      });
    }

    // Auto-notify the requesting agent when a task finishes
    const done = task.state === STATE.COMPLETED || task.state === STATE.FAILED || task.state === STATE.TIMEOUT;
    if (done && task.from) {
      const delivery = (this.getConfig().OrchestrateResultDelivery) || 'inject';
      const stateLabel = task.state === STATE.COMPLETED ? 'completed successfully' : task.state;
      const snippet = task.result ? task.result.substring(0, 500) : (task.error || 'No output');

      // PTY injection: push a short completion hint into the requesting AI's terminal.
      // We do NOT include the worker's output here. Terminal PTYs truncate long pastes
      // and large inline outputs inflate the supervisor's context; instead we point the
      // supervisor at the fetch endpoint so it pulls the full result on demand.
      if (delivery === 'inject' || delivery === 'both') {
        const resultOneLine = `[TASK DONE ${task.id}] ${stateLabel} (${task.cli || 'dispatch'}). Fetch full result: GET /api/orchestrator/task?id=${task.id}`;
        this.inject(task.from, resultOneLine + '\r');
      }

      // Inbox delivery (legacy polling mode)
      if (delivery === 'inbox' || delivery === 'both') {
        this.sendMessage({
          to: task.from,
          from: 'orchestrator',
          content: `Task ${task.id} ${stateLabel}.\n\nResult:\n${snippet}`,
          metadata: { taskId: task.id, state: task.state, type: 'task-result' },
        });
      }
    }
  },
};
