/**
 * Site Recipes - per-site saved automation definitions, mirroring
 * apps-recipes for desktop apps. Storage is one JSON file per host
 * under dashboard/site-recipes/, plus a parallel site-memory/ for
 * markdown notes the agent writes during sessions and a
 * site-snapshots/ for cached DOM digests.
 *
 * Recipe schema:
 *   { id, name, description?, host, status, conceptTags?, sourceSessionId?,
 *     successCount, inputs?, steps: [{ id, verb, target?, text?, notes? }],
 *     createdAt, updatedAt }
 *
 * Verbs (web-flavored DSL):
 *   GOTO            - navigate to URL
 *   CLICK           - css selector or "role=...|name=..." or "text=..."
 *   TYPE            - selector + text (fires input+change)
 *   PRESS           - keyboard combo
 *   WAIT_FOR_DOM    - wait for selector
 *   WAIT_FOR_NETWORK- wait for network idle
 *   WAIT            - fixed delay (ms)
 *   EXTRACT         - read text from selector and bind to a variable
 *   SCROLL_TO       - scroll element into view
 *   IF/ELSE/ENDIF, REPEAT/ENDREPEAT - control flow (Phase E)
 */

const fs = require('fs');
const path = require('path');

const RECIPES_DIR = path.join(__dirname, 'site-recipes');
const MEMORY_DIR = path.join(__dirname, 'site-memory');
const SNAPSHOT_DIR = path.join(__dirname, 'site-snapshots');
const HISTORY_DIR = path.join(__dirname, 'site-recipe-history');

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }

// Stable host slug. Strips port, lowercases, replaces unsafe chars. We
// intentionally keep one file per host (not per origin) so a recipe for
// reddit.com works whether the agent visits over http or https.
function normalizeHost(input) {
  if (!input) return '__unknown__';
  let s = String(input).trim().toLowerCase();
  // Accept full URLs too.
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).hostname;
  } catch (_) {}
  s = s.replace(/^www\./, '');
  s = s.replace(/[^a-z0-9._-]+/g, '_');
  return s.slice(0, 80) || '__unknown__';
}

function recipesPath(host) { return path.join(RECIPES_DIR, normalizeHost(host) + '.json'); }
function memoryPath(host)  { return path.join(MEMORY_DIR, normalizeHost(host) + '.md'); }
function snapshotPath(host, pathHash) { return path.join(SNAPSHOT_DIR, normalizeHost(host), pathHash + '.json'); }
function historyPath(host) { return path.join(HISTORY_DIR, normalizeHost(host) + '.json'); }

function _load(host) {
  ensureDir(RECIPES_DIR);
  const p = recipesPath(host);
  if (!fs.existsSync(p)) return { host: normalizeHost(host), recipes: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    data.host = normalizeHost(host);
    if (!Array.isArray(data.recipes)) data.recipes = [];
    return data;
  } catch (_) {
    return { host: normalizeHost(host), recipes: [] };
  }
}

function _write(host, data) {
  ensureDir(RECIPES_DIR);
  fs.writeFileSync(recipesPath(host), JSON.stringify(data, null, 2), 'utf8');
}

const ALLOWED_VERBS = new Set([
  'GOTO', 'CLICK', 'TYPE', 'PRESS', 'WAIT', 'WAIT_FOR_DOM', 'WAIT_FOR_NETWORK',
  'EXTRACT', 'SCROLL_TO', 'FIND', 'VERIFY',
  'IF', 'ELSE', 'ENDIF', 'REPEAT', 'ENDREPEAT',
]);

const SAFE_ID_RE = /^[a-zA-Z][\w-]{0,63}$/;
const MAX_REPEAT = 1000;

function _stepId() { return 's_' + Math.random().toString(36).slice(2, 10); }
function _recipeId() { return 'r_' + Math.random().toString(36).slice(2, 10); }

