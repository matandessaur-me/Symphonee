/**
 * Orchestrator — Cross-AI communication bus for DevOps Pilot
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

// ── Constants ────────────────────────────────────────────────────────────────
const TASK_TIMEOUT_MS = 0;  // 0 = no timeout (unlimited)
const MAX_HEADLESS_OUTPUT = 512 * 1024;  // 512 KB stdout cap
const RESULT_POLL_MS = 500;

// Headless CLI flags per provider
// Each entry defines how to run the CLI non-interactively:
//   args:        base flags for headless/non-interactive mode
//   promptMode:  how the prompt is delivered:
//     'stdin'  — prompt is piped via process.stdin
//     'flag'   — prompt is appended as the value of the last arg (-p "prompt")
//     'positional' — prompt is appended as a trailing positional argument
//   shell:       override for spawn shell option (default true; false avoids cmd.exe quoting issues)
//
// IMPORTANT: These flags were verified against each CLI's --help output on 2026-04-03.
// If a CLI updates its interface, update the corresponding entry here.
const HEADLESS_FLAGS = {
  claude:  { cmd: 'claude',  args: ['-p'], promptMode: 'stdin' },                                   // -p = print mode, reads prompt from stdin
  gemini:  { cmd: 'gemini',  args: [],                   promptMode: 'stdin' },                    // non-TTY pipes auto-trigger headless mode; no flags needed
  codex:   { cmd: 'codex',   args: ['exec'],             promptMode: 'stdin' },                    // exec subcommand, reads prompt from stdin
  copilot: { cmd: 'copilot', args: ['-p'],               promptMode: 'flag',  shell: false },      // -p <prompt>; shell:false so Node.js handles quoting
  grok:    { cmd: 'grok',    args: ['--print'],           promptMode: 'positional', shell: false }, // --print <prompt>; shell:false for safe quoting
};

// ── CLI Model & Flag Intelligence ───────────────────────────────────────────
// The orchestrator and AI use this to spawn CLIs with optimal flags.
// The AI should select model + flags based on task complexity and cost.
// Grounded model availability per CLI and account type (researched 2026-04-05).
// IMPORTANT: Update this when models change. The AI should check /api/orchestrator/cli-models
// and never attempt a model that is not available for the user's account type.
const CLI_MODELS = {
  claude: {
    // Auth: Anthropic API key (ANTHROPIC_API_KEY) or Claude Pro/Max subscription
    // All models available with both auth methods
    models: ['opus', 'sonnet', 'haiku'],
    modelIds: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'sonnet',
    modelFlag: '--model',
    effortFlag: '--effort',           // low, medium, high, max
    effortValues: ['low', 'medium', 'high', 'max'],
    permissionFlag: '--dangerously-skip-permissions',
    autoPermission: true,
    outputFormatFlag: '--output-format',
    systemPromptFlag: '--append-system-prompt',
    worktreeFlag: '--worktree',
    extraHeadless: [],
    notes: 'All models work with both API key and subscription auth.',
  },
  gemini: {
    // Auth: Google account (free tier) or Gemini API key (GEMINI_API_KEY)
    // FREE tier: flash and flash-lite ONLY. Pro requires API billing enabled.
    models: ['flash', 'flash-lite'],
    modelIds: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash'],
    paidModels: ['pro', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
    defaultModel: 'flash',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--approval-mode',
    autoPermission: 'yolo',
    outputFormatFlag: '-o',
    systemPromptFlag: null,
    worktreeFlag: '--worktree',
    extraHeadless: [],
    notes: 'Free tier: flash/flash-lite only. Pro models require API billing enabled on Google Cloud project.',
  },
  codex: {
    // Auth: ChatGPT account (Plus/Pro/Business/Enterprise) or OpenAI API key (OPENAI_API_KEY)
    // ChatGPT account: gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark, gpt-5.1-codex family
    // NOT supported with ChatGPT account: o3, o4-mini, gpt-4.1, gpt-4o
    // API key: all models available
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1-codex'],
    modelIds: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'],
    apiKeyOnlyModels: ['o3', 'o4-mini', 'gpt-4.1'],
    notSupported: ['gpt-4o'],
    defaultModel: 'gpt-5.4',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--full-auto',
    autoPermission: true,
    outputFormatFlag: '--json',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'ChatGPT account: gpt-5.x models only. o3/o4-mini/gpt-4.1 require an OpenAI API key. gpt-4o is not available in Codex at all.',
  },
  copilot: {
    // Auth: GitHub account with Copilot Pro/Pro+/Business/Enterprise subscription
    // Models from 3 providers: Anthropic, OpenAI, Google
    // gpt-5-mini and gpt-4.1 do NOT consume premium requests (included free)
    models: ['claude-sonnet-4.6', 'gpt-5.4', 'gpt-4.1', 'gpt-5-mini'],
    modelIds: ['claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-5.3-codex', 'gemini-3-pro-preview'],
    freeModels: ['gpt-5-mini', 'gpt-4.1'],
    defaultModel: 'claude-sonnet-4.6',
    modelFlag: '--model',
    effortFlag: '--effort',
    effortValues: ['low', 'medium', 'high', 'xhigh'],
    permissionFlag: '--yolo',
    autoPermission: true,
    silentFlag: '--silent',
    outputFormatFlag: '--output-format',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'gpt-5-mini and gpt-4.1 are free (no premium requests). Claude/GPT-5.4/Gemini consume premium requests. Requires Copilot Pro+ for premium models.',
  },
  grok: {
    // Auth: xAI API key (XAI_API_KEY) - requires credits loaded in xAI console
    // All models require API key with credits
    models: ['grok-4', 'grok-3', 'grok-3-mini-fast'],
    modelIds: ['grok-4', 'grok-4-latest', 'grok-4.20', 'grok-3', 'grok-3-latest', 'grok-3-mini-fast', 'grok-code-fast-1', 'grok-4-1-fast-reasoning'],
    defaultModel: 'grok-3-mini-fast',
    modelFlag: '--model',
    effortFlag: null,
    permissionFlag: '--permission-mode',
    autoPermission: 'full',
    outputFormatFlag: '--output-format',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'All models require xAI API key with loaded credits. grok-3-mini-fast is cheapest.',
  },
};

// ── Provider Abstraction ─────────────────────────────────────────────────────
// Formal interface per CLI: launch config, cost tier, status detection patterns.
// Extends basic CLI_CONFIG with intelligence-level routing and idle detection.
const CLI_CONFIG = {
  claude:  { cmd: 'claude',  label: 'Claude Code', pipeMode: true, tier: 3, costRank: 5, idlePattern: /[❯>]\s*$/ },
  gemini:  { cmd: 'gemini',  label: 'Gemini CLI',  pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
  codex:   { cmd: 'codex',   label: 'Codex CLI',   pipeMode: true, tier: 2, costRank: 3, idlePattern: /[❯>$]\s*$/ },
  copilot: { cmd: 'copilot', label: 'Copilot CLI', pipeMode: true, tier: 1, costRank: 1, idlePattern: /[❯>]\s*$/ },
  grok:    { cmd: 'grok',    label: 'Grok Code',   pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
};
// tier: 1=basic, 2=mid, 3=premium (intelligence level)
// costRank: 1=cheapest .. 5=most expensive

// ── Cross-Model Escalation Chain ────────────────────────────────────────────
// Defines the order to try CLIs when a task fails. Cheapest first, premium last.
// The escalation chain is dynamic: it skips CLIs that are circuit-broken or not installed.
const ESCALATION_ORDER = ['copilot', 'gemini', 'grok', 'codex', 'claude']; // cheapest to most capable

// ── Concurrency Controls ────────────────────────────────────────────────────
const MAX_CONCURRENT_SPAWNS = 5;    // max simultaneous headless tasks
const SPAWN_STAGGER_MS = 200;       // delay between parallel spawns to prevent thundering herd

// ── Circuit Breaker per CLI ──────────────────────────────────────────────────
// Tracks failures per CLI provider. After N transient failures, the CLI is
// disabled for a cooldown period to prevent wasting time on broken providers.
const CIRCUIT_BREAKER_THRESHOLD = 3;     // failures before opening
const CIRCUIT_BREAKER_COOLDOWN = 5 * 60 * 1000; // 5 min cooldown
const CIRCUIT_BREAKER_HALF_OPEN_AFTER = 2 * 60 * 1000; // 2 min before trying one request

class CircuitBreaker {
  constructor() {
    /** @type {Map<string, { state: 'closed'|'open'|'half-open', failures: number, lastFailure: number, lastSuccess: number }>} */
    this.circuits = new Map();
  }

  _get(cli) {
    if (!this.circuits.has(cli)) {
      this.circuits.set(cli, { state: 'closed', failures: 0, lastFailure: 0, lastSuccess: 0 });
    }
    return this.circuits.get(cli);
  }

  /** Check if a CLI is available (circuit not open) */
  isAvailable(cli) {
    const c = this._get(cli);
    if (c.state === 'closed') return true;
    if (c.state === 'open') {
      // Check if cooldown elapsed, transition to half-open
      if (Date.now() - c.lastFailure > CIRCUIT_BREAKER_HALF_OPEN_AFTER) {
        c.state = 'half-open';
        return true; // allow one probe request
      }
      return false;
    }
    return true; // half-open: allow the probe
  }

  /** Record a success (resets the circuit) */
  recordSuccess(cli) {
    const c = this._get(cli);
    c.state = 'closed';
    c.failures = 0;
    c.lastSuccess = Date.now();
  }

  /** Record a failure. Returns true if circuit just opened. */
  recordFailure(cli, error) {
    const c = this._get(cli);
    // Classify error: only transient errors count toward the breaker
    if (this._isPermanent(error)) return false;
    c.failures++;
    c.lastFailure = Date.now();
    if (c.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      c.state = 'open';
      return true; // just opened
    }
    return false;
  }

  /** Get status of all circuits */
  getStatus() {
    const status = {};
    for (const [cli, c] of this.circuits) {
      status[cli] = { ...c };
    }
    return status;
  }

  /** Reset a specific CLI circuit */
  reset(cli) {
    this.circuits.delete(cli);
  }

  _isPermanent(error) {
    if (!error) return false;
    const msg = typeof error === 'string' ? error : (error.message || '');
    // Auth, billing, not-installed errors are permanent (do not count toward breaker)
    return /not installed|not found|not recognized|API key|not logged in|auth.*failed|invalid.*key|billing/i.test(msg);
  }
}

