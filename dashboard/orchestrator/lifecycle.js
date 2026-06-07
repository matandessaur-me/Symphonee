'use strict';
// Lifecycle / queue: agent registry, dependency-aware queue (DAG), pause/resume,
// heartbeat monitoring, and event waitFor. Mixed into Orchestrator.prototype.
// Extracted from orchestrator.js (behavior-preserving).

const { STATE } = require('./state');
module.exports = {
  // ── Agent registry ───────────────────────────────────────────────────────

  /**
   * List all terminals that are running an AI agent.
   * The frontend tracks which CLI is launched per terminal via termAiState;
   * the server doesn't have that info directly, so we expose the raw
   * terminal list and let callers enrich it with frontend state.
   */
  getAgents() {
    const agents = [];
    for (const [termId, t] of this.terminals) {
      agents.push({
        termId,
        cols: t.cols,
        rows: t.rows,
        alive: true,
      });
    }
    return agents;
  },

  // ── Dependency-Aware Task Queue (DAG) ─────────────────────────────────

  /**
   * Spawn a task that depends on other tasks completing first.
   * The task stays in QUEUED state until all dependencies are met.
   * @param {Object} opts - same as spawnHeadless plus:
   * @param {string[]} opts.dependsOn - array of task IDs that must complete first
   */
  spawnWithDependencies({ dependsOn = [], ...opts }) {
    const task = this._createTask({
      type: 'headless',
      cli: opts.cli,
      prompt: opts.prompt,
      from: opts.from || null,
      timeout: 0,
    });
    task.dependsOn = dependsOn;
    task.state = STATE.QUEUED;
    task._spawnOpts = opts;

    // Check if dependencies are already met
    this._checkAndRelease(task);
    this._broadcastTaskUpdate(task);
    return this._serializeTask(task);
  },

  /** Check queued tasks and release those whose dependencies are met */
  _checkAndRelease(task) {
    if (task.state !== STATE.QUEUED || !task.dependsOn) return false;
    const allMet = task.dependsOn.every(depId => {
      const dep = this.tasks.get(depId);
      return dep && dep.state === STATE.COMPLETED;
    });
    if (allMet) {
      // Inject dependency results as context
      const depResults = task.dependsOn.map(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.result ? `[Result from task ${depId}]: ${dep.result.substring(0, 500)}` : '';
      }).filter(Boolean).join('\n\n');

      const enhancedPrompt = depResults
        ? `${depResults}\n\n[Your task]:\n${task._spawnOpts.prompt}`
        : task._spawnOpts.prompt;

      try {
        const spawned = this.spawnHeadless({ ...task._spawnOpts, prompt: enhancedPrompt, taskId: task.id });
        Object.assign(task, { state: spawned.state, _proc: spawned._proc, startedAt: spawned.startedAt });
      } catch (e) {
        task.state = STATE.FAILED;
        task.error = `Failed to spawn after dependencies met: ${e.message}`;
        task.completedAt = Date.now();
        this._broadcastTaskUpdate(task);
      }
      delete task._spawnOpts;
      return true;
    }
    return false;
  },

  /** Called after any task completes; checks if queued tasks can now run */
  _releaseQueuedTasks() {
    for (const [, task] of this.tasks) {
      if (task.state === STATE.QUEUED) {
        this._checkAndRelease(task);
      }
    }
  },

  // ── Heartbeat Monitoring ────────────────────────────────────────────────

  /**
   * Get heartbeat status for all running tasks.
   * Returns tasks classified as active, stale, or missing.
   */
  getHeartbeats() {
    const now = Date.now();
    const result = [];
    for (const [, task] of this.tasks) {
      if (task.state !== STATE.RUNNING) continue;
      const lastBeat = this.heartbeats.get(task.id);
      const age = lastBeat ? now - lastBeat : now - (task.startedAt || task.createdAt);
      let status = 'active';
      if (age > 90000) status = 'stale';       // > 90s no output
      else if (age > 30000) status = 'idle';    // > 30s no output
      result.push({
        taskId: task.id,
        cli: task.cli,
        status,
        lastActivity: lastBeat || task.startedAt,
        idleMs: age,
      });
    }
    return result;
  },

  // ── Workflow Pause / Resume ─────────────────────────────────────────────

  /** Pause all running tasks (they continue in background but results are held) */
  pauseAll() {
    this._paused = true;
    this.broadcast({ type: 'orchestrator-event', event: 'paused', timestamp: Date.now() });
    return { ok: true, paused: true };
  },

  /** Resume orchestration */
  resumeAll() {
    this._paused = false;
    this.broadcast({ type: 'orchestrator-event', event: 'resumed', timestamp: Date.now() });
    // Release any queued tasks that were held
    this._releaseQueuedTasks();
    return { ok: true, paused: false };
  },

  /** Check if orchestration is paused */
  isPaused() { return !!this._paused; },

  // ── Event WaitFor ───────────────────────────────────────────────────────

  /**
   * Wait for a specific task to reach a terminal state.
   * Promise-based one-shot listener with timeout.
   * @param {string} taskId
   * @param {number} [timeoutMs=300000] - max wait (5 min default)
   * @returns {Promise<Task>}
   */
  waitFor(taskId, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const task = this.tasks.get(taskId);
        if (!task) { clearInterval(check); reject(new Error('Task not found')); return; }
        if (task.state === STATE.COMPLETED || task.state === STATE.FAILED || task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) {
          clearInterval(check);
          resolve(this._serializeTask(task));
        }
      }, 500);
      if (timeoutMs > 0) {
        setTimeout(() => { clearInterval(check); reject(new Error(`waitFor timed out after ${timeoutMs}ms`)); }, timeoutMs);
      }
    });
  },
};
