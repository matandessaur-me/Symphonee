/**
 * Apps Recipes - per-app saved automation definitions.
 *
 * A recipe is a named, structured sequence of steps the user can re-run
 * against a specific app ("Open new file in Figma", "Export PNG", ...).
 * Storage is one JSON file per normalized app name, kept beside the app's
 * memory/instructions markdown so the two live together on disk.
 *
 * Step schema (Phase A - kept intentionally simple; the Phase B DSL engine
 * upgrades each verb to a deterministic driver call):
 *   { id, verb: 'CLICK'|'TYPE'|'PRESS'|'WAIT'|'FIND'|'VERIFY',
 *     target?: string, text?: string, notes?: string }
 *
 * Recipe schema:
 *   { id, name, description?, variables?: object, steps: Step[],
 *     createdAt, updatedAt }
 */

const fs = require('fs');
const path = require('path');

const { normalizeApp } = require('./apps-memory');

const DIR = path.join(__dirname, 'app-recipes');

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
}

function filePath(app) {
  return path.join(DIR, normalizeApp(app) + '.json');
}

function _load(app) {
  ensureDir();
  const p = filePath(app);
  if (!fs.existsSync(p)) return { app: normalizeApp(app), recipes: [] };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw || '{}');
    data.app = normalizeApp(app);
    if (!Array.isArray(data.recipes)) data.recipes = [];
    return data;
  } catch (_) {
    return { app: normalizeApp(app), recipes: [] };
  }
}

function _write(app, data) {
  ensureDir();
  fs.writeFileSync(filePath(app), JSON.stringify(data, null, 2), 'utf8');
}

const ALLOWED_VERBS = new Set([
  'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'TYPE', 'PRESS', 'WAIT', 'WAIT_UNTIL', 'FIND', 'VERIFY',
  'SCROLL', 'DRAG',
  // Reads a live UIA element value into a variable for subsequent steps.
  // Makes recipes dynamic ("play the first result, whatever it is").
  'EXTRACT',
  // Control flow (Phase E):
  'IF', 'ELSE', 'ENDIF',
  'REPEAT', 'ENDREPEAT',
]);

const SAFE_ID_RE = /^[a-zA-Z][\w-]{0,63}$/;
const MAX_REPEAT = 1000;

function _validateStep(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('step must be an object');
  const verb = String(raw.verb || '').trim().toUpperCase();
  if (!ALLOWED_VERBS.has(verb)) throw new Error(`unknown verb "${raw.verb}". Allowed: ${[...ALLOWED_VERBS].join(', ')}.`);
  // Honour caller-supplied step ids only if they are safe for HTML attribute
  // interpolation. Otherwise mint a fresh id. Prevents stored XSS through
  // recipe imports.
  const safeId = SAFE_ID_RE.test(String(raw.id || '')) ? String(raw.id) : _stepId();
  const step = { id: safeId, verb };
  if (raw.target != null) step.target = String(raw.target).slice(0, 500);
  if (raw.text != null) step.text = String(raw.text).slice(0, 2000);
  if (raw.notes != null) step.notes = String(raw.notes).slice(0, 500);
  // Cap REPEAT counts at validation time so a hostile or AI-generated recipe
  // can't pin the runner with REPEAT 1000000000.
  if (verb === 'REPEAT' && step.target) {
    const n = parseInt(step.target, 10);
    if (Number.isFinite(n) && n > MAX_REPEAT) step.target = String(MAX_REPEAT);
  }
  return step;
}

function _stepId() {
  return 's_' + Math.random().toString(36).slice(2, 10);
}

function _recipeId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function listRecipes(app) {
  return _load(app);
}

function getRecipe(app, id) {
  const data = _load(app);
  const r = data.recipes.find(x => x.id === id);
  return r || null;
}

function _validateInputs(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name || !/^[\w-]+$/.test(name)) continue;
    out.push({
      name,
      label: String(item.label || '').trim().slice(0, 120) || name,
      placeholder: String(item.placeholder || '').trim().slice(0, 200) || undefined,
      default: item.default != null ? String(item.default).slice(0, 500) : undefined,
      required: !!item.required,
    });
  }
  return out.length ? out : undefined;
}

