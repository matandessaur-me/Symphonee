/**
 * Symphonee — Node.js server
 * Serves the web UI, manages a persistent PTY terminal via WebSocket,
 * and provides Azure DevOps REST API proxy.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { exec, execSync, spawnSync } = require('child_process');

// ── New utility modules ────────────────────────────────────────────────────
const { gitAsync, gitSync } = require('./utils/git-async');
const { SWRCache } = require('./utils/swr-cache');
const { atomicWriteSync } = require('./utils/atomic-write');
const { BusyGuard } = require('./utils/busy-guard');

// Core-owned SWR caches. ADO/GitHub caches moved into their plugins in v0.4.0;
// core keeps git-branch cache + a general-purpose plugin cache.
const swrGit     = new SWRCache({ staleTTL: 10000, maxAge: 60000 });
const swrPlugins = new SWRCache({ staleTTL: 30000, maxAge: 300000 });
const guard      = new BusyGuard();

// Return plugin info when a /api/ path matches routes a known extracted plugin
// owns but no plugin currently has a handler registered. Lets core give a
// useful {pluginRequired} 404 instead of bare "Not found" when the plugin is
// uninstalled or inactive. Hardcoded to the two first-party extractions; add
// future plugin prefixes here as needed.
const EXTRACTED_PLUGIN_ROUTES = [
  { pluginId: 'azure-devops', pluginName: 'Azure DevOps', prefix: /^\/api\/(workitems|iterations|teams|areas|velocity|burndown|start-working|team-members)(?:\/|$|\?)/ },
  { pluginId: 'github',       pluginName: 'GitHub',       prefix: /^\/api\/(github\/|pull-request(?:$|\?))/ },
];
function matchUnclaimedPluginRoute(pathname, plugins) {
  for (const spec of EXTRACTED_PLUGIN_ROUTES) {
    if (!spec.prefix.test(pathname)) continue;
    const installed = Array.isArray(plugins) && plugins.some(p => p.id === spec.pluginId);
    return { pluginId: spec.pluginId, pluginName: spec.pluginName, installed };
  }
  return null;
}

// Strip non-ASCII control chars, smart quotes, and replacement characters.
// Generic text hygiene shared by core and plugins via ctx.shell.
function sanitizeText(str) {
  if (!str) return str;
  return str
    .replace(/[\u2014]/g, '--')
    .replace(/[\u2013]/g, '-')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[\uFFFD\uFFFE\uFFFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .trim();
}

const PORT = 3800;
const HOST = '127.0.0.1';
const repoRoot = path.resolve(__dirname, '..');

const publicDir = path.join(__dirname, 'public');
const nodeModules = path.join(repoRoot, 'node_modules');
const configPath = path.join(repoRoot, 'config', 'config.json');
const templatePath = path.join(repoRoot, 'config', 'config.template.json');

// ── Static file routes ─────────────────────────────────────────────────────
const ROUTES = {
  '/':                        { file: path.join(publicDir, 'index.html'),                                          type: 'text/html' },
  '/xterm.css':               { file: path.join(nodeModules, '@xterm/xterm/css/xterm.css'),                          type: 'text/css' },
  '/xterm.js':                { file: path.join(nodeModules, '@xterm/xterm/lib/xterm.js'),                           type: 'application/javascript' },
  '/xterm-addon-fit.js':      { file: path.join(nodeModules, '@xterm/addon-fit/lib/addon-fit.js'),                   type: 'application/javascript' },
  '/xterm-addon-webgl.js':    { file: path.join(nodeModules, '@xterm/addon-webgl/lib/addon-webgl.js'),               type: 'application/javascript' },
  '/xterm-addon-web-links.js':{ file: path.join(nodeModules, '@xterm/addon-web-links/lib/addon-web-links.js'),       type: 'application/javascript' },
  '/xterm-addon-unicode11.js':{ file: path.join(nodeModules, '@xterm/addon-unicode11/lib/addon-unicode11.js'),       type: 'application/javascript' },
  '/logo.svg':                { file: path.join(publicDir, 'logo.svg'),                                            type: 'image/svg+xml' },
  '/contributions-client.js': { file: path.join(publicDir, 'contributions-client.js'),                             type: 'application/javascript' },
};

// ── Pluggable route handlers (Electron adds its own via addRoute) ────────────
const extraRoutes = [];
function addRoute(method, pathname, handler) {
  extraRoutes.push({ method: method.toUpperCase(), pathname, handler });
}

// ── Plugin system ────────────────────────────────────────────────────────────
const { loadPlugins, checkActivation } = require('./plugin-loader');
const pluginsDir = path.join(__dirname, 'plugins');
let loadedPlugins = [];

// ── Orchestrator (cross-AI communication bus) ────────────────────────────────
const { mountOrchestrator } = require('./orchestrator');
const permissions = require('./permissions');
const { MCPClientManager } = require('./mcp-client');
const mcpClient = new MCPClientManager({ configPath });
mcpClient.bootstrap().catch(e => console.warn('  [mcp-client] bootstrap error:', e.message));
const { GraphRunsEngine } = require('./graph-runs');
const graphRuns = new GraphRunsEngine({
  repoRoot,
  injectToTerminal: (termId, text) => {
    const t = terminals.get(termId);
    if (t && t.pty) try { t.pty.write(text); } catch (_) {}
  },
});
const modelRouter = require('./model-router');
const recipes = require('./recipes');
const { HybridSearchEngine } = require('./hybrid-search');
const { buildRepoMap } = require('./repo-map');
const hybridSearch = new HybridSearchEngine({ repoRoot });

// Render input.default templates so the UI sees evaluated values
// instead of raw {{ context.selectedIterationName }} placeholders.
function withRenderedDefaults(recipe, ctx) {
  if (!recipe || !Array.isArray(recipe.inputs)) return recipe;
  const renderedInputs = recipe.inputs.map(i => {
    if (typeof i.default !== 'string' || !i.default.includes('{{')) return i;
    try {
      const rendered = recipes.renderTemplate(i.default, { context: ctx });
      return { ...i, default: rendered, defaultTemplate: i.default };
    } catch (_) { return i; }
  });
  return { ...recipe, inputs: renderedInputs };
}

async function permGate(res, type, value, label) {
  return permissions.gate(res, { type, value }, { configPath, actionLabel: label });
}

// ── Learnings (collective intelligence) ──────────────────────────────────────
const { mountLearnings } = require('./learnings');
let _learningsInstance = null;

// ── Helper: read JSON body ────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Helper: JSON response ─────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Pluggable routes first
  for (const r of extraRoutes) {
    // Exact match for normal routes, prefix match for plugin static files and plugin API prefixes
    if (r.pathname === '/__plugin_static__') {
      if (url.pathname.startsWith('/plugins/') && req.method === 'GET') {
        const result = r.handler(req, res, url);
        if (result !== false) return;
      }
    } else if (r.method === '__PREFIX__') {
      if (url.pathname.startsWith(r.pathname + '/') || url.pathname === r.pathname) {
        const subpath = url.pathname.slice(r.pathname.length) || '/';
        const result = r.handler(req, res, url, subpath);
        // Async prefix handlers return a Promise; await it so a Promise<false>
        // correctly falls through to the next route instead of being treated
        // as "handled" just because the Promise is truthy.
        if (result && typeof result.then === 'function') {
          const resolved = await result;
          if (resolved !== false) return;
        } else if (result !== false) {
          return;
        }
      }
    } else if (url.pathname === r.pathname && req.method === r.method) {
      return r.handler(req, res, url);
    }
  }

  try {
    // ── Config ────────────────────────────────────────────────────────────
    if (url.pathname === '/api/config' && req.method === 'GET')  return handleGetConfig(res);
    if (url.pathname === '/api/config' && req.method === 'POST') return handleSaveConfig(req, res);
    if (url.pathname === '/api/config/export' && req.method === 'GET')  return handleExportConfig(res);
    if (url.pathname === '/api/config/import' && req.method === 'POST') return handleImportConfig(req, res);
    if (url.pathname === '/api/config/reset' && req.method === 'POST')  return handleFactoryReset(req, res);
    if (url.pathname === '/api/themes' && req.method === 'GET')  return handleGetThemes(res);
    if (url.pathname === '/api/themes' && req.method === 'POST') return handleSaveThemes(req, res);

    // ── Model Router ──────────────────────────────────────────────────────
    if (url.pathname === '/api/models/catalog' && req.method === 'GET') {
      return json(res, modelRouter.publicCatalog(configPath));
    }
    if (url.pathname === '/api/models/recommend' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, modelRouter.recommend({ ...body, configPath }));
    }

    // ── Recipes ───────────────────────────────────────────────────────────
    if (url.pathname === '/api/recipes' && req.method === 'GET') {
      const ctx = getUiContextWithPath();
      return json(res, recipes.listRecipes().map(r => withRenderedDefaults(r, ctx)));
    }
    const recipeMatch = url.pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (recipeMatch && req.method === 'GET') {
      const r = recipes.loadRecipe(decodeURIComponent(recipeMatch[1]));
      if (!r) return json(res, { error: 'recipe not found' }, 404);
      return json(res, withRenderedDefaults(r, getUiContextWithPath()));
    }
    if (url.pathname === '/api/recipes/save' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!id) return json(res, { error: 'id required' }, 400);
      // User-authored recipes live in ~/.symphonee/recipes/ so they stay
      // machine-local and never get committed alongside the shipped recipes.
      const userRecipesDir = path.join(require('os').homedir(), '.symphonee', 'recipes');
      const shippedFile = path.join(repoRoot, 'recipes', id + '.md');
      const file = path.join(userRecipesDir, id + '.md');
      const alreadyExists = fs.existsSync(file) || fs.existsSync(shippedFile);
      if (alreadyExists && !body.overwrite) {
        return json(res, { error: `A recipe with id '${id}' already exists. Pass overwrite:true to replace it.`, exists: true }, 409);
      }
      if (!await permGate(res, 'api', 'POST /api/recipes/save', `${body.overwrite ? 'Update' : 'Save'} recipe: ${id}`)) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fm = body.frontmatter || {};
        const lines = ['---'];
        const order = ['name', 'description', 'icon', 'intent', 'cli', 'model', 'mode', 'dispatch', 'plugins', 'mcpServers', 'inputs'];
        for (const k of order) {
          if (fm[k] === undefined || fm[k] === null || fm[k] === '') continue;
          if (Array.isArray(fm[k])) {
            if (k === 'inputs') {
              lines.push('inputs:');
              for (const it of fm[k]) {
                lines.push('  - name: ' + it.name);
                if (it.type) lines.push('    type: ' + it.type);
                if (it.description) lines.push('    description: ' + JSON.stringify(it.description));
                if (it.default !== undefined && it.default !== '') lines.push('    default: ' + JSON.stringify(String(it.default)));
                if (it.required) lines.push('    required: true');
              }
            } else {
              lines.push(k + ': [' + fm[k].map(v => JSON.stringify(v)).join(', ') + ']');
            }
          } else if (typeof fm[k] === 'boolean') {
            lines.push(k + ': ' + (fm[k] ? 'true' : 'false'));
          } else {
            lines.push(k + ': ' + (typeof fm[k] === 'string' && /[:#'"\\\[\]\{\}]/.test(fm[k]) ? JSON.stringify(fm[k]) : fm[k]));
          }
        }
        lines.push('---');
        const content = lines.join('\n') + '\n\n' + (body.body || '').replace(/\r\n/g, '\n');
        fs.writeFileSync(file, content, 'utf8');
        return json(res, { ok: true, id, path: file });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }
    if (url.pathname === '/api/recipes/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!id) return json(res, { error: 'id required' }, 400);
      const recipe = recipes.loadRecipe(id);
      if (!recipe) return json(res, { error: 'recipe not found' }, 404);
      try {
        const ctx = getUiContextWithPath();
        const finalInputs = {};
        for (const def of (recipe.inputs || [])) {
          let v = (body.inputs && Object.prototype.hasOwnProperty.call(body.inputs, def.name)) ? body.inputs[def.name] : undefined;
          if (v === undefined && def.default !== undefined) v = def.default;
          if (typeof v === 'string' && v.includes('{{')) {
            v = recipes.renderTemplate(v, { context: ctx });
          }
          finalInputs[def.name] = v;
        }
        const rendered = recipes.renderTemplate(recipe.body, { context: ctx, env: process.env, inputs: finalInputs });
        return json(res, { id, inputs: finalInputs, prompt: rendered.trim() });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }
    const recipeDelMatch = url.pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (recipeDelMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(recipeDelMatch[1]).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!id) return json(res, { error: 'id required' }, 400);
      if (!await permGate(res, 'api', `DELETE /api/recipes/${id}`, `Delete recipe: ${id}`)) return;
      try {
        // Prefer the user-scoped file; only shipped recipes should be in the
        // repo folder, and we refuse to delete those here.
        const userFile = path.join(require('os').homedir(), '.symphonee', 'recipes', id + '.md');
        const repoFile = path.join(repoRoot, 'recipes', id + '.md');
        if (fs.existsSync(userFile)) {
          fs.unlinkSync(userFile);
          return json(res, { ok: true, id, scope: 'user' });
        }
        if (fs.existsSync(repoFile)) {
          return json(res, { error: 'Shipped recipes cannot be deleted from the UI.' }, 403);
        }
        return json(res, { error: 'not found' }, 404);
      } catch (e) { return json(res, { error: e.message }, 500); }
    }
    if (url.pathname === '/api/recipes/run' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return json(res, { error: 'id required' }, 400);
      if (!await permGate(res, 'api', 'POST /api/recipes/run', `Run recipe: ${body.id}`)) return;
      try {
        return json(res, await recipes.runRecipe({
          ...body,
          injectToTerminal: (termId, text) => {
            const t = terminals.get(termId);
            if (t && t.pty) try { t.pty.write(text); } catch (_) {}
          },
        }));
      } catch (e) { return json(res, { error: e.message }, 400); }
    }
    // ── Hybrid Search ─────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/search')) {
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const kindsParam = url.searchParams.get('kinds') || '';
        const kinds = kindsParam ? kindsParam.split(',').map(s => s.trim()).filter(Boolean) : null;
        const ns = url.searchParams.get('ns') || null;
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        return json(res, { query: q, kinds, ns, results: hybridSearch.search(q, { kinds, ns, limit }) });
      }
      if (url.pathname === '/api/search/reindex' && req.method === 'POST') {
        try { return json(res, await hybridSearch.reindex()); }
        catch (e) { return json(res, { error: e.message }, 500); }
      }
      if (url.pathname === '/api/search/stats' && req.method === 'GET') {
        return json(res, { docs: hybridSearch.totalDocs, terms: hybridSearch.invertedIndex.size, avgDocLength: Math.round(hybridSearch.avgDocLength) });
      }
    }

    // ── Plugin recommendations (local git remote detection, no network) ───
    if (url.pathname === '/api/plugins/recommendations' && req.method === 'GET') {
      return json(res, getPluginRecommendations());
    }

    // ── Repo Map (always available) ──────────────────────────────────────
    if (url.pathname === '/api/repo/map' && req.method === 'GET') {
      const repoName = url.searchParams.get('repo') || (getUiContextWithPath().activeRepo);
      const budget = parseInt(url.searchParams.get('budget') || '4000', 10);
      const cfg = getConfig();
      const repoPath = (cfg.Repos || {})[repoName];
      if (!repoPath) return json(res, { error: `Repo '${repoName}' not configured` }, 400);
      try {
        const md = await buildRepoMap({ repoPath, repoName, budget });
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(md);
        return;
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    if (url.pathname === '/api/ui/open-path' && req.method === 'POST') {
      const body = await readBody(req);
      const safe = String(body.path || '').replace(/\.\./g, '');
      // scope: 'repo' (default) joins with repoRoot; 'home' joins with the user home dir.
      const scope = body.scope === 'home' ? 'home' : 'repo';
      const rootDir = scope === 'home' ? require('os').homedir() : repoRoot;
      const target = path.join(rootDir, safe);
      try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
      const opener = process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      try { spawnSync(opener, [target], { detached: true, stdio: 'ignore' }); return json(res, { ok: true, path: target }); }
      catch (e) { return json(res, { error: e.message }, 500); }
    }

    // Reveal a specific file in the OS file explorer (highlighted).
    //   { type: 'note', name }      -> notes/<name>.md
    //   { type: 'file', repo, path} -> <configured repo path>/<path>
    if (url.pathname === '/api/ui/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      const type = body.type;
      let target = null;
      if (type === 'note') {
        const name = String(body.name || '').replace(/\.\./g, '');
        if (!name) return json(res, { error: 'name required' }, 400);
        const candidate = path.join(notesDir, name.endsWith('.md') ? name : name + '.md');
        if (!path.resolve(candidate).startsWith(path.resolve(notesDir))) return json(res, { error: 'Invalid path' }, 403);
        target = candidate;
      } else if (type === 'file') {
        const repoName = String(body.repo || '').trim();
        const rel = String(body.path || '').replace(/\.\./g, '');
        const cfg = getConfig();
        const repoPath = (cfg.Repos || {})[repoName];
        if (!repoPath) return json(res, { error: `Repo '${repoName}' not configured` }, 400);
        const candidate = rel ? path.join(repoPath, rel) : repoPath;
        if (!path.resolve(candidate).startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);
        target = candidate;
      } else {
        return json(res, { error: "type must be 'note' or 'file'" }, 400);
      }
      if (!fs.existsSync(target)) return json(res, { error: 'Path does not exist: ' + target }, 404);
      try {
        const isDir = fs.statSync(target).isDirectory();
        if (process.platform === 'win32') {
          if (isDir) spawnSync('explorer.exe', [target], { detached: true, stdio: 'ignore' });
          else spawnSync('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' });
        } else if (process.platform === 'darwin') {
          if (isDir) spawnSync('open', [target], { detached: true, stdio: 'ignore' });
          else spawnSync('open', ['-R', target], { detached: true, stdio: 'ignore' });
        } else {
          const folder = isDir ? target : path.dirname(target);
          spawnSync('xdg-open', [folder], { detached: true, stdio: 'ignore' });
        }
        return json(res, { ok: true, path: target });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Permissions ────────────────────────────────────────────────────────
    if (url.pathname === '/api/permissions' && req.method === 'GET') {
      return json(res, { settings: permissions.loadSettings(configPath), modes: permissions.MODES, defaults: permissions.MODE_DEFAULTS });
    }
    if (url.pathname === '/api/permissions' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, permissions.saveSettings(configPath, body));
    }
    if (url.pathname === '/api/permissions/mode' && req.method === 'POST') {
      const body = await readBody(req);
      if (!permissions.MODES.includes(body.mode)) return json(res, { error: 'invalid mode' }, 400);
      return json(res, permissions.saveSettings(configPath, { mode: body.mode }));
    }
    if (url.pathname === '/api/permissions/evaluate' && req.method === 'POST') {
      const body = await readBody(req);
      const settings = permissions.loadSettings(configPath);
      return json(res, permissions.evaluate(body.action || {}, settings, body.ctx || {}));
    }
    if (url.pathname === '/api/permissions/promote' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.rule) return json(res, { error: 'rule required' }, 400);
      return json(res, permissions.promoteRule(configPath, body.rule, body.bucket || 'allow'));
    }
    if (url.pathname === '/api/permissions/pending' && req.method === 'GET') {
      return json(res, permissions.listPending());
    }
    if (url.pathname === '/api/permissions/resolve' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = permissions.resolveApproval(body.id, body.decision, !!body.promote);
      return json(res, { ok });
    }

    // ── MCP client (external servers) ──────────────────────────────────────
    if (url.pathname === '/api/mcp/servers' && req.method === 'GET') {
      return json(res, mcpClient.listServers());
    }
    if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, await mcpClient.addServer(body)); }
      catch (e) { return json(res, { error: e.message }, 400); }
    }
    const mcpServerMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
    if (mcpServerMatch && req.method === 'DELETE') {
      return json(res, await mcpClient.removeServer(decodeURIComponent(mcpServerMatch[1])));
    }
    const mcpToggleMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/enabled$/);
    if (mcpToggleMatch && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, await mcpClient.setEnabled(decodeURIComponent(mcpToggleMatch[1]), !!body.enabled)); }
      catch (e) { return json(res, { error: e.message }, 400); }
    }
    const mcpRefreshMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/refresh$/);
    if (mcpRefreshMatch && req.method === 'POST') {
      try { return json(res, await mcpClient.refresh(decodeURIComponent(mcpRefreshMatch[1]))); }
      catch (e) { return json(res, { error: e.message }, 400); }
    }
    // ── Graph Runs ────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/graph-runs')) {
      if (url.pathname === '/api/graph-runs' && req.method === 'GET') {
        return json(res, graphRuns.listRuns());
      }
      if (url.pathname === '/api/graph-runs/pending-approvals' && req.method === 'GET') {
        return json(res, graphRuns.listPendingApprovals());
      }
      if (url.pathname === '/api/graph-runs' && req.method === 'POST') {
        const body = await readBody(req);
        if (!await permGate(res, 'api', 'POST /api/graph-runs', `Start graph run: ${body.name || 'unnamed'}`)) return;
        try { return json(res, await graphRuns.createRun(body)); }
        catch (e) { return json(res, { error: e.message }, 400); }
      }
      const grMatch = url.pathname.match(/^\/api\/graph-runs\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (grMatch) {
        const [_, runId, action, nodeId] = grMatch;
        if (!action && req.method === 'GET') {
          const run = graphRuns.getRun(runId);
          if (!run) return json(res, { error: 'not found' }, 404);
          return json(res, run);
        }
        if (action === 'pause' && req.method === 'POST') {
          try { return json(res, graphRuns.pauseRun(runId)); } catch (e) { return json(res, { error: e.message }, 400); }
        }
        if (action === 'resume' && req.method === 'POST') {
          try { return json(res, await graphRuns.resumeRun(runId)); } catch (e) { return json(res, { error: e.message }, 400); }
        }
        if (action === 'cancel' && req.method === 'POST') {
          try { return json(res, graphRuns.cancelRun(runId)); } catch (e) { return json(res, { error: e.message }, 400); }
        }
        if (action === 'interrupt' && req.method === 'POST') {
          const body = await readBody(req);
          try { return json(res, graphRuns.updateState(runId, body.patch || {})); } catch (e) { return json(res, { error: e.message }, 400); }
        }
        if (action === 'approve' && nodeId && req.method === 'POST') {
          const body = await readBody(req);
          try { return json(res, graphRuns.approveNode(runId, nodeId, body)); } catch (e) { return json(res, { error: e.message }, 400); }
        }
      }
      return json(res, { error: 'graph-runs: route not found' }, 404);
    }

    if (url.pathname === '/api/mcp/call' && req.method === 'POST') {
      const body = await readBody(req);
      if (!await permGate(res, 'api', 'POST /api/mcp/call', `Call MCP tool ${body.server}/${body.tool}`)) return;
      try {
        if (body.kind === 'resource') return json(res, await mcpClient.readResource(body.server, body.uri));
        if (body.kind === 'prompt') return json(res, await mcpClient.getPrompt(body.server, body.name, body.arguments));
        return json(res, await mcpClient.callTool(body.server, body.tool, body.arguments));
      } catch (e) { return json(res, { error: e.message }, 500); }
    }
    if (url.pathname === '/api/prerequisites')                   return handlePrerequisites(res);
    if (url.pathname === '/api/cli/install' && req.method === 'POST') return handleCliInstall(req, res);

    // ── Repos ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/repos' && req.method === 'GET')  return handleGetRepos(res);
    if (url.pathname === '/api/repos' && req.method === 'POST') return handleSaveRepo(req, res);
    // Spaces: non-git workspaces (Personal, Business, Freelance, ...). Stored
    // like repos but flagged so the UI hides git actions. Live at a separate
    // route so existing repo consumers are unaffected.
    if (url.pathname === '/api/spaces' && req.method === 'GET')  return handleGetSpaces(res);
    if (url.pathname === '/api/spaces' && req.method === 'POST') return handleSaveSpace(req, res);
    if (url.pathname === '/api/spaces' && req.method === 'DELETE') return handleDeleteSpace(req, res);
    if (url.pathname === '/api/spaces/attach-repo' && req.method === 'POST') return handleSpaceAttachRepo(req, res);
    if (url.pathname === '/api/spaces/toggle-plugin' && req.method === 'POST') return handleSpaceTogglePlugin(req, res);
    if (url.pathname === '/api/skills' && req.method === 'GET')  return handleGetSkills(res);
    if (url.pathname.startsWith('/api/skills/') && req.method === 'GET') {
      const slug = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
      return handleGetSkill(res, slug);
    }

    // Azure DevOps routes (/api/workitems/*, /api/iterations, /api/teams,
    // /api/areas, /api/velocity, /api/burndown, /api/team-members,
    // /api/start-working) are fully owned by the azure-devops plugin as
    // of v0.4.0 -- registered via ctx.addAbsoluteRoute against the same
    // URLs. Same story for GitHub (/api/github/*, /api/pull-request):
    // owned by the github plugin v0.4.0. When a plugin is uninstalled or
    // unconfigured, the route 404s naturally because no handler is
    // registered -- no explicit gate needed in core.

    // ── Notes ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/notes' && req.method === 'GET')    return handleListNotes(url, res);
    if (url.pathname === '/api/notes/read' && req.method === 'GET') return handleReadNote(url, res);
    if (url.pathname === '/api/notes/save' && req.method === 'POST') return handleSaveNote(req, res);
    if (url.pathname === '/api/notes/delete' && req.method === 'DELETE') return handleDeleteNote(req, res);
    if (url.pathname === '/api/notes/create' && req.method === 'POST') return handleCreateNote(req, res);
    if (url.pathname === '/api/notes/export' && req.method === 'GET')  return handleExportNote(url, res);
    if (url.pathname === '/api/notes/export-all' && req.method === 'GET') return handleExportAllNotes(res);
    if (url.pathname === '/api/notes/import' && req.method === 'POST')  return handleImportNotes(req, res);

    // ── File Browser & Git ─────────────────────────────────────────────────
    if (url.pathname === '/api/files/tree' && req.method === 'GET')    return handleFileTree(url, res);
    if (url.pathname === '/api/files/read' && req.method === 'GET')    return handleFileRead(url, res);
    if (url.pathname === '/api/files/save' && req.method === 'POST')   return handleFileSave(req, res);
    if (url.pathname === '/api/git/status' && req.method === 'GET')    return handleGitStatus(url, res);
    if (url.pathname === '/api/git/diff' && req.method === 'GET')      return handleGitDiff(url, res);
    if (url.pathname === '/api/git/branches' && req.method === 'GET')  return handleGitBranches(url, res);
    if (url.pathname === '/api/git/log' && req.method === 'GET')       return handleGitLog(url, res);
    if (url.pathname === '/api/git/commit-diff' && req.method === 'GET') return handleCommitDiff(url, res);
    if (url.pathname === '/api/git/checkout' && req.method === 'POST')  return handleGitCheckout(req, res);
    if (url.pathname === '/api/git/pull' && req.method === 'POST') {
      if (incognitoGuard(res, 'git pull')) return; return handleGitPull(req, res);
    }
    if (url.pathname === '/api/git/push' && req.method === 'POST') {
      if (incognitoGuard(res, 'git push')) return; return handleGitPush(req, res);
    }
    if (url.pathname === '/api/git/fetch' && req.method === 'POST') {
      if (incognitoGuard(res, 'git fetch')) return; return handleGitFetch(req, res);
    }
    if (url.pathname === '/api/git/discard' && req.method === 'POST')   return handleGitDiscard(req, res);

    // ── Split Diff ────────────────────────────────────────────────────────
    if (url.pathname === '/api/git/split-diff' && req.method === 'GET') return handleSplitDiff(url, res);

    // ── Project Scripts (package.json) ──────────────────────────────────────
    if (url.pathname === '/api/project/scripts' && req.method === 'GET') return handleProjectScripts(url, res);

    // ── File Search ────────────────────────────────────────────────────────
    if (url.pathname === '/api/files/search' && req.method === 'GET') return handleFileSearch(url, res);
    if (url.pathname === '/api/files/grep' && req.method === 'GET')   return handleFileGrep(url, res);

    // ── Serve repo files (images, etc.) ────────────────────────────────────
    if (url.pathname === '/api/files/serve' && req.method === 'GET') return handleServeFile(url, res);

    // ── Voice-to-Text (OpenAI Whisper) ────────────────────────────────────
    if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') return handleVoiceTranscribe(req, res);

    // ── Image Proxy (ADO images need auth) ─────────────────────────────────
    if (url.pathname === '/api/image-proxy' && req.method === 'GET') return handleImageProxy(url, res);

    // ── Open External URL ─────────────────────────────────────────────────
    if (url.pathname === '/api/open-external' && req.method === 'POST') return handleOpenExternal(req, res);

    // ── UI Actions (AI → Dashboard) ───────────────────────────────────────
    if (url.pathname === '/api/ui/tab' && req.method === 'POST')              return handleUiAction(req, res, 'switch-tab');
    if (url.pathname === '/api/ui/view-workitem' && req.method === 'POST')  return handleUiAction(req, res, 'view-workitem');
    if (url.pathname === '/api/ui/view-note' && req.method === 'POST')      return handleUiAction(req, res, 'view-note');
    if (url.pathname === '/api/ui/refresh-workitems' && req.method === 'POST') return handleUiAction(req, res, 'refresh-workitems');
    if (url.pathname === '/api/ui/view-file' && req.method === 'POST')       return handleUiAction(req, res, 'view-file');
    if (url.pathname === '/api/ui/view-diff' && req.method === 'POST')       return handleUiAction(req, res, 'view-diff');
    if (url.pathname === '/api/ui/view-commit-diff' && req.method === 'POST') return handleUiAction(req, res, 'view-commit-diff');
    if (url.pathname === '/api/ui/view-activity' && req.method === 'POST')   return handleUiAction(req, res, 'view-activity');
    if (url.pathname === '/api/ui/view-pr' && req.method === 'POST')       return handleUiAction(req, res, 'view-pr');
    if (url.pathname === '/api/ui/view-plugin' && req.method === 'POST')   return handleUiAction(req, res, 'view-plugin');
    if (url.pathname === '/api/ui/context' && req.method === 'GET')         return json(res, getUiContextWithPath());
    if (url.pathname === '/api/ui/context' && req.method === 'POST')        return handleUiContextUpdate(req, res);
    if (url.pathname === '/api/ui/mutate' && req.method === 'POST')         return handleUiMutate(req, res);
    if (url.pathname === '/api/application-state/focus' && req.method === 'GET')  return json(res, _getFocusState());
    if (url.pathname === '/api/application-state/focus' && req.method === 'POST') return handleFocusUpdate(req, res);
    // Generic key-value application-state store. Key is the last path segment.
    // Pattern from agent-native: UI writes 'navigation' on every route change,
    // AI writes 'navigate' as a one-shot command. GET reads; PUT sets;
    // DELETE clears. Also supports GET /api/application-state (listing).
    if (url.pathname === '/api/application-state' && req.method === 'GET') {
      return json(res, _appStateStore);
    }
    if (url.pathname.startsWith('/api/application-state/') && req.method === 'GET') {
      const key = decodeURIComponent(url.pathname.slice('/api/application-state/'.length));
      if (!key) return json(res, { error: 'key required' }, 400);
      return json(res, { key, value: _appStateStore[key] !== undefined ? _appStateStore[key] : null });
    }
    if (url.pathname.startsWith('/api/application-state/') && req.method === 'PUT') {
      const key = decodeURIComponent(url.pathname.slice('/api/application-state/'.length));
      if (!key || key === 'focus') return json(res, { error: key ? 'reserved key' : 'key required' }, 400);
      return handleAppStateWrite(req, res, key);
    }
    if (url.pathname.startsWith('/api/application-state/') && req.method === 'DELETE') {
      const key = decodeURIComponent(url.pathname.slice('/api/application-state/'.length));
      if (!key || key === 'focus') return json(res, { error: key ? 'reserved key' : 'key required' }, 400);
      delete _appStateStore[key];
      broadcast({ type: 'app-state-set', key, value: null });
      return json(res, { ok: true, key });
    }

    // ── Bootstrap: one call returns everything an AI CLI needs to start ─
    // The instructions tell every CLI (Claude, Gemini, Codex, Copilot, Grok)
    // to call this once at the start of a session. Returns a checksum the
    // CLI is required to echo in its first reply so we can verify it
    // actually bootstrapped.
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
      try {
        const context = getUiContextWithPath();
        const cfg = getConfig();
        const permissionsData = { settings: permissions.loadSettings(configPath), modes: permissions.MODES };
        // Reuse the instructions builder by calling the route handler logic inline.
        // Simpler: read all files in dashboard/instructions/ same way /api/instructions does.
        const instrDir = path.join(__dirname, 'instructions');
        let instructions = '';
        try {
          const priorityOrder = ['workflows.md', 'orchestrator.md', 'api-reference.md'];
          const files = fs.readdirSync(instrDir).filter(f => f.endsWith('.md')).sort((a, b) => {
            const ai = priorityOrder.indexOf(a), bi = priorityOrder.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
          });
          // Core instructions are fully plugin-agnostic. Per-plugin guidance
          // (work-item linking, PR creation, CMS flows, etc.) lives in each
          // plugin's own instructions.md and is fetched via
          // /api/plugins/instructions on demand, keeping the core payload
          // identical regardless of which plugins the user has installed.
          instructions = files.map(f => fs.readFileSync(path.join(instrDir, f), 'utf8')).join('\n\n---\n\n');
        } catch (_) {}
        // Plugins: lightweight index (full instructions remain at /api/plugins/instructions)
        const plugins = (loadedPlugins || []).map(p => ({
          id: p.id, name: p.name, description: p.description || '',
          keywords: p.aiKeywords || [],
        }));
        // Learnings: full list, AI must scan
        const learnings = _learningsInstance ? _learningsInstance.list() : [];
        // Compose payload
        const payload = {
          context, instructions, plugins, learnings, permissions: permissionsData,
          loadedAt: new Date().toISOString(),
          features: {
            orchestrateMode: true,
            graphRunsMode: true,
            incognitoMode: cfg.IncognitoMode === true,
          },
        };
        // Checksum: short hash so the CLI can echo it. Computed over a stable view.
        const stable = JSON.stringify({
          activeRepo: context.activeRepo, mode: permissionsData.settings.mode,
          pluginCount: plugins.length, learningCount: learnings.length,
          features: payload.features, instructionsLen: instructions.length,
        });
        const crypto = require('crypto');
        payload.checksum = 'b' + crypto.createHash('sha256').update(stable).digest('hex').slice(0, 10);
        return json(res, payload);
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }
    if (url.pathname === '/api/bootstrap/ack' && req.method === 'POST') {
      const body = await readBody(req);
      // Lightweight receipt log; visible in dashboard later.
      try {
        const log = path.join(repoRoot, '.symphonee', 'bootstrap-acks.jsonl');
        fs.mkdirSync(path.dirname(log), { recursive: true });
        fs.appendFileSync(log, JSON.stringify({ ts: Date.now(), ...body }) + '\n', 'utf8');
      } catch (_) {}
      return json(res, { ok: true });
    }

    // ── System Health & Diagnostics ─────────────────────────────────────
    if (url.pathname === '/api/health' && req.method === 'GET')              return handleHealthCheck(res);
    if (url.pathname === '/api/busy' && req.method === 'GET')                return json(res, guard.activeLocks());

    // ── Static files ──────────────────────────────────────────────────────
    const route = ROUTES[url.pathname];
    if (route && fs.existsSync(route.file)) {
      res.writeHead(200, { 'Content-Type': route.type });
      fs.createReadStream(route.file).pipe(res);
    } else {
      // Plugin-aware 404 for /api/ paths owned by extracted plugins. Keeps the
      // UI and AI seeing a structured 'this feature lives in a plugin -- install
      // it' response instead of a bare "Not found" when the plugin is absent.
      const unclaimed = matchUnclaimedPluginRoute(url.pathname, loadedPlugins);
      if (unclaimed) {
        return json(res, {
          error: unclaimed.installed
            ? `${unclaimed.pluginName} plugin is installed but not configured.`
            : `${unclaimed.pluginName} plugin is not installed.`,
          hint: unclaimed.installed
            ? `Open Settings > Plugins > ${unclaimed.pluginName} and add the required config.`
            : 'Install it from Settings > Plugins > Browse Plugins.',
          pluginRequired: unclaimed.pluginId,
        }, 404);
      }
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// ── Config API ──────────────────────────────────────────────────────────────
function getConfig() {
  let template = {};
  let root = {};
  try { template = JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch (_) {}
  try { root = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  return { ...template, ...root, ...readAllPluginConfigs() };
}

function readAllPluginConfigs() {
  const merged = {};
  try {
    if (!fs.existsSync(pluginsDir)) return merged;
    for (const dir of fs.readdirSync(pluginsDir)) {
      if (dir === 'sdk') continue;
      const cfgFile = path.join(pluginsDir, dir, 'config.json');
      if (!fs.existsSync(cfgFile)) continue;
      try { Object.assign(merged, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch (_) {}
    }
  } catch (_) {}
  return merged;
}

function getPluginConfigKeyMap() {
  const map = new Map();
  try {
    if (!fs.existsSync(pluginsDir)) return map;
    for (const dir of fs.readdirSync(pluginsDir)) {
      if (dir === 'sdk') continue;
      const manifestPath = path.join(pluginsDir, dir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { continue; }
      const keys = (manifest.contributions && manifest.contributions.configKeys) || [];
      for (const key of keys) {
        if (typeof key === 'string' && key) map.set(key, manifest.id || dir);
      }
    }
  } catch (_) {}
  return map;
}

function persistPluginConfigKeys(config) {
  const keyMap = getPluginConfigKeyMap();
  if (!keyMap.size) return config;
  const rootConfig = { ...config };
  const byPlugin = {};
  for (const [key, pluginId] of keyMap.entries()) {
    if (Object.prototype.hasOwnProperty.call(rootConfig, key)) {
      byPlugin[pluginId] = byPlugin[pluginId] || {};
      byPlugin[pluginId][key] = rootConfig[key];
      delete rootConfig[key];
    }
  }
  for (const [pluginId, pluginCfg] of Object.entries(byPlugin)) {
    try {
      const pluginDir = path.join(pluginsDir, pluginId);
      const cfgFile = path.join(pluginDir, 'config.json');
      if (!fs.existsSync(pluginDir)) continue;
      let existing = {};
      try { if (fs.existsSync(cfgFile)) existing = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
      fs.writeFileSync(cfgFile, JSON.stringify({ ...existing, ...pluginCfg }, null, 2), 'utf8');
    } catch (_) {}
  }
  return rootConfig;
}

const LEGACY_ROOT_CONFIG_KEYS = [
  'YoloMode',
  'YoloCliList',
  'GemmaEnabled',
  'GemmaModel',
  'GemmaOllamaHost',
  'GemmaOllamaPort',
];

function normalizeRootConfig(config) {
  const rootConfig = persistPluginConfigKeys(config);
  for (const key of LEGACY_ROOT_CONFIG_KEYS) {
    delete rootConfig[key];
  }
  return rootConfig;
}

// ── Incognito Mode guard ─────────────────────────────────────────────────
function isIncognito() { return getConfig().IncognitoMode === true; }
function incognitoGuard(res, action) {
  if (isIncognito()) {
    json(res, { error: `Blocked by Incognito Mode: "${action}" is not available in incognito. Plugin-backed integrations and remote operations are disabled. Turn off incognito in Settings to proceed.`, incognito: true }, 403);
    return true;
  }
  return false;
}

// ── Themes ────────────────────────────────────────────────────────────────
const themesPath = path.join(repoRoot, 'config', 'themes.json');

function handleGetThemes(res) {
  try {
    const data = fs.existsSync(themesPath) ? JSON.parse(fs.readFileSync(themesPath, 'utf8')) : { themes: [], active: null };
    json(res, data);
  } catch (_) {
    json(res, { themes: [], active: null });
  }
}

async function handleSaveThemes(req, res) {
  const data = await readBody(req);
  try {
    fs.writeFileSync(themesPath, JSON.stringify(data, null, 2));
    json(res, { ok: true });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

function handleGetConfig(res) {
  json(res, getConfig());
}

async function handleSaveConfig(req, res) {
  const incoming = await readBody(req);
  let template = {};
  try { template = JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch (_) {}
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  const config = normalizeRootConfig({ ...template, ...existing, ...incoming });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicWriteSync(configPath, JSON.stringify(config, null, 2));
  // Immediately clear all caches so the next request uses the new config
  // Core caches that survive in core. Plugin caches (ADO, GH) are invalidated
  // via the 'config-changed' broadcast the next step already emits.
  swrGit.clear(); swrPlugins.clear();
  // Regenerate AI instructions (incognito, orchestration, etc. may have changed)
  try { writePluginHints(); } catch (_) {}
  json(res, { ok: true });
}

// Sensitive fields to strip from exports (PATs, API keys).
// Core owns only its own shell-level secrets; plugins contribute their own via
// contributions.sensitiveKeys. This keeps core zero-coupled from ADO/GH/etc.
const CORE_SENSITIVE_KEYS = ['WhisperKey', 'AiApiKeys', 'BrowserCredentials'];
function getSensitiveKeys() {
  const keys = new Set(CORE_SENSITIVE_KEYS);
  for (const p of (loadedPlugins || [])) {
    const c = (p.contributions || {});
    if (Array.isArray(c.sensitiveKeys)) for (const k of c.sensitiveKeys) if (typeof k === 'string') keys.add(k);
  }
  return [...keys];
}

function handleExportConfig(res) {
  const cfg = getConfig();
  // Strip machine-specific fields only (repos have local paths).
  // Secrets (PATs, API keys, OAuth tokens) are kept: exports are for the user's own
  // machine-to-machine transfer (USB, etc.) and never meant to be shared or committed.
  const exportCfg = { ...cfg };
  delete exportCfg.Repos;
  exportCfg._exportedAt = new Date().toISOString();
  exportCfg._exportedFrom = 'Symphonee';
  // Collect plugin configs
  const pluginConfigs = {};
  try {
    const dirs = fs.readdirSync(pluginsDir);
    for (const dir of dirs) {
      if (dir === 'sdk') continue;
      const cfgFile = path.join(pluginsDir, dir, 'config.json');
        if (fs.existsSync(cfgFile)) {
          try {
            const pcfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
            pluginConfigs[dir] = pcfg;
          } catch (_) {}
        }
    }
  } catch (_) {}
  if (Object.keys(pluginConfigs).length) exportCfg._pluginConfigs = pluginConfigs;
  // Include custom themes
  try {
    if (fs.existsSync(themesPath)) {
      exportCfg._themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
    }
  } catch (_) {}
  // Include notes (markdown bodies keyed by filename without extension)
  try {
    const notesRoot = path.join(repoRoot, 'notes');
    if (fs.existsSync(notesRoot)) {
      const map = {};
      for (const f of fs.readdirSync(notesRoot)) {
        if (!f.endsWith('.md')) continue;
        try { map[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(notesRoot, f), 'utf8'); } catch (_) {}
      }
      if (Object.keys(map).length) exportCfg._notes = map;
    }
  } catch (_) {}
  // Include user-authored recipes (from both project-local and ~/.symphonee/recipes).
  // We bundle whatever is on disk; on import we only write non-shipped names to avoid overwriting the built-ins.
  try {
    const recipeMap = {};
    const dirs = [path.join(repoRoot, 'recipes'), path.join(require('os').homedir(), '.symphonee', 'recipes')];
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.md')) continue;
        try { recipeMap[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(d, f), 'utf8'); } catch (_) {}
      }
    }
    if (Object.keys(recipeMap).length) exportCfg._recipes = recipeMap;
  } catch (_) {}
  // Include learnings
  try {
    const lp = path.join(learningsDataDir, 'learnings.json');
    if (fs.existsSync(lp)) exportCfg._learnings = JSON.parse(fs.readFileSync(lp, 'utf8'));
  } catch (_) {}
  // Include display preferences (sidebar widths, collapsed state)
  try {
    const dp = path.join(repoRoot, 'config', 'display-pref.json');
    if (fs.existsSync(dp)) exportCfg._displayPref = JSON.parse(fs.readFileSync(dp, 'utf8'));
  } catch (_) {}
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': 'attachment; filename="symphonee-settings.json"',
  });
  res.end(JSON.stringify(exportCfg, null, 2));
}

async function handleImportConfig(req, res) {
  const incoming = await readBody(req);
  if (!incoming || typeof incoming !== 'object') {
    return json(res, { error: 'Invalid settings file' }, 400);
  }
  // Remove export metadata and machine-specific fields
  delete incoming._exportedAt;
  delete incoming._exportedFrom;
  delete incoming.Repos;
  // Restore themes
  const importedThemes = incoming._themes;
  delete incoming._themes;
  if (importedThemes && typeof importedThemes === 'object') {
    try {
      fs.mkdirSync(path.dirname(themesPath), { recursive: true });
      fs.writeFileSync(themesPath, JSON.stringify(importedThemes, null, 2), 'utf8');
    } catch (_) {}
  }
  // Restore notes
  const importedNotes = incoming._notes;
  delete incoming._notes;
  if (importedNotes && typeof importedNotes === 'object') {
    try {
      const notesRoot = path.join(repoRoot, 'notes');
      fs.mkdirSync(notesRoot, { recursive: true });
      for (const [name, body] of Object.entries(importedNotes)) {
        const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
        const dest = path.join(notesRoot, safe + '.md');
        if (path.resolve(dest).startsWith(path.resolve(notesRoot))) {
          try { fs.writeFileSync(dest, String(body || ''), 'utf8'); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  // Restore user recipes into ~/.symphonee/recipes (never overwrite shipped defaults).
  const importedRecipes = incoming._recipes;
  delete incoming._recipes;
  if (importedRecipes && typeof importedRecipes === 'object') {
    try {
      const shippedDir = path.join(repoRoot, 'recipes');
      const shipped = new Set();
      if (fs.existsSync(shippedDir)) {
        for (const f of fs.readdirSync(shippedDir)) {
          if (f.endsWith('.md')) shipped.add(f.replace(/\.md$/, ''));
        }
      }
      const userDir = path.join(require('os').homedir(), '.symphonee', 'recipes');
      fs.mkdirSync(userDir, { recursive: true });
      for (const [name, body] of Object.entries(importedRecipes)) {
        if (shipped.has(name)) continue;
        const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
        const dest = path.join(userDir, safe + '.md');
        if (path.resolve(dest).startsWith(path.resolve(userDir))) {
          try { fs.writeFileSync(dest, String(body || ''), 'utf8'); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  // Restore learnings
  const importedLearnings = incoming._learnings;
  delete incoming._learnings;
  if (importedLearnings && typeof importedLearnings === 'object') {
    try {
      fs.mkdirSync(learningsDataDir, { recursive: true });
      fs.writeFileSync(path.join(learningsDataDir, 'learnings.json'), JSON.stringify(importedLearnings, null, 2), 'utf8');
    } catch (_) {}
  }
  // Restore display preferences
  const importedDisplayPref = incoming._displayPref;
  delete incoming._displayPref;
  if (importedDisplayPref && typeof importedDisplayPref === 'object') {
    try {
      const dp = path.join(repoRoot, 'config', 'display-pref.json');
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      fs.writeFileSync(dp, JSON.stringify(importedDisplayPref, null, 2), 'utf8');
    } catch (_) {}
  }
  // Restore plugin configs (and auto-install missing plugins from registry).
  const pluginConfigs = incoming._pluginConfigs;
  delete incoming._pluginConfigs;
  const installedPlugins = [];
  if (pluginConfigs && typeof pluginConfigs === 'object') {
    const missingPluginIds = [];
    for (const pluginId of Object.keys(pluginConfigs)) {
      const pluginDir = path.join(pluginsDir, pluginId);
      if (fs.existsSync(pluginDir)) {
        try { fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify(pluginConfigs[pluginId], null, 2), 'utf8'); } catch (_) {}
      } else {
        missingPluginIds.push(pluginId);
      }
    }
    if (missingPluginIds.length > 0) {
      try {
        const https = require('https');
        const REGISTRY_API_URL = 'https://api.github.com/repos/matandessaur-me/Symphonee-plugins/contents/registry.json';
        const raw = await new Promise((resolve, reject) => {
          https.get(REGISTRY_API_URL, { headers: { 'User-Agent': 'Symphonee', 'Accept': 'application/vnd.github.v3+json' } }, (resp) => {
            let d = '';
            resp.on('data', c => { d += c; });
            resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
          }).on('error', reject);
        });
        if (raw.content) {
          const registry = JSON.parse(Buffer.from(raw.content, 'base64').toString());
          const { execSync } = require('child_process');
          for (const pluginId of missingPluginIds) {
            const entry = (registry.plugins || []).find(p => p.id === pluginId);
            if (!entry || !entry.repo) continue;
            const destDir = path.join(pluginsDir, pluginId);
            try {
              execSync('git clone "' + entry.repo + '.git" "' + destDir + '"', { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
              if (fs.existsSync(path.join(destDir, 'plugin.json'))) {
                fs.writeFileSync(path.join(destDir, 'config.json'), JSON.stringify(pluginConfigs[pluginId], null, 2), 'utf8');
                installedPlugins.push(pluginId);
              } else {
                fs.rmSync(destDir, { recursive: true, force: true });
              }
            } catch (_) {
              try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }
    if (installedPlugins.length > 0 && typeof writePluginHints === 'function') writePluginHints();
  }
  // Merge with existing config; preserve sensitive values (PATs, API keys) when
  // the import doesn't include them. The list comes from core + every plugin's
  // contributions.sensitiveKeys, so third-party plugins automatically opt in.
  const existing = getConfig();
  const merged = { ...existing, ...incoming };
  for (const key of getSensitiveKeys()) {
    if (!incoming[key] && existing[key]) merged[key] = existing[key];
  }
  const config = normalizeRootConfig(merged);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicWriteSync(configPath, JSON.stringify(config, null, 2));
  swrGit.clear(); swrPlugins.clear();
  broadcast({ type: 'config-changed' });
  const result = { ok: true };
  if (installedPlugins.length > 0) {
    result.pluginsInstalled = installedPlugins;
    result.restartRequired = true;
  }
  json(res, result);
}

// Wipe everything a clean install would not have. Bundled plugins that ship with the app stay,
// third-party plugin dirs are deleted. Caller must set { confirm: true } in the body.
async function handleFactoryReset(req, res) {
  const body = await readBody(req).catch(() => ({}));
  if (!body || body.confirm !== true) return json(res, { error: 'confirm:true required' }, 400);
  const rmIfExists = (p) => { try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
  // 1. Core state
  rmIfExists(configPath);
  rmIfExists(themesPath);
  rmIfExists(path.join(repoRoot, 'config', 'display-pref.json'));
  // 2. Notes + user recipes + learnings
  rmIfExists(path.join(repoRoot, 'notes'));
  rmIfExists(path.join(require('os').homedir(), '.symphonee', 'recipes'));
  rmIfExists(path.join(learningsDataDir, 'learnings.json'));
  // 3. Third-party plugins (keep only the SDK docs that ship from the main repo).
  const BUNDLED_PLUGIN_IDS = new Set(['sdk']);
  try {
    for (const d of fs.readdirSync(pluginsDir)) {
      if (BUNDLED_PLUGIN_IDS.has(d)) continue;
      rmIfExists(path.join(pluginsDir, d));
    }
  } catch (_) {}
  // 4. Also wipe each remaining plugin's config.json so bundled plugins come back blank
  try {
    for (const d of fs.readdirSync(pluginsDir)) {
      if (d === 'sdk') continue;
      rmIfExists(path.join(pluginsDir, d, 'config.json'));
    }
  } catch (_) {}
  // 5. Reset in-memory caches so subsequent requests don't serve stale values
  // Core caches that survive in core. Plugin caches (ADO, GH) are invalidated
  // via the 'config-changed' broadcast the next step already emits.
  swrGit.clear(); swrPlugins.clear();
  const result = { ok: true };
  json(res, result);
}

// ── Watch config for external changes ─────────────────────────────────────
let configWatchDebounce = null;
let _configSelfWriteAt = 0;
global.__markConfigSelfWrite = () => { _configSelfWriteAt = Date.now(); };
try {
  fs.watch(path.dirname(configPath), (eventType, filename) => {
    if (filename === 'config.json') {
      // Ignore server-initiated writes (permissions toggle, internal saves).
      // Only react to external edits (user editing the JSON file directly).
      if (Date.now() - _configSelfWriteAt < 1500) return;
      if (configWatchDebounce) clearTimeout(configWatchDebounce);
      configWatchDebounce = setTimeout(() => {
  swrGit.clear();
        broadcast({ type: 'config-changed' });
      }, 500);
    }
  });
} catch (_) {}

// ── Prerequisites API ────────────────────────────────────────────────────
function handlePrerequisites(res) {
  const result = {
    cliTools: {},
    nodeJs: { installed: true, version: process.version },
    config: { exists: false, complete: false },
  };

  for (const id of ['claude', 'gemini', 'copilot', 'codex', 'grok', 'qwen']) {
    result.cliTools[id] = detectCli(id);
  }

  result.pwsh = detectPwsh();

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    result.config.exists = true;
    // "Complete" no longer means ADO is configured -- the shell ships plugin-first, so
    // a DefaultUser + at least one configured repo is enough to be a usable install.
    result.config.complete = !!(cfg.DefaultUser && cfg.Repos && Object.keys(cfg.Repos).length > 0);
  } catch (_) {}

  const anyCliInstalled = Object.values(result.cliTools).some(c => c.installed);
  result.ready = anyCliInstalled && result.config.complete;

  json(res, result);
}

// ── CLI Install Handler ──────────────────────────────────────────────────────
const CLI_INSTALL_COMMANDS = {
  claude:  'npm install -g @anthropic-ai/claude-code',
  gemini:  'npm install -g @google/gemini-cli',
  copilot: 'npm install -g @github/copilot',
  codex:   'npm install -g @openai/codex',

  grok:    'npm install -g @webdevtoday/grok-cli',
  qwen:    'npm install -g @qwen-code/qwen-code',
};

// Detect a CLI tool via `where` first, then fall back to common npm global paths.
// After a fresh npm install the current process PATH may be stale, so we also
// check the typical npm global bin directories directly (same strategy as detectPwsh).
// Returns { installed, path, inPath } -- `inPath` indicates if `where` found it (ready to use)
// vs found via fallback (installed but may need terminal restart).
function detectCli(cli) {
  // 1. Try `where` (checks current PATH -- means it's ready to use right now)
  const whereCmd = `where ${cli}.cmd 2>nul || where ${cli} 2>nul`;
  try {
    const where = execSync(whereCmd, { encoding: 'utf8', timeout: 5000 }).trim();
    if (where) return { installed: true, path: where.split('\n')[0].trim(), inPath: true };
  } catch (_) {}

  // 2. Fallback: check common npm global install locations
  const npmPrefixes = [];
  // Try to get the actual npm prefix
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 5000 }).trim();
    if (prefix) npmPrefixes.push(prefix);
  } catch (_) {}
  // Common Windows locations
  const appData = process.env.APPDATA || '';
  if (appData) npmPrefixes.push(path.join(appData, 'npm'));
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) npmPrefixes.push(path.join(localAppData, 'npm'));
  // nvm-windows uses per-version dirs
  const nvmHome = process.env.NVM_HOME || process.env.NVM_SYMLINK || '';
  if (nvmHome) npmPrefixes.push(nvmHome);
  // Deduplicate
  const seen = new Set();
  for (const prefix of npmPrefixes) {
    if (!prefix || seen.has(prefix.toLowerCase())) continue;
    seen.add(prefix.toLowerCase());
    for (const ext of ['.cmd', '.ps1', '']) {
      const candidate = path.join(prefix, cli + ext);
      try { if (fs.existsSync(candidate)) return { installed: true, path: candidate, inPath: false }; } catch (_) {}
    }
  }
  return { installed: false, path: '', inPath: false };
}

const PWSH_WINGET_CMD = 'winget install Microsoft.PowerShell --accept-source-agreements --accept-package-agreements';

// Detect pwsh.exe via `where` first, then fall back to common install paths.
// `where` relies on the current process PATH which may be stale after a fresh install.
function detectPwsh() {
  try {
    const where = execSync('where pwsh.exe 2>nul', { encoding: 'utf8', timeout: 5000 }).trim();
    if (where) return { installed: true, path: where.split('\n')[0].trim() };
  } catch (_) {}
  // Fallback: check common install locations (PATH may not be refreshed yet)
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '8', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', 'pwsh.exe'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return { installed: true, path: c }; } catch (_) {}
  }
  return { installed: false, path: '' };
}

function handleCliInstall(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { cli } = JSON.parse(body);

      // PowerShell 7 needs admin elevation — handle separately
      if (cli === 'pwsh') return handlePwshInstall(res);

      const installCmd = CLI_INSTALL_COMMANDS[cli];
      if (!installCmd) return json(res, { error: `Unknown CLI: ${cli}` }, 400);

      // Run install asynchronously
      const { exec } = require('child_process');
      exec(installCmd, { timeout: 120000, encoding: 'utf8' }, (err, stdout, stderr) => {
        // After install, re-check using detectCli (checks PATH + common npm global dirs)
        const result = detectCli(cli);

        if (result.installed) {
          json(res, {
            ok: true, cli, installed: true, path: result.path,
            // If found via fallback (not in PATH), the user may need to restart the app
            needsRestart: !result.inPath,
          });
        } else {
          json(res, {
            ok: false, cli, installed: false,
            error: err ? err.message : 'Installation failed. Please try the manual command below.',
            fallbackCmd: installCmd,
          });
        }
      });
    } catch (e) {
      json(res, { error: 'Invalid request' }, 400);
    }
  });
}

function handlePwshInstall(res) {
  const { exec } = require('child_process');
  // Attempt elevated install via Start-Process -Verb RunAs (triggers UAC prompt)
  const elevatedCmd = `powershell.exe -NoProfile -Command "Start-Process -FilePath 'winget' -ArgumentList 'install Microsoft.PowerShell --accept-source-agreements --accept-package-agreements' -Verb RunAs -Wait -PassThru | Select-Object -ExpandProperty ExitCode"`;
  exec(elevatedCmd, { timeout: 180000, encoding: 'utf8' }, (err, stdout, stderr) => {
    // Check if pwsh is now available (detectPwsh checks common paths too, not just PATH)
    const result = detectPwsh();
    if (result.installed) {
      json(res, { ok: true, cli: 'pwsh', installed: true, path: result.path });
    } else {
      json(res, {
        ok: false, cli: 'pwsh', installed: false,
        error: 'Installation requires administrator privileges.',
        fallbackCmd: PWSH_WINGET_CMD,
      });
    }
  });
}

// All Azure DevOps HTTP helpers and handlers moved to the azure-devops plugin
// (dashboard/plugins/azure-devops/routes.js) as of plugin v0.4.0. This includes:
//   adoRequest, adoOrgRequest, getTeamAreaPaths, proxyHtmlImages,
//   SWR caches (swrIterations, swrWorkItems, swrTeamAreas, swrAreas),
//   handleIterations, handleWorkItems (+ dynamic routes), handleWorkItemDetail,
//   handleUpdateWorkItem, handleWorkItemState, handleAddWorkItemComment,
//   handleCreateWorkItem, handleVelocity, handleBurndown, handleTeams,
//   handleAreas, handleTeamMembers.

// ── Repos Management ────────────────────────────────────────────────────────
function handleGetRepos(res) {
  const cfg = getConfig();
  json(res, cfg.Repos || {});
}

async function handleSaveRepo(req, res) {
  const { name, path: repoPath } = await readBody(req);
  if (!name || !repoPath) return json(res, { error: 'name and path are required' }, 400);
  let cfg = {};
  try { cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}; } catch (_) { cfg = {}; }
  cfg.Repos = cfg.Repos || {};
  cfg.Repos[name] = repoPath;
  atomicWriteSync(configPath, JSON.stringify(normalizeRootConfig(cfg), null, 2));
  broadcast({ type: 'config-changed' });
  json(res, { ok: true });
}

function handleGetSpaces(res) {
  const cfg = getConfig();
  json(res, cfg.Spaces || {});
}
async function handleSaveSpace(req, res) {
  const body = await readBody(req);
  const { name, icon, description, repos, plugins } = body || {};
  if (!name) return json(res, { error: 'name is required' }, 400);
  let cfg = {};
  try { cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}; } catch (_) { cfg = {}; }
  cfg.Spaces = cfg.Spaces || {};
  const prev = cfg.Spaces[name] || {};
  cfg.Spaces[name] = {
    icon: icon || prev.icon || 'layers',
    description: description !== undefined ? description : (prev.description || ''),
    repos: Array.isArray(repos) ? repos.filter(r => typeof r === 'string') : (prev.repos || []),
    plugins: Array.isArray(plugins) ? plugins.filter(p => typeof p === 'string') : (prev.plugins || []),
    createdAt: prev.createdAt || Date.now(),
  };
  atomicWriteSync(configPath, JSON.stringify(normalizeRootConfig(cfg), null, 2));
  broadcast({ type: 'config-changed' });
  json(res, { ok: true, space: cfg.Spaces[name] });
}

// Toggle whether a repo is a member of a space (single-space membership:
// adding to one space removes it from any other).
async function handleSpaceAttachRepo(req, res) {
  const { space, repo, attach } = await readBody(req);
  if (!space || !repo) return json(res, { error: 'space and repo are required' }, 400);
  let cfg = {};
  try { cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}; } catch (_) { cfg = {}; }
  cfg.Spaces = cfg.Spaces || {};
  if (!cfg.Spaces[space]) return json(res, { error: 'space not found' }, 404);
  // Remove from every other space first (single-membership rule).
  for (const [n, s] of Object.entries(cfg.Spaces)) {
    if (!s || !Array.isArray(s.repos)) continue;
    cfg.Spaces[n] = { ...s, repos: s.repos.filter(r => r !== repo) };
  }
  if (attach !== false) {
    const s = cfg.Spaces[space];
    const list = Array.isArray(s.repos) ? s.repos : [];
    cfg.Spaces[space] = { ...s, repos: list.includes(repo) ? list : list.concat(repo) };
  }
  atomicWriteSync(configPath, JSON.stringify(normalizeRootConfig(cfg), null, 2));
  broadcast({ type: 'config-changed' });
  json(res, { ok: true });
}

// Toggle plugin presence in a space's preset.
async function handleSpaceTogglePlugin(req, res) {
  const { space, plugin, enabled } = await readBody(req);
  if (!space || !plugin) return json(res, { error: 'space and plugin are required' }, 400);
  let cfg = {};
  try { cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}; } catch (_) { cfg = {}; }
  cfg.Spaces = cfg.Spaces || {};
  if (!cfg.Spaces[space]) return json(res, { error: 'space not found' }, 404);
  const s = cfg.Spaces[space];
  const list = Array.isArray(s.plugins) ? s.plugins.slice() : [];
  const idx = list.indexOf(plugin);
  if (enabled === false || (enabled === undefined && idx >= 0)) {
    if (idx >= 0) list.splice(idx, 1);
  } else if (idx < 0) {
    list.push(plugin);
  }
  cfg.Spaces[space] = { ...s, plugins: list };
  atomicWriteSync(configPath, JSON.stringify(normalizeRootConfig(cfg), null, 2));
  broadcast({ type: 'config-changed' });
  json(res, { ok: true, plugins: list });
}
const _skillsDir = path.join(__dirname, 'skills');
function _parseSkillFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (mm) meta[mm[1]] = mm[2].trim().replace(/^>-\s*/, '');
  }
  return { meta, body: m[2] };
}
function handleGetSkills(res) {
  try {
    if (!fs.existsSync(_skillsDir)) return json(res, []);
    const files = fs.readdirSync(_skillsDir).filter(f => f.endsWith('.md'));
    const skills = files.map(f => {
      const slug = f.replace(/\.md$/, '');
      try {
        const { meta } = _parseSkillFrontmatter(fs.readFileSync(path.join(_skillsDir, f), 'utf8'));
        return { slug, name: meta.name || slug, description: meta.description || '' };
      } catch (_) {
        return { slug, name: slug, description: '' };
      }
    });
    json(res, skills);
  } catch (e) { json(res, { error: e.message }, 500); }
}
function handleGetSkill(res, slug) {
  if (!/^[a-z0-9_-]+$/i.test(slug)) return json(res, { error: 'invalid slug' }, 400);
  const file = path.join(_skillsDir, slug + '.md');
  if (!fs.existsSync(file)) return json(res, { error: 'not found' }, 404);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = _parseSkillFrontmatter(raw);
    json(res, { slug, name: meta.name || slug, description: meta.description || '', body });
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleDeleteSpace(req, res) {
  const { name } = await readBody(req);
  if (!name) return json(res, { error: 'name is required' }, 400);
  let cfg = {};
  try { cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}; } catch (_) { cfg = {}; }
  if (cfg.Spaces && cfg.Spaces[name]) delete cfg.Spaces[name];
  atomicWriteSync(configPath, JSON.stringify(normalizeRootConfig(cfg), null, 2));
  broadcast({ type: 'config-changed' });
  json(res, { ok: true });
}

