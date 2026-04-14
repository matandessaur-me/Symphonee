/**
 * DevOps Pilot -- Recipes
 *
 * A recipe is a single markdown file with YAML frontmatter that bundles
 * everything needed to run a recurring AI operation:
 *   - which CLI/model (or just an intent for the model router)
 *   - which plugins/MCP servers should be available
 *   - what permission mode to enforce during the run
 *   - typed inputs prompted at run time
 *   - a prompt template body with {{ inputs.X }} / {{ context.X }} substitution
 *   - optional outputs (save as note, etc.)
 *
 * Lives in `recipes/` at the repo root (project-local). Future: also
 * `~/.devops-pilot/recipes/` (user-global).
 *
 * No external deps: tiny YAML and tiny template renderer below.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_DIR = path.resolve(__dirname, '..', 'recipes');
const USER_DIR = path.join(require('os').homedir(), '.devops-pilot', 'recipes');

// ── Frontmatter parser (tiny YAML subset) ───────────────────────────────────
// Supports: scalars (string, number, bool), inline arrays [a, b, c], and
// indented block lists/objects. Quoted strings supported. Enough for recipe
// frontmatter; not a general YAML implementation.
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const fmText = raw.slice(3, end).replace(/^\n/, '');
  const body = raw.slice(end + 4).replace(/^\n/, '');
  return { meta: parseYamlBlock(fmText), body };
}

function parseYamlBlock(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  parseYamlLines(lines, 0, 0, root);
  return root;
}

function parseYamlLines(lines, idx, indent, target) {
  while (idx < lines.length) {
    const raw = lines[idx];
    if (!raw.trim() || raw.trim().startsWith('#')) { idx++; continue; }
    const curIndent = raw.match(/^ */)[0].length;
    if (curIndent < indent) return idx;
    const line = raw.slice(curIndent);
    // Block list under the parent key (handled by caller via array detection)
    if (line.startsWith('- ')) return idx;
    const colon = line.indexOf(':');
    if (colon < 0) { idx++; continue; }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (!rest) {
      // Block value: either array of objects (- name: ...) or nested map
      const next = lines[idx + 1] || '';
      const nextIndent = next.match(/^ */)[0].length;
      if (next.trimStart().startsWith('- ')) {
        const arr = [];
        idx = parseYamlList(lines, idx + 1, nextIndent, arr);
        target[key] = arr;
      } else if (nextIndent > curIndent) {
        const obj = {};
        idx = parseYamlLines(lines, idx + 1, nextIndent, obj);
        target[key] = obj;
      } else {
        target[key] = null;
        idx++;
      }
    } else {
      target[key] = parseScalar(rest);
      idx++;
    }
  }
  return idx;
}

function parseYamlList(lines, idx, indent, arr) {
  while (idx < lines.length) {
    const raw = lines[idx];
    if (!raw.trim()) { idx++; continue; }
    const curIndent = raw.match(/^ */)[0].length;
    if (curIndent < indent) return idx;
    const line = raw.slice(curIndent);
    if (!line.startsWith('- ')) return idx;
    const after = line.slice(2);
    const colon = after.indexOf(':');
    if (colon < 0) {
      arr.push(parseScalar(after.trim()));
      idx++;
    } else {
      // Object item; collect indented lines as a block
      const obj = {};
      const firstKey = after.slice(0, colon).trim();
      const firstVal = after.slice(colon + 1).trim();
      if (firstVal) obj[firstKey] = parseScalar(firstVal);
      else obj[firstKey] = null;
      idx++;
      // Continue gathering lines indented deeper than the dash
      const childIndent = curIndent + 2;
      while (idx < lines.length) {
        const r = lines[idx];
        if (!r.trim()) { idx++; continue; }
        const ci = r.match(/^ */)[0].length;
        if (ci < childIndent) break;
        const ln = r.slice(ci);
        if (ln.startsWith('- ')) break;
        const c = ln.indexOf(':');
        if (c < 0) { idx++; continue; }
        const k = ln.slice(0, c).trim();
        const v = ln.slice(c + 1).trim();
        obj[k] = parseScalar(v);
        idx++;
      }
      arr.push(obj);
    }
  }
  return idx;
}

function parseScalar(s) {
  if (s === '' || s == null) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  // Inline array: [a, b, "c"]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(x => parseScalar(x.trim()));
  }
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Number
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ── Template rendering ──────────────────────────────────────────────────────
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    try { return String(readPath(vars, expr) ?? ''); } catch (_) { return ''; }
  });
}

function readPath(obj, expr) {
  const parts = String(expr).split('.').map(s => s.trim()).filter(Boolean);
  let cur = obj;
  for (const part of parts) { if (cur == null) return undefined; cur = cur[part]; }
  return cur;
}

