/**
 * Local LLM chat helper for Mind's reasoning passes.
 *
 * Mind's reflection cycle (cluster -> memory card promotion) and any future
 * reasoning task call into this helper rather than touching Ollama directly.
 * Everything stays local — same provider policy as embeddings.js.
 *
 * Why split from embeddings.js: embeddings is a hot path on every save-result
 * and runs constantly in the background. Chat is occasional, slower, and uses
 * a different model. Different concerns, different files.
 *
 * Defaults:
 *   model:        SYMPHONEE_CHAT_MODEL env > pickChatModel() > 'qwen2.5:1.5b'
 *   format:       'json' (Ollama's structured-output mode)
 *   timeout:      30s — pattern detection is small prompts, fast models
 *   temperature:  0.2 — low so the JSON stays stable across runs
 */

'use strict';

const http = require('http');
const { URL } = require('url');

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 30_000;

// Preference order for reflection's chat model. Smaller = faster reflection
// passes. qwen2.5:1.5b is the sweet spot: ~1GB on disk, ~200ms per call,
// strong reasoning + JSON adherence. llama3.2:1b is a fine second choice.
// gemma3:1b and qwen2.5:0.5b sit below as smaller-but-weaker. Anything else
// the user already has gets picked up last.
const PREFERRED_CHAT_MODELS = [
  'qwen2.5:1.5b',
  'llama3.2:1b',
  'gemma3:1b',
  'qwen2.5:0.5b',
  'llama3.2:3b',
  'qwen2.5:3b',
];

// Models we explicitly exclude when scanning the installed list — these are
// embedding-only and can't serve chat completions. Match on prefix so
// `:latest`, `:fp16`, etc. all map correctly.
const EMBED_ONLY_PREFIXES = [
  'nomic-embed-text',
  'mxbai-embed',
  'all-minilm',
  'bge-',
  'snowflake-arctic-embed',
];

function isEmbeddingModel(name) {
  const n = String(name || '').toLowerCase();
  return EMBED_ONLY_PREFIXES.some(p => n.startsWith(p));
}

// Cached state populated by refreshChatStatus(). Sync getters read this.
let _status = { reachable: false, models: [], preferred: null, checkedAt: 0 };
const STATUS_TTL_MS = 5 * 60 * 1000;

function postJson(urlStr, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); }
          catch (e) { reject(new Error('bad json from ollama: ' + e.message)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('chat-timeout')));
    req.write(data);
    req.end();
  });
}

async function refreshChatStatus({ force = false } = {}) {
  if (!force && Date.now() - _status.checkedAt < STATUS_TTL_MS) return _status;
  try {
    const res = await new Promise((resolve, reject) => {
      const u = new URL(OLLAMA_BASE + '/api/tags');
      const r = http.request({
        hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET',
      }, (resp) => {
        let buf = '';
        resp.on('data', c => buf += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
      });
      r.on('error', reject);
      r.setTimeout(1500, () => r.destroy(new Error('chat-status-timeout')));
      r.end();
    });
    if (res.status !== 200) throw new Error('ollama ' + res.status);
    const data = JSON.parse(res.body);
    const installed = (data.models || []).map(m => m.name);
    const chatModels = installed.filter(n => !isEmbeddingModel(n));
    let preferred = null;
    for (const pref of PREFERRED_CHAT_MODELS) {
      const hit = chatModels.find(n => n === pref || n.startsWith(pref + ':'));
      if (hit) { preferred = hit; break; }
    }
    if (!preferred && chatModels.length) preferred = chatModels[0];
    _status = { reachable: true, models: chatModels, preferred, checkedAt: Date.now() };
  } catch (_) {
    _status = { reachable: false, models: [], preferred: null, checkedAt: Date.now() };
  }
  return _status;
}

function getChatStatus() { return _status; }

function pickChatModel() {
  if (process.env.SYMPHONEE_CHAT_MODEL) return process.env.SYMPHONEE_CHAT_MODEL;
  return _status.preferred || null;
}

/**
 * Call Ollama /api/chat. Returns the parsed assistant content. If
 * `format` is 'json' (default), tries to JSON.parse the response and
 * returns the object; throws if the response wasn't valid JSON. Pass
 * `format: null` for free-form text.
 *
 * @param {Array<{role,content}>} messages
 * @param {Object} opts
 * @param {string} [opts.model]      explicit override; otherwise pickChatModel()
 * @param {string|null} [opts.format='json']
 * @param {number} [opts.temperature=0.2]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.numPredict]   ollama options.num_predict cap
 */
async function chatOllama(messages, opts = {}) {
  const model = opts.model || pickChatModel();
  if (!model) throw new Error('no-chat-model-available');
  const format = opts.format === undefined ? 'json' : opts.format;
  const body = {
    model,
    messages,
    stream: false,
    options: {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      num_predict: opts.numPredict || 512,
    },
  };
  if (format) body.format = format;
  const r = await postJson(OLLAMA_BASE + '/api/chat', body, { timeoutMs: opts.timeoutMs });
  const content = r && r.message && r.message.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty chat response');
  if (format === 'json') {
    try { return { ok: true, model, json: JSON.parse(content) }; }
    catch (e) { throw new Error('chat returned non-JSON: ' + content.slice(0, 200)); }
  }
  return { ok: true, model, text: content };
}

module.exports = {
  chatOllama,
  refreshChatStatus,
  getChatStatus,
  pickChatModel,
  isEmbeddingModel,
  PREFERRED_CHAT_MODELS,
};