function getPluginRecommendations() {
  const cfg = getConfig();
  const repos = cfg.Repos || {};
  const uiCtx = getUiContextWithPath();
  const repoEntries = [];
  if (uiCtx.activeRepo && repos[uiCtx.activeRepo]) repoEntries.push([uiCtx.activeRepo, repos[uiCtx.activeRepo]]);
  for (const entry of Object.entries(repos)) {
    if (!repoEntries.some(([name]) => name === entry[0])) repoEntries.push(entry);
  }

  const remotes = [];
  for (const [repoName, repoPath] of repoEntries.slice(0, 20)) {
    if (!repoPath || !fs.existsSync(repoPath)) continue;
    const out = gitSync(repoPath, 'remote -v', 5000);
    if (out) remotes.push({ repoName, text: out.toLowerCase() });
  }

  const installedIds = new Set();
  try {
    if (fs.existsSync(pluginsDir)) {
      for (const dir of fs.readdirSync(pluginsDir)) {
        if (dir !== 'sdk' && fs.existsSync(path.join(pluginsDir, dir, 'plugin.json'))) installedIds.add(dir);
      }
    }
  } catch (_) {}
  const activeIds = new Set((loadedPlugins || []).filter(p => checkActivation(p, getConfig)).map(p => p.id));
  const byId = new Map();
  const add = (id, label, reason, repoName, score) => {
    const item = byId.get(id) || { id, label, reasons: [], repoNames: [], score: 0, installed: installedIds.has(id), configured: activeIds.has(id) };
    if (reason && !item.reasons.includes(reason)) item.reasons.push(reason);
    if (repoName && !item.repoNames.includes(repoName)) item.repoNames.push(repoName);
    item.score = Math.max(item.score, score || 0);
    byId.set(id, item);
  };

  for (const r of remotes) {
    if (r.text.includes('github.com')) {
      add('github', 'GitHub', `Detected a GitHub remote in ${r.repoName}.`, r.repoName, 100);
    }
    if (r.text.includes('dev.azure.com') || r.text.includes('visualstudio.com')) {
      add('azure-devops', 'Azure DevOps', `Detected an Azure DevOps remote in ${r.repoName}.`, r.repoName, 95);
    }
  }

  return {
    recommendations: [...byId.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)),
    scannedRepos: repoEntries.length,
  };
}

