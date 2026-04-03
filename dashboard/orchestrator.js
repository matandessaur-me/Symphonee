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
// Headless pipe-mode flags per CLI (prompt via stdin, stdout result)
// All major CLIs now support -p for non-interactive/headless mode
const HEADLESS_FLAGS = {
  claude:  { cmd: 'claude',  args: ['-p', '--no-input'] },          // -p = print mode (stdin -> stdout)
  gemini:  { cmd: 'gemini',  args: ['-p'] },                        // -p = headless/non-interactive
  codex:   { cmd: 'codex',   args: ['-q', '-a', 'full-auto'] },     // -q = quiet, -a full-auto = no approval prompts
  copilot: { cmd: 'copilot', args: ['-p'] },                        // -p = non-interactive prompt mode
  grok:    { cmd: 'grok',    args: ['-p'] },                        // -p = headless prompt mode
};

// CLI launch commands, labels, and capabilities
// All CLIs support pipe mode now via their respective headless flags
const CLI_CONFIG = {
  claude:  { cmd: 'claude',  label: 'Claude Code', pipeMode: true },
  gemini:  { cmd: 'gemini',  label: 'Gemini CLI',  pipeMode: true },
  codex:   { cmd: 'codex',   label: 'Codex CLI',   pipeMode: true },
  copilot: { cmd: 'copilot', label: 'Copilot CLI', pipeMode: true },
  grok:    { cmd: 'grok',    label: 'Grok Code',   pipeMode: true },
};

// ── Task states ──────────────────────────────────────────────────────────────
const STATE = {
  PENDING:   'pending',
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
   */
  constructor({ terminals, broadcast, workspaceDir, createTerminal }) {
    super();
    this.terminals = terminals;
    this.broadcast = broadcast;
    this.workspaceDir = workspaceDir;
    this.createTerminal = createTerminal;

    /** @type {Map<string, Task>} */
    this.tasks = new Map();

    /** @type {Map<string, string>} per-terminal output buffer (last 4KB) for AI inspection */
    this.termOutput = new Map();

    /** @type {Map<string, Message[]>} per-terminal inbox */
    this.inboxes = new Map();

    /** @type {boolean} Whether orchestration mode is active (at least one task running) */
    this.orchestrating = false;

    // Ensure workspace directories exist
    for (const sub of ['tasks', 'results', 'inboxes']) {
      const dir = path.join(workspaceDir, sub);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
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

    const payload = text.endsWith('\n') ? text : text + '\n';
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
   * @param {string} opts.cli       — 'claude' | 'gemini' | 'codex' | 'copilot'
   * @param {string} opts.prompt    — the prompt to send
   * @param {string} [opts.cwd]     — working directory
   * @param {number} [opts.timeout] — ms before killing (default 5 min)
   * @param {string} [opts.from]    — termId of the requesting agent
   * @param {string} [opts.taskId]  — tie to existing task
   * @returns {Task}
   */
  spawnHeadless({ cli, prompt, cwd, timeout, from, taskId }) {
    const cfg = HEADLESS_FLAGS[cli];
    if (!cfg) throw new Error(`Unknown CLI: "${cli}". Use: ${Object.keys(HEADLESS_FLAGS).join(', ')}`);

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
      timeout: timeout || TASK_TIMEOUT_MS,
    });

    const proc = spawn(cfg.cmd, [...cfg.args], {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: true,
    });

    task._proc = proc;
    task.state = STATE.RUNNING;
    task.startedAt = Date.now();

    let stdout = '';
    let stderr = '';

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < MAX_HEADLESS_OUTPUT) {
        stdout += text;
      }
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
      } else {
        task.state = STATE.FAILED;
        task.error = stderr.trim() || `Process exited with code ${code}`;
        task.result = stdout.trim();
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
      timeout: timeout || TASK_TIMEOUT_MS,
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
      timeout: timeout || TASK_TIMEOUT_MS,
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
   * Clean up completed/failed/cancelled tasks older than maxAge.
   * @param {number} [maxAgeMs=3600000] — 1 hour default
   */
  cleanup(maxAgeMs = 60 * 60 * 1000) {
    const now = Date.now();
    const forceAll = maxAgeMs === 0;

    // Pass 1: cancel running/pending tasks if force-cleaning
    if (forceAll) {
      for (const [id, task] of this.tasks) {
        if (task.state === STATE.RUNNING || task.state === STATE.PENDING) {
          this.cancelTask(id);
        }
      }
    }

    // Pass 2: delete all non-running tasks that match the age criteria
    const toDelete = [];
    for (const [id, task] of this.tasks) {
      if (task.state === STATE.RUNNING || task.state === STATE.PENDING) continue;
      if (forceAll || now - (task.completedAt || task.createdAt) > maxAgeMs) {
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
    return toDelete.length;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _id() {
    return crypto.randomBytes(6).toString('hex');
  }

  _createTask({ id, type, cli, prompt, from, timeout, targetTermId }) {
    const task = {
      id: id || this._id(),
      type,              // 'headless' | 'dispatch'
      cli: cli || null,
      prompt,
      from,
      targetTermId: targetTermId || null,
      state: STATE.PENDING,
      result: null,
      error: null,
      resultFile: null,
      timeout: timeout || TASK_TIMEOUT_MS,
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
    const { _proc, _timer, _pollInterval, ...safe } = task;
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
    this.broadcast({
      type: 'orchestrator-event',
      event: 'task-update',
      task: this._serializeTask(task),
      timestamp: Date.now(),
    });

    // Track orchestration mode: active when any task is running
    const wasOrchestrating = this.orchestrating;
    const hasRunning = [...this.tasks.values()].some(t => t.state === STATE.RUNNING || t.state === STATE.PENDING);
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
      const stateLabel = task.state === STATE.COMPLETED ? 'completed successfully' : task.state;
      const snippet = task.result ? task.result.substring(0, 300) : (task.error || 'No output');
      this.sendMessage({
        to: task.from,
        from: 'orchestrator',
        content: `Task ${task.id} ${stateLabel}.\n\nResult:\n${snippet}`,
        metadata: { taskId: task.id, state: task.state, type: 'task-result' },
      });
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
function mountOrchestrator(addRoute, json, { terminals, broadcast, repoRoot, createTerminal }) {
  const workspaceDir = path.join(repoRoot, '.ai-workspace', 'orchestrator');
  const orch = new Orchestrator({ terminals, broadcast, workspaceDir, createTerminal });

  // Cleanup old tasks every 30 minutes
  setInterval(() => orch.cleanup(), 30 * 60 * 1000);

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

  // ── POST /api/orchestrator/spawn ──────────────────────────────────────
  addRoute('POST', '/api/orchestrator/spawn', async (req, res) => {
    const { cli, prompt, cwd, timeout, from, taskId, visible } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    try {
      // Auto-select best mode: pipe mode for CLIs that support it (fast, reliable),
      // visible PTY for interactive CLIs that need a terminal.
      // The 'visible' param can override: visible=true forces PTY, visible=false forces headless.
      const cliCfg = CLI_CONFIG[cli];
      const useVisible = visible === true || (visible !== false && cliCfg && !cliCfg.pipeMode);
      const task = useVisible
        ? orch.spawnVisible({ cli, prompt, cwd, timeout, from, taskId })
        : orch.spawnHeadless({ cli, prompt, cwd, timeout, from, taskId });
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
    const maxAge = body.maxAgeMs || undefined;
    const cleaned = orch.cleanup(maxAge);
    json(res, { cleaned });
  });

  return orch;
}

module.exports = { Orchestrator, mountOrchestrator };
