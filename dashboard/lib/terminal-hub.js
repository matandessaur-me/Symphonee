'use strict';
// Terminal hub - PTY management + WebSocket + broadcast. The last kernel piece
// extracted from server.js. Owns the terminal map, shell spawning, session
// persistence, the WS server, and broadcast (the fan-out to all connected UIs).
//
// createTerminalHub({ httpServer, repoRoot, getConfig })
//   -> { broadcast, terminals, termAiMeta, createTerminal, killTerminal, wss }
//
// server.js binds broadcast/terminals/createTerminal/killTerminal from this and
// passes them to the mounts, so all existing call sites keep their names.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { atomicWriteSync } = require('../utils/atomic-write');
const { detectPwsh } = require('./detect-cli');

function createTerminalHub({ httpServer, repoRoot, getConfig, verifyUpgrade }) {
  const terminals = new Map();   // termId -> { pty, cols, rows, cwd, label }
  const termAiMeta = new Map();  // termId -> { cli, launched, updatedAt }
  let defaultCols = 120, defaultRows = 30;

  // ── Terminal session persistence (under .ai-workspace, gitignored) ───────
  const termSessionsFile = path.join(repoRoot, '.ai-workspace', 'terminal-sessions.json');
  let _sessionsRestored = false;
  function loadTermSessions() {
    try { return JSON.parse(fs.readFileSync(termSessionsFile, 'utf8')) || {}; }
    catch (_) { return { shells: [], mainLabel: null }; }
  }
  function saveTermSessions() {
    try {
      fs.mkdirSync(path.dirname(termSessionsFile), { recursive: true });
      const shells = [];
      let mainLabel = null;
      for (const [id, t] of terminals) {
        if (id === 'main') { mainLabel = t.label || null; continue; }
        shells.push({ id, label: t.label || null, cwd: t.cwd || null });
      }
      atomicWriteSync(termSessionsFile, JSON.stringify({ shells, mainLabel }, null, 2));
    } catch (_) { /* best-effort */ }
  }
  function restoreTermSessionsOnce() {
    if (_sessionsRestored) return;
    _sessionsRestored = true;
    let saved;
    try { saved = loadTermSessions(); } catch (_) { return; }
    for (const s of (saved && saved.shells) || []) {
      if (!s || !s.id || s.id === 'main' || terminals.has(s.id)) continue;
      let cwd = repoRoot;
      try { if (s.cwd && fs.existsSync(s.cwd)) cwd = s.cwd; } catch (_) {}
      try { createTerminal(s.id, defaultCols, defaultRows, cwd, s.label || null); } catch (_) {}
    }
  }

  function findShell() {
    const pwsh = detectPwsh();
    if (pwsh.installed) return pwsh.path;
    try { execSync('where powershell.exe 2>nul', { encoding: 'utf8', timeout: 3000 }).trim(); return 'powershell.exe'; } catch (_) {
      const fallback = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (fs.existsSync(fallback)) return fallback;
      return 'powershell.exe';
    }
  }
  const shellPath = findShell();

  function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  function _normFsPath(p) {
    return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  }
  function _repoForPath(cwd) {
    const cfg = getConfig();
    const repos = cfg.Repos || {};
    const nCwd = _normFsPath(cwd);
    let best = null;
    let bestLen = -1;
    for (const [name, repoPath] of Object.entries(repos)) {
      const nRepo = _normFsPath(repoPath);
      if (!nRepo) continue;
      if ((nCwd === nRepo || nCwd.startsWith(nRepo + '\\')) && nRepo.length > bestLen) {
        best = name;
        bestLen = nRepo.length;
      }
    }
    return best;
  }
  function _handleTerminalCwd(termId, cwd) {
    if (!cwd) return;
    const t = terminals.get(termId);
    if (t) t.cwd = cwd;
    broadcast({ type: 'term-cwd', termId, cwd, repo: _repoForPath(cwd) });
  }

  function createTerminal(termId, cols = 120, rows = 30, cwd = null, label = null) {
    // New terminals default to Symphonee's repoRoot (where scripts/*.ps1 live).
    if (!cwd) cwd = repoRoot;
    if (terminals.has(termId)) {
      try { terminals.get(termId).pty.kill(); } catch (_) {}
      terminals.delete(termId);
    }
    termAiMeta.delete(termId);

    const ptyProcess = pty.spawn(shellPath, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NoLogo', '-NoExit'], {
      name: 'xterm-256color',
      cols, rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        SYMPHONEE_TERM_ID: termId,
      },
    });

    terminals.set(termId, { pty: ptyProcess, cols, rows, cwd, label: label || null });

    ptyProcess.onData(data => {
      broadcast({ type: 'output', termId, data });
    });
    ptyProcess.onExit(() => {
      terminals.delete(termId);
      termAiMeta.delete(termId);
      broadcast({ type: 'term-exited', termId });
    });

    broadcast({ type: 'term-started', termId, cwd, isNew: true });
    _handleTerminalCwd(termId, cwd);
    return ptyProcess;
  }

  function killTerminal(termId) {
    const t = terminals.get(termId);
    if (t) {
      try { t.pty.kill(); } catch (_) {}
      terminals.delete(termId);
    }
    termAiMeta.delete(termId);
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  // Same Origin/Host firewall as the HTTP server: a malicious web page can open
  // a WebSocket to ws://127.0.0.1:PORT (WS has no same-origin restriction at the
  // protocol level), so we reject foreign origins / non-loopback hosts at the
  // upgrade handshake. The renderer (same-origin) and local clients pass.
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, cb) => {
      try {
        if (typeof verifyUpgrade === 'function' && !verifyUpgrade(info.req)) {
          return cb(false, 403, 'Forbidden');
        }
      } catch (_) { return cb(false, 403, 'Forbidden'); }
      return cb(true);
    },
  });

  wss.on('connection', (ws) => {
    // First connection after an app restart: bring back saved shells.
    restoreTermSessionsOnce();
    const active = [];
    let mainLabel = null;
    for (const [id, t] of terminals) {
      if (id === 'main') mainLabel = t.label || null;
      active.push({ id, label: t.label || null, cwd: t.cwd || null });
    }
    if (mainLabel == null) { try { mainLabel = loadTermSessions().mainLabel || null; } catch (_) {} }
    ws.send(JSON.stringify({ type: 'term-list', terminals: active, mainLabel }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const termId = msg.termId || 'main';
        switch (msg.type) {
          case 'input': {
            const t = terminals.get(termId);
            if (t) t.pty.write(msg.data || '');
            break;
          }
          case 'resize': {
            if (msg.cols && msg.rows) {
              const cols = Math.max(msg.cols, 20);
              const rows = Math.max(msg.rows, 5);
              defaultCols = cols;
              defaultRows = rows;
              const t = terminals.get(termId);
              if (!t) {
                createTerminal(termId, cols, rows);
              } else if (cols !== t.cols || rows !== t.rows) {
                t.cols = cols;
                t.rows = rows;
                t.pty.resize(cols, rows);
              }
            }
            break;
          }
          case 'create-term': {
            createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows, msg.cwd, msg.label || null);
            saveTermSessions();
            break;
          }
          case 'kill-term': {
            if (termId !== 'main') { killTerminal(termId); saveTermSessions(); }
            break;
          }
          case 'rename-term': {
            const t = terminals.get(termId);
            if (t) { t.label = (String(msg.label || '').slice(0, 60)) || null; saveTermSessions(); }
            break;
          }
          case 'restart': {
            createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows);
            break;
          }
          case 'term-ai-state': {
            const cli = typeof msg.cli === 'string' ? msg.cli.trim() : '';
            const launched = msg.launched !== false;
            if (!cli || !launched) termAiMeta.delete(termId);
            else termAiMeta.set(termId, { cli, launched: true, updatedAt: Date.now() });
            break;
          }
        }
      } catch (_) {}
    });
  });

  return { broadcast, terminals, termAiMeta, createTerminal, killTerminal, wss };
}

module.exports = { createTerminalHub };