// handleStartWorking moved to the azure-devops plugin (dashboard/plugins/azure-devops/routes.js) as of plugin v0.4.0.

// GitHub handlers (handleCreatePullRequest, handleGitHub*) moved to the github plugin
// in dashboard/plugins/github/routes.js as of plugin v0.4.0.

// ── UI Actions (AI -> Dashboard) ─────────────────────────────────────────────
// ── File Browser ────────────────────────────────────────────────────────────
function getRepoPath(repoName) {
  const cfg = getConfig();
  const repos = cfg.Repos || {};
  return repos[repoName] || null;
}

const FILE_BROWSER_SKIP = new Set([
  '.git',
  '.ai-workspace',
  '.symphonee',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'bin',
  'obj'
]);

function resolveRepoSubPath(repoPath, subPath = '') {
  const repoRoot = path.resolve(repoPath);
  const targetPath = path.resolve(path.join(repoRoot, subPath || ''));
  if (targetPath !== repoRoot && !targetPath.startsWith(repoRoot + path.sep)) return null;
  return targetPath;
}

function handleFileTree(url, res) {
  const repoName = url.searchParams.get('repo');
  const subPath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const resolved = resolveRepoSubPath(repoPath, subPath);
  if (!resolved) return json(res, { error: 'Invalid path' }, 403);

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !FILE_BROWSER_SKIP.has(e.name))
      .map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        path: subPath ? `${subPath}/${e.name}` : e.name,
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    json(res, { entries, currentPath: subPath, repoName });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── File name search (recursive, returns matching paths) ──────────────────
function handleFileSearch(url, res) {
  const repoName = url.searchParams.get('repo');
  const query = (url.searchParams.get('q') || '').toLowerCase();
  const scopePath = (url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!query) return json(res, { results: [] });

  const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock']);
  const results = [];
  const MAX = 80;
  const rootDir = resolveRepoSubPath(repoPath, scopePath);
  if (!rootDir) return json(res, { error: 'Invalid path' }, 403);

  try {
    if (!fs.statSync(rootDir).isDirectory()) return json(res, { error: 'Search path must be a directory' }, 400);
  } catch (_) {
    return json(res, { error: 'Search path not found' }, 404);
  }

  function walk(dir, rel) {
    if (results.length >= MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (results.length >= MAX) return;
      if (FILE_BROWSER_SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), childRel);
      } else {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (e.name.toLowerCase().includes(query)) {
          results.push({ path: childRel, name: e.name, isDir: false });
        }
      }
    }
  }
  walk(rootDir, scopePath);
  json(res, { results });
}

