/**
 * Action registry for the browser-use plugin.
 *
 * Pattern ported from browser-use/browser_use/tools/service.py - each action
 * has a name, a JSON-schema-ish param spec, and an executor that calls the
 * existing Symphonee browser-agent over HTTP. The LLM picks an action by
 * name; we validate params before dispatching so the agent gets a clean
 * error instead of a stack trace from a missing field.
 *
 * Validation is intentionally minimal (type + required) rather than pulling
 * Zod or AJV - we don't want a new top-level dep for one plugin and the
 * surface area is small.
 */

'use strict';

const http = require('http');

const PORT = process.env.SYMPHONEE_PORT ? Number(process.env.SYMPHONEE_PORT) : 3800;

function _request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    };
    const req = http.request(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(parsed);
          else reject(new Error(`/api${urlPath.replace(/^\/api/, '')} -> ${resp.statusCode}: ${data.slice(0, 300)}`));
        } catch (e) {
          if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(data);
          else reject(new Error(`Bad JSON from ${urlPath}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function _get(urlPath) { return _request('GET', urlPath, null); }
function _post(urlPath, body) { return _request('POST', urlPath, body || {}); }

function _validate(params, spec) {
  const out = {};
  for (const [key, def] of Object.entries(spec || {})) {
    const val = params ? params[key] : undefined;
    if (val === undefined || val === null || val === '') {
      if (def.required) throw new Error(`Missing required param: ${key}`);
      if ('default' in def) out[key] = def.default;
      continue;
    }
    if (def.type === 'string' && typeof val !== 'string') throw new Error(`Param ${key}: expected string, got ${typeof val}`);
    if (def.type === 'number' && typeof val !== 'number') throw new Error(`Param ${key}: expected number, got ${typeof val}`);
    if (def.type === 'boolean' && typeof val !== 'boolean') throw new Error(`Param ${key}: expected boolean, got ${typeof val}`);
    out[key] = val;
  }
  return out;
}

const ACTIONS = {
  navigate: {
    description: 'Load a URL in the browser tab.',
    params: { url: { type: 'string', required: true } },
    async exec(p) { return await _post('/api/browser/navigate', { url: p.url }); },
  },
  click_text: {
    description: 'Click the best-matching visible element by visible text or aria-label.',
    params: { text: { type: 'string', required: true }, exact: { type: 'boolean', required: false, default: false } },
    async exec(p) { return await _post('/api/browser/click-text', { text: p.text, exact: !!p.exact }); },
  },
  click_handle: {
    description: 'Click using an opaque handle returned by list_clickables.',
    params: { handle: { type: 'string', required: true } },
    async exec(p) { return await _post('/api/browser/click-handle', { handle: p.handle }); },
  },
  fill_label: {
    description: 'Fill an input identified by its label text.',
    params: {
      label: { type: 'string', required: true },
      value: { type: 'string', required: true },
      exact: { type: 'boolean', required: false, default: false },
    },
    async exec(p) { return await _post('/api/browser/fill-by-label', { label: p.label, value: p.value, exact: !!p.exact }); },
  },
  fill_handle: {
    description: 'Fill an input identified by handle.',
    params: { handle: { type: 'string', required: true }, value: { type: 'string', required: true } },
    async exec(p) { return await _post('/api/browser/fill-handle', { handle: p.handle, value: p.value }); },
  },
  press_key: {
    description: 'Send a single keyboard key (Enter, Tab, Escape, etc.).',
    params: { key: { type: 'string', required: true } },
    async exec(p) { return await _post('/api/browser/press-key', { key: p.key }); },
  },
  wait_for: {
    description: 'Wait for a CSS selector to be present, up to timeout ms.',
    params: { selector: { type: 'string', required: true }, timeout: { type: 'number', required: false, default: 10000 } },
    async exec(p) { return await _post('/api/browser/wait-for', { selector: p.selector, timeout: p.timeout }); },
  },
  screenshot: {
    description: 'Capture a viewport screenshot.',
    params: {},
    async exec() { return await _get('/api/browser/screenshot'); },
  },
  read_page: {
    description: 'Read cleaned page text. Optional CSS selector to narrow scope.',
    params: { selector: { type: 'string', required: false } },
    async exec(p) {
      const q = p.selector ? `?selector=${encodeURIComponent(p.selector)}` : '';
      return await _get(`/api/browser/read-page${q}`);
    },
  },
  list_clickables: {
    description: 'Return interactive-element inventory across all accessible frames. Each entry has { handle, tag, text, href, role, visible, occluded, pagesAway } - feed handles into click_handle / fill_handle.',
    params: {
      limit: { type: 'number', required: false, default: 200 },
      includeHidden: { type: 'boolean', required: false, default: false },
    },
    async exec(p) {
      const q = `?limit=${p.limit || 200}&includeHidden=${p.includeHidden ? 'true' : 'false'}`;
      return await _get(`/api/browser/interactive${q}`);
    },
  },
  get_watchdogs: {
    description: 'Return popups/aboutblank/downloads events captured since the page launched.',
    params: {},
    async exec() { return await _get('/api/browser/watchdogs'); },
  },
};

function listActions() {
  return Object.entries(ACTIONS).map(([name, def]) => ({
    name,
    description: def.description,
    params: def.params,
  }));
}

async function runAction(name, params) {
  const def = ACTIONS[name];
  if (!def) throw new Error(`Unknown action: ${name}. Available: ${Object.keys(ACTIONS).join(', ')}`);
  const validated = _validate(params || {}, def.params);
  return await def.exec(validated);
}

async function _seedCitedNodes(action, params) {
  // Per the plugin instructions: seed citedNodeIds from a Mind query about
  // the action+params before saving the step. Best-effort - if Mind is
  // unreachable we just save with an empty list.
  try {
    const probe = `${action} ${JSON.stringify(params || {}).slice(0, 200)}`;
    const r = await _post('/api/mind/query', { question: probe, budget: 600 });
    const seeds = (r && Array.isArray(r.seedIds)) ? r.seedIds.slice(0, 5) : [];
    return seeds;
  } catch (_) { return []; }
}

async function saveStepToMind({ action, params, result, url }) {
  try {
    const citedNodeIds = await _seedCitedNodes(action, params);
    const body = {
      question: `browser-use action: ${action}`,
      answer: JSON.stringify({ action, params, url, ok: !!(result && result.ok), summary: _summarize(result) }).slice(0, 4000),
      citedNodeIds,
      createdBy: 'browser-use',
    };
    return await _post('/api/mind/save-result', body);
  } catch (_) { return null; }
}

function _summarize(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.url) return `url=${result.url}${result.title ? ` title=${result.title}` : ''}`;
  if (Array.isArray(result.elements)) return `elements=${result.elements.length}`;
  if (result.matchedText) return `matched=${result.matchedText}`;
  if (result.error) return `error=${result.error}`;
  return null;
}

module.exports = { listActions, runAction, saveStepToMind, ACTIONS };