// ── Error Classification ────────────────────────────────────────────────────
// Structured error objects with recoverable/retryable flags
function classifyError(error, cli) {
  const msg = typeof error === 'string' ? error : (error.message || String(error));
  const isTransient = /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|rate.?limit|429|500|502|503/i.test(msg);
  const isPermanent = /not installed|not found|not recognized|API key|not logged in|auth.*failed|invalid.*key|billing|unexpected argument|bad flag/i.test(msg);
  const isFlagError = /unexpected argument|unrecognized option|unknown (flag|option)|bad flag/i.test(msg);
  const isModelError = /model.*not supported|not.*supported.*model|invalid.*model|unknown model|model.*not available|not supported when using.*account|requires.*api.?key/i.test(msg);

  return {
    message: msg,
    cli,
    transient: isTransient,
    permanent: isPermanent || isModelError, // model errors are permanent for that CLI/model combo
    flagError: isFlagError,
    modelError: isModelError,
    recoverable: !isPermanent && !isModelError,
    retryable: isTransient && !isPermanent && !isModelError,
    timestamp: Date.now(),
  };
}

// ── Retry with Exponential Backoff ──────────────────────────────────────────
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 3000;

function retryDelay(attempt) {
  // Exponential backoff with jitter: base * 2^attempt + random(0..1000)
  return RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
}