// ── Content grep (search inside files, returns matches with line numbers) ──
function handleFileGrep(url, res) {
  const repoName = url.searchParams.get('repo');
  const query = url.searchParams.get('q') || '';
  const scopePath = (url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!query || query.length < 2) return json(res, { results: [] });

  const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock','map']);
  const results = [];
  const MAX_FILES = 50;
  const MAX_MATCHES = 150;
  let fileCount = 0;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);
  const rootDir = resolveRepoSubPath(repoPath, scopePath);
  if (!rootDir) return json(res, { error: 'Invalid path' }, 403);

  try {
    if (!fs.statSync(rootDir).isDirectory()) return json(res, { error: 'Search path must be a directory' }, 400);
  } catch (_) {
    return json(res, { error: 'Search path not found' }, 404);
  }

  function lineMatches(lineLower) {
    if (queryWords.length <= 1) return lineLower.includes(queryLower);
    return queryWords.every(w => lineLower.includes(w));
  }

  function walk(dir, rel) {
    if (results.length >= MAX_MATCHES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (results.length >= MAX_MATCHES) return;
      if (FILE_BROWSER_SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), childRel);
      } else {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (fileCount >= MAX_FILES && results.length > 0) return;
        try {
          const fullPath = path.join(dir, e.name);
          const stat = fs.statSync(fullPath);
          if (stat.size > 512 * 1024) continue; // skip files > 512KB
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          fileCount++;
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_MATCHES) break;
            if (lineMatches(lines[i].toLowerCase())) {
              results.push({ path: childRel, name: e.name, line: i + 1, text: lines[i].substring(0, 200) });
            }
          }
        } catch (_) {}
      }
    }
  }
  walk(rootDir, scopePath);
  json(res, { results });
}

