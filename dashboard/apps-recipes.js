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
  'CLICK', 'TYPE', 'PRESS', 'WAIT', 'FIND', 'VERIFY',
  // Control flow (Phase E):
  'IF', 'ELSE', 'ENDIF',
  'REPEAT', 'ENDREPEAT',
]);

function _validateStep(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('step must be an object');
  const verb = String(raw.verb || '').trim().toUpperCase();
  if (!ALLOWED_VERBS.has(verb)) throw new Error(`unknown verb "${raw.verb}". Allowed: ${[...ALLOWED_VERBS].join(', ')}.`);
  const step = { id: String(raw.id || _stepId()), verb };
  if (raw.target != null) step.target = String(raw.target).slice(0, 500);
  if (raw.text != null) step.text = String(raw.text).slice(0, 2000);
  if (raw.notes != null) step.notes = String(raw.notes).slice(0, 500);
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

function saveRecipe(app, recipe) {
  if (!recipe || !String(recipe.name || '').trim()) throw new Error('recipe name required');
  const steps = Array.isArray(recipe.steps) ? recipe.steps.map(_validateStep) : [];
  const now = new Date().toISOString();
  const data = _load(app);
  const id = recipe.id || _recipeId();
  const existing = data.recipes.find(x => x.id === id);
  const record = {
    id,
    name: String(recipe.name).trim().slice(0, 120),
    description: String(recipe.description || '').trim().slice(0, 1000) || undefined,
    variables: (recipe.variables && typeof recipe.variables === 'object') ? recipe.variables : undefined,
    steps,
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
  return { ok: true, recipe: record };
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

// Convert the action log a chat session collected during a run into a
// concrete recipe. Clicks with hand-tuned coordinates stay as explicit
// "x,y" targets so playback is deterministic and doesn't need the vision
// locator; type/key/scroll/wait map 1:1 to DSL verbs.
function actionsToSteps(actions) {
  const out = [];
  for (const a of actions || []) {
    const name = a.name;
    const args = a.args || {};
    if (name === 'click' && Number.isFinite(args.x) && Number.isFinite(args.y)) {
      out.push({ verb: 'CLICK', target: `${args.x},${args.y}` });
    } else if (name === 'type_text' && typeof args.text === 'string') {
      out.push({ verb: 'TYPE', text: args.text });
    } else if (name === 'key' && typeof args.combo === 'string') {
      out.push({ verb: 'PRESS', target: args.combo });
    } else if (name === 'wait_ms' && Number.isFinite(args.ms)) {
      out.push({ verb: 'WAIT', target: String(Math.max(0, Math.min(60000, args.ms | 0))) });
    } else if (name === 'scroll') {
      const dy = Number.isFinite(args.dy) ? args.dy : 0;
      const dx = Number.isFinite(args.dx) ? args.dx : 0;
      out.push({ verb: 'WAIT', target: '100', notes: `scroll dx=${dx} dy=${dy} (rewrite manually)` });
    } else if (name === 'drag') {
      out.push({ verb: 'CLICK', target: `${args.fromX},${args.fromY}`, notes: `drag from (${args.fromX},${args.fromY}) to (${args.toX},${args.toY}) - replay manually` });
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
};