function _validateVerify(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const elementsPresent = Array.isArray(raw.elementsPresent)
    ? raw.elementsPresent.map(s => String(s).slice(0, 300)).filter(Boolean) : [];
  const elementsAbsent = Array.isArray(raw.elementsAbsent)
    ? raw.elementsAbsent.map(s => String(s).slice(0, 300)).filter(Boolean) : [];
  if (!elementsPresent.length && !elementsAbsent.length) return undefined;
  return { elementsPresent, elementsAbsent };
}

function saveRecipe(app, recipe) {
  if (!recipe || !String(recipe.name || '').trim()) throw new Error('recipe name required');
  const steps = Array.isArray(recipe.steps) ? recipe.steps.map(_validateStep) : [];
  const inputs = _validateInputs(recipe.inputs);
  const verify = _validateVerify(recipe.verify);
  const now = new Date().toISOString();
  const data = _load(app);
  // Same id-safety rule as steps: only honour caller-supplied ids that are
  // safe for attribute interpolation.
  const id = SAFE_ID_RE.test(String(recipe.id || '')) ? String(recipe.id) : _recipeId();
  const existing = data.recipes.find(x => x.id === id);
  let captureRect;
  if (recipe.captureRect && typeof recipe.captureRect === 'object') {
    const w = parseInt(recipe.captureRect.w, 10);
    const h = parseInt(recipe.captureRect.h, 10);
    if (w > 0 && h > 0) captureRect = { w, h };
  }
  let windowPin;
  if (recipe.window && typeof recipe.window === 'object') {
    const w = parseInt(recipe.window.w, 10);
    const h = parseInt(recipe.window.h, 10);
    const x = recipe.window.x != null ? parseInt(recipe.window.x, 10) : undefined;
    const y = recipe.window.y != null ? parseInt(recipe.window.y, 10) : undefined;
    const maximized = !!recipe.window.maximized;
    if (maximized) windowPin = { maximized: true };
    else if (w > 0 && h > 0) windowPin = { w, h, x: Number.isFinite(x) ? x : undefined, y: Number.isFinite(y) ? y : undefined };
  }
  // Auto-recorded recipes start as 'draft'. Manually-saved recipes default
  // to 'verified'. The status drives the pre-session Mind query: only
  // verified recipes are auto-suggested for replay.
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
  const record = {
    id,
    name: String(recipe.name).trim().slice(0, 120),
    description: String(recipe.description || '').trim().slice(0, 1000) || undefined,
    variables: (recipe.variables && typeof recipe.variables === 'object') ? recipe.variables : undefined,
    inputs,
    verify,
    captureRect,
    window: windowPin,
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
  _write(app, data);
  return { ok: true, recipe: record, path: filePath(app) };
}

function deleteRecipe(app, id) {
  const data = _load(app);
  const idx = data.recipes.findIndex(x => x.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  data.recipes.splice(idx, 1);
  _write(app, data);
  return { ok: true };
}

// Bring a recipe in from an external JSON blob. Accepts either a single
// recipe object or an array of recipes; assigns fresh IDs to avoid clashes
// with anything already on disk. Returns { ok, imported: n }.
function importRecipes(app, payload) {
  if (!payload) throw new Error('no payload');
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.recipes) ? payload.recipes : [payload]);
  let imported = 0;
  for (const raw of list) {
    if (!raw || !raw.name) continue;
    saveRecipe(app, {
      id: undefined, // always assign a new id so imports don't overwrite
      name: raw.name,
      description: raw.description,
      variables: raw.variables,
      inputs: raw.inputs,
      verify: raw.verify,
      captureRect: raw.captureRect,
      window: raw.window,
      steps: raw.steps,
    });
    imported++;
  }
  return { ok: true, imported };
}

function exportRecipes(app, ids) {
  const data = _load(app);
  const filter = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const recipes = filter ? data.recipes.filter(r => filter.has(r.id)) : data.recipes;
  return { ok: true, app: data.app, exportedAt: new Date().toISOString(), recipes };
}

// Per-app run history. Small JSON file capped at 50 entries. Each entry is
// the outcome summary the runner emits on completion.
const HIST_DIR = path.join(__dirname, 'app-recipe-history');
const HIST_CAP = 50;

function _histPath(app) {
  return path.join(HIST_DIR, normalizeApp(app) + '.json');
}