function handleFileRead(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const fullPath = path.join(repoPath, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

  try {
    const st = fs.statSync(resolved);
    const ext = path.extname(resolved).slice(1).toLowerCase();

    // Check for binary files
    const binaryExts = ['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf'];
    if (binaryExts.includes(ext)) {
      return json(res, { content: `[Binary file: ${path.basename(resolved)} - ${st.size} bytes]`, name: path.basename(resolved), path: filePath, size: st.size, lines: 1, ext, isBinary: true });
    }

    const content = fs.readFileSync(resolved, 'utf8');
    json(res, {
      content,
      name: path.basename(resolved),
      path: filePath,
      size: st.size,
      lines: content.split('\n').length,
      ext,
    });
  } catch (e) {
    json(res, { error: e.message }, 404);
  }
}

async function handleFileSave(req, res) {
  const { repo, path: filePath, content } = await readBody(req);
  const repoPath = getRepoPath(repo);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const fullPath = path.join(repoPath, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

  try {
    fs.writeFileSync(resolved, content, 'utf8');
    broadcast({ type: 'ui-action', action: 'file-changed', repo, path: filePath });
    json(res, { ok: true });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Git Integration ─────────────────────────────────────────────────────────
// Legacy sync wrapper (kept for non-critical reads; async preferred for new code)
function gitExec(repoPath, cmd, timeoutMs) {
  return gitSync(repoPath, cmd, timeoutMs);
}

function handleGitStatus(url, res) {
  const repoName = url.searchParams.get('repo');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const branch = gitExec(repoPath, 'rev-parse --abbrev-ref HEAD');
  const status = gitExec(repoPath, 'status --porcelain -u');
  const statusMap = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', '?': 'new', 'U': 'conflict' };
  const statusLabel = { 'modified': 'M', 'added': 'A', 'deleted': 'D', 'renamed': 'R', 'new': 'N', 'conflict': 'U' };
  const files = status ? status.split('\n').filter(Boolean).map(line => {
    // Git porcelain: XY filename — X=index status, Y=worktree status
    const x = line.charAt(0);
    const y = line.charAt(1);
    let file;
    if (line.charAt(2) === ' ') {
      file = line.substring(3); // standard: XY<space>filename
    } else {
      file = line.substring(2); // no separator: XYfilename
    }
    // Handle renamed files: "R  old-name -> new-name"
    if (file.includes(' -> ')) {
      file = file.split(' -> ').pop();
    }
    // Strip any trailing \r from Windows line endings
    file = file.replace(/\r$/, '').trim();
    const raw = (x + y).trim() || '?';
    const statusChar = raw.charAt(0);
    const cls = statusMap[statusChar] || 'modified';
    return { status: statusLabel[cls], statusClass: cls, file };
  }).filter(f => f.file) : [];

  json(res, { branch, files, clean: files.length === 0 });
}

function handleGitDiff(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  let diff = '';
  if (filePath) {
    // Try staged + unstaged diff against HEAD (ignore CRLF differences on Windows)
    diff = gitExec(repoPath, `diff --ignore-cr-at-eol HEAD -- "${filePath}"`);
    // Try unstaged only
    if (!diff) diff = gitExec(repoPath, `diff --ignore-cr-at-eol -- "${filePath}"`);
    // Try staged only
    if (!diff) diff = gitExec(repoPath, `diff --ignore-cr-at-eol --cached -- "${filePath}"`);
    // For untracked/new files, show entire content as additions
    if (!diff) {
      const fullPath = path.join(repoPath, filePath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          diff = `diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map(l => `+${l}`).join('\n');
        } catch (_) {}
      }
    }
  } else {
    diff = gitExec(repoPath, 'diff --ignore-cr-at-eol HEAD');
    if (!diff) diff = gitExec(repoPath, 'diff --ignore-cr-at-eol');
    // Include untracked (new) files in the combined diff
    const status = gitExec(repoPath, 'status --porcelain');
    if (status) {
      const untrackedFiles = status.split('\n').filter(Boolean)
        .filter(l => l.startsWith('??'))
        .map(l => l.substring(3).replace(/\r$/, '').trim());
      for (const uf of untrackedFiles) {
        const fullPath = path.join(repoPath, uf);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            const fileDiff = `diff --git a/${uf} b/${uf}\nnew file\n--- /dev/null\n+++ b/${uf}\n@@ -0,0 +1,${lines.length} @@\n` +
              lines.map(l => `+${l}`).join('\n');
            diff = diff ? diff + '\n' + fileDiff : fileDiff;
          } catch (_) {}
        }
      }
    }
  }

  json(res, { diff: diff || 'No changes', filePath });
}

async function handleGitBranches(url, res) {
  const repoName = url.searchParams.get('repo');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  try {
    const data = await swrGit.get('branches:' + repoPath, async () => {
      const current = await gitAsync(repoPath, 'rev-parse --abbrev-ref HEAD');
      const output = await gitAsync(repoPath, 'branch --format="%(refname:short)"');
      const branches = output ? output.split('\n').filter(Boolean) : [];
      return { current, branches };
    });
    json(res, data);
  } catch (err) {
    console.error('handleGitBranches error:', err.message);
    json(res, { error: 'Failed to list branches' }, 500);
  }
}

function handleGitLog(url, res) {
  const repoName = url.searchParams.get('repo');
  const count = url.searchParams.get('count') || '20';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const output = gitExec(repoPath, `log -${count} --pretty=format:"%h|%s|%an|%ar"`);
  const commits = output ? output.split('\n').filter(Boolean).map(line => {
    const [hash, subject, author, date] = line.replace(/^"|"$/g, '').split('|');
    return { hash, subject, author, date };
  }) : [];

  json(res, { commits });
}

function handleCommitDiff(url, res) {
  const repoName = url.searchParams.get('repo');
  const hash = url.searchParams.get('hash');
  const filePath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!hash) return json(res, { error: 'hash required' }, 400);

  const pathArg = filePath ? ` -- "${filePath}"` : '';
  const diff = gitExec(repoPath, `diff --ignore-cr-at-eol ${hash}~1 ${hash}${pathArg}`);
  const stat = gitExec(repoPath, `diff --ignore-cr-at-eol --stat=999 ${hash}~1 ${hash}`);
  const msg = gitExec(repoPath, `log -1 --pretty=format:"%s" ${hash}`);

  json(res, { diff: diff || 'No changes', stat, message: msg, hash });
}

// ── Git Actions (checkout, pull, push, fetch) -- async with busy guards ────
async function handleGitCheckout(req, res) {
  try {
    const body = await readBody(req);
    const repoPath = getRepoPath(body.repo);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
    if (!body.branch) return json(res, { error: 'branch required' }, 400);

    await guard.run(`git:${repoPath}`, 'checkout', async () => {
      // Check for uncommitted changes
      const status = await gitAsync(repoPath, 'status --porcelain');
      if (status && status.trim()) {
        throw Object.assign(new Error('You have uncommitted changes. Commit or stash them before switching branches.'), { dirty: true });
      }

      // Fetch latest from remote before switching
      await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });

      const result = await gitAsync(repoPath, `checkout ${body.branch}`);
      const current = await gitAsync(repoPath, 'rev-parse --abbrev-ref HEAD');

      // Pull latest changes after switching (best-effort, don't fail the checkout)
      let pullMsg = '';
      try {
        pullMsg = await gitAsync(repoPath, 'pull', { timeout: 30000 });
      } catch (_) {
        // Pull failed -- checkout still succeeded, continue
      }

      // Notify UI of branch change
      swrGit.clear();
      broadcast({ type: 'git-changed', repo: body.repo, branch: current });
      json(res, { ok: true, branch: current, message: result, pullMessage: pullMsg });
    }, 60000);
  } catch (e) {
    const status = e.dirty ? 400 : (e.message.includes('busy') ? 409 : 500);
    json(res, { error: e.message, dirty: e.dirty || false }, status);
  }
}

async function handleGitPull(req, res) {
  try {
    const body = await readBody(req);
    const repoPath = getRepoPath(body.repo);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    await guard.run(`git:${repoPath}`, 'pull', async () => {
      await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });
      const result = await gitAsync(repoPath, 'pull', { timeout: 30000 });
      const branch = await gitAsync(repoPath, 'rev-parse --abbrev-ref HEAD');
      swrGit.clear();
      broadcast({ type: 'git-changed', repo: body.repo, branch });
      json(res, { ok: true, branch, message: result });
    }, 60000);
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('busy') ? 409 : 500);
  }
}

async function handleGitPush(req, res) {
  try {
    const body = await readBody(req);
    const repoPath = getRepoPath(body.repo);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    await guard.run(`git:${repoPath}`, 'push', async () => {
      const branch = await gitAsync(repoPath, 'rev-parse --abbrev-ref HEAD');
      await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });

      let behindCount = 0;
      try {
        const behind = await gitAsync(repoPath, `rev-list --count HEAD..origin/${branch}`);
        behindCount = parseInt(behind, 10) || 0;
      } catch (_) {
        // Remote branch doesn't exist yet -- not behind, safe to push
      }
      if (behindCount > 0) {
        throw Object.assign(
          new Error(`Your branch is ${behindCount} commit(s) behind origin/${branch}. Pull first, then push.`),
          { needsPull: true }
        );
      }

      const result = await gitAsync(repoPath, `push -u origin ${branch}`, { timeout: 30000 });
      swrGit.clear();
      broadcast({ type: 'git-changed', repo: body.repo, branch });
      json(res, { ok: true, branch, message: result || 'Pushed successfully' });
    }, 60000);
  } catch (e) {
    const status = e.needsPull ? 409 : (e.message.includes('busy') ? 409 : 500);
    json(res, { error: e.message, needsPull: e.needsPull || false }, status);
  }
}

async function handleGitFetch(req, res) {
  try {
    const body = await readBody(req);
    const repoPath = getRepoPath(body.repo);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    await guard.run(`git:${repoPath}`, 'fetch', async () => {
      await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });
      const current = await gitAsync(repoPath, 'rev-parse --abbrev-ref HEAD');
      const localOut = await gitAsync(repoPath, 'branch --format="%(refname:short)"');
      const remoteOut = await gitAsync(repoPath, 'branch -r --format="%(refname:short)"');
      const local = localOut ? localOut.split('\n').filter(Boolean) : [];
      const remote = remoteOut ? remoteOut.split('\n').filter(Boolean)
        .filter(b => !b.includes('/HEAD'))
        .map(b => b.replace(/^origin\//, '')) : [];
      const remoteOnly = remote.filter(r => !local.includes(r));

      json(res, { ok: true, current, local, remoteOnly });
    }, 60000);
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('busy') ? 409 : 500);
  }
}

// ── Git Discard (restore file to HEAD) ──────────────────────────────────────
async function handleGitDiscard(req, res) {
  try {
    const body = await readBody(req);
    const repoPath = getRepoPath(body.repo);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
    if (!body.path) return json(res, { error: 'path required' }, 400);

    const filePath = body.path;

    // Check if the file is untracked (new) or tracked
    const status = gitExec(repoPath, `status --porcelain -- "${filePath}"`);
    const statusCode = status ? status.substring(0, 2) : '';

    if (statusCode.trim().startsWith('?')) {
      // Untracked file -- remove it
      gitExec(repoPath, `clean -f -- "${filePath}"`);
    } else {
      // Tracked file -- unstage and restore
      gitExec(repoPath, `reset HEAD -- "${filePath}"`);
      gitExec(repoPath, `checkout -- "${filePath}"`);
    }

    json(res, { ok: true, discarded: filePath });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Split Diff ──────────────────────────────────────────────────────────────
function handleSplitDiff(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path') || '';
  const base = url.searchParams.get('base') || 'HEAD';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  try {
    // Get the original version from git
    let original = '';
    try {
      original = execSync(`git -C "${repoPath}" show ${base}:"${filePath}"`, { encoding: 'utf8', timeout: 10000 });
    } catch (_) { original = ''; }

    // Get the current version from disk
    const fullPath = path.join(repoPath, filePath);
    let modified = '';
    try { modified = fs.readFileSync(fullPath, 'utf8'); } catch (_) {}

    // Normalize line endings to LF so diff doesn't flag every line
    original = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    modified = modified.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    json(res, { original, modified, filePath, base });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Project Scripts ──────────────────────────────────────────────────────────
function handleProjectScripts(url, res) {
  const repoName = url.searchParams.get('repo');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const pkgPath = path.join(repoPath, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) return json(res, { scripts: {}, type: 'none' });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasNodeModules = fs.existsSync(path.join(repoPath, 'node_modules'));

    // Detect project type
    let type = 'node';
    if (deps['next']) type = 'nextjs';
    else if (deps['react-scripts']) type = 'cra';
    else if (deps['vite']) type = 'vite';
    else if (deps['gatsby']) type = 'gatsby';
    else if (deps['nuxt']) type = 'nuxt';

    json(res, { scripts, type, name: pkg.name || '', hasNodeModules });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Serve repo file (for images/media) ──────────────────────────────────────
function handleServeFile(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path');
  const repoPath = getRepoPath(repoName);
  if (!repoPath || !filePath) { res.writeHead(400); return res.end('Missing params'); }

  const fullPath = path.join(repoPath, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(resolved)) { res.writeHead(404); return res.end('Not found'); }

  const ext = path.extname(resolved).slice(1).toLowerCase();
  const mimeTypes = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'max-age=60' });
  fs.createReadStream(resolved).pipe(res);
}

// ── Voice-to-Text (OpenAI Whisper) ──────────────────────────────────────────
async function handleVoiceTranscribe(req, res) {
  try {
    const { audio } = await readBody(req);
    if (!audio) return json(res, { error: 'audio (base64 WAV) required' }, 400);

    const cfg = getConfig();
    const apiKey = cfg.WhisperKey || '';
    if (!apiKey) return json(res, { error: 'OpenAI API key not configured. Add it in Settings > Other > Voice Input.' }, 400);

    // Decode base64 WAV to buffer
    const wavBuffer = Buffer.from(audio, 'base64');

    // Build multipart/form-data for OpenAI Whisper API
    const boundary = '----SymphoneeVoice' + Date.now();
    const parts = [];

    // File part
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    parts.push(wavBuffer);
    parts.push('\r\n');

    // Model part
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`
    );

    // Response format
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `json\r\n`
    );

    parts.push(`--${boundary}--\r\n`);

    // Combine into single buffer
    const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };

      const apiReq = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => { data += chunk; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (_) { resolve({ text: data }); }
          } else {
            reject(new Error(`Whisper API error (${resp.statusCode}): ${data.slice(0, 300)}`));
          }
        });
      });
      apiReq.on('error', reject);
      apiReq.write(body);
      apiReq.end();
    });

    json(res, { text: result.text || '', language: result.language || '' });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Open External URL ───────────────────────────────────────────────────────
