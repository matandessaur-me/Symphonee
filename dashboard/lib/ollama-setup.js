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
const DEFAULT_CHAT_MODEL = process.env.SYMPHONEE_CHAT_MODEL || 'qwen2.5:1.5b';
// Brain models. Triage is small (~1GB) and cheap; we auto-pull it.
// Reasoning is large (gemma4:26b ~ 16GB). We do NOT auto-pull - we
// announce it as a missing dependency and let the user (or the UI's
// explicit "Install brain models" button) decide.
const DEFAULT_TRIAGE_MODEL = process.env.SYMPHONEE_TRIAGE_MODEL || 'qwen2.5:1.5b';
const DEFAULT_REASONING_MODEL = process.env.SYMPHONEE_REASONING_MODEL || 'gemma4:26b';
const { PREFERRED_CHAT_MODELS, isEmbeddingModel } = require('./llm');

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

async function detect({ model = DEFAULT_MODEL, chatModel = DEFAULT_CHAT_MODEL } = {}) {
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
  // Split installed models into embed-capable vs chat-capable. The
  // reflection cycle picks the smallest preferred chat model that's
  // present; falls back to any non-embed model the user has.
  const chatModels = models.filter(n => !isEmbeddingModel(n));
  let preferredChat = null;
  for (const pref of PREFERRED_CHAT_MODELS) {
    const hit = chatModels.find(n => n === pref || n.startsWith(pref + ':'));
    if (hit) { preferredChat = hit; break; }
  }
  if (!preferredChat && chatModels.length) preferredChat = chatModels[0];
  const chatModelInstalled = !!preferredChat;
  return {
    installed, installPath, running,
    model, modelInstalled,
    chatModel, chatModelInstalled, preferredChat, chatModels,
    models,
  };
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

/**
 * Brain-specific detection. Reports whether the planner triage model
 * (small, auto-pullable) and the reasoning model (large, manual-pull)
 * are installed alongside the standard Ollama + embedding detection.
 *
 * Returns:
 *   {
 *     ollamaInstalled, ollamaRunning,
 *     triageModel, triageModelInstalled,
 *     reasoningModel, reasoningModelInstalled,
 *     missing: ['ollama' | 'triage' | 'reasoning' ...],
 *     hint: 'human-readable next step' | null,
 *   }
 */
async function detectBrainSetup({
  triageModel = DEFAULT_TRIAGE_MODEL,
  reasoningModel = DEFAULT_REASONING_MODEL,
} = {}) {
  const installPath = findOllamaBinary();
  const ollamaInstalled = !!installPath;
  let ollamaRunning = false;
  let models = [];
  try {
    const r = await getHttp(OLLAMA_BASE + '/api/tags');
    if (r.status === 200) {
      ollamaRunning = true;
      const data = JSON.parse(r.body);
      models = (data.models || []).map(m => m.name);
    }
  } catch (_) { /* not running */ }

  function _has(name) {
    return models.some(n => n === name || n.startsWith(name + ':'));
  }

  const triageModelInstalled = _has(triageModel);
  const reasoningModelInstalled = _has(reasoningModel);
  const missing = [];
  if (!ollamaInstalled) missing.push('ollama');
  if (ollamaInstalled && ollamaRunning && !triageModelInstalled) missing.push('triage');
  if (ollamaInstalled && ollamaRunning && !reasoningModelInstalled) missing.push('reasoning');

  let hint = null;
  if (!ollamaInstalled) {
    hint = 'Install Ollama from https://ollama.com/download, then restart Symphonee.';
  } else if (!ollamaRunning) {
    hint = 'Ollama is installed but not running. Symphonee will try to start it automatically; otherwise launch it from your Start menu.';
  } else if (!triageModelInstalled) {
    hint = `Symphonee will auto-pull the small triage model "${triageModel}" (~1 GB). This should happen on next boot.`;
  } else if (!reasoningModelInstalled) {
    hint = `The brain's reasoning model "${reasoningModel}" (~16 GB) is not installed. POST /api/symphonee/setup/pull to download it (one-time, on demand) or run \`ollama pull ${reasoningModel}\` manually. Brain features (intent recompute, local-first answering, workflow synthesis, self-iteration) need this model.`;
  }

  return {
    ollamaInstalled, ollamaRunning, installPath,
    triageModel, triageModelInstalled,
    reasoningModel, reasoningModelInstalled,
    missing,
    hint,
    ready: missing.length === 0,
  };
}

/**
 * Pull a specific brain model with progress broadcast. Use for the
 * "Install brain models" flow. Returns the same shape as ensureModel().
 */
async function pullBrainModel({ model, broadcast } = {}) {
  if (!model) return { ok: false, step: 'pullBrainModel', reason: 'no-model-specified' };
  return ensureModel({ model, broadcast });
}

module.exports = {
  OLLAMA_BASE,
  DEFAULT_MODEL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_TRIAGE_MODEL,
  DEFAULT_REASONING_MODEL,
  detect,
  detectBrainSetup,
  ensureRunning,
  ensureModel,
  pullBrainModel,
  findOllamaBinary,
};
