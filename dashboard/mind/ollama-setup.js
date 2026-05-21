/**
 * Local semantic-search setup helper.
 *
 * The one-button "Make search smarter" flow non-technical users see in
 * Settings. Each step is idempotent and exposes its state so the UI can
 * stream progress over the WebSocket.
 *
 *   1. detect()        - is Ollama installed? running? is the model pulled?
 *   2. ensureRunning() - if installed but not running, try to start it
 *                        (best-effort spawn, fire-and-forget).
 *   3. ensureModel()   - if the model isn't pulled, pull it via the
 *                        streaming /api/pull endpoint and broadcast
 *                        progress to the UI.
 *   4. rebuildVectors()- drop any incompatible old vector store (the
 *                        existing OpenAI 1536-dim file is unusable when
 *                        switching to Ollama's 768-dim) and trigger a
 *                        fresh full embed run.
 *
 * Anything that fails returns { ok: false, step, hint } so the UI can
 * either link the user to a downloader or show a retry button.
 */

'use strict';

const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.SYMPHONEE_EMBED_MODEL || 'nomic-embed-text';

function getHttp(urlStr, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'GET',
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function postJsonStream(urlStr, body, { onChunk, timeoutMs = 600_000 } = {}) {
  // Streams newline-delimited JSON chunks (Ollama's /api/pull format)
  // through onChunk so the UI can render a progress bar.
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errBuf = '';
        res.on('data', c => errBuf += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBuf.slice(0, 200)}`)));
        return;
      }
      let leftover = '';
      res.on('data', (chunk) => {
        leftover += chunk.toString('utf8');
        const lines = leftover.split('\n');
        leftover = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { onChunk && onChunk(JSON.parse(trimmed)); } catch (_) { /* skip bad line */ }
        }
      });
      res.on('end', () => {
        if (leftover.trim()) {
          try { onChunk && onChunk(JSON.parse(leftover)); } catch (_) {}
        }
        resolve({ ok: true });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('pull-timeout')));
    req.write(data);
    req.end();
  });
}

function findOllamaBinary() {
  // Honor explicit override first.
  if (process.env.OLLAMA_BIN && fs.existsSync(process.env.OLLAMA_BIN)) return process.env.OLLAMA_BIN;
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'));
    candidates.push('C:\\Program Files\\Ollama\\ollama.exe');
  } else if (process.platform === 'darwin') {
    candidates.push('/usr/local/bin/ollama');
    candidates.push('/opt/homebrew/bin/ollama');
  } else {
    candidates.push('/usr/local/bin/ollama');
    candidates.push('/usr/bin/ollama');
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

async function detect({ model = DEFAULT_MODEL } = {}) {
  const installPath = findOllamaBinary();
  const installed = !!installPath;
  let running = false, modelInstalled = false, models = [];
  try {
    const r = await getHttp(OLLAMA_BASE + '/api/tags');
    if (r.status === 200) {
      running = true;
      const data = JSON.parse(r.body);
      models = (data.models || []).map(m => m.name);
      modelInstalled = models.some(n => n.startsWith(model));
    }
  } catch (_) { /* not running */ }
  return { installed, installPath, running, model, modelInstalled, models };
}

async function ensureRunning({ installPath }) {
  // Best-effort spawn. Ollama's `ollama serve` daemonizes itself on most
  // platforms; we detach the child so it survives the Node process. If
  // the spawn fails the user just has to launch Ollama manually — we
  // surface a clear hint.
  if (!installPath) return { ok: false, step: 'ensureRunning', reason: 'not-installed' };
  try {
    const child = spawn(installPath, ['serve'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (e) {
    return { ok: false, step: 'ensureRunning', reason: 'spawn-failed', error: e.message };
  }
  // Wait up to ~6s for the daemon to accept connections.
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      const r = await getHttp(OLLAMA_BASE + '/api/tags', 500);
      if (r.status === 200) return { ok: true, step: 'ensureRunning' };
    } catch (_) { /* still starting */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return { ok: false, step: 'ensureRunning', reason: 'timeout', hint: 'Ollama did not respond after launch. Try opening Ollama from your Start menu.' };
}

async function ensureModel({ model = DEFAULT_MODEL, broadcast } = {}) {
  // Pull the embedding model. The /api/pull stream emits progress chunks
  // shaped { status, completed?, total? }. We rebroadcast a compact
  // version so the UI can show "Downloading X.XX GB / Y.YY GB".
  let lastReported = 0;
  try {
    await postJsonStream(OLLAMA_BASE + '/api/pull', { model, stream: true }, {
      onChunk: (chunk) => {
        if (!broadcast) return;
        const now = Date.now();
        if (now - lastReported < 250 && chunk.status !== 'success') return;
        lastReported = now;
        broadcast({
          type: 'mind-update',
          payload: { kind: 'ollama-pull', model, status: chunk.status, completed: chunk.completed || null, total: chunk.total || null },
        });
      },
    });
    return { ok: true, step: 'ensureModel' };
  } catch (e) {
    return { ok: false, step: 'ensureModel', reason: 'pull-failed', error: e.message };
  }
}

module.exports = {
  OLLAMA_BASE,
  DEFAULT_MODEL,
  detect,
  ensureRunning,
  ensureModel,
  findOllamaBinary,
};