// ── Recipe loader ───────────────────────────────────────────────────────────
function listDirs() {
  const dirs = [];
  if (fs.existsSync(PROJECT_DIR)) dirs.push({ scope: 'project', dir: PROJECT_DIR });
  if (fs.existsSync(USER_DIR)) dirs.push({ scope: 'user', dir: USER_DIR });
  return dirs;
}

function listRecipes() {
  const out = [];
  const seen = new Set();
  for (const { scope, dir } of listDirs()) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      const id = f.replace(/\.md$/i, '');
      if (seen.has(id)) continue; // project-local wins over user-global
      seen.add(id);
      const r = loadRecipe(id, scope);
      if (r) out.push(r);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function loadRecipe(id, preferredScope = null) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  const candidates = preferredScope
    ? listDirs().filter(d => d.scope === preferredScope)
    : listDirs();
  for (const { scope, dir } of candidates) {
    const p = path.join(dir, safeId + '.md');
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      return {
        id: safeId,
        scope,
        path: p,
        name: meta.name || safeId,
        description: meta.description || '',
        icon: meta.icon || 'play',
        intent: meta.intent || null,
        cli: meta.cli || null,
        model: meta.model || null,
        mode: meta.mode || null,
        plugins: Array.isArray(meta.plugins) ? meta.plugins : [],
        mcpServers: Array.isArray(meta.mcpServers) ? meta.mcpServers : [],
        inputs: Array.isArray(meta.inputs) ? meta.inputs : [],
        outputs: Array.isArray(meta.outputs) ? meta.outputs : [],
        body,
        meta,
      };
    } catch (_) {}
  }
  return null;
}

// ── Run a recipe ────────────────────────────────────────────────────────────
async function runRecipe({ id, inputs, originTermId, apiHost = '127.0.0.1', apiPort = 3800 }) {
  const recipe = loadRecipe(id);
  if (!recipe) throw new Error(`Recipe not found: ${id}`);

  // Validate required inputs and apply defaults
  const finalInputs = {};
  for (const def of recipe.inputs) {
    let v = (inputs && Object.prototype.hasOwnProperty.call(inputs, def.name)) ? inputs[def.name] : undefined;
    if (v === undefined && def.default !== undefined) v = def.default;
    if ((v === undefined || v === '') && def.required) throw new Error(`Missing required input: ${def.name}`);
    finalInputs[def.name] = v;
  }

  // Fetch context for {{ context.* }} substitution
  const context = await apiGet(apiHost, apiPort, '/api/ui/context').catch(() => ({}));

  // Resolve inputs that have template defaults (e.g. "{{ context.selectedIterationName }}")
  for (const k of Object.keys(finalInputs)) {
    if (typeof finalInputs[k] === 'string' && finalInputs[k].includes('{{')) {
      finalInputs[k] = renderTemplate(finalInputs[k], { context, env: process.env, inputs: finalInputs });
    }
  }

  // Render the body with full var scope
  const prompt = renderTemplate(recipe.body, {
    context,
    env: process.env,
    inputs: finalInputs,
  }).trim();

  // Resolve cli/model: explicit > router via intent > default
  let cli = recipe.cli;
  let model = recipe.model;
  if (!cli && recipe.intent) {
    const rec = await apiPost(apiHost, apiPort, '/api/models/recommend', { intent: recipe.intent }).catch(() => null);
    if (rec && rec.cli) { cli = rec.cli; model = rec.model; }
  }
  if (!cli) cli = 'claude';

  // Spawn the worker. Note: this respects the active permission mode at the
  // server gate. We do NOT temporarily switch modes (that would be invisible
  // to the user and risky); the recipe's `mode` field is advisory in v1 and
  // shown in the UI so the user can switch the chip themselves.
  const spawnBody = {
    cli, model, prompt,
    from: originTermId || `recipe:${recipe.id}`,
    autoPermit: false,
  };
  const spawnRes = await apiPost(apiHost, apiPort, '/api/orchestrator/spawn', spawnBody);
  if (!spawnRes || !spawnRes.id) throw new Error(`spawn failed: ${JSON.stringify(spawnRes)}`);

  return {
    recipe: recipe.id,
    cli, model,
    taskId: spawnRes.id,
    inputs: finalInputs,
    promptPreview: prompt.slice(0, 400),
    advisedMode: recipe.mode,
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function apiGet(host, port, pathname) {
  return apiRequest(host, port, 'GET', pathname);
}
function apiPost(host, port, pathname, body) {
  return apiRequest(host, port, 'POST', pathname, body);
}
function apiRequest(host, port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host, port, path: pathname, method,
      headers: Object.assign({ Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { body: parsed }));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = {
  listRecipes, loadRecipe, runRecipe,
  parseFrontmatter, renderTemplate, // exported for tests
  PROJECT_DIR, USER_DIR,
};