// ── Quality Gates (State Machine) ───────────────────────────────────────────
// Tasks can optionally go through quality gates: IMPLEMENT -> VALIDATE -> REVIEW -> DONE
// Each gate is a blocking state transition. Failure triggers retry with fresh context.
const QUALITY_GATES = {
  IMPLEMENT: 'implement',
  VALIDATE:  'validate',
  REVIEW:    'review',
  DONE:      'done',
};

// ── Result Scoring ──────────────────────────────────────────────────────────
// Score a task result by quality signals (length, structure, completeness)
function scoreResult(result) {
  if (!result) return 0;
  let score = 0;
  score += Math.min(result.length / 500, 10);  // length (up to 10 points for 5KB+)
  if (/```/.test(result)) score += 3;           // contains code blocks
  if (/\n##?\s/.test(result)) score += 2;       // has headings (structured)
  if (/\d+\.\s/.test(result)) score += 1;       // has numbered lists
  if (/error|fail|cannot|unable/i.test(result)) score -= 3; // contains error language
  if (result.length < 50) score -= 5;           // very short (likely failure)
  return Math.max(0, score);
}

// ── Reaction System ─────────────────────────────────────────────────────────
// Configurable per-event reactions: auto-send instructions, retry, escalate to human
const DEFAULT_REACTIONS = {
  'task-failed':    { action: 'retry',    maxRetries: 2, escalateAfterMs: 5 * 60 * 1000 },
  'task-timeout':   { action: 'retry',    maxRetries: 1, escalateAfterMs: 3 * 60 * 1000 },
  'agent-stale':    { action: 'nudge',    maxRetries: 3, escalateAfterMs: 10 * 60 * 1000 },
  'circuit-open':   { action: 'escalate', maxRetries: 0, escalateAfterMs: 0 },
};

// ── Task states ──────────────────────────────────────────────────────────────
const STATE = {
  PENDING:   'pending',
  QUEUED:    'queued',      // waiting for dependencies
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
  TIMEOUT:   'timeout',
};

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
  inject(termId, text) {
    const t = this.terminals.get(termId);
    if (!t) return { ok: false, error: `Terminal "${termId}" not found` };

    // Use \r (carriage return) for terminal submission, not \n (line feed)
    const payload = text.endsWith('\r') || text.endsWith('\n') ? text : text + '\r';
    t.pty.write(payload);

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
   * @param {string} opts.cli       — 'claude' | 'gemini' | 'codex' | 'copilot' | 'grok'
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
  spawnHeadless({ cli, prompt, cwd, timeout, from, taskId, model, effort, autoPermit, _retryAttempt = 0 }) {
    const cfg = HEADLESS_FLAGS[cli];
    if (!cfg) throw new Error(`Unknown CLI: "${cli}". Use: ${Object.keys(HEADLESS_FLAGS).join(', ')}`);

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

    const task = this._createTask({
      id: taskId,
      type: 'headless',
      cli,
      prompt,
      from: from || null,
      timeout: 0,  // Never timeout — AI runs as long as it needs
    });

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
          finalArgs.unshift(cliMeta.permissionFlag); // boolean flag like --full-auto, --yolo
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
    };
    for (const envKey of (CLI_ENV_KEYS[cli] || [])) {
      if (aiKeys[envKey]) spawnEnv[envKey] = aiKeys[envKey];
    }

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
              const retryTask = this.spawnHeadless({ cli, prompt: enhancedPrompt, cwd, timeout, from, taskId: task.id, _retryAttempt: _retryAttempt + 1 });
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

        // Try cross-model escalation before giving up
        if (task._escalationChain && task._escalationChain.length && classified.recoverable) {
          if (this._tryEscalate(task)) return; // escalated to next CLI
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
  spawnVisible({ cli, prompt, cwd, timeout, from, taskId }) {
    const cfg = CLI_CONFIG[cli];
    if (!cfg) throw new Error(`Unknown CLI: "${cli}". Use: ${Object.keys(CLI_CONFIG).join(', ')}`);
    if (!this.createTerminal) throw new Error('createTerminal not available -- cannot spawn visible terminals');

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
      // Trust/permission dialogs
      { match: /trust.*\(yes\/no\)/i,                        respond: 'yes\n',desc: 'trust prompt' },
      { match: /Do you trust/i,                              respond: 'yes\n',desc: 'trust prompt' },
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
  sendMessage({ to, from, content, metadata }) {
    if (!this.inboxes.has(to)) this.inboxes.set(to, []);

    const msg = {
      id: this._id(),
      from: from || 'system',
      to,
      content,
      metadata: metadata || {},
      timestamp: Date.now(),
      read: false,
    };

    this.inboxes.get(to).push(msg);

    // Also persist to disk for durability
    const inboxFile = path.join(this.workspaceDir, 'inboxes', `${to}.json`);
    try {
      const existing = fs.existsSync(inboxFile)
        ? JSON.parse(fs.readFileSync(inboxFile, 'utf8'))
        : [];
      existing.push(msg);
      fs.writeFileSync(inboxFile, JSON.stringify(existing, null, 2));
    } catch (_) {}

    this.broadcast({
      type: 'orchestrator-event',
      event: 'message',
      from: msg.from,
      to,
      preview: content.substring(0, 200),
      timestamp: msg.timestamp,
    });

    return msg;
  }

  /**
   * Read messages from a terminal's inbox.
   * @param {string} termId
   * @param {boolean} [markRead=true]
   */
  readInbox(termId, markRead = true) {
    const msgs = this.inboxes.get(termId) || [];
    if (markRead) {
      for (const m of msgs) m.read = true;
    }
    return msgs;
  }

  /**
   * Read only unread messages from a terminal's inbox.
   */
  readUnread(termId) {
    const msgs = this.inboxes.get(termId) || [];
    const unread = msgs.filter(m => !m.read);
    for (const m of unread) m.read = true;
    return unread;
  }

  /**
   * Clear a terminal's inbox.
   */
  clearInbox(termId) {
    this.inboxes.set(termId, []);
    const inboxFile = path.join(this.workspaceDir, 'inboxes', `${termId}.json`);
    try { if (fs.existsSync(inboxFile)) fs.unlinkSync(inboxFile); } catch (_) {}
  }

  // ── Task Management ──────────────────────────────────────────────────────

  getTask(taskId) {
    return this._serializeTask(this.tasks.get(taskId));
  }

  listTasks({ state, from, cli, limit } = {}) {
    let tasks = [...this.tasks.values()];

    if (state) tasks = tasks.filter(t => t.state === state);
    if (from) tasks = tasks.filter(t => t.from === from);
    if (cli) tasks = tasks.filter(t => t.cli === cli);

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
      const checkpoint = this.checkpoints.get(task.id);
      const enhancedPrompt = checkpoint
        ? `[Previous attempt by ${task.cli} produced partial results]:\n${checkpoint.partial.substring(0, 1000)}\n\n[Retry with ${nextCli}]:\n${task._escalationPrompt}`
        : task._escalationPrompt;

      const newTask = this.spawnHeadless({ cli: nextCli, prompt: enhancedPrompt, cwd: task._escalationCwd, from: task.from, taskId: task.id });
      // Transfer escalation chain to new attempt
      newTask._escalationChain = task._escalationChain;
      newTask._escalationPrompt = task._escalationPrompt;
      newTask._escalationCwd = task._escalationCwd;
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

  _createTask({ id, type, cli, prompt, from, timeout, targetTermId }) {
    const task = {
      id: id || this._id(),
      type,              // 'headless' | 'dispatch' | 'handoff'
      cli: cli || null,
      prompt,
      from,
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

      // PTY injection: push result directly into the requesting AI's terminal
      if (delivery === 'inject' || delivery === 'both') {
        // Build result as a single line to avoid multi-line paste issues in AI CLIs.
        // Multi-line pastes don't auto-submit in most CLIs; a single-line message does.
        const resultOneLine = `[TASK RESULT ${task.id}] ${stateLabel} (${task.cli || 'dispatch'}): ${snippet.replace(/\n/g, ' ').substring(0, 800)}`;
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

function mountOrchestrator(addRoute, json, { terminals, broadcast, repoRoot, createTerminal, getConfig, getLearnings }) {
  const workspaceDir = path.join(repoRoot, '.ai-workspace', 'orchestrator');
  const orch = new Orchestrator({ terminals, broadcast, workspaceDir, createTerminal, getConfig });
  orch.getLearnings = getLearnings || null;

  // Auto-cleanup tasks older than 1 hour every 30 minutes (preserves recent results)
  setInterval(() => orch.cleanup(60 * 60 * 1000), 30 * 60 * 1000);

  // ── GET /api/orchestrator/status ──────────────────────────────────────
  addRoute('GET', '/api/orchestrator/status', (req, res) => {
    const running = [...orch.tasks.values()].filter(t => t.state === 'running' || t.state === 'pending');
    json(res, {
      orchestrating: orch.orchestrating,
      runningTasks: running.length,
      tasks: running.map(t => orch._serializeTask(t)),
    });
  });

  // ── GET /api/orchestrator/agents ──────────────────────────────────────
  addRoute('GET', '/api/orchestrator/agents', (req, res) => {
    json(res, orch.getAgents());
  });

  // ── GET /api/orchestrator/terminal-output ────────────────────────────
  // Lets the AI read what's on a spawned terminal's screen (ANSI-stripped)
  addRoute('GET', '/api/orchestrator/terminal-output', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const termId = url.searchParams.get('termId');
    const lines = parseInt(url.searchParams.get('lines')) || 50;
    if (!termId) return json(res, { error: 'termId required' }, 400);
    const output = orch.termOutput.get(termId) || '';
    // Return last N lines
    const allLines = output.split('\n');
    const lastLines = allLines.slice(-lines).join('\n');
    json(res, { termId, output: lastLines, totalLines: allLines.length });
  });

  // ── POST /api/orchestrator/inject ─────────────────────────────────────
  addRoute('POST', '/api/orchestrator/inject', async (req, res) => {
    const { termId, text } = await readBody(req);
    if (!termId || !text) return json(res, { error: 'termId and text required' }, 400);
    const result = orch.inject(termId, text);
    json(res, result, result.ok ? 200 : 404);
  });

  // ── POST /api/orchestrator/dispatch ───────────────────────────────────
  addRoute('POST', '/api/orchestrator/dispatch', async (req, res) => {
    const { targetTermId, prompt, from, timeout } = await readBody(req);
    if (!targetTermId || !prompt) return json(res, { error: 'targetTermId and prompt required' }, 400);
    try {
      const task = orch.dispatch({ targetTermId, prompt, from, timeout });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── GET /api/orchestrator/cli-models ──────────────────────────────────
  // Returns available models per CLI, enriched with which API keys are configured
  addRoute('GET', '/api/orchestrator/cli-models', (req, res) => {
    const aiKeys = getConfig ? getConfig().AiApiKeys || {} : {};
    const enriched = {};
    for (const [cli, meta] of Object.entries(CLI_MODELS)) {
      enriched[cli] = { ...meta };
      // Indicate which API keys are set (boolean, not the actual key)
      const keyMap = { claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', codex: 'OPENAI_API_KEY', grok: 'XAI_API_KEY' };
      enriched[cli].hasApiKey = !!(keyMap[cli] && aiKeys[keyMap[cli]]);
      // If API key is set, merge apiKeyOnlyModels into available models
      if (enriched[cli].hasApiKey && enriched[cli].apiKeyOnlyModels) {
        enriched[cli].models = [...enriched[cli].models, ...enriched[cli].apiKeyOnlyModels];
      }
      if (enriched[cli].hasApiKey && enriched[cli].paidModels) {
        enriched[cli].models = [...enriched[cli].models, ...enriched[cli].paidModels];
      }
    }
    json(res, enriched);
  });

  // ── POST /api/orchestrator/spawn ──────────────────────────────────────
  addRoute('POST', '/api/orchestrator/spawn', async (req, res) => {
    const { cli, prompt, cwd, timeout, from, taskId, visible, model, effort, autoPermit } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    // Check if this CLI is allowed by the user's settings
    if (getConfig) {
      const cfg = getConfig();
      const allowList = cfg.OrchestrateCliList;
      if (Array.isArray(allowList) && allowList.length > 0 && !allowList.includes(cli)) {
        return json(res, { error: `CLI "${cli}" is not enabled for orchestration. Enable it in Settings > Other.` }, 403);
      }
    }
    if (!await gateSpawn(res, { cli, cwd, label: `Spawn ${cli} worker`, wait: !autoPermit })) return;
    try {
      // Auto-select best mode: pipe mode for CLIs that support it (fast, reliable),
      // visible PTY for interactive CLIs that need a terminal.
      // The 'visible' param can override: visible=true forces PTY, visible=false forces headless.
      const cliCfg = CLI_CONFIG[cli];
      const useVisible = visible === true || (visible !== false && cliCfg && !cliCfg.pipeMode);
      const task = useVisible
        ? orch.spawnVisible({ cli, prompt, cwd, timeout, from, taskId })
        : orch.spawnHeadless({ cli, prompt, cwd, timeout, from, taskId, model, effort, autoPermit });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── GET /api/orchestrator/tasks ───────────────────────────────────────
  addRoute('GET', '/api/orchestrator/tasks', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const state = url.searchParams.get('state');
    const from = url.searchParams.get('from');
    const cli = url.searchParams.get('cli');
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    json(res, orch.listTasks({ state, from, cli, limit }));
  });

  // ── GET /api/orchestrator/tasks/:id ───────────────────────────────────
  addRoute('GET', '/api/orchestrator/task', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) return json(res, { error: 'id query param required' }, 400);
    const task = orch.getTask(id);
    if (!task) return json(res, { error: 'Task not found' }, 404);
    json(res, task);
  });

  // ── POST /api/orchestrator/cancel ─────────────────────────────────────
  addRoute('POST', '/api/orchestrator/cancel', async (req, res) => {
    const { taskId } = await readBody(req);
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    const result = orch.cancelTask(taskId);
    json(res, result, result.ok ? 200 : 400);
  });

  // ── DELETE /api/orchestrator/task ──────────────────────────────────────
  addRoute('DELETE', '/api/orchestrator/task', async (req, res) => {
    const body = await readBody(req);
    const taskId = body.taskId;
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    const result = orch.deleteTask(taskId);
    json(res, result, result.ok ? 200 : 400);
  });

  // ── POST /api/orchestrator/message ────────────────────────────────────
  addRoute('POST', '/api/orchestrator/message', async (req, res) => {
    const { to, from, content, metadata } = await readBody(req);
    if (!to || !content) return json(res, { error: 'to and content required' }, 400);
    const msg = orch.sendMessage({ to, from, content, metadata });
    json(res, msg);
  });

  // ── POST /api/orchestrator/broadcast ──────────────────────────────────
  addRoute('POST', '/api/orchestrator/broadcast', async (req, res) => {
    const { from, content, metadata } = await readBody(req);
    if (!content) return json(res, { error: 'content required' }, 400);
    const msgs = orch.broadcastMessage({ from, content, metadata });
    json(res, { sent: msgs.length, messages: msgs });
  });

  // ── GET /api/orchestrator/inbox ───────────────────────────────────────
  addRoute('GET', '/api/orchestrator/inbox', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const termId = url.searchParams.get('termId');
    const unreadOnly = url.searchParams.get('unread') === '1';
    if (!termId) return json(res, { error: 'termId query param required' }, 400);
    const msgs = unreadOnly ? orch.readUnread(termId) : orch.readInbox(termId);
    json(res, msgs);
  });

  // ── POST /api/orchestrator/inbox/clear ────────────────────────────────
  addRoute('POST', '/api/orchestrator/inbox/clear', async (req, res) => {
    const { termId } = await readBody(req);
    if (!termId) return json(res, { error: 'termId required' }, 400);
    orch.clearInbox(termId);
    json(res, { ok: true });
  });

  // ── POST /api/orchestrator/cleanup ────────────────────────────────────
  addRoute('POST', '/api/orchestrator/cleanup', async (req, res) => {
    const body = await readBody(req);
    // Default: clean all non-running tasks (maxAgeMs=0). Pass maxAgeMs>0 for age-based cleanup.
    // Pass maxAgeMs=-1 to also cancel running tasks.
    const maxAge = body.maxAgeMs !== undefined ? body.maxAgeMs : 0;
    const cleaned = orch.cleanup(maxAge);
    json(res, { cleaned });
  });

  // ── GET /api/orchestrator/circuit-breaker ──────────────────────────────
  addRoute('GET', '/api/orchestrator/circuit-breaker', (req, res) => {
    json(res, orch.circuitBreaker.getStatus());
  });

  // ── POST /api/orchestrator/circuit-breaker/reset ─────────────────────
  addRoute('POST', '/api/orchestrator/circuit-breaker/reset', async (req, res) => {
    const { cli } = await readBody(req);
    if (cli) { orch.circuitBreaker.reset(cli); json(res, { ok: true, cli }); }
    else { json(res, { error: 'cli required' }, 400); }
  });

  // ── GET /api/orchestrator/heartbeats ─────────────────────────────────
  addRoute('GET', '/api/orchestrator/heartbeats', (req, res) => {
    json(res, orch.getHeartbeats());
  });

  // ── POST /api/orchestrator/handoff ───────────────────────────────────
  // Blocking handoff: spawns worker, waits for result, returns it
  addRoute('POST', '/api/orchestrator/handoff', async (req, res) => {
    const { cli, prompt, cwd, from, handoffTimeout } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    // Check CLI allowlist
    if (getConfig) {
      const cfg = getConfig();
      const allowList = cfg.OrchestrateCliList;
      if (Array.isArray(allowList) && allowList.length > 0 && !allowList.includes(cli)) {
        return json(res, { error: `CLI "${cli}" is not enabled for orchestration.` }, 403);
      }
    }
    if (!await gateSpawn(res, { cli, cwd, label: `Handoff to ${cli}` })) return;
    const result = await orch.handoff({ cli, prompt, cwd, from, handoffTimeout });
    json(res, result, result.ok ? 200 : 500);
  });

  // ── POST /api/orchestrator/spawn-with-deps ───────────────────────────
  // Spawn a task that waits for dependencies to complete first
  addRoute('POST', '/api/orchestrator/spawn-with-deps', async (req, res) => {
    const { cli, prompt, cwd, from, dependsOn } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    if (!Array.isArray(dependsOn) || !dependsOn.length) return json(res, { error: 'dependsOn must be a non-empty array of task IDs' }, 400);
    if (!await gateSpawn(res, { cli, cwd, label: `Spawn ${cli} with dependencies` })) return;
    try {
      const task = orch.spawnWithDependencies({ cli, prompt, cwd, from, dependsOn });
      json(res, task);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/spawn-worktree ────────────────────────────
  // Spawn a task in an isolated git worktree
  addRoute('POST', '/api/orchestrator/spawn-worktree', async (req, res) => {
    const { cli, prompt, repoPath, branch, from } = await readBody(req);
    if (!cli || !prompt || !repoPath) return json(res, { error: 'cli, prompt, and repoPath required' }, 400);
    if (!await gateSpawn(res, { cli, cwd: 'worktree', label: `Spawn ${cli} in worktree` })) return;
    try {
      const task = orch.spawnInWorktree({ cli, prompt, repoPath, branch, from });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/cleanup-worktree ──────────────────────────
  addRoute('POST', '/api/orchestrator/cleanup-worktree', async (req, res) => {
    const { taskId } = await readBody(req);
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    json(res, orch.cleanupWorktree(taskId));
  });

  // ── GET /api/orchestrator/checkpoints ────────────────────────────────
  addRoute('GET', '/api/orchestrator/checkpoints', (req, res) => {
    const checkpoints = {};
    for (const [taskId, cp] of orch.checkpoints) {
      checkpoints[taskId] = { ...cp, partial: cp.partial.substring(0, 200) + '...' };
    }
    json(res, checkpoints);
  });

  // ── POST /api/orchestrator/spawn-escalate ──────────────────────────────
  // Spawn with auto-escalation: tries cheapest CLI, escalates on failure
  addRoute('POST', '/api/orchestrator/spawn-escalate', async (req, res) => {
    const { preferCli, prompt, cwd, from } = await readBody(req);
    if (!prompt) return json(res, { error: 'prompt required' }, 400);
    if (!await gateSpawn(res, { cli: preferCli || 'escalation', cwd, label: `Spawn with escalation (prefer ${preferCli || 'auto'})` })) return;
    try {
      const task = orch.spawnWithEscalation({ preferCli, prompt, cwd, from });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/fan-out ───────────────────────────────────
  // Spawn multiple tasks in parallel with staggered starts
  addRoute('POST', '/api/orchestrator/fan-out', async (req, res) => {
    const { tasks: taskConfigs, maxConcurrent, staggerMs, aggregate } = await readBody(req);
    if (!Array.isArray(taskConfigs) || !taskConfigs.length) return json(res, { error: 'tasks array required' }, 400);
    if (!await gateSpawn(res, { cli: 'fan-out', label: `Fan out ${taskConfigs.length} workers` })) return;
    try {
      const result = orch.fanOut(taskConfigs, { maxConcurrent, staggerMs, aggregate });
      json(res, { tasks: result.tasks, aggregate: !!aggregate });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/spawn-lineage ─────────────────────────────
  // Spawn with sibling/parent awareness
  addRoute('POST', '/api/orchestrator/spawn-lineage', async (req, res) => {
    const { cli, prompt, cwd, from, parentTaskId, siblingTaskIds } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    if (!await gateSpawn(res, { cli, cwd, label: `Spawn ${cli} with lineage` })) return;
    try {
      const task = orch.spawnWithLineage({ cli, prompt, cwd, from, parentTaskId, siblingTaskIds });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/pause ─────────────────────────────────────
  addRoute('POST', '/api/orchestrator/pause', (req, res) => { json(res, orch.pauseAll()); });

  // ── POST /api/orchestrator/resume ────────────────────────────────────
  addRoute('POST', '/api/orchestrator/resume', (req, res) => { json(res, orch.resumeAll()); });

  // ── POST /api/orchestrator/wait-for ──────────────────────────────────
  // Promise-based wait for a task to complete (blocking HTTP call)
  addRoute('POST', '/api/orchestrator/wait-for', async (req, res) => {
    const { taskId, timeoutMs } = await readBody(req);
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    try {
      const task = await orch.waitFor(taskId, timeoutMs);
      json(res, task);
    } catch (err) {
      json(res, { error: err.message }, 408);
    }
  });

  // ── GET /api/orchestrator/aggregate ──────────────────────────────────
  // Aggregate and rank results from multiple tasks
  addRoute('GET', '/api/orchestrator/aggregate', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const taskIds = (url.searchParams.get('taskIds') || '').split(',').filter(Boolean);
    if (!taskIds.length) return json(res, { error: 'taskIds query param required (comma-separated)' }, 400);
    json(res, orch._aggregateResults(taskIds));
  });

  // ── Heartbeat monitor: detect stale agents and trigger reactions ──────
  setInterval(() => {
    const beats = orch.getHeartbeats();
    for (const beat of beats) {
      if (beat.status === 'stale') {
        orch.broadcast({ type: 'orchestrator-event', event: 'agent-stale', taskId: beat.taskId, cli: beat.cli, idleMs: beat.idleMs, timestamp: Date.now() });
      }
    }
  }, 30000);

  return orch;
}

module.exports = { Orchestrator, mountOrchestrator };