async function handleOpenExternal(req, res) {
  const { url: extUrl } = await readBody(req);
  if (!extUrl) return json(res, { error: 'url required' }, 400);
  try { new URL(extUrl); } catch (_) { return json(res, { error: 'Invalid URL' }, 400); }
  // Use rundll32 which reliably opens URLs in the default browser on Windows
  exec(`rundll32 url.dll,FileProtocolHandler "${extUrl}"`);
  json(res, { ok: true });
}

// ── Image Proxy ─────────────────────────────────────────────────────────────
// Plugins contribute contributions.imageAuth entries to register URL-pattern
// auth headers. Core never hardcodes service-specific auth -- it just walks
// the contributed rules. Each rule: { hostnamePattern, authType, authConfigKey }.
//   authType 'basic-pat' -> 'Basic ' + base64(':' + config[authConfigKey])
//   authType 'bearer'    -> 'Bearer ' + config[authConfigKey]
//   authType 'token'     -> 'token '  + config[authConfigKey]
function resolveImageAuth(hostname, cfg) {
  for (const p of (loadedPlugins || [])) {
    const rules = (p.contributions && p.contributions.imageAuth) || [];
    for (const rule of rules) {
      if (!rule || !rule.hostnamePattern || !rule.authConfigKey) continue;
      if (!hostname.includes(rule.hostnamePattern)) continue;
      const secret = cfg[rule.authConfigKey];
      if (!secret) continue;
      switch (rule.authType) {
        case 'bearer':    return 'Bearer ' + secret;
        case 'token':     return 'token ' + secret;
        case 'basic-pat':
        default:          return 'Basic ' + Buffer.from(':' + secret).toString('base64');
      }
    }
  }
  return null;
}
function handleImageProxy(url, res) {
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) { res.writeHead(400); return res.end('Missing url param'); }

  const cfg = getConfig();
  const parsedUrl = new URL(imageUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: { 'Accept': '*/*' },
  };
  const authHeader = resolveImageAuth(parsedUrl.hostname, cfg);
  if (authHeader) options.headers['Authorization'] = authHeader;

  const proto = parsedUrl.protocol === 'https:' ? https : http;
  const proxyReq = proto.request(options, (proxyRes) => {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      // Follow redirect
      const redirectUrl = new URL(proxyRes.headers.location, imageUrl);
      const newUrl = new URL(`http://${HOST}:${PORT}/api/image-proxy`);
      newUrl.searchParams.set('url', redirectUrl.href);
      return handleImageProxy(newUrl, res);
    }
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'image/png',
      'Cache-Control': 'max-age=3600',
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  proxyReq.end();
}

// ── UI Context (tracks what's selected in the dashboard) ────────────────────
// activeSpace is the organizational container (e.g. "Business"); activeRepo is
// the specific working repo inside that space. They can be independent.
let _uiContext = {
  selectedIteration: null,
  selectedIterationName: 'All Iterations',
  activeSpace: null,
  activeRepo: null,
  activeRepoPath: null,
};

