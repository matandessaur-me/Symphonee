/**
 * Orchestrator — Cross-AI communication bus for Symphonee
 *
 * Enables AI agents running in different terminals to dispatch tasks to each
 * other, exchange messages, and collect structured results.
 *
 * Three communication tiers:
 *   1. PTY Injection   — write prompts directly into a running AI terminal
 *   2. Headless Spawn  — launch an AI CLI in pipe mode for one-shot tasks
 *   3. File Mailbox    — structured results via .ai-workspace/orchestrator/
 *
 * All state is ephemeral (in-memory Maps). Restarts clear the task queue.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { pretrustFolderForCli } = require('./orchestrator/pretrust');
const { CircuitBreaker } = require('./orchestrator/reliability');
const { registerOrchestratorRoutes } = require('./orchestrator/routes');

// ── Orchestrator class ───────────────────────────────────────────────────────
// The class body is intentionally minimal: it owns construction and instance
// state only. All behavior lives in cohesive method-group mixins under
// orchestrator/ and is composed onto the prototype via Object.assign below.
class Orchestrator extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Map}      opts.terminals   — server.js terminals Map (termId -> {pty, cols, rows})
   * @param {Function} opts.broadcast   — server.js broadcast(msg) for WebSocket push
   * @param {string}   opts.workspaceDir — absolute path to .ai-workspace/orchestrator/
   * @param {Function} opts.getConfig   — returns current config object
   */
  constructor({ terminals, broadcast, workspaceDir, createTerminal, getConfig }) {
    super();
    this.terminals = terminals;
    this.broadcast = broadcast;
    this.workspaceDir = workspaceDir;
    this.createTerminal = createTerminal;
    this.getConfig = getConfig || (() => ({}));
    this.getLearnings = null; // set by mountOrchestrator after construction
    this.getMindHint = null;  // set by server.js after Mind is mounted; () => string | null
    this.getSkillsHint = null; // set by server.js after Skills are mounted; () => string | null
    this.saveTaskToMind = null; // set by server.js; (task) => void, called on task completion

    /** @type {Map<string, Task>} */
    this.tasks = new Map();

    /** @type {Map<string, string>} per-terminal output buffer (last 4KB) for AI inspection */
    this.termOutput = new Map();

    /** @type {Map<string, Message[]>} per-terminal inbox */
    this.inboxes = new Map();

    /** @type {boolean} Whether orchestration mode is active (at least one task running) */
    this.orchestrating = false;

    /** @type {CircuitBreaker} per-CLI circuit breaker */
    this.circuitBreaker = new CircuitBreaker();

    /** @type {Map<string, number>} task heartbeat timestamps (taskId -> lastActivity) */
    this.heartbeats = new Map();

    /** @type {Map<string, Object>} task checkpoints (taskId -> { partial, attempt, timestamp }) */
    this.checkpoints = new Map();

    // Ensure workspace directories exist
    for (const sub of ['tasks', 'results', 'inboxes']) {
      const dir = path.join(workspaceDir, sub);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // Restore persisted tasks from disk
    this._tasksFile = path.join(workspaceDir, 'tasks.json');
    this._loadTasks();
  }
}

// ── Compose behavior from cohesive method-group mixins ────────────────────────
// Each module exports a plain object of methods that run with the Orchestrator
// instance as `this`. Order is irrelevant (methods only call each other at
// runtime). Keep these grouped by concern; add new groups as their own module.
Object.assign(
  Orchestrator.prototype,
  require('./orchestrator/bus'),            // messaging: send/read/clear inbox, broadcastMessage
  require('./orchestrator/task-store'),     // task CRUD, persistence, serialization, update broadcast
  require('./orchestrator/lifecycle'),      // agent registry, dependency queue, pause/resume, heartbeats, waitFor
  require('./orchestrator/escalation'),     // escalation, fan-out, aggregation, worktree, lineage, handoff
  require('./orchestrator/spawn-headless'), // headless spawn, PTY injection, dispatch
  require('./orchestrator/spawn-visible'),  // visible PTY spawn with interactive watcher
);

// ── Route mounting ───────────────────────────────────────────────────────────

/**
 * Mount orchestrator API routes onto the server. Constructs the Orchestrator,
 * wires the auto-cleanup timer, and delegates route registration to
 * registerOrchestratorRoutes (orchestrator/routes.js).
 *
 * @param {Function} addRoute  — server.js addRoute(method, path, handler)
 * @param {Function} json      — server.js json(res, data, status)
 * @param {Object}   opts      — { terminals, broadcast, repoRoot, createTerminal, getConfig, getLearnings, getUiContext }
 * @returns {Orchestrator}
 */
function mountOrchestrator(addRoute, json, { terminals, broadcast, repoRoot, createTerminal, getConfig, getLearnings, getUiContext }) {
  const workspaceDir = path.join(repoRoot, '.ai-workspace', 'orchestrator');
  const orch = new Orchestrator({ terminals, broadcast, workspaceDir, createTerminal, getConfig });
  orch.getLearnings = getLearnings || null;

  // Auto-cleanup tasks older than 1 hour every 30 minutes (preserves recent results)
  setInterval(() => orch.cleanup(60 * 60 * 1000), 30 * 60 * 1000);

  registerOrchestratorRoutes(addRoute, json, orch, { getConfig, broadcast, getUiContext, repoRoot });
  return orch;
}

module.exports = { Orchestrator, mountOrchestrator, pretrustFolderForCli };
