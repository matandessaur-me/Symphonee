'use strict';
// Visible spawn (Tier 2b): launch an AI CLI in a real PTY tab the user can watch,
// with a phase-based terminal watcher that auto-handles interactive prompts.
// Mixed into Orchestrator.prototype. Extracted from orchestrator.js (behavior-preserving).

const fs = require('fs');
const path = require('path');
const { STATE } = require('./state');
const { CLI_CONFIG } = require('./cli-config');
const { RESULT_POLL_MS } = require('./constants');
module.exports = {
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
  },
};