function _loadHist(app) {
  try { fs.mkdirSync(HIST_DIR, { recursive: true }); } catch (_) {}
  const p = _histPath(app);
  if (!fs.existsSync(p)) return { app: normalizeApp(app), runs: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    if (!Array.isArray(data.runs)) data.runs = [];
    return { app: normalizeApp(app), runs: data.runs };
  } catch (_) {
    return { app: normalizeApp(app), runs: [] };
  }
}

function recordRun(app, entry) {
  const data = _loadHist(app);
  const rec = {
    id: 'h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    at: entry.at || new Date().toISOString(),
    recipeId: entry.recipeId || null,
    recipeName: entry.recipeName || null,
    outcome: entry.outcome || 'unknown',   // 'ok' | 'failed' | 'aborted'
    iterations: entry.iterations || 0,
    durationMs: entry.durationMs || 0,
    error: entry.error || null,
  };
  data.runs.unshift(rec);
  if (data.runs.length > HIST_CAP) data.runs.length = HIST_CAP;
  try { fs.writeFileSync(_histPath(app), JSON.stringify(data, null, 2), 'utf8'); } catch (_) {}
  return rec;
}

function listHistory(app) {
  return _loadHist(app);
}

// ─── Tests ─────────────────────────────────────────────────────────────
// A test references a recipe (macro), supplies inputs, and names the
// post-run assertions. Stored per-app in a second JSON file.
const TEST_DIR = path.join(__dirname, 'app-recipe-tests');

function _testsPath(app) {
  return path.join(TEST_DIR, normalizeApp(app) + '.json');
}

function _loadTests(app) {
  try { fs.mkdirSync(TEST_DIR, { recursive: true }); } catch (_) {}
  const p = _testsPath(app);
  if (!fs.existsSync(p)) return { app: normalizeApp(app), tests: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    if (!Array.isArray(data.tests)) data.tests = [];
    return { app: normalizeApp(app), tests: data.tests };
  } catch (_) {
    return { app: normalizeApp(app), tests: [] };
  }
}

function _writeTests(app, data) {
  try { fs.mkdirSync(TEST_DIR, { recursive: true }); } catch (_) {}
  fs.writeFileSync(_testsPath(app), JSON.stringify(data, null, 2), 'utf8');
}

function _validateTest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('test must be an object');
  const name = String(raw.name || '').trim();
  const macro = String(raw.macro || '').trim();
  if (!name) throw new Error('test name required');
  if (!macro) throw new Error('macro (recipe id) required');
  const inputs = (raw.inputs && typeof raw.inputs === 'object') ? raw.inputs : {};
  const expected = raw.expected && typeof raw.expected === 'object' ? raw.expected : {};
  const out = {
    name: name.slice(0, 120),
    macro: macro.slice(0, 120),
    inputs,
    expected: {
      outcome: ['ok', 'failed', 'aborted'].includes(expected.outcome) ? expected.outcome : 'ok',
      elementsPresent: Array.isArray(expected.elementsPresent)
        ? expected.elementsPresent.map(s => String(s).slice(0, 300)).filter(Boolean) : [],
      elementsAbsent: Array.isArray(expected.elementsAbsent)
        ? expected.elementsAbsent.map(s => String(s).slice(0, 300)).filter(Boolean) : [],
    },
  };
  return out;
}