function _validateStep(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('step must be an object');
  const verb = String(raw.verb || '').trim().toUpperCase();
  if (!ALLOWED_VERBS.has(verb)) throw new Error(`unknown verb "${raw.verb}". Allowed: ${[...ALLOWED_VERBS].join(', ')}.`);
  const safeId = SAFE_ID_RE.test(String(raw.id || '')) ? String(raw.id) : _stepId();
  const step = { id: safeId, verb };
  if (raw.target != null) step.target = String(raw.target).slice(0, 1000);
  if (raw.text != null) step.text = String(raw.text).slice(0, 4000);
  if (raw.notes != null) step.notes = String(raw.notes).slice(0, 500);
  if (verb === 'REPEAT' && step.target) {
    const n = parseInt(step.target, 10);
    if (Number.isFinite(n) && n > MAX_REPEAT) step.target = String(MAX_REPEAT);
  }
  return step;
}

function listRecipes(host) { return _load(host); }

function getRecipe(host, id) {
  const data = _load(host);
  return data.recipes.find(r => r.id === id) || null;
}

function saveRecipe(host, recipe) {
  if (!recipe || !String(recipe.name || '').trim()) throw new Error('recipe name required');
  const steps = Array.isArray(recipe.steps) ? recipe.steps.map(_validateStep) : [];
  const now = new Date().toISOString();
  const data = _load(host);
  const id = SAFE_ID_RE.test(String(recipe.id || '')) ? String(recipe.id) : _recipeId();
  const existing = data.recipes.find(x => x.id === id);
  const allowedStatuses = new Set(['draft', 'verified', 'archived']);
  const status = allowedStatuses.has(String(recipe.status))
    ? String(recipe.status)
    : (existing && existing.status) || 'verified';
  const conceptTags = Array.isArray(recipe.conceptTags)
    ? recipe.conceptTags.map(t => String(t).slice(0, 40)).filter(Boolean).slice(0, 12)
    : (existing && existing.conceptTags) || undefined;
  const sourceSessionId = recipe.sourceSessionId
    ? String(recipe.sourceSessionId).slice(0, 80)
    : (existing && existing.sourceSessionId) || undefined;
  const successCount = Number.isFinite(recipe.successCount)
    ? Math.max(0, recipe.successCount | 0)
    : (existing && existing.successCount) || 0;
  const inputs = Array.isArray(recipe.inputs)
    ? recipe.inputs.filter(i => i && typeof i === 'object').slice(0, 12)
    : (existing && existing.inputs) || undefined;
  const record = {
    id,
    name: String(recipe.name).trim().slice(0, 120),
    description: String(recipe.description || '').trim().slice(0, 1000) || undefined,
    host: normalizeHost(host),
    inputs,
    steps,
    status,
    conceptTags,
    sourceSessionId,
    successCount,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  if (existing) {
    const idx = data.recipes.findIndex(x => x.id === id);
    data.recipes[idx] = record;
  } else {
    data.recipes.push(record);
  }
  _write(host, data);
  return { ok: true, recipe: record, path: recipesPath(host) };
}

function deleteRecipe(host, id) {
  const data = _load(host);
  const idx = data.recipes.findIndex(x => x.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  data.recipes.splice(idx, 1);
  _write(host, data);
  return { ok: true };
}

// Hash a URL path (and optional query) to a short stable id so a single
// host with many pages doesn't create a sprawl of unbounded-length filenames.
function pathHash(url) {
  try {
    const u = new URL(url);
    const key = u.pathname + (u.search || '');
    return require('crypto').createHash('md5').update(key).digest('hex').slice(0, 12);
  } catch (_) {
    return require('crypto').createHash('md5').update(String(url || '')).digest('hex').slice(0, 12);
  }
}

// DOM digest: structured snapshot of a page (interactive elements, headings,
// forms). Stored under site-snapshots/<host>/<pathHash>.json. The agent
// chooses to refresh the snapshot if the digest hash differs from the
// cached one.
function saveSnapshot(host, url, digest) {
  if (!digest || typeof digest !== 'object') return null;
  const slugDir = path.join(SNAPSHOT_DIR, normalizeHost(host));
  ensureDir(slugDir);
  const ph = pathHash(url);
  const file = path.join(slugDir, ph + '.json');
  const payload = {
    host: normalizeHost(host),
    url,
    pathHash: ph,
    capturedAt: new Date().toISOString(),
    digestHash: require('crypto').createHash('sha256').update(JSON.stringify(digest)).digest('hex').slice(0, 16),
    digest,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return { path: file, ...payload };
}

function loadSnapshot(host, url) {
  try {
    const f = snapshotPath(host, pathHash(url));
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Convert an action log (the same shape browser-agent-chat session._recordedActions
// uses) to recipe steps. Mirrors apps-recipes.actionsToSteps but for web verbs.
function _selectorString(args) {
  // browser-agent-chat tools use varied arg shapes. Pick whatever stable
  // identifier we can. Prefer role+name form, then css, then handle.
  if (args.selector) return String(args.selector);
  if (args.css) return String(args.css);
  if (args.handle) return 'handle:' + String(args.handle);
  if (args.role && args.name) return `role=${args.role}|name=${args.name}`;
  if (args.text) return `text=${args.text}`;
  return '';
}

function actionsToSteps(actions) {
  const out = [];
  for (const a of actions || []) {
    const name = a.name;
    const args = a.args || {};
    if (name === 'navigate' && args.url) {
      out.push({ verb: 'GOTO', target: String(args.url) });
    } else if (name === 'click' || name === 'click_text' || name === 'click_handle') {
      const t = name === 'click_text' && args.text ? `text=${args.text}` : _selectorString(args);
      if (t) out.push({ verb: 'CLICK', target: t });
    } else if (name === 'fill' || name === 'fill_by_label' || name === 'fill_handle') {
      const t = name === 'fill_by_label' && args.label ? `label=${args.label}` : _selectorString(args);
      const text = args.value != null ? String(args.value) : (args.text != null ? String(args.text) : '');
      if (t) out.push({ verb: 'TYPE', target: t, text });
    } else if (name === 'press_key' && args.key) {
      out.push({ verb: 'PRESS', target: String(args.key) });
    } else if (name === 'wait_for' && args.selector) {
      out.push({ verb: 'WAIT_FOR_DOM', target: String(args.selector), notes: args.timeoutMs ? `timeout ${args.timeoutMs}ms` : undefined });
    } else if (name === 'scroll_to' && args.selector) {
      out.push({ verb: 'SCROLL_TO', target: String(args.selector) });
    } else if (name === 'fill_saved_credentials' && args.account) {
      out.push({ verb: 'TYPE', target: 'credentials:' + args.account, text: '<saved>', notes: 'fill_saved_credentials' });
    }
  }
  return out;
}

function recordRun(host, entry) {
  ensureDir(HISTORY_DIR);
  const p = historyPath(host);
  let data = { host: normalizeHost(host), runs: [] };
  if (fs.existsSync(p)) {
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
    if (!Array.isArray(data.runs)) data.runs = [];
  }
  const rec = {
    id: 'h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    at: entry.at || new Date().toISOString(),
    recipeId: entry.recipeId || null,
    recipeName: entry.recipeName || null,
    outcome: entry.outcome || 'unknown',
    iterations: entry.iterations || 0,
    durationMs: entry.durationMs || 0,
    error: entry.error || null,
  };
  data.runs.unshift(rec);
  if (data.runs.length > 200) data.runs.length = 200;
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return rec;
}

module.exports = {
  RECIPES_DIR, MEMORY_DIR, SNAPSHOT_DIR, HISTORY_DIR,
  normalizeHost, pathHash,
  recipesPath, memoryPath, snapshotPath, historyPath,
  listRecipes, getRecipe, saveRecipe, deleteRecipe,
  saveSnapshot, loadSnapshot,
  actionsToSteps, recordRun,
};