function getUiContextWithPath() {
  // Always resolve the repo path from config so it's up to date
  const ctx = { ..._uiContext };
  if (ctx.activeRepo) {
    const cfg = getConfig();
    ctx.activeRepoPath = (cfg.Repos || {})[ctx.activeRepo] || null;
  }
  // Derive the notes namespace: active space name, or '_global' when none.
  ctx.notesNamespace = ctx.activeSpace ? _namespaceFromName(ctx.activeSpace) : '_global';
  return ctx;
}

async function handleUiContextUpdate(req, res) {
  const data = await readBody(req);
  const prevRepo = _uiContext.activeRepo;
  Object.assign(_uiContext, data);
  // Regenerate AI instructions when active repo changes (e.g. No Repo mode toggle)
  if (data.activeRepo !== undefined && data.activeRepo !== prevRepo) {
    try { writePluginHints(); } catch (_) {}
  }
  json(res, { ok: true, context: getUiContextWithPath() });
}

async function handleUiAction(req, res, action) {
  const data = await readBody(req);
  // Normalize: accept "commit" as alias for "hash" in view-commit-diff
  if (action === 'view-commit-diff' && data.commit && !data.hash) {
    data.hash = data.commit;
    delete data.commit;
  }
  broadcast({ type: 'ui-action', action, ...data });
  json(res, { ok: true, action });
}

// Runtime UI mutation: the AI sends a spec (add a tab, show a FAB, collapse a
// panel) and we broadcast it to every connected dashboard. The client applies
// the mutation in-memory and persists it to localStorage so it survives a
// reload without touching source files.
//
// Accepted ops:
//   { op: 'addTab',        id, label, bodyHtml }
//   { op: 'removeTab',     id }
//   { op: 'setTabHidden',  id, hidden }
//   { op: 'addFab',        id, label, icon?, prompt? | href? }
//   { op: 'removeFab',     id }
//   { op: 'setCollapsed',  target, collapsed }   // CSS selector
//   { op: 'reset' }                              // clear all mutations
//
// `bodyHtml` is sanitized client-side; we do not eval anything on the server.
// Focus / context-awareness state. Mirrors agent-native's application-state
// pattern: the UI tells the server what it is currently looking at so any
// AI worker can fetch one URL to know the user's "where" without asking.
let _focusState = {
  activeTab: null,     // "terminal" | "notes" | "files" | ...
  activeRepo: null,    // mirrors /api/ui/context.activeRepo
  currentNote: null,   // selected note name
  selection: '',       // last non-trivial text selection
  updatedAt: 0,
};

function _getFocusState() {
  // Merge in the authoritative activeRepo from /api/ui/context so workers
  // never have to fetch both endpoints.
  const ctx = (typeof getUiContextWithPath === 'function') ? getUiContextWithPath() : {};
  return {
    ..._focusState,
    activeRepo: _focusState.activeRepo || ctx.activeRepo || null,
    activeRepoPath: ctx.activeRepoPath || null,
  };
}

async function handleFocusUpdate(req, res) {
  const data = await readBody(req);
  _focusState = {
    activeTab: data.activeTab ?? _focusState.activeTab,
    activeRepo: data.activeRepo ?? _focusState.activeRepo,
    currentNote: data.currentNote ?? _focusState.currentNote,
    selection: typeof data.selection === 'string' ? data.selection.slice(0, 2000) : _focusState.selection,
    updatedAt: Date.now(),
  };
  json(res, { ok: true });
}

// ── Application state key/value store (agent-native pattern) ───────────────
// General-purpose shared state between UI and AI agents. The UI writes
// navigation state (what the user is looking at); the AI writes a 'navigate'
// command and the UI reads + deletes it. Persisted to disk so it survives
// restarts (except ephemeral keys like 'navigate').
const APP_STATE_MAX_KEYS = 128;
const APP_STATE_EPHEMERAL = new Set(['navigate']);
const _appStatePath = path.join(repoRoot, 'config', 'application-state.json');
let _appStateStore = {};
try {
  if (fs.existsSync(_appStatePath)) {
    _appStateStore = JSON.parse(fs.readFileSync(_appStatePath, 'utf8')) || {};
  }
} catch (_) { _appStateStore = {}; }
let _appStateSaveTimer = null;
function _saveAppState() {
  clearTimeout(_appStateSaveTimer);
  _appStateSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(_appStatePath), { recursive: true });
      // Never persist ephemeral keys.
      const serializable = {};
      for (const [k, v] of Object.entries(_appStateStore)) {
        if (!APP_STATE_EPHEMERAL.has(k)) serializable[k] = v;
      }
      fs.writeFileSync(_appStatePath, JSON.stringify(serializable, null, 2));
    } catch (_) {}
  }, 200);
}
async function handleAppStateWrite(req, res, key) {
  const data = await readBody(req);
  if (Object.keys(_appStateStore).length >= APP_STATE_MAX_KEYS && !(key in _appStateStore)) {
    return json(res, { error: 'too many keys' }, 400);
  }
  _appStateStore[key] = data && Object.prototype.hasOwnProperty.call(data, 'value') ? data.value : data;
  _saveAppState();
  broadcast({ type: 'app-state-set', key, value: _appStateStore[key] });
  json(res, { ok: true, key });
}

async function handleUiMutate(req, res) {
  const data = await readBody(req);
  const ops = Array.isArray(data.ops) ? data.ops : (data.op ? [data] : []);
  if (!ops.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No ops supplied. Pass { op, ... } or { ops: [...] }.' }));
  }
  broadcast({ type: 'ui-mutate', ops });
  json(res, { ok: true, count: ops.length });
}

// ── Utilities ───────────────────────────────────────────────────────────────
// ── Notes Management (namespaced by space) ─────────────────────────────────
// Notes are partitioned into subdirs under `notes/` so each space has its own
// notebook. The special '_global' namespace holds notes taken when no space is
// active. Legacy flat notes (notes/*.md from before this change) are migrated
// into '_global' on boot.
const notesDir = path.join(repoRoot, 'notes');

function _namespaceFromName(name) {
  // Keep a reversible, filesystem-safe slug that avoids collisions with
  // other subdirs.
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || '_global';
}
function _resolveNotesNs(raw) {
  const ns = _namespaceFromName(raw);
  const dir = path.join(notesDir, ns);
  fs.mkdirSync(dir, { recursive: true });
  return { ns, dir };
}
function _pickNotesNsFromReq(source) {
  // Preference order: explicit ns param -> active space -> '_global'
  const explicit = source && (source.ns || source.namespace);
  if (explicit) return _resolveNotesNs(explicit);
  const ctx = getUiContextWithPath();
  return _resolveNotesNs(ctx.notesNamespace || '_global');
}

// Migration: move flat notes/*.md into notes/_global/. Runs on boot AND before
// every list/create/save so manually-dropped flat files (e.g. after a sync or
// restore) get picked up without a restart. Idempotent: a second call is a
// no-op when there are no flat .md files left.
function _migrateLegacyNotes() {
  try {
    if (!fs.existsSync(notesDir)) return;
    const flat = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
    if (!flat.length) return;
    const { dir: globalDir } = _resolveNotesNs('_global');
    let moved = false;
    for (const f of flat) {
      const src = path.join(notesDir, f);
      const dst = path.join(globalDir, f);
      try {
        if (!fs.existsSync(dst)) { fs.renameSync(src, dst); moved = true; }
        else fs.unlinkSync(src); // global already has a same-named note
      } catch (_) {}
    }
    // Re-index after a silent migration so hybrid search sees the moved notes
    // immediately (list endpoint paths don't reindex otherwise).
    if (moved) {
      try { hybridSearch.reindex().catch(() => {}); } catch (_) {}
    }
  } catch (_) {}
}
_migrateLegacyNotes();

function handleListNotes(url, res) {
  try {
    // Catch any flat notes/*.md files that landed after boot (e.g. via sync).
    _migrateLegacyNotes();
    const { dir } = _pickNotesNsFromReq({ ns: url.searchParams.get('ns') });
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f.replace('.md', ''), mtime: st.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    json(res, files);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

function handleReadNote(url, res) {
  const name = url.searchParams.get('name');
  if (!name) return json(res, { error: 'name required' }, 400);
  const { dir } = _pickNotesNsFromReq({ ns: url.searchParams.get('ns') });
  const filePath = path.join(dir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) return json(res, { error: 'Invalid path' }, 403);
  try {
    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    json(res, { name, content });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function handleSaveNote(req, res) {
  const body = await readBody(req);
  const { name, content } = body || {};
  if (!name) return json(res, { error: 'name required' }, 400);
  const { dir } = _pickNotesNsFromReq(body);
  const filePath = path.join(dir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) return json(res, { error: 'Invalid path' }, 403);
  atomicWriteSync(resolved, content || '');
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  hybridSearch.indexNote(resolved).catch(() => {});
  json(res, { ok: true });
}

async function handleCreateNote(req, res) {
  const body = await readBody(req);
  const { name } = body || {};
  if (!name) return json(res, { error: 'name required' }, 400);
  const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  if (!safeName) return json(res, { error: 'Invalid name' }, 400);
  _migrateLegacyNotes();
  const { dir } = _pickNotesNsFromReq(body);
  const filePath = path.join(dir, safeName + '.md');
  if (fs.existsSync(filePath)) return json(res, { error: 'Note already exists' }, 409);
  atomicWriteSync(filePath, `# ${safeName}\n\n`);
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true, name: safeName });
}

function handleExportNote(url, res) {
  const name = url.searchParams.get('name');
  if (!name) return json(res, { error: 'name required' }, 400);
  const { ns, dir } = _pickNotesNsFromReq({ ns: url.searchParams.get('ns') });
  const filePath = path.join(dir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) return json(res, { error: 'Invalid path' }, 403);
  if (!fs.existsSync(resolved)) return json(res, { error: 'Not found' }, 404);
  const bodyTxt = fs.readFileSync(resolved, 'utf8');
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
  // Prefix the filename with the namespace so same-named notes in different
  // spaces don't collide when downloaded into one folder.
  const safeNs = String(ns || '_global').replace(/[\\/:*?"<>|]/g, '_');
  const downloadName = (safeNs === '_global' ? safeName : safeNs + '__' + safeName) + '.md';
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': 'attachment; filename="' + downloadName + '"',
  });
  res.end(bodyTxt);
}

function handleExportAllNotes(res) {
  // Export every namespace in a single payload so round-tripping via import
  // preserves per-space organization.
  const payload = { _exportedAt: new Date().toISOString(), _exportedFrom: 'Symphonee', namespaces: {} };
  try {
    if (fs.existsSync(notesDir)) {
      for (const ns of fs.readdirSync(notesDir)) {
        const nsDir = path.join(notesDir, ns);
        if (!fs.statSync(nsDir).isDirectory()) continue;
        const nsMap = {};
        for (const f of fs.readdirSync(nsDir)) {
          if (!f.endsWith('.md')) continue;
          try { nsMap[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(nsDir, f), 'utf8'); } catch (_) {}
        }
        if (Object.keys(nsMap).length) payload.namespaces[ns] = nsMap;
      }
    }
  } catch (_) {}
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': 'attachment; filename="symphonee-notes.json"',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function handleImportNotes(req, res) {
  const body = await readBody(req);
  // Accepted shapes:
  //   { namespaces: { nsName: { noteName: content, ... }, ... } } (new export-all)
  //   { notes: { noteName: content, ... } } (legacy export-all -> active ns)
  //   { name, content, ns? }                 (single note)
  //   { noteName: content, ... }             (flat map -> active ns)
  let byNs = {};
  if (body && body.namespaces && typeof body.namespaces === 'object') {
    byNs = body.namespaces;
  } else if (body && body.notes && typeof body.notes === 'object') {
    const ns = _namespaceFromName(body.ns);
    byNs[ns] = body.notes;
  } else if (body && body.name && typeof body.content === 'string') {
    const ns = _namespaceFromName(body.ns);
    byNs[ns] = { [body.name]: body.content };
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    const ns = _namespaceFromName(body.ns);
    const map = { ...body }; delete map.ns;
    byNs[ns] = map;
  }
  if (!Object.keys(byNs).length) return json(res, { error: 'Invalid payload' }, 400);
  let written = 0, skipped = 0;
  for (const [nsRaw, map] of Object.entries(byNs)) {
    const { dir } = _resolveNotesNs(nsRaw);
    for (const [name, content] of Object.entries(map || {})) {
      if (typeof content !== 'string') { skipped++; continue; }
      const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
      const dest = path.join(dir, safe + '.md');
      if (!path.resolve(dest).startsWith(path.resolve(dir))) { skipped++; continue; }
      try { fs.writeFileSync(dest, content, 'utf8'); written++; } catch (_) { skipped++; }
    }
  }
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true, written, skipped });
}

async function handleDeleteNote(req, res) {
  const body = await readBody(req);
  const { name } = body || {};
  if (!name) return json(res, { error: 'name required' }, 400);
  const { dir } = _pickNotesNsFromReq(body);
  const filePath = path.join(dir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) return json(res, { error: 'Invalid path' }, 403);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true });
}

// proxyHtmlImages moved to the azure-devops plugin (it only rewrites ADO-hosted image URLs).

