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

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { pretrustFolderForCli } = require('./orchestrator/pretrust');
const { HEADLESS_FLAGS, CLI_MODELS, CLI_CONFIG, ESCALATION_ORDER } = require('./orchestrator/cli-config');
const { CircuitBreaker, classifyError, retryDelay, scoreResult, MAX_RETRIES } = require('./orchestrator/reliability');
const { registerOrchestratorRoutes } = require('./orchestrator/routes');
const { STATE, DEFAULT_REACTIONS } = require('./orchestrator/state');

// ── Constants ────────────────────────────────────────────────────────────────
const TASK_TIMEOUT_MS = 0;  // 0 = no timeout (unlimited)
const MAX_HEADLESS_OUTPUT = 512 * 1024;  // 512 KB stdout cap
const RESULT_POLL_MS = 500;

// ── Concurrency Controls ────────────────────────────────────────────────────
const MAX_CONCURRENT_SPAWNS = 5;    // max simultaneous headless tasks
const SPAWN_STAGGER_MS = 200;       // delay between parallel spawns to prevent thundering herd

// ── Reaction System ─────────────────────────────────────────────────────────
// Configurable per-event reactions: auto-send instructions, retry, escalate to human
// ── Orchestrator class ───────────────────────────────────────────────────────
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
  }

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
  }

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
  }

  // ── PTY Injection (Tier 1) ───────────────────────────────────────────────

  /**
   * Inject text directly into a terminal's stdin.
   * The target AI will process it as if the user typed it.
   *
   * @param {string} termId  — target terminal
   * @param {string} text    — text to inject (newline appended if missing)
   * @returns {{ ok: boolean, error?: string }}
   */
  inject(termId, text, opts) {
    opts = opts || {};
    const t = this.terminals.get(termId);
    if (!t) return { ok: false, error: `Terminal "${termId}" not found` };

    // Write the raw text without a trailing newline so interactive AI CLIs
    // (which treat the whole thing as a bracketed paste) land it in the
    // input buffer. Then send a SEPARATE carriage return after a short
    // delay so the CLI submits it as its own keystroke - a trailing \r
    // inside the same paste is treated as paste content, not submit.
    const clean = text.replace(/[\r\n]+$/, '');
    t.pty.write(clean);
    const submit = opts.autoSubmit !== false;
    if (submit) {
      setTimeout(function () { try { t.pty.write('\r'); } catch (_) {} }, 150);
    }

    this.broadcast({
      type: 'orchestrator-event',
      event: 'inject',
      termId,
      preview: text.substring(0, 200),
      timestamp: Date.now(),
    });

    return { ok: true };
  }

  // ── Headless Spawn (Tier 2) ──────────────────────────────────────────────

  /**
   * Spawn an AI CLI in headless/pipe mode for a one-shot task.
   * The prompt is sent via stdin and stdout is collected as the result.
   *
   * @param {Object} opts
   * @param {string} opts.cli       — 'claude' | 'gemini' | 'codex' | 'copilot' | 'grok' | 'qwen'
   * @param {string} opts.prompt    — the prompt to send
   * @param {string} [opts.cwd]     — working directory
   * @param {number} [opts.timeout] — ms before killing (default 5 min)
   * @param {string} [opts.from]    — termId of the requesting agent
   * @param {string} [opts.taskId]  — tie to existing task
   * @param {string} [opts.model]   — model override (e.g. 'opus', 'gpt-5.4', 'flash')
   * @param {string} [opts.effort]  — effort level (e.g. 'low', 'high', 'max')
   * @param {boolean} [opts.autoPermit] — auto-approve all permissions
   * @returns {Task}
   */
  spawnHeadless({ cli, prompt, cwd, timeout, from, taskId, model, effort, autoPermit, space, _retryAttempt = 0 }) {
    const cfg = HEADLESS_FLAGS[cli];
    if (!cfg) throw new Error(`Unknown CLI: "${cli}". Use: ${Object.keys(HEADLESS_FLAGS).join(', ')}`);
    const originalPrompt = prompt;

    // Mind hint: prepend the metadata stamp + L0+L1 wake-up. Pass the
    // worker's own prompt to the hint so L1 becomes the BFS sub-graph
    // for THIS task instead of generic god-nodes. Skipped silently if
    // Mind is not available.
    if (typeof this.getMindHint === 'function' && _retryAttempt === 0) {
      try {
        // Pass the prompt as the question so L1 is task-aware. The hint
        // function accepts an opts object; legacy callers without args still work.
        const hint = (this.getMindHint.length >= 1)
          ? this.getMindHint({ question: typeof prompt === 'string' ? prompt : '' })
          : this.getMindHint();
        if (hint && typeof prompt === 'string' && !prompt.startsWith('[mind:')) {
          prompt = `${hint}\n\n${prompt}`;
        }
      } catch (_) {}
    }

    // Skills hint: prepend the procedural catalog so a dispatched worker follows
    // the same consistent procedures as every other CLI. Each skill's full body
    // is fetched on demand (GET /api/skills/item?id=<id>). Skipped if no skills.
    if (typeof this.getSkillsHint === 'function' && _retryAttempt === 0) {
      try {
        const sh = this.getSkillsHint();
        if (sh && typeof prompt === 'string' && !prompt.includes('[skills:')) {
          prompt = `${sh}\n\n${prompt}`;
        }
      } catch (_) {}
    }

    // Circuit breaker: check if CLI is available
    if (!this.circuitBreaker.isAvailable(cli)) {
      throw new Error(`CLI "${cli}" circuit breaker is OPEN (too many recent failures). Try again later or use a different CLI.`);
    }

    // Verify CLI exists before spawning (fail fast instead of timing out)
    try {
      const { execSync } = require('child_process');
      execSync(`where ${cfg.cmd} 2>nul || which ${cfg.cmd} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    } catch (_) {
      throw new Error(`CLI "${cli}" (${cfg.cmd}) is not installed. Install it first.`);
    }

    const resolvedModel = model || (CLI_MODELS[cli] && CLI_MODELS[cli].defaultModel) || null;
    const task = this._createTask({
      id: taskId,
      type: 'headless',
      cli,
      model: resolvedModel,
      prompt,
      from: from || null,
      space: space || null,
      timeout: 0,  // Never timeout — AI runs as long as it needs
    });
    task._originalPrompt = originalPrompt;

    // Build final args based on how this CLI expects the prompt
    const finalArgs = [...cfg.args];

    // Inject model/effort/permission flags from CLI_MODELS intelligence
    const cliMeta = CLI_MODELS[cli];
    if (cliMeta) {
      if (model && cliMeta.modelFlag) {
        finalArgs.unshift(cliMeta.modelFlag, model);
      }
      if (effort && cliMeta.effortFlag) {
        finalArgs.unshift(cliMeta.effortFlag, effort);
      }
      // Auto-permit resolves from two sources, in order:
      //   1. explicit autoPermit param on the spawn call
      //   2. the active permission mode (bypass always; trusted only in a worktree)
      // Folder-trust is handled separately by pretrustFolderForCli() below so
      // we don't have to enable full-yolo just to dodge the first-run trust
      // prompt.
      let modeYolo = false;
      try {
        const perms = require('./permissions');
        const path = require('path');
        const configPath = path.join(path.resolve(__dirname, '..'), 'config', 'config.json');
        const settings = perms.loadSettings(configPath);
        const isWorktree = !!cwd && cwd.includes('worktree');
        if (settings.mode === 'bypass') modeYolo = true;
        else if (settings.mode === 'trusted' && isWorktree) modeYolo = true;
      } catch (_) {}
      const shouldYolo = autoPermit || modeYolo;
      if (shouldYolo && cliMeta.permissionFlag) {
        if (typeof cliMeta.autoPermission === 'boolean') {
          finalArgs.unshift(cliMeta.permissionFlag); // boolean flag like --yolo or Codex bypass
        } else {
          finalArgs.unshift(cliMeta.permissionFlag, cliMeta.autoPermission);
        }
      }
      // Inject behavioral guardrails for spawned Claude workers
      if (cliMeta.systemPromptFlag) {
        finalArgs.unshift(cliMeta.systemPromptFlag,
          'You are a worker agent. NEVER use sleep commands. NEVER poll with curl in a loop. ' +
          'Just do the task and output the result. Do not dispatch sub-tasks to other CLIs. ' +
          'Do not call orchestrator APIs. Focus only on the task in the prompt.');
      }
    }

    if (cfg.promptMode === 'flag') {
      // Prompt is the value of the last flag (e.g. gemini -p "prompt", copilot -p "prompt")
      finalArgs.push(prompt);
    } else if (cfg.promptMode === 'positional') {
      // Prompt is a trailing positional argument (e.g. grok --print "prompt")
      finalArgs.push(prompt);
    }
    // 'stdin' mode: prompt is written to proc.stdin below

    const useShell = cfg.shell !== undefined ? cfg.shell : true;
    // Inject API keys from config as environment variables (unlocks additional models)
    const spawnEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const aiKeys = this.getConfig().AiApiKeys || {};
    const CLI_ENV_KEYS = {
      claude:  ['ANTHROPIC_API_KEY'],
      gemini:  ['GEMINI_API_KEY'],
      codex:   ['OPENAI_API_KEY'],
      copilot: [],  // uses GitHub auth, not API keys
      grok:    ['XAI_API_KEY'],
      qwen:    ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'],
    };
    for (const envKey of (CLI_ENV_KEYS[cli] || [])) {
      if (aiKeys[envKey]) spawnEnv[envKey] = aiKeys[envKey];
    }

    // Pre-trust the working folder so first-time dispatches don't abort with
    // "this folder isn't trusted". This is independent of full bypass mode.
    try { pretrustFolderForCli(cli, cwd || process.cwd()); } catch (_) {}

    const proc = spawn(cfg.cmd, finalArgs, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      shell: useShell,
    });

    task._proc = proc;
    task.state = STATE.RUNNING;
    task.startedAt = Date.now();

    let stdout = '';
    let stderr = '';

    if (cfg.promptMode === 'stdin') {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } else {
      // Prompt was passed as an argument; close stdin so the process doesn't hang
      proc.stdin.end();
    }

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < MAX_HEADLESS_OUTPUT) {
        stdout += text;
      }
      // Heartbeat: track last activity
      this.heartbeats.set(task.id, Date.now());
      // Stream live output to frontend
      this.broadcast({
        type: 'orchestrator-event',
        event: 'task-output',
        taskId: task.id,
        chunk: text.substring(0, 4096),
        timestamp: Date.now(),
      });
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString().substring(0, 8192);
    });

    proc.on('close', (code) => {
      task._proc = null;
      if (task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) return;

      if (code === 0) {
        task.state = STATE.COMPLETED;
        task.result = stdout.trim();
        this.circuitBreaker.recordSuccess(cli);
        this.heartbeats.delete(task.id);
      } else {
        const errText = stderr.trim() || stdout.trim() || '';
        const classified = classifyError(errText || `Process exited with code ${code}`, cli);

        // Save checkpoint for crash recovery (partial results)
        if (stdout.trim()) {
          this.checkpoints.set(task.id, {
            partial: stdout.trim().substring(0, 4096),
            attempt: _retryAttempt,
            cli,
            prompt: task.prompt,
            timestamp: Date.now(),
          });
        }

        // Circuit breaker: record failure
        const circuitOpened = this.circuitBreaker.recordFailure(cli, errText);
        if (circuitOpened) {
          this.broadcast({ type: 'orchestrator-event', event: 'circuit-open', cli, timestamp: Date.now() });
        }

        // Retry with exponential backoff if error is retryable
        if (classified.retryable && _retryAttempt < MAX_RETRIES) {
          const delay = retryDelay(_retryAttempt);
          task.state = STATE.PENDING;
          task._retryAttempt = _retryAttempt + 1;
          this.broadcast({ type: 'orchestrator-event', event: 'task-retry', taskId: task.id, attempt: _retryAttempt + 1, delay, timestamp: Date.now() });
          setTimeout(() => {
            try {
              // Re-spawn with checkpoint context
              const checkpoint = this.checkpoints.get(task.id);
              const enhancedPrompt = checkpoint
                ? `[Previous attempt partial result for context]:\n${checkpoint.partial.substring(0, 1000)}\n\n[Retry the task]:\n${prompt}`
                : prompt;
              const retryTask = this.spawnHeadless({ cli, prompt: enhancedPrompt, cwd, timeout, from, taskId: task.id, space: task.space, _retryAttempt: _retryAttempt + 1 });
              // Merge retry into original task
              Object.assign(task, { state: retryTask.state, _proc: retryTask._proc, startedAt: retryTask.startedAt });
            } catch (e) {
              task.state = STATE.FAILED;
              task.error = `Retry failed: ${e.message}`;
              task.completedAt = Date.now();
              this._broadcastTaskUpdate(task);
            }
          }, delay);
          return; // don't complete the task yet
        }

        task.state = STATE.FAILED;
        task.error = classified.flagError
          ? `CLI "${cli}" rejected flags ${JSON.stringify(finalArgs)}: ${errText.substring(0, 300)}. ` +
            `Update HEADLESS_FLAGS in orchestrator.js to match the CLI's current interface.`
          : errText || `Process exited with code ${code}`;
        task.errorClassification = classified;
        task.result = stdout.trim();
        this.heartbeats.delete(task.id);

        // Auto-failover: if this is a credit / quota / auth / model failure,
        // attach a default escalation chain (cheapest -> most capable) on the
        // fly so the user does not have to opt in to spawnWithEscalation.
        // The actual failover event is broadcast by _tryEscalate after it
        // successfully spawns the next CLI. That keeps the UI from saying
        // "sent to Copilot" when Copilot is skipped and Gemini actually runs.
        if (classified.failover) {
          if (!task._escalationChain || !task._escalationChain.length) {
            task._escalationChain = ESCALATION_ORDER
              .filter(c => c !== cli && this.circuitBreaker.isAvailable(c));
          }
          task._escalationPrompt = task._escalationPrompt || originalPrompt;
          task._escalationCwd = task._escalationCwd || cwd;
        }

        // Try cross-model escalation before giving up
        if (task._escalationChain && task._escalationChain.length && classified.recoverable) {
          if (this._tryEscalate(task)) return; // escalated to next CLI
        }

        // All providers exhausted: notify the UI so it can toast the user.
        if (classified.failover) {
          this.broadcast({
            type: 'orchestrator-event',
            event: 'provider-exhausted',
            taskId: task.id,
            lastCli: cli,
            reason: classified.failoverReason || 'provider error',
            timestamp: Date.now(),
          });
        }

        // Auto-record failure in learnings
        if (this.getLearnings) {
          const lrn = this.getLearnings();
          if (lrn) lrn.recordFailure({ cli, args: finalArgs, error: task.error });
        }
      }
      task.completedAt = Date.now();
      this._persistResult(task);
      this._broadcastTaskUpdate(task);
    });

    proc.on('error', (err) => {
      task._proc = null;
      task.state = STATE.FAILED;
      task.error = err.message;
      task.completedAt = Date.now();
      this._broadcastTaskUpdate(task);
    });

    // Timeout guard (skip if timeout is 0 = unlimited)
    if (task.timeout) task._timer = setTimeout(() => {
      if (task.state === STATE.RUNNING) {
        task.state = STATE.TIMEOUT;
        task.error = `Timed out after ${task.timeout}ms`;
        task.completedAt = Date.now();
        try { proc.kill('SIGTERM'); } catch (_) {}
        this._broadcastTaskUpdate(task);
      }
    }, task.timeout);

    this._broadcastTaskUpdate(task);
    return task;
  }

  // ── Visible Spawn (Tier 2b) ──────────────────────────────────────────────

  /**
   * Spawn an AI CLI in a visible terminal tab so the user can watch it work.
   * Uses a real PTY instead of a headless pipe, and the file-mailbox pattern
   * for result collection (same as dispatch).
   *
   * @param {Object} opts
   * @param {string} opts.cli       — 'claude' | 'gemini' | 'codex' | 'copilot'
   * @param {string} opts.prompt    — the prompt to send
   * @param {string} [opts.cwd]     — working directory
   * @param {number} [opts.timeout] — ms before killing (default 5 min)
   * @param {string} [opts.from]    — termId of the requesting agent
   * @param {string} [opts.taskId]  — tie to existing task
   * @returns {Task}
   */
  spawnVisible({ cli, prompt, cwd, timeout, from, taskId, space }) {
    const cfg = CLI_CONFIG[cli];
    if (!cfg) throw new Error(`Unknown CLI: "${cli}". Use: ${Object.keys(CLI_CONFIG).join(', ')}`);
    if (!this.createTerminal) throw new Error('createTerminal not available - cannot spawn visible terminals');

    // Verify CLI exists before spawning
    try {
      const { execSync } = require('child_process');
      execSync(`where ${cfg.cmd} 2>nul || which ${cfg.cmd} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    } catch (_) {
      throw new Error(`CLI "${cli}" (${cfg.cmd}) is not installed. Install it first.`);
    }

    // Use orch- prefix to avoid collision with frontend's term-N IDs
    const termId = `orch-${this._id()}`;

    const task = this._createTask({
      id: taskId,
      type: 'visible',
      cli,
      prompt,
      from: from || null,
      space: space || null,
      timeout: 0,  // Never timeout — AI runs as long as it needs
      targetTermId: termId,
    });

    // Create a real PTY terminal
    this.createTerminal(termId, 120, 30, cwd || process.cwd());

    task.state = STATE.RUNNING;
    task.startedAt = Date.now();

    // Tell the frontend to create a tab for this terminal
    this.broadcast({
      type: 'term-spawned',
      termId,
      cli,
      label: cfg.label,
      taskId: task.id,
      orchestrated: true,
    });

    // Result file (file-mailbox pattern)
    const resultFile = path.join(this.workspaceDir, 'results', `${task.id}.md`);
    task.resultFile = resultFile;

    // Build single-line prompt (multi-line pastes don't auto-submit in most CLIs)
    const resultPath = resultFile.replace(/\\/g, '/');
    const wrappedPrompt = `[ORCHESTRATOR TASK ${task.id}] ${prompt} ` +
      `IMPORTANT: When done, write your result to ${resultPath} with "TASK_COMPLETE" on the first line followed by your response.`;

    // ── Terminal Watcher ────────────────────────────────────────────────
    // Continuously monitors PTY output and reacts to what it sees.
    // Phases: SHELL_WAIT -> CLI_LAUNCH -> CLI_READY -> PROMPT_SENT -> WORKING
    const t = this.terminals.get(termId);
    if (!t) return task;

    let _phase = 'SHELL_WAIT';
    let _buf = '';             // rolling buffer of recent output
    let _totalOutput = 0;      // total chars received
    let _lastActivityAt = Date.now();
    let _nudgeCount = 0;

    const _stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const _write = (text) => { const term = this.terminals.get(termId); if (term) term.pty.write(text); };
    const _log = (action) => {
      this.broadcast({ type: 'orchestrator-event', event: 'watcher', taskId: task.id, termId, action, phase: _phase, timestamp: Date.now() });
    };
    const _tail = (n) => _stripAnsi(_buf).slice(-(n || 200));

    // Interactive prompt patterns the watcher knows how to handle
    const INTERACTIVE_PATTERNS = [
      // Yes/No confirmations (update prompts, permission asks)
      { match: /\(y\/n\)\s*$/i,                              respond: 'y\n',  desc: 'y/n prompt' },
      { match: /\[Y\/n\]\s*$/i,                              respond: 'Y\n',  desc: 'Y/n prompt' },
      { match: /\[y\/N\]\s*$/i,                              respond: 'y\n',  desc: 'y/N prompt' },
      { match: /press enter to continue/i,                   respond: '\n',   desc: 'press enter' },
      { match: /do you want to (update|upgrade|install)/i,   respond: 'y\n',  desc: 'update prompt' },
      { match: /would you like to (update|upgrade|install)/i,respond: 'y\n',  desc: 'update prompt' },
      { match: /continue\? \(Y\/n\)/i,                       respond: 'Y\n',  desc: 'continue prompt' },
      { match: /Are you sure/i,                              respond: 'y\n',  desc: 'confirmation' },
      // Trust/permission dialogs - always yes so the agent doesn't bail on
      // first launch because Symphonee's CWD isn't yet on the CLI's trusted list.
      { match: /trust.*\(yes\/no\)/i,                        respond: 'yes\n',desc: 'trust prompt' },
      { match: /Do you trust/i,                              respond: 'yes\n',desc: 'trust prompt' },
      { match: /trust.*this (folder|workspace|directory|project)/i, respond: 'yes\n', desc: 'folder trust prompt' },
      { match: /working directory.*not.*trusted/i,           respond: 'yes\n', desc: 'untrusted cwd' },
      // Numbered trust menu (Codex): "1) Yes, trust this folder"
      { match: /1\)\s*Yes[^\n]*trust/i,                      respond: '1\r',  desc: 'trust this folder (option 1)' },
      // Accept/agree
      { match: /\(accept\)/i,                                respond: 'accept\n', desc: 'accept' },
      { match: /agree.*terms/i,                              respond: 'y\n',  desc: 'agree terms' },
      // CLI permission/action prompts (numbered selections)
      // "Allow for this session" is typically option 2 in Claude/Gemini/Codex
      { match: /Allow for this session/,                     respond: '2\r',  desc: 'allow for session' },
      { match: /1\. Allow once/,                             respond: '2\r',  desc: 'allow for session (selecting option 2)' },
      // If only "Allow once" is available
      { match: /Allow once.*\n.*No,/,                        respond: '1\r',  desc: 'allow once' },
      // Generic numbered selection (allow/approve)
      { match: /Allow execution of/i,                        respond: '2\r',  desc: 'allow execution' },
      { match: /Approve plan/i,                              respond: 'y\r',  desc: 'approve plan' },
      // Login/auth prompts
      { match: /press Enter to open/i,                       respond: '\r',   desc: 'open auth page' },
      { match: /press enter to authenticate/i,               respond: '\r',   desc: 'authenticate' },
    ];

    // Patterns that require a CLI restart (Ctrl+C then relaunch)
    const RESTART_PATTERNS = [
      /please restart/i,
      /restart.*to apply/i,
      /run.*again/i,
      /please re-?run/i,
      /update.*complete.*restart/i,
      /upgrade.*complete.*restart/i,
    ];

    // Patterns that mean the CLI is broken and should be abandoned
    const FATAL_PATTERNS = [
      { match: /API key.*not (set|found|configured)/i,       desc: 'missing API key' },
      { match: /authentication.*failed/i,                    desc: 'auth failed' },
      { match: /not logged in/i,                             desc: 'not logged in' },
      { match: /invalid.*api.?key/i,                         desc: 'invalid API key' },
      { match: /ECONNREFUSED/i,                              desc: 'connection refused' },
      { match: /command not found/i,                         desc: 'CLI not installed' },
      { match: /is not recognized/i,                         desc: 'CLI not installed' },
      { match: /not recognized as.*command/i,                desc: 'CLI not installed' },
      { match: /No such file or directory/i,                 desc: 'CLI not found' },
      { match: /unexpected argument/i,                       desc: 'bad CLI flags' },
      { match: /unrecognized option/i,                       desc: 'bad CLI flags' },
      { match: /unknown (flag|option)/i,                     desc: 'bad CLI flags' },
    ];

    // Check for fatal errors that mean we should abandon this CLI
    const _checkFatal = (text) => {
      for (const fp of FATAL_PATTERNS) {
        if (fp.match.test(text)) {
          _log('FATAL: ' + fp.desc + '. Abandoning CLI.');
          task.state = STATE.FAILED;
          task.error = fp.desc + '. The ' + cli + ' CLI could not be used for this task.';
          task.completedAt = Date.now();
          // Kill the terminal
          _write('\x03');
          setTimeout(() => _write('exit\r'), 500);
          try { watcher.dispose(); } catch (_) {}
          clearInterval(healthCheck);
          if (task._pollInterval) clearInterval(task._pollInterval);
          if (task._timer) clearTimeout(task._timer);
          this._broadcastTaskUpdate(task);
          return true;
        }
      }
      return false;
    };

    const watcher = t.pty.onData((data) => {
      _buf += data;
      _totalOutput += data.length;
      // Keep buffer from growing unbounded (last 4KB)
      if (_buf.length > 8192) _buf = _buf.slice(-4096);
      // Store clean output for AI inspection via /api/orchestrator/terminal-output
      const prev = this.termOutput.get(termId) || '';
      const updated = prev + _stripAnsi(data);
      this.termOutput.set(termId, updated.length > 8192 ? updated.slice(-4096) : updated);

      if (task.state !== STATE.RUNNING) { try { watcher.dispose(); } catch (_) {} return; }

      const tail = _tail(300);

      // Always check for fatal errors in any phase
      if (_phase !== 'SHELL_WAIT' && _checkFatal(tail)) return;

      switch (_phase) {

        case 'SHELL_WAIT': {
          // Wait for shell prompt (PS>, $, >, #)
          if (/(\$|>|#)\s*$/.test(tail) && _stripAnsi(_buf).length > 5) {
            _phase = 'CLI_LAUNCH';
            _buf = '';
            _log('Shell ready, launching ' + cfg.cmd);
            _write(cfg.cmd + '\r');
            _lastActivityAt = Date.now();
          }
          break;
        }

        case 'CLI_LAUNCH': {
          // CLI is starting up. Watch for interactive prompts (update dialogs, etc.)
          // and for the CLI's ready prompt.

          // Check for restart requests first
          for (const rp of RESTART_PATTERNS) {
            if (rp.test(tail)) {
              _log('Restart requested, restarting CLI');
              _write('\x03');
              _buf = '';
              _phase = 'RESTARTING';
              _lastActivityAt = Date.now();
              setTimeout(() => {
                _write(cfg.cmd + '\r');
                _phase = 'CLI_LAUNCH';
                _buf = '';
                _lastActivityAt = Date.now();
              }, 2000);
              return;
            }
          }

          for (const p of INTERACTIVE_PATTERNS) {
            if (p.match.test(tail)) {
              _log('Auto-responding to: ' + p.desc);
              _write(p.respond);
              _lastActivityAt = Date.now();
              _buf = '';
              return;
            }
          }
          // Detect CLI ready prompt
          if (_stripAnsi(_buf).length > 20 && /[❯>$✦⟩]\s*$/.test(tail)) {
            _log('CLI ready, injecting prompt');
            _phase = 'PROMPT_INJECTING';
            _buf = '';
            _lastActivityAt = Date.now();
            // Write the prompt text. The watcher will detect echo-back
            // in PROMPT_INJECTING phase and send Enter immediately.
            _write(wrappedPrompt);
          }
          break;
        }

        case 'PROMPT_INJECTING': {
          // Prompt text was written. Watch for it to appear in the output
          // (echo-back), then immediately send Enter. No timers needed.
          const clean = _stripAnsi(_buf);
          // The prompt contains ORCHESTRATOR TASK - check if we see it echoed
          if (clean.includes('ORCHESTRATOR TASK') || clean.includes('TASK_COMPLETE') || clean.length > 100) {
            _write('\r');
            _phase = 'PROMPT_SENT';
            _lastActivityAt = Date.now();
            _nudgeCount = 0;
            _buf = '';
          }
          break;
        }

        case 'PROMPT_SENT': {
          // Prompt was sent. Check if the CLI is actually processing.
          _lastActivityAt = Date.now();
          // If we see substantial new output, it's working
          if (_stripAnsi(_buf).length > 50) {
            _phase = 'WORKING';
          }
          // Also check for interactive prompts during this phase
          for (const p of INTERACTIVE_PATTERNS) {
            if (p.match.test(tail)) {
              _write(p.respond);
              _buf = '';
              return;
            }
          }
          break;
        }

        case 'WORKING': {
          // CLI is actively processing. Stay vigilant.
          _lastActivityAt = Date.now();

          // Check for restart requests
          for (const rp of RESTART_PATTERNS) {
            if (rp.test(tail)) {
              _write('\x03');
              _buf = '';
              _phase = 'RESTARTING';
              setTimeout(() => {
                _write(cfg.cmd + '\r');
                _phase = 'CLI_LAUNCH';
                _buf = '';
                _lastActivityAt = Date.now();
              }, 2000);
              return;
            }
          }

          // Check for interactive prompts
          for (const p of INTERACTIVE_PATTERNS) {
            if (p.match.test(tail)) {
              _write(p.respond);
              _buf = '';
              return;
            }
          }

          // Detect if CLI crashed back to shell prompt (unexpected exit)
          if (/PS [^>]*>\s*$/.test(tail) || /\$\s*$/.test(tail)) {
            const cleanTail = _stripAnsi(_buf.slice(-500));
            // Only trigger if we see error-like output before the shell prompt
            if (/error|crashed|exited|fatal|panic/i.test(cleanTail)) {
              // CLI crashed. Relaunch it.
              _phase = 'CLI_LAUNCH';
              _buf = '';
              _lastActivityAt = Date.now();
              _write(cfg.cmd + '\r');
            }
          }
          break;
        }

        case 'RESTARTING': {
          // Waiting for restart timeout to fire
          _lastActivityAt = Date.now();
          break;
        }
      }
    });

    // Periodic health check: detect stalls and nudge
    const healthCheck = setInterval(() => {
      if (task.state !== STATE.RUNNING) { clearInterval(healthCheck); return; }
      const idleMs = Date.now() - _lastActivityAt;

      // If prompt was sent but no output for 5 seconds, nudge with Enter
      if (_phase === 'PROMPT_SENT' && idleMs > 5000 && _nudgeCount < 4) {
        _nudgeCount++;
        _log('No activity, nudging with Enter (attempt ' + _nudgeCount + ')');
        _write('\r');
        _lastActivityAt = Date.now();
      }

      // If shell or CLI launch stalls for 20 seconds, force next phase
      if (_phase === 'SHELL_WAIT' && idleMs > 20000) {
        _phase = 'CLI_LAUNCH';
        _write(cfg.cmd + '\r');
        _lastActivityAt = Date.now();
      }
      if (_phase === 'CLI_LAUNCH' && idleMs > 20000) {
        _log('CLI launch stalled, forcing prompt injection');
        _phase = 'PROMPT_INJECTING';
        _buf = '';
        _write(wrappedPrompt);
      }
      // If PROMPT_INJECTING stalls (no echo), force Enter
      if (_phase === 'PROMPT_INJECTING' && idleMs > 3000) {
        _write('\r');
        _phase = 'PROMPT_SENT';
        _lastActivityAt = Date.now();
        _nudgeCount = 0;
      }
    }, 3000);

    // Poll for result file
    task._pollInterval = setInterval(() => {
      if (task.state !== STATE.RUNNING) {
        clearInterval(task._pollInterval);
        return;
      }
      try {
        if (fs.existsSync(resultFile)) {
          const content = fs.readFileSync(resultFile, 'utf8');
          if (content.startsWith('TASK_COMPLETE')) {
            task.state = STATE.COMPLETED;
            task.result = content.replace(/^TASK_COMPLETE\r?\n?/, '').trim();
            task.completedAt = Date.now();
            clearInterval(task._pollInterval);
            clearTimeout(task._timer);
            this._broadcastTaskUpdate(task);
          }
        }
      } catch (_) {}
    }, RESULT_POLL_MS);

    // Timeout guard (skip if timeout is 0 = unlimited)
    if (task.timeout) task._timer = setTimeout(() => {
      if (task.state === STATE.RUNNING) {
        task.state = STATE.TIMEOUT;
        task.error = `Timed out after ${task.timeout}ms`;
        task.completedAt = Date.now();
        clearInterval(task._pollInterval);
        this._broadcastTaskUpdate(task);
      }
    }, task.timeout);

    this._broadcastTaskUpdate(task);
    return task;
  }

  // ── Task Dispatch (Tier 1 + File Mailbox) ────────────────────────────────

  /**
   * Dispatch a task to a running AI terminal via PTY injection.
   * Wraps the prompt with instructions for the target AI to write results
   * to a known file path, then monitors for completion.
   *
   * @param {Object} opts
   * @param {string} opts.targetTermId — terminal to inject into
   * @param {string} opts.prompt       — the task prompt
   * @param {string} [opts.from]       — requesting terminal ID
   * @param {number} [opts.timeout]    — ms timeout
   * @returns {Task}
   */
  dispatch({ targetTermId, prompt, from, timeout }) {
    const t = this.terminals.get(targetTermId);
    if (!t) throw new Error(`Terminal "${targetTermId}" not found`);

    const task = this._createTask({
      type: 'dispatch',
      targetTermId,
      prompt,
      from: from || null,
      timeout: 0,  // Never timeout — AI runs as long as it needs
    });

    task.state = STATE.RUNNING;
    task.startedAt = Date.now();

    // Result file the target AI should write to
    const resultFile = path.join(this.workspaceDir, 'results', `${task.id}.md`);
    task.resultFile = resultFile;

    // Build the injection payload with clear instructions for the target AI
    const wrappedPrompt = [
      '',
      `[ORCHESTRATOR TASK ${task.id}]`,
      '',
      prompt,
      '',
      `IMPORTANT: When you are done, write your complete response/result to this file:`,
      `  ${resultFile.replace(/\\/g, '/')}`,
      '',
      `Write the file using whatever tool you have (Write tool, bash echo/cat, etc).`,
      `Start the file with "TASK_COMPLETE" on the first line so the orchestrator knows you are done.`,
      `Put your actual response/result on the lines after that.`,
      '',
    ].join('\n');

    // Inject into the target terminal
    this.inject(targetTermId, wrappedPrompt);

    // Poll for the result file
    task._pollInterval = setInterval(() => {
      if (task.state !== STATE.RUNNING) {
        clearInterval(task._pollInterval);
        return;
      }
      try {
        if (fs.existsSync(resultFile)) {
          const content = fs.readFileSync(resultFile, 'utf8');
          if (content.startsWith('TASK_COMPLETE')) {
            task.state = STATE.COMPLETED;
            task.result = content.replace(/^TASK_COMPLETE\r?\n?/, '').trim();
            task.completedAt = Date.now();
            clearInterval(task._pollInterval);
            clearTimeout(task._timer);
            this._broadcastTaskUpdate(task);
          }
        }
      } catch (_) {}
    }, RESULT_POLL_MS);

    // Timeout guard (skip if timeout is 0 = unlimited)
    if (task.timeout) task._timer = setTimeout(() => {
      if (task.state === STATE.RUNNING) {
        task.state = STATE.TIMEOUT;
        task.error = `Timed out after ${task.timeout}ms`;
        task.completedAt = Date.now();
        clearInterval(task._pollInterval);
        this._broadcastTaskUpdate(task);
      }
    }, task.timeout);

    this._broadcastTaskUpdate(task);
    return task;
  }

  // ── Inbox / Message Passing ──────────────────────────────────────────────

  /**
   * Send a message to a terminal's inbox.
   * The target AI can check its inbox via the API.
   */
  // ── Task Management ──────────────────────────────────────────────────────

  getTask(taskId) {
    return this._serializeTask(this.tasks.get(taskId));
  }

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
  }

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
  }

  // ── Broadcast / Announce ─────────────────────────────────────────────────

  /**
   * Broadcast a message to ALL terminal inboxes.
   */
  broadcastMessage({ from, content, metadata }) {
    const results = [];
    for (const [termId] of this.terminals) {
      if (termId === from) continue; // don't send to self
      results.push(this.sendMessage({ to: termId, from, content, metadata }));
    }
    return results;
  }

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
  }

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
  }

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
  }

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
  }

  /** Called after any task completes; checks if queued tasks can now run */
  _releaseQueuedTasks() {
    for (const [, task] of this.tasks) {
      if (task.state === STATE.QUEUED) {
        this._checkAndRelease(task);
      }
    }
  }

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
  }

  // ── Worktree Isolation ──────────────────────────────────────────────────

  /**
   * Create a git worktree for a task, spawn the CLI in it.
   * @param {Object} opts - same as spawnHeadless plus:
   * @param {string} opts.repoPath - path to the git repo
   * @param {string} [opts.branch] - branch name (auto-generated if omitted)
   */
  spawnInWorktree({ repoPath, branch, ...opts }) {
    if (!repoPath) throw new Error('repoPath is required for worktree spawn');
    const { execSync } = require('child_process');
    const taskId = opts.taskId || this._id();
    const branchName = branch || `orch/${taskId}`;
    const worktreePath = path.join(repoPath, '..', `.worktree-${taskId}`);

    try {
      // Create worktree with a new branch
      execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, { cwd: repoPath, timeout: 10000, encoding: 'utf8' });
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
  }

  /**
   * Clean up a task's worktree after results have been merged/reviewed.
   */
  cleanupWorktree(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.worktree) return { ok: false, error: 'Task has no worktree' };
    const { execSync } = require('child_process');
    try {
      execSync(`git worktree remove "${task.worktree.path}" --force`, { cwd: task.worktree.repoPath, timeout: 10000 });
      // Delete the branch too
      try { execSync(`git branch -D "${task.worktree.branch}"`, { cwd: task.worktree.repoPath, timeout: 5000 }); } catch (_) {}
      delete task.worktree;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  // ── Workflow Pause / Resume ─────────────────────────────────────────────

  /** Pause all running tasks (they continue in background but results are held) */
  pauseAll() {
    this._paused = true;
    this.broadcast({ type: 'orchestrator-event', event: 'paused', timestamp: Date.now() });
    return { ok: true, paused: true };
  }

  /** Resume orchestration */
  resumeAll() {
    this._paused = false;
    this.broadcast({ type: 'orchestrator-event', event: 'resumed', timestamp: Date.now() });
    // Release any queued tasks that were held
    this._releaseQueuedTasks();
    return { ok: true, paused: false };
  }

  /** Check if orchestration is paused */
  isPaused() { return !!this._paused; }

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
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _id() {
    return crypto.randomBytes(6).toString('hex');
  }

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
  }

  _serializeTask(task) {
    if (!task) return null;
    const { _proc, _timer, _pollInterval, _spawnOpts, _retryAttempt, ...safe } = task;
    return safe;
  }

  _persistResult(task) {
    if (!task.result) return;
    const resultFile = path.join(this.workspaceDir, 'results', `${task.id}.md`);
    try {
      fs.writeFileSync(resultFile, task.result);
      task.resultFile = resultFile;
    } catch (_) {}
  }

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
  }
}

// ── Route mounting ───────────────────────────────────────────────────────────

// ── Helper: read JSON body from request ──────────────────────────────────────
Object.assign(Orchestrator.prototype, require('./orchestrator/bus'));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Mount orchestrator API routes onto the server.
 *
 * @param {Function} addRoute  — server.js addRoute(method, path, handler)
 * @param {Function} json      — server.js json(res, data, status)
 * @param {Object}   opts
 * @param {Map}      opts.terminals
 * @param {Function} opts.broadcast
 * @param {string}   opts.repoRoot
 * @returns {Orchestrator}
 */
async function gateSpawn(res, { cli, cwd, label, wait = true }) {
  const permissions = require('./permissions');
  const path = require('path');
  const configPath = path.join(path.resolve(__dirname, '..'), 'config', 'config.json');
  return permissions.gate(res, { type: 'cli', value: `${cli}:spawn` }, {
    configPath,
    wait,
    ctx: { worktree: !!cwd && cwd.includes('worktree') },
    actionLabel: label || `Spawn ${cli} worker`,
  });
}

function mountOrchestrator(addRoute, json, { terminals, broadcast, repoRoot, createTerminal, getConfig, getLearnings, getUiContext }) {
  const workspaceDir = path.join(repoRoot, '.ai-workspace', 'orchestrator');
  const orch = new Orchestrator({ terminals, broadcast, workspaceDir, createTerminal, getConfig });
  orch.getLearnings = getLearnings || null;

  // Auto-cleanup tasks older than 1 hour every 30 minutes (preserves recent results)
  setInterval(() => orch.cleanup(60 * 60 * 1000), 30 * 60 * 1000);

  registerOrchestratorRoutes(addRoute, json, orch, { getConfig, broadcast, getUiContext });
  return orch;
}

module.exports = { Orchestrator, mountOrchestrator, pretrustFolderForCli };