function listTests(app) { return _loadTests(app); }
function getTest(app, id) {
  const { tests } = _loadTests(app);
  return tests.find(t => t.id === id) || null;
}
function saveTest(app, raw) {
  const v = _validateTest(raw);
  const data = _loadTests(app);
  const now = new Date().toISOString();
  const id = SAFE_ID_RE.test(String(raw.id || '')) ? String(raw.id) : ('t_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
  const existing = data.tests.find(t => t.id === id);
  const record = { id, ...v, createdAt: existing ? existing.createdAt : now, updatedAt: now };
  if (existing) {
    data.tests[data.tests.findIndex(t => t.id === id)] = record;
  } else {
    data.tests.push(record);
  }
  _writeTests(app, data);
  return { ok: true, test: record };
}
function deleteTest(app, id) {
  const data = _loadTests(app);
  const idx = data.tests.findIndex(t => t.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  data.tests.splice(idx, 1);
  _writeTests(app, data);
  return { ok: true };
}

// Convert the action log a chat session collected during a run into a
// concrete recipe. Clicks with hand-tuned coordinates stay as explicit
// "x,y" targets so playback is deterministic and doesn't need the vision
// locator; type/key/scroll/wait map 1:1 to DSL verbs.
// Encode a UIA selector as a single-line target string the recipe DSL can
// hold. Format: "uia:<key=val|key=val>" — name/type/id/class only. Ancestors
// are dropped here; recipes that need ancestor disambiguation can be edited
// to use the FIND/CLICK with notes after the fact.
function _encodeSelector(sel) {
  if (!sel || typeof sel !== 'object') return '';
  const parts = [];
  if (sel.id)    parts.push(`id=${sel.id}`);
  if (sel.name)  parts.push(`name=${sel.name}`);
  if (sel.type)  parts.push(`type=${sel.type}`);
  if (sel.class) parts.push(`class=${sel.class}`);
  return 'uia:' + parts.join('|');
}

function actionsToSteps(actions) {
  const out = [];
  for (const a of actions || []) {
    const name = a.name;
    const args = a.args || {};
    if (name === 'click' && Number.isFinite(args.x) && Number.isFinite(args.y)) {
      out.push({ verb: args.double ? 'DOUBLE_CLICK' : 'CLICK', target: `${args.x},${args.y}` });
    } else if (name === 'type_text' && typeof args.text === 'string') {
      out.push({ verb: 'TYPE', text: args.text });
    } else if (name === 'key' && typeof args.combo === 'string') {
      out.push({ verb: 'PRESS', target: args.combo });
    } else if (name === 'wait_ms' && Number.isFinite(args.ms)) {
      out.push({ verb: 'WAIT', target: String(Math.max(0, Math.min(60000, args.ms | 0))) });
    } else if (name === 'scroll') {
      const dy = Number.isFinite(args.dy) ? args.dy : 0;
      const dx = Number.isFinite(args.dx) ? args.dx : 0;
      out.push({ verb: 'SCROLL', target: `${dx},${dy}` });
    } else if (name === 'drag') {
      out.push({ verb: 'DRAG', target: `${args.fromX},${args.fromY}`, text: `${args.toX},${args.toY}` });
    } else if (name === 'click_element') {
      const t = _encodeSelector(args.selector);
      if (t) out.push({ verb: 'CLICK', target: t, notes: 'UIA' });
    } else if (name === 'type_into_element' && typeof args.text === 'string') {
      const t = _encodeSelector(args.selector);
      if (t) out.push({ verb: 'TYPE', target: t, text: args.text, notes: 'UIA' });
    } else if (name === 'wait_for_element') {
      const t = _encodeSelector(args.selector);
      if (t) out.push({ verb: 'WAIT_UNTIL', target: t, notes: `timeout ${args.timeoutMs || 5000}ms` });
    }
  }
  return out;
}

// Render a recipe into a plain-English goal string the agent can consume.
// Phase A implementation: the recipe becomes a hard subgoal plan injected
// as the user's initial goal, with an explicit "follow these steps in order,
// do not improvise" header. Phase B replaces this with a deterministic DSL
// runner; the JSON shape is forward-compatible.
function renderRecipeAsGoal(recipe) {
  if (!recipe) return '';
  const header = `Run the "${recipe.name}" automation. Follow these steps in order. Do NOT improvise or skip steps.`;
  const lines = recipe.steps.map((s, i) => {
    let line = `${i + 1}. ${s.verb}`;
    if (s.target) line += ` ${s.target}`;
    if (s.text) line += ` -> "${s.text}"`;
    if (s.notes) line += `   (${s.notes})`;
    return line;
  });
  const parts = [header];
  if (recipe.description) parts.push(`Context: ${recipe.description}`);
  parts.push('Steps:', ...lines);
  parts.push('', 'When every step is done, call finish with a one-sentence confirmation.');
  return parts.join('\n');
}

module.exports = {
  DIR,
  normalizeApp,
  listRecipes,
  getRecipe,
  saveRecipe,
  deleteRecipe,
  renderRecipeAsGoal,
  importRecipes,
  exportRecipes,
  recordRun,
  listHistory,
  actionsToSteps,
  listTests,
  getTest,
  saveTest,
  deleteTest,
};