function formatAge(date) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = ms / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${hrs.toFixed(1)}h ago`;
  return `${(hrs / 24).toFixed(1)}d ago`;
}

function handleHealthCheck(res) {
  json(res, {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    terminals: terminals.size,
    activeLocks: guard.activeLocks().length,
  });
}

// ── Multi-PTY management ────────────────────────────────────────────────────
const terminals = new Map(); // termId -> { pty, cols, rows }
let defaultCols = 120, defaultRows = 30;

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

function createTerminal(termId, cols = 120, rows = 30, cwd = repoRoot) {
  // Kill existing if same ID
  if (terminals.has(termId)) {
    try { terminals.get(termId).pty.kill(); } catch (_) {}
    terminals.delete(termId);
  }

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

  terminals.set(termId, { pty: ptyProcess, cols, rows });

  ptyProcess.onData(data => broadcast({ type: 'output', termId, data }));
  ptyProcess.onExit(() => {
    terminals.delete(termId);
    broadcast({ type: 'term-exited', termId });
  });

  broadcast({ type: 'term-started', termId, cwd, isNew: true });
  return ptyProcess;
}

function killTerminal(termId) {
  const t = terminals.get(termId);
  if (t) {
    try { t.pty.kill(); } catch (_) {}
    terminals.delete(termId);
  }
}

// Backward compat: currentPty getter for start-working feature
Object.defineProperty(global, 'currentPty', {
  get() { return terminals.has('main') ? terminals.get('main').pty : null; },
});

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // Send list of active terminals
  const active = [];
  for (const [id] of terminals) active.push(id);
  ws.send(JSON.stringify({ type: 'term-list', terminals: active }));

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
          createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows, msg.cwd || repoRoot);
          break;
        }
        case 'kill-term': {
          if (termId !== 'main') killTerminal(termId);
          break;
        }
        case 'restart': {
          createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows);
          break;
        }
      }
    } catch (_) {}
  });
});

// ── Write .claude/CLAUDE.md with plugin instructions for AI ─────────────────
function writePluginHints() {
  // Collect all installed plugins with instructions or keywords
  const pluginData = [];
  try {
    const dirs = fs.readdirSync(pluginsDir);
    for (const dir of dirs) {
      if (dir === 'sdk') continue;
      const mf = path.join(pluginsDir, dir, 'plugin.json');
      if (!fs.existsSync(mf)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const instrFile = manifest.instructions
          ? path.join(pluginsDir, dir, manifest.instructions)
          : path.join(pluginsDir, dir, 'instructions.md');
        let instructions = '';
        if (fs.existsSync(instrFile)) {
          try { instructions = fs.readFileSync(instrFile, 'utf8'); } catch (_) {}
        }
        pluginData.push({
          id: manifest.id,
          name: manifest.name,
          description: manifest.description || '',
          keywords: manifest.aiKeywords || [],
          instructions,
        });
      } catch (_) {}
    }
  } catch (_) {}

  // Build a lightweight plugin keyword index (full instructions are fetched dynamically via /api/plugins/instructions)
  let block = '';
  if (pluginData.length) {
    block += '\n## Installed Plugins\n\n';
    block += '### How Plugins Work\n\n';
    block += 'Plugins extend Symphonee with extra capabilities. Each plugin may provide:\n';
    block += '- **API routes** at `/api/plugins/<plugin-id>/` (call via curl or Invoke-RestMethod)\n';
    block += '- **PowerShell scripts** (`.ps1` files) in `dashboard/plugins/<plugin-id>/scripts/` that you can run directly\n';
    block += '- **Node.js scripts** (`.js` files) that you can run with `node`\n\n';
    block += 'You are in a shell environment (PowerShell or bash). You can run plugin scripts directly without curl if scripts exist. ';
    block += 'Fetch the plugin instructions to discover available scripts and API routes.\n\n';
    block += '### IMPORTANT: Always Ask Before Using a Plugin\n\n';
    block += 'When the user\'s request matches any of the keywords below, **ASK the user if they want to use the plugin** before proceeding. For example: "Would you like to use the Builder.io plugin for this?"\n\n';
    block += 'Do NOT silently use a plugin. Do NOT ignore plugins and search the repo instead. Ask first, then fetch the plugin\'s instructions to learn its capabilities.\n\n';
    for (const p of pluginData) {
      if (p.keywords.length) {
        block += `- **${p.name}** (${p.description}): ${p.keywords.join(', ')}\n`;
      }
    }
    block += '\nTo get detailed plugin instructions (API routes, scripts, workflows), run:\n';
    block += '```bash\ncurl -s http://127.0.0.1:3800/api/plugins/instructions\n```\n';
  }

  // Generate all instruction files from a single template (INSTRUCTIONS.base.md)
  const templatePath = path.join(repoRoot, 'INSTRUCTIONS.base.md');
  const outputFiles = [
    { out: path.join(repoRoot, 'CLAUDE.md'),    filename: 'CLAUDE.md' },
    { out: path.join(repoRoot, 'AGENTS.md'),    filename: 'AGENTS.md' },
    { out: path.join(repoRoot, 'GEMINI.md'),    filename: 'GEMINI.md' },
    { out: path.join(repoRoot, 'GROK.md'),      filename: 'GROK.md' },
    { out: path.join(repoRoot, 'QWEN.md'),      filename: 'QWEN.md' },
    { out: path.join(repoRoot, '.github', 'copilot-instructions.md'), filename: 'copilot-instructions.md' },
  ];
  const START = '<!-- PLUGIN_INSTRUCTIONS_START -->';
  const END = '<!-- PLUGIN_INSTRUCTIONS_END -->';
  const REPO_START = '<!-- REPO_CONTEXT_START -->';
  const REPO_END = '<!-- REPO_CONTEXT_END -->';
  const INCOGNITO_START = '<!-- INCOGNITO_START -->';
  const INCOGNITO_END = '<!-- INCOGNITO_END -->';
  const cfg = getConfig();
  // Orchestration (and Graph Runs) are always on; BETA toggle is gone.
  const uiCtx = getUiContextWithPath();
  const hasRepo = !!uiCtx.activeRepo;
  const incognitoActive = cfg.IncognitoMode === true;

  if (!fs.existsSync(templatePath)) {
    console.warn('  [writePluginHints] template not found: INSTRUCTIONS.base.md');
    return;
  }
  const template = fs.readFileSync(templatePath, 'utf8');

  for (const { out, filename } of outputFiles) {
    try {
      // Replace the filename placeholder
      let content = template.replace('{{FILENAME}}', filename);
      // Orchestration and Graph Runs are always on -- the ORCH_* and GRAPH_*
      // marker pairs are always kept. Markers themselves get cleaned up by
      // the generic pass below so they don't leak into the rendered file.
      // Strip repo-specific context when in No Repo mode (handles multiple marker pairs)
      if (!hasRepo) {
        let rStart, rEnd;
        while ((rStart = content.indexOf(REPO_START)) !== -1 && (rEnd = content.indexOf(REPO_END, rStart)) !== -1) {
          content = content.substring(0, rStart) + content.substring(rEnd + REPO_END.length);
        }
      }
      // Strip incognito section when NOT in incognito mode (include when active)
      if (!incognitoActive) {
        const iStart = content.indexOf(INCOGNITO_START);
        const iEnd = content.indexOf(INCOGNITO_END);
        if (iStart !== -1 && iEnd !== -1) {
          content = content.substring(0, iStart) + content.substring(iEnd + INCOGNITO_END.length);
        }
      }
      // Inject plugin instructions
      const startIdx = content.indexOf(START);
      const endIdx = content.indexOf(END);
      if (startIdx === -1 || endIdx === -1) { console.warn(`  [writePluginHints] markers not found for ${filename}`); continue; }
      const before = content.substring(0, startIdx + START.length);
      const after = content.substring(endIdx);
      // Inject learnings (if the module is loaded)
      // NOTE: learnings are NOT inlined here. They are fetchable via
      // /api/learnings at bootstrap. Inlining pushed CLAUDE.md past 40k
      // chars (Claude Code's warning threshold) and grew with every new
      // entry. The fetch is one extra curl at session start.
      content = before + '\n' + block + '\n' + after;
      atomicWriteSync(out, content);
    } catch (err) { console.error(`  [writePluginHints] failed to generate ${filename}:`, err.message); }
  }
}

// ── Mount orchestrator ───────────────────────────────────────────────────────
const orchestrator = mountOrchestrator(addRoute, json, { terminals, broadcast, repoRoot, createTerminal, getConfig, getLearnings: () => _learningsInstance });
const { mountJobs } = require('./jobs-scheduler');
mountJobs(addRoute, json, { repoRoot, orchestrator, broadcast });
console.log('  Orchestrator bus mounted (/api/orchestrator/*)');

// ── Mount learnings ─────────────────────────────────────────────────────────
const learningsDataDir = path.join(repoRoot, '.ai-workspace');
_learningsInstance = mountLearnings(addRoute, json, { dataDir: learningsDataDir, getConfig, readBody });
console.log('  Learnings module mounted (/api/learnings/*)');
// Pull shared learnings on startup, then regenerate instruction files
_learningsInstance.pull().then(r => {
  if (r.pulled > 0) { console.log(`  Pulled ${r.pulled} shared learning(s)`); writePluginHints(); }
}).catch(() => {});

// ── Hybrid search bootstrap ─────────────────────────────────────────────────
hybridSearch.initialize({ notesDir, learnings: _learningsInstance })
  .then(() => console.log(`  Hybrid search indexed ${hybridSearch.totalDocs} doc(s) across ${hybridSearch.invertedIndex.size} term(s)`))
  .catch(e => console.warn('  [hybrid-search] init error:', e.message));

// ── Mount browser agent ──────────────────────────────────────────────────────
try {
  const { mountBrowserRoutes } = require('./browser-agent');
  const browserAgentInstance = mountBrowserRoutes(addRoute, json, { getConfig, repoRoot, broadcast });
  console.log('  Browser agent mounted (/api/browser/*)');
  try {
    const { mountBrowserAgentChatRoutes } = require('./browser-agent-chat');
    mountBrowserAgentChatRoutes(addRoute, json, { getConfig, agent: browserAgentInstance, broadcast });
    console.log('  Browser agent chat mounted (/api/browser/agent/*)');
  } catch (e2) {
    console.log('  Browser agent chat skipped:', e2.message);
  }
} catch (e) {
  console.log('  Browser agent skipped:', e.message);
}

// ── Mount apps agent (desktop control) ──────────────────────────────────────
try {
  const { mountAppsRoutes } = require('./apps-agent');
  mountAppsRoutes(addRoute, json, { getConfig, broadcast, permGate });
  console.log('  Apps agent mounted (/api/apps/*)');
} catch (e) {
  console.log('  Apps agent skipped:', e.message);
}

// ── Load plugins ─────────────────────────────────────────────────────────────
loadedPlugins = loadPlugins(pluginsDir, {
  addRoute, getConfig, broadcast, json, writePluginHints,
  swrCache: swrPlugins,
  shellDeps: {
    gitExec, sanitizeText, permGate, incognitoGuard,
    getRepoPath, repoRoot,
    https: require('https'),
    fs: require('fs'),
    path: require('path'),
    execSync: require('child_process').execSync,
    spawnSync: require('child_process').spawnSync,
    SWRCache,
    broadcast,
  },
});
if (loadedPlugins.length) console.log(`  Loaded ${loadedPlugins.length} plugin(s)`);
try {
  const rootCfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const migratedRootCfg = normalizeRootConfig(rootCfg);
  if (JSON.stringify(migratedRootCfg) !== JSON.stringify(rootCfg)) {
    atomicWriteSync(configPath, JSON.stringify(migratedRootCfg, null, 2));
    console.log('  Migrated root config');
  }
} catch (_) {}
writePluginHints();

// One-time migration for users upgrading from pre-plugin-first builds: if the
// main config still has AzureDevOpsPAT or GitHubPAT but the corresponding
// plugin is not installed, clone it from the registry so the user's existing
// workflow keeps working after the upgrade. Silent, best-effort; any failure
// leaves the plugin uninstalled and the user can Browse Plugins manually.
(async () => {
  try {
    const cfg = getConfig();
    const wants = [];
    const installedIds = new Set((loadedPlugins || []).map(p => p.id));
    // Skip anything the user uninstalled on purpose -- re-cloning a plugin the
    // user just removed is exactly the "I uninstalled it, restarted, it came
    // back" bug we are fixing.
    let tombstoned = [];
    try {
      const tombPath = path.join(repoRoot, 'config', 'uninstalled-plugins.json');
      if (fs.existsSync(tombPath)) tombstoned = JSON.parse(fs.readFileSync(tombPath, 'utf8')) || [];
    } catch (_) {}
    const isTomb = (id) => Array.isArray(tombstoned) && tombstoned.includes(id);
    if (cfg.AzureDevOpsPAT && !installedIds.has('azure-devops') && !isTomb('azure-devops')) wants.push('azure-devops');
    if (cfg.GitHubPAT       && !installedIds.has('github')       && !isTomb('github'))       wants.push('github');
    if (!wants.length) return;
    console.log(`  Migration: detected ${wants.join('+')} config without plugin. Auto-installing from registry...`);
    const httpsLib = require('https');
    const { execSync } = require('child_process');
    const registry = await new Promise((resolve, reject) => {
      httpsLib.get('https://api.github.com/repos/matandessaur-me/Symphonee-plugins/contents/registry.json',
        { headers: { 'User-Agent': 'Symphonee', 'Accept': 'application/vnd.github.v3+json' } },
        (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }
      ).on('error', reject);
    });
    if (!registry.content) return;
    const reg = JSON.parse(Buffer.from(registry.content, 'base64').toString());
    for (const id of wants) {
      const entry = (reg.plugins || []).find(p => p.id === id);
      if (!entry || !entry.repo) continue;
      const destDir = path.join(pluginsDir, id);
      try {
        execSync('git clone "' + entry.repo + '.git" "' + destDir + '"', { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
        if (!fs.existsSync(path.join(destDir, 'plugin.json'))) {
          fs.rmSync(destDir, { recursive: true, force: true });
          continue;
        }
        console.log(`  Migration: installed ${id}. Restart to activate.`);
      } catch (e) {
        console.warn(`  Migration: failed to install ${id}: ${e.message}`);
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('  Migration: auto-install skipped --', e.message);
  }
})();

// ── AI Instructions endpoint ────────────────────────────────────────────────
// Serves split instruction files from dashboard/instructions/ so CLAUDE.md stays small.
// GET /api/instructions           - merged (all files concatenated)
// GET /api/instructions/api-reference  - just the API reference
(() => {
  const instrDir = path.join(__dirname, 'instructions');
  function readInstrFile(name) {
    const p = path.join(instrDir, name + '.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    return null;
  }
  // Core instructions are plugin-agnostic. Plugin-specific rules live in each
  // plugin's own instructions.md (served by /api/plugins/instructions), so no
  // runtime stripping is needed here.
  function stripPluginMarkers(content) { return content; }
  // Merged: returns all instruction files concatenated (config-aware)
  addRoute('GET', '/api/instructions', (req, res) => {
    try {
      // Order: behavioral rules first (survive compaction better), reference tables last
      const priorityOrder = ['workflows.md', 'orchestrator.md', 'api-reference.md'];
      const files = fs.readdirSync(instrDir).filter(f => f.endsWith('.md')).sort((a, b) => {
        const ai = priorityOrder.indexOf(a), bi = priorityOrder.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
      const sections = files.map(f => stripPluginMarkers(fs.readFileSync(path.join(instrDir, f), 'utf8')));
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(sections.join('\n\n---\n\n'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  // Individual: /api/instructions/{name} serves a single file
  addRoute('__PREFIX__', '/api/instructions', (req, res, url, subpath) => {
    const name = (subpath || '').replace(/^\//, '').replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) { json(res, { error: 'Missing instruction name' }, 400); return; }
    const content = readInstrFile(name);
    if (!content) { json(res, { error: `Instruction "${name}" not found` }, 404); return; }
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(stripPluginMarkers(content));
  });
  console.log('  AI Instructions endpoint mounted (/api/instructions/*)');
})();

// ── Start ───────────────────────────────────────────────────────────────────
function startServer() {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ERROR: Port ${PORT} is already in use.\n`);
      if (!process.env.ELECTRON) process.exit(1);
      return;
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`\n  Symphonee running at ${url}\n`);
    if (!process.env.ELECTRON) exec(`start ${url}`);
  });
}

if (!process.env.ELECTRON) startServer();

process.on('SIGINT', () => {
  for (const [, t] of terminals) { try { t.pty.kill(); } catch (_) {} }
  server.close();
  process.exit(0);
});

module.exports = {
  server, startServer, addRoute, loadedPlugins,
  guard, broadcast, orchestrator,
};
