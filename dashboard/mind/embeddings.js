/**
 * Pluggable embedding provider for Mind's semantic search.
 *
 * Providers, swappable via env or POST body:
 *   - openai             https://api.openai.com/v1/embeddings, model: text-embedding-3-small (1536d)
 *   - google             generativelanguage.googleapis.com,    model: text-embedding-004 (768d)
 *
 * Provider is gracefully optional - if no API key is set, semantic search
 * falls back to BM25-only and the UI shows a quiet disabled state.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Provider resolution order:
//   1. Explicit SYMPHONEE_EMBED_PROVIDER env var (developer override).
//   2. Symphonee's config.AiApiKeys - whichever key is set first wins
//      (openai > google). Set per-process by mind/index.js at boot.
//   3. No implicit provider. If no key is configured, dense search stays off.
const DEFAULT_PROVIDER = process.env.SYMPHONEE_EMBED_PROVIDER || 'auto';

let _availableKeys = null;
function setAvailableApiKeys(keys) { _availableKeys = keys || null; }
function pickProvider() {
  if (DEFAULT_PROVIDER && DEFAULT_PROVIDER !== 'auto') return DEFAULT_PROVIDER;
  const k = _availableKeys || {};
  if (k.OPENAI_API_KEY) return 'openai';
  if (k.GOOGLE_API_KEY) return 'google';
  return null;
}

// Per-process cache of last-known provider state so the health endpoint
// doesn't ping the network on every paint.
let _healthCache = null;
let _healthCacheAt = 0;
const HEALTH_TTL_MS = 30_000;

function postJson(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json: ' + e.message)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function ollamaEmbed(texts, opts = {}) {
  const url = (opts.url || process.env.OLLAMA_URL || 'http://localhost:11434') + '/api/embeddings';
  const model = opts.model || process.env.SYMPHONEE_EMBED_MODEL || 'nomic-embed-text';
  const out = [];
  for (const text of texts) {
    const r = await postJson(url, { model, prompt: text });
    if (!r.embedding) throw new Error('ollama returned no embedding');
    out.push(r.embedding);
  }
  return out;
}

async function openaiEmbed(texts, opts = {}) {
  const key = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const model = opts.model || process.env.SYMPHONEE_EMBED_MODEL || 'text-embedding-3-small';
  const r = await postJson('https://api.openai.com/v1/embeddings',
    { model, input: texts },
    { Authorization: `Bearer ${key}` });
  return (r.data || []).map(d => d.embedding);
}

async function googleEmbed(texts, opts = {}) {
  const key = opts.apiKey || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const model = opts.model || process.env.SYMPHONEE_EMBED_MODEL || 'text-embedding-004';
  const out = [];
  for (const text of texts) {
    const r = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`,
      { content: { parts: [{ text }] } },
    );
    if (!r.embedding || !r.embedding.values) throw new Error('google returned no embedding');
    out.push(r.embedding.values);
  }
  return out;
}

async function embed(texts, opts = {}) {
  const picked = opts.provider || pickProvider();
  if (!picked) throw new Error('No embedding provider configured. Add an OpenAI or Google API key in Settings > AI Providers.');
  const provider = picked.toLowerCase();
  if (!Array.isArray(texts)) throw new Error('embed expects an array of texts');
  if (texts.length === 0) return [];
  // Inject API keys from Symphonee's config when not explicitly passed.
  const k = _availableKeys || {};
  const enriched = { ...opts, apiKey: opts.apiKey || (provider === 'openai' ? k.OPENAI_API_KEY : provider === 'google' ? k.GOOGLE_API_KEY : null) };
  try {
    switch (provider) {
      case 'openai': return await openaiEmbed(texts, enriched);
      case 'google': return await googleEmbed(texts, enriched);
      case 'ollama':
      default: return await ollamaEmbed(texts, enriched);
    }
  } catch (err) {
    // Wrap with a clearer message when no key is set
    if (provider !== 'ollama' && /api[_ ]?key/i.test(err.message || '')) {
      throw new Error(`${provider} embedding needs an API key in Settings > AI Providers (key '${provider === 'openai' ? 'OPENAI_API_KEY' : 'GOOGLE_API_KEY'}' missing)`);
    }
    throw err;
  }
}

async function embedSingle(text, opts = {}) {
  const out = await embed([text], opts);
  return out[0] || null;
}

async function ping(opts = {}) {
  const picked = opts.provider || pickProvider();
  if (!picked) {
    return {
      ok: false,
      provider: null,
      error: 'No embedding provider configured. Add an OpenAI or Google API key in Settings > AI Providers.',
    };
  }
  const provider = picked.toLowerCase();
  const t0 = Date.now();
  try {
    const v = await embedSingle('healthcheck', opts);
    if (!v || !v.length) throw new Error('empty vector');
    return { ok: true, provider, latencyMs: Date.now() - t0, dimensions: v.length };
  } catch (err) {
    return { ok: false, provider, error: err.message };
  }
}

async function health(opts = {}) {
  const now = Date.now();
  if (_healthCache && now - _healthCacheAt < HEALTH_TTL_MS && !opts.fresh) return _healthCache;
  const result = await ping(opts);
  _healthCache = result;
  _healthCacheAt = now;
  return result;
}

module.exports = {
  embed,
  embedSingle,
  ping,
  health,
  pickProvider,
  setAvailableApiKeys,
  defaultProvider: () => DEFAULT_PROVIDER,
};
