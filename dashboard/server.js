/**
 * DevOps Pilot — Node.js server
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
};

// ── Pluggable route handlers (Electron adds its own via addRoute) ────────────
const extraRoutes = [];
function addRoute(method, pathname, handler) {
  extraRoutes.push({ method: method.toUpperCase(), pathname, handler });
}

// ── Plugin system ────────────────────────────────────────────────────────────
const { loadPlugins } = require('./plugin-loader');
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
        if (result !== false) return;
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
      const file = path.join(repoRoot, 'recipes', id + '.md');
      if (fs.existsSync(file) && !body.overwrite) {
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
        const file = path.join(repoRoot, 'recipes', id + '.md');
        if (!fs.existsSync(file)) return json(res, { error: 'not found' }, 404);
        fs.unlinkSync(file);
        return json(res, { ok: true, id });
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
          getOrchestrateMode: () => getConfig().OrchestrateMode === true,
        }));
      } catch (e) { return json(res, { error: e.message }, 400); }
    }
    // ── Hybrid Search ─────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/search')) {
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const kindsParam = url.searchParams.get('kinds') || '';
        const kinds = kindsParam ? kindsParam.split(',').map(s => s.trim()).filter(Boolean) : null;
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        return json(res, { query: q, kinds, results: hybridSearch.search(q, { kinds, limit }) });
      }
      if (url.pathname === '/api/search/reindex' && req.method === 'POST') {
        try { return json(res, await hybridSearch.reindex()); }
        catch (e) { return json(res, { error: e.message }, 500); }
      }
      if (url.pathname === '/api/search/stats' && req.method === 'GET') {
        return json(res, { docs: hybridSearch.totalDocs, terms: hybridSearch.invertedIndex.size, avgDocLength: Math.round(hybridSearch.avgDocLength) });
      }
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
      const target = path.join(repoRoot, safe);
      try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
      const opener = process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      try { spawnSync(opener, [target], { detached: true, stdio: 'ignore' }); return json(res, { ok: true, path: target }); }
      catch (e) { return json(res, { error: e.message }, 500); }
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
    // ── Graph Runs (gated by config.OrchestrateMode; graph runs are
    //    part of the AI Orchestration BETA, not a separate feature) ─────
    if (url.pathname.startsWith('/api/graph-runs')) {
      if (getConfig().OrchestrateMode !== true) {
        return json(res, { error: 'Graph Runs requires AI Orchestration. Enable it in Settings -> Other.' }, 501);
      }
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

    // ── Azure DevOps: Iterations ──────────────────────────────────────────
    if (url.pathname === '/api/iterations' && req.method === 'GET') {
      if (incognitoGuard(res, 'read iterations')) return; return handleIterations(res, url);
    }

    // ── Azure DevOps: Work Items ──────────────────────────────────────────
    if (url.pathname === '/api/workitems' && req.method === 'GET') {
      if (incognitoGuard(res, 'read work items')) return; return handleWorkItems(url, res);
    }
    if (url.pathname === '/api/workitems/create' && req.method === 'POST') {
      if (incognitoGuard(res, 'create work item')) return;
      if (!await permGate(res, 'api', 'POST /api/workitems/create', 'Create work item')) return;
      return handleCreateWorkItem(req, res);
    }

    const wiMatch = url.pathname.match(/^\/api\/workitems\/(\d+)$/);
    if (wiMatch && req.method === 'GET') {
      if (incognitoGuard(res, 'read work item')) return; return handleWorkItemDetail(wiMatch[1], res);
    }
    if (wiMatch && req.method === 'PATCH') {
      if (incognitoGuard(res, 'update work item')) return;
      if (!await permGate(res, 'api', `PATCH /api/workitems/${wiMatch[1]}`, `Update work item #${wiMatch[1]}`)) return;
      return handleUpdateWorkItem(wiMatch[1], req, res);
    }

    const wiStateMatch = url.pathname.match(/^\/api\/workitems\/(\d+)\/state$/);
    if (wiStateMatch && req.method === 'PATCH') {
      if (incognitoGuard(res, 'change work item state')) return;
      if (!await permGate(res, 'api', `PATCH /api/workitems/${wiStateMatch[1]}/state`, `Change state of work item #${wiStateMatch[1]}`)) return;
      return handleWorkItemState(wiStateMatch[1], req, res);
    }

    const wiCommentMatch = url.pathname.match(/^\/api\/workitems\/(\d+)\/comments$/);
    if (wiCommentMatch && req.method === 'POST') {
      if (incognitoGuard(res, 'add work item comment')) return;
      if (!await permGate(res, 'api', `POST /api/workitems/${wiCommentMatch[1]}/comments`, `Comment on work item #${wiCommentMatch[1]}`)) return;
      return handleAddWorkItemComment(wiCommentMatch[1], req, res);
    }

    // ── Azure DevOps: Velocity ────────────────────────────────────────────
    if (url.pathname === '/api/velocity' && req.method === 'GET') {
      if (incognitoGuard(res, 'read velocity')) return; return handleVelocity(res);
    }

    // ── Azure DevOps: Teams & Members ─────────────────────────────────────
    if (url.pathname === '/api/teams' && req.method === 'GET') {
      if (incognitoGuard(res, 'read teams')) return; return handleTeams(res);
    }
    if (url.pathname === '/api/team-members' && req.method === 'GET') {
      if (incognitoGuard(res, 'read team members')) return; return handleTeamMembers(res);
    }
    if (url.pathname === '/api/areas' && req.method === 'GET') {
      if (incognitoGuard(res, 'read areas')) return; return handleAreas(res);
    }

    // ── Azure DevOps: Burndown ────────────────────────────────────────────
    if (url.pathname === '/api/burndown' && req.method === 'GET') {
      if (incognitoGuard(res, 'read burndown')) return; return handleBurndown(url, res);
    }

    // ── Repos ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/repos' && req.method === 'GET')  return handleGetRepos(res);
    if (url.pathname === '/api/repos' && req.method === 'POST') return handleSaveRepo(req, res);

    // ── Start Working ─────────────────────────────────────────────────────
    if (url.pathname === '/api/start-working' && req.method === 'POST') {
      if (incognitoGuard(res, 'start working on work item')) return; return handleStartWorking(req, res);
    }

    // ── Pull Requests (ADO) ────────────────────────────────────────────────
    if (url.pathname === '/api/pull-request' && req.method === 'POST') {
      if (incognitoGuard(res, 'create pull request')) return;
      if (!await permGate(res, 'api', 'POST /api/pull-request', 'Create pull request')) return;
      return handleCreatePullRequest(req, res);
    }

    // ── GitHub Pull Requests ────────────────────────────────────────────────
    if (url.pathname === '/api/github/repo-info' && req.method === 'GET') {
      if (incognitoGuard(res, 'read GitHub repo info')) return; return handleGitHubRepoInfo(url, res);
    }
    if (url.pathname === '/api/github/pulls' && req.method === 'GET') {
      if (incognitoGuard(res, 'read GitHub pull requests')) return; return handleGitHubPulls(url, res);
    }
    if (url.pathname === '/api/github/pulls/detail' && req.method === 'GET') {
      if (incognitoGuard(res, 'read GitHub pull request detail')) return; return handleGitHubPullDetail(url, res);
    }
    if (url.pathname === '/api/github/pulls/files' && req.method === 'GET') {
      if (incognitoGuard(res, 'read GitHub pull request files')) return; return handleGitHubPullFiles(url, res);
    }
    if (url.pathname === '/api/github/pulls/comments' && req.method === 'GET') {
      if (incognitoGuard(res, 'read GitHub pull request comments')) return; return handleGitHubPullComments(url, res);
    }
    if (url.pathname === '/api/github/pulls/timeline' && req.method === 'GET') {
      if (incognitoGuard(res, 'read GitHub pull request timeline')) return; return handleGitHubPullTimeline(url, res);
    }
    if (url.pathname === '/api/github/pulls/comment' && req.method === 'POST') {
      if (incognitoGuard(res, 'comment on pull request')) return;
      if (!await permGate(res, 'api', 'POST /api/github/pulls/comment', 'Comment on GitHub PR')) return;
      return handleGitHubAddComment(req, res);
    }
    if (url.pathname === '/api/github/pulls/review' && req.method === 'POST') {
      if (incognitoGuard(res, 'submit pull request review')) return;
      if (!await permGate(res, 'api', 'POST /api/github/pulls/review', 'Submit GitHub PR review')) return;
      return handleGitHubSubmitReview(req, res);
    }
    if (url.pathname === '/api/github/image' && req.method === 'GET')          return handleGitHubImageProxy(url, res);
    if (url.pathname === '/api/github/user-repos' && req.method === 'GET') {
      if (incognitoGuard(res, 'read GitHub repositories')) return; return handleGitHubUserRepos(url, res);
    }
    if (url.pathname === '/api/github/clone' && req.method === 'POST') {
      if (incognitoGuard(res, 'clone GitHub repository')) return; return handleGitHubClone(req, res);
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/notes' && req.method === 'GET')    return handleListNotes(res);
    if (url.pathname === '/api/notes/read' && req.method === 'GET') return handleReadNote(url, res);
    if (url.pathname === '/api/notes/save' && req.method === 'POST') return handleSaveNote(req, res);
    if (url.pathname === '/api/notes/delete' && req.method === 'DELETE') return handleDeleteNote(req, res);
    if (url.pathname === '/api/notes/create' && req.method === 'POST') return handleCreateNote(req, res);

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
          const orchestrationEnabled = cfg.OrchestrateMode === true;
          const priorityOrder = ['workflows.md', 'orchestrator.md', 'api-reference.md'];
          const files = fs.readdirSync(instrDir).filter(f => {
            if (!f.endsWith('.md')) return false;
            if (f === 'orchestrator.md' && !orchestrationEnabled) return false;
            return true;
          }).sort((a, b) => {
            const ai = priorityOrder.indexOf(a), bi = priorityOrder.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
          });
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
            orchestrateMode: cfg.OrchestrateMode === true,
            graphRunsMode: cfg.OrchestrateMode === true,
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
        const log = path.join(repoRoot, '.devops-pilot', 'bootstrap-acks.jsonl');
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
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// ── Config API ──────────────────────────────────────────────────────────────
function getConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  try { return JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch (_) {}
  return {};
}

// ── Incognito Mode guard ─────────────────────────────────────────────────
function isIncognito() { return getConfig().IncognitoMode === true; }
function incognitoGuard(res, action) {
  if (isIncognito()) {
    json(res, { error: `Blocked by Incognito Mode: "${action}" is not available in incognito. All Azure DevOps, GitHub, and remote operations are disabled. Turn off incognito in Settings to proceed.`, incognito: true }, 403);
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
  const config = { ...template, ...existing, ...incoming };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicWriteSync(configPath, JSON.stringify(config, null, 2));
  // Immediately clear all caches so the next request uses the new config
  teamAreasCache = { data: null, team: null, ts: 0 };
  areasCache = { data: null, ts: 0 };
  iterationsCache = { data: null, ts: 0 };
  workItemsCache = { data: null, key: null, ts: 0 };
  swrIterations.clear(); swrWorkItems.clear(); swrTeamAreas.clear(); swrAreas.clear(); swrGit.clear(); swrGitHub.clear(); swrPlugins.clear();
  // Regenerate AI instructions (incognito, orchestration, etc. may have changed)
  try { writePluginHints(); } catch (_) {}
  json(res, { ok: true });
}

// Sensitive fields to strip from exports (PATs, API keys)
const SENSITIVE_KEYS = ['AzureDevOpsPAT', 'GitHubPAT', 'WhisperKey', 'AiApiKeys'];

function handleExportConfig(res) {
  const cfg = getConfig();
  // Strip machine-specific fields only (repos have local paths)
  const exportCfg = { ...cfg };
  delete exportCfg.Repos;
  exportCfg._exportedAt = new Date().toISOString();
  exportCfg._exportedFrom = 'DevOps Pilot';
  // Collect plugin configs
  const pluginConfigs = {};
  try {
    const dirs = fs.readdirSync(pluginsDir);
    for (const dir of dirs) {
      if (dir === 'sdk') continue;
      const cfgFile = path.join(pluginsDir, dir, 'config.json');
      if (fs.existsSync(cfgFile)) {
        try { pluginConfigs[dir] = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
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
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': 'attachment; filename="devops-pilot-settings.json"',
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
  delete incoming.Repos;  // Repos have local paths -- never import them
  // Restore plugin configs
  // Restore themes
  const importedThemes = incoming._themes;
  delete incoming._themes;
  if (importedThemes && typeof importedThemes === 'object') {
    try {
      fs.mkdirSync(path.dirname(themesPath), { recursive: true });
      fs.writeFileSync(themesPath, JSON.stringify(importedThemes, null, 2), 'utf8');
    } catch (_) {}
  }
  // Restore plugin configs (and auto-install missing plugins from registry)
  const pluginConfigs = incoming._pluginConfigs;
  delete incoming._pluginConfigs;
  const installedPlugins = [];
  if (pluginConfigs && typeof pluginConfigs === 'object') {
    // Find which plugins need installing
    const missingPluginIds = [];
    for (const pluginId of Object.keys(pluginConfigs)) {
      const pluginDir = path.join(pluginsDir, pluginId);
      if (fs.existsSync(pluginDir)) {
        // Already installed, just write config
        try { fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify(pluginConfigs[pluginId], null, 2), 'utf8'); } catch (_) {}
      } else {
        missingPluginIds.push(pluginId);
      }
    }
    // Auto-install missing plugins from registry
    if (missingPluginIds.length > 0) {
      try {
        const https = require('https');
        const REGISTRY_API_URL = 'https://api.github.com/repos/matandessaur-me/devops-pilot-plugins/contents/registry.json';
        const raw = await new Promise((resolve, reject) => {
          https.get(REGISTRY_API_URL, { headers: { 'User-Agent': 'DevOps-Pilot', 'Accept': 'application/vnd.github.v3+json' } }, (resp) => {
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
                // Write the config from the export
                fs.writeFileSync(path.join(destDir, 'config.json'), JSON.stringify(pluginConfigs[pluginId], null, 2), 'utf8');
                installedPlugins.push(pluginId);
              } else {
                // Not a valid plugin, clean up
                fs.rmSync(destDir, { recursive: true, force: true });
              }
            } catch (_) {
              // Clone failed, skip this plugin
              try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
            }
          }
        }
      } catch (_) {
        // Registry fetch failed, skip auto-install
      }
    }
    if (installedPlugins.length > 0) writePluginHints();
  }
  // Merge with existing config (preserve existing PATs if not provided)
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  const config = { ...existing, ...incoming };
  // Restore sensitive fields from existing if not in import
  for (const key of SENSITIVE_KEYS) {
    if (!incoming[key] && existing[key]) config[key] = existing[key];
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicWriteSync(configPath, JSON.stringify(config, null, 2));
  teamAreasCache = { data: null, team: null, ts: 0 };
  areasCache = { data: null, ts: 0 };
  iterationsCache = { data: null, ts: 0 };
  workItemsCache = { data: null, key: null, ts: 0 };
  swrIterations.clear(); swrWorkItems.clear(); swrTeamAreas.clear(); swrAreas.clear(); swrGit.clear(); swrGitHub.clear(); swrPlugins.clear();
  const result = { ok: true };
  if (installedPlugins.length > 0) {
    result.pluginsInstalled = installedPlugins;
    result.restartRequired = true;
  }
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
        teamAreasCache = { data: null, team: null, ts: 0 };
        areasCache = { data: null, ts: 0 };
        iterationsCache = { data: null, ts: 0 };
        workItemsCache = { data: null, key: null, ts: 0 };
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

  for (const id of ['claude', 'gemini', 'copilot', 'codex', 'grok']) {
    result.cliTools[id] = detectCli(id);
  }

  result.pwsh = detectPwsh();

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    result.config.exists = true;
    result.config.complete = !!(cfg.AzureDevOpsOrg && cfg.AzureDevOpsProject && cfg.AzureDevOpsPAT);
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

// ── Azure DevOps API Helper ─────────────────────────────────────────────────
function adoRequest(method, apiPath, body, contentType, _skipTeam) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const project = cfg.AzureDevOpsProject;
    const pat = cfg.AzureDevOpsPAT;
    const team = cfg.DefaultTeam;
    if (!org || !project || !pat) {
      return reject(new Error('Azure DevOps not configured. Set Org, Project, and PAT in Settings.'));
    }

    // Only /work/ endpoints are team-scoped in ADO. /wit/ endpoints are project-scoped.
    const useTeam = !_skipTeam && team && apiPath.startsWith('/work/');
    const teamSegment = useTeam ? `/${encodeURIComponent(team)}` : '';
    const url = new URL(`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}${teamSegment}/_apis${apiPath}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(':' + pat).toString('base64'),
        'Content-Type': contentType || 'application/json',
        'Accept': 'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
        } else if (resp.statusCode === 404 && useTeam && !_skipTeam) {
          // Team not found in this project — retry without team segment
          adoRequest(method, apiPath, body, contentType, true).then(resolve, reject);
        } else {
          const msg = resp.statusCode === 401
            ? 'Authentication failed — PAT may be expired or invalid'
            : `Azure DevOps API error (${resp.statusCode}): ${data.slice(0, 200)}`;
          reject(new Error(msg));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ADO request to org-level APIs (no project in path)
function adoOrgRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const pat = cfg.AzureDevOpsPAT;
    if (!org || !pat) return reject(new Error('Azure DevOps not configured.'));

    const url = new URL(`https://dev.azure.com/${encodeURIComponent(org)}/_apis${apiPath}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(':' + pat).toString('base64'),
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
        } else {
          reject(new Error(`ADO org API error (${resp.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── GitHub API Helper ────────────────────────────────────────────────────────
function parseGitHubRemote(repoPath) {
  const url = gitExec(repoPath, 'remote get-url origin');
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function ghRequest(method, apiPath, body, accept) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const pat = cfg.GitHubPAT;
    if (!pat) return reject(new Error('GitHub PAT not configured. Set it in Settings.'));
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `token ${pat}`,
        'Accept': accept || 'application/vnd.github+json',
        'User-Agent': 'DevOps-Pilot',
        'Content-Type': 'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
        } else {
          const msg = resp.statusCode === 401
            ? 'GitHub auth failed — PAT may be expired or invalid'
            : `GitHub API error (${resp.statusCode}): ${data.slice(0, 300)}`;
          reject(new Error(msg));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── SWR Caches (stale-while-revalidate) ─────────────────────────────────────
// Legacy cache vars kept for backward compatibility with cache invalidation code.
// New SWR caches provide better UX: return stale data instantly, refresh in background.
let iterationsCache = { data: null, ts: 0 };
let workItemsCache = { data: null, key: null, ts: 0 };
let teamAreasCache = { data: null, team: null, ts: 0 };
let areasCache = { data: null, ts: 0 };
const ITER_CACHE_TTL = 300000;
const WI_CACHE_TTL = 30000;
const TEAM_AREAS_TTL = 600000; // 10 min
const AREAS_CACHE_TTL = 600000; // 10 min

const swrIterations = new SWRCache({ staleTTL: 60000, maxAge: 300000, onRevalidate: (key, data) => broadcast({ type: 'cache-updated', cache: 'iterations', data }) });
const swrWorkItems = new SWRCache({ staleTTL: 15000, maxAge: 60000, onRevalidate: (key, data) => broadcast({ type: 'cache-updated', cache: 'workitems', key, data }) });
const swrTeamAreas = new SWRCache({ staleTTL: 300000, maxAge: 600000 });
const swrAreas = new SWRCache({ staleTTL: 300000, maxAge: 600000 });
const swrGit = new SWRCache({ staleTTL: 10000, maxAge: 60000 });        // git branches/status (10s fresh, 60s max)
const swrGitHub = new SWRCache({ staleTTL: 30000, maxAge: 120000 });    // github PRs (30s fresh, 2min max)
const swrPlugins = new SWRCache({ staleTTL: 30000, maxAge: 300000 });   // general purpose for plugins

// ── Busy Guards ─────────────────────────────────────────────────────────────
const guard = new BusyGuard();

// ── Get team area paths (SWR cached) ────────────────────────────────────────
async function getTeamAreaPaths() {
  const cfg = getConfig();
  const team = cfg.DefaultTeam;
  if (!team) return null;

  try {
    return await swrTeamAreas.get('teamAreas:' + team, async () => {
      const data = await adoRequest('GET', `/work/teamsettings/teamfieldvalues?api-version=7.1`);
      const areas = (data.values || []).map(v => v.value).filter(Boolean);
      teamAreasCache = { data: areas, team, ts: Date.now() };
      return areas;
    });
  } catch (_) {
    return null;
  }
}

// ── Iterations (SWR cached -- returns stale data instantly, refreshes in background) ──
async function fetchIterations() {
  const data = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
  const now = new Date();
  const iterations = (data.value || []).map(it => {
    const startDate = it.attributes?.startDate ? new Date(it.attributes.startDate) : null;
    const finishDate = it.attributes?.finishDate ? new Date(it.attributes.finishDate) : null;
    const isCurrent = startDate && finishDate && now >= startDate && now <= finishDate;
    return {
      id: it.id, name: it.name, path: it.path,
      startDate: it.attributes?.startDate || null,
      finishDate: it.attributes?.finishDate || null,
      timeFrame: it.attributes?.timeFrame || null,
      isCurrent,
    };
  });
  iterations.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    const da = a.startDate ? new Date(a.startDate) : new Date(0);
    const db = b.startDate ? new Date(b.startDate) : new Date(0);
    return db - da;
  });
  // Also update legacy cache for backward compat
  iterationsCache = { data: iterations, ts: Date.now() };
  return iterations;
}

async function handleIterations(res, url) {
  try {
    const forceRefresh = url && url.searchParams.get('refresh') === '1';
    const iterations = await swrIterations.get('iterations', fetchIterations, { forceRefresh });
    json(res, iterations);
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
  }
}

// ── Work Items List ─────────────────────────────────────────────────────────
async function handleWorkItems(url, res) {
  const refresh = url.searchParams.get('refresh') === '1';
  const iterationPath = url.searchParams.get('iteration') || '';
  const state = url.searchParams.get('state') || '';
  const type = url.searchParams.get('type') || '';
  const assignedTo = url.searchParams.get('assignedTo') || '';
  const areaPath = url.searchParams.get('area') || '';
  const closedTopParam = url.searchParams.get('closedTop');
  const closedTop = Math.min(parseInt(closedTopParam || '10', 10) || 10, 200);
  // When closedTop is explicitly passed (by the dashboard), fetch closed items separately
  // When not passed (by scripts), use legacy behavior (exclude closed entirely)
  const noClosedFilter = !iterationPath && !state;
  const fetchClosedSeparately = noClosedFilter && closedTopParam !== null;
  const cacheKey = `${iterationPath}|${state}|${type}|${assignedTo}|${areaPath}|ct${closedTopParam !== null ? closedTop : '-'}`;

  try {
    const result = await swrWorkItems.get('wi:' + cacheKey, () => fetchWorkItemsData(iterationPath, state, type, assignedTo, areaPath, closedTop, fetchClosedSeparately, noClosedFilter, cacheKey), { forceRefresh: refresh });
    return json(res, result);
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
  }
}

async function fetchWorkItemsData(iterationPath, state, type, assignedTo, areaPath, closedTop, fetchClosedSeparately, noClosedFilter, cacheKey) {
    // Build area path clause (reused for both queries)
    // If an explicit area is selected, use it; otherwise fall back to team area paths
    let areaClause = '';
    if (areaPath) {
      areaClause = ` AND [System.AreaPath] UNDER '${areaPath}'`;
    } else {
      const teamAreas = await getTeamAreaPaths();
      if (teamAreas && teamAreas.length > 0) {
        const areaConditions = teamAreas.map(a => `[System.AreaPath] UNDER '${a}'`).join(' OR ');
        areaClause = ` AND (${areaConditions})`;
      }
    }

    let wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] NOT IN ('Removed')`;
    // Without an iteration filter, exclude Closed to avoid 20k+ results
    if (noClosedFilter) wiqlQuery += ` AND [System.State] NOT IN ('Closed', 'Done')`;
    wiqlQuery += areaClause;
    if (iterationPath) wiqlQuery += ` AND [System.IterationPath] = '${iterationPath}'`;
    if (state)         wiqlQuery += ` AND [System.State] = '${state}'`;
    if (type)          wiqlQuery += ` AND [System.WorkItemType] = '${type}'`;
    if (assignedTo)    wiqlQuery += ` AND [System.AssignedTo] = '${assignedTo}'`;
    wiqlQuery += ` ORDER BY [System.ChangedDate] DESC`;

    // Run main query (and closed query in parallel when needed)
    const mainPromise = adoRequest('POST', '/wit/wiql?$top=200&api-version=7.1', { query: wiqlQuery });

    let closedPromise = null;
    if (fetchClosedSeparately) {
      // Fetch closed IDs with a cap -- only need closedTop items + 1 to know if there are more
      let closedQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] IN ('Closed', 'Done') AND [System.State] NOT IN ('Removed')`;
      closedQuery += areaClause;
      if (type)       closedQuery += ` AND [System.WorkItemType] = '${type}'`;
      if (assignedTo) closedQuery += ` AND [System.AssignedTo] = '${assignedTo}'`;
      closedQuery += ` ORDER BY [System.ChangedDate] DESC`;
      // Cap the WIQL query to avoid fetching 20k+ IDs on large projects.
      // Use max(closedTop, 200) + 1 so we get a useful count for the "X of Y" label
      // while still knowing if there are more beyond the cap.
      const closedCap = Math.max(closedTop, 200) + 1;
      closedPromise = adoRequest('POST', `/wit/wiql?$top=${closedCap}&api-version=7.1`, { query: closedQuery });
    }

    const [wiql, closedWiql] = await Promise.all([mainPromise, closedPromise]);

    const mainIds = (wiql.workItems || []).map(w => w.id).slice(0, 200);
    let closedIds = [];
    let hasMoreClosed = false;
    let totalClosed = 0;
    let totalClosedCapped = false;

    if (closedWiql) {
      const returnedClosedIds = (closedWiql.workItems || []).map(w => w.id);
      const closedCap = Math.max(closedTop, 200);
      // If ADO returned more than closedCap, the true total is unknown (capped)
      totalClosedCapped = returnedClosedIds.length > closedCap;
      hasMoreClosed = returnedClosedIds.length > closedTop;
      closedIds = returnedClosedIds.slice(0, closedTop);
      totalClosed = totalClosedCapped ? closedCap : returnedClosedIds.length;
    }

    const allIds = [...new Set([...mainIds, ...closedIds])];

    if (allIds.length === 0) {
      const emptyResult = fetchClosedSeparately ? { items: [], hasMoreClosed: false, totalClosed: 0, totalClosedCapped: false } : [];
      workItemsCache = { data: emptyResult, key: cacheKey, ts: Date.now() };
      return json(res, emptyResult);
    }

    // Fetch details in batches of 200 (API limit)
    const batches = [];
    for (let i = 0; i < allIds.length; i += 200) {
      batches.push(allIds.slice(i, i + 200));
    }
    const detailResults = await Promise.all(batches.map(batch =>
      adoRequest('GET',
        `/wit/workitems?ids=${batch.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.Tags,System.CreatedDate,System.ChangedDate,Microsoft.VSTS.Common.Priority,System.IterationPath,Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort,System.Parent&api-version=7.1`
      )
    ));

    const items = detailResults.flatMap(d => (d.value || []).map(wi => {
      const f = wi.fields;
      return {
        id: wi.id,
        title: f['System.Title'],
        state: f['System.State'],
        type: f['System.WorkItemType'],
        assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : '',
        tags: f['System.Tags'] || '',
        changedDate: f['System.ChangedDate'],
        priority: f['Microsoft.VSTS.Common.Priority'] || 0,
        iterationPath: f['System.IterationPath'] || '',
        storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] || f['Microsoft.VSTS.Scheduling.Effort'] || '',
        createdDate: f['System.CreatedDate'] || '',
        parentId: f['System.Parent'] || null,
      };
    }));

    // When excluding closed (no iteration/state filter), return wrapped format with pagination info
    // Otherwise return flat array for backward compat with scripts
    const result = fetchClosedSeparately ? { items, hasMoreClosed, totalClosed, totalClosedCapped } : items;
    workItemsCache = { data: result, key: cacheKey, ts: Date.now() };
    return result;
}

// ── Work Item Detail ────────────────────────────────────────────────────────
async function handleWorkItemDetail(id, res) {
  try {
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const project = cfg.AzureDevOpsProject;

    const [wi, commentsData] = await Promise.all([
      adoRequest('GET', `/wit/workitems/${id}?$expand=all&api-version=7.1`),
      adoRequest('GET', `/wit/workitems/${id}/comments?api-version=7.1-preview.4`).catch(() => ({ comments: [] })),
    ]);

    const f = wi.fields;

    const attachments = [];
    const linkedItems = [];
    (wi.relations || []).forEach(rel => {
      if (rel.rel === 'AttachedFile') {
        attachments.push({
          name: rel.attributes?.name || 'attachment',
          url: rel.url,
          comment: rel.attributes?.comment || '',
        });
      } else {
        const idMatch = rel.url?.match(/workItems\/(\d+)/i);
        linkedItems.push({
          rel: rel.rel,
          title: rel.attributes?.name || '',
          comment: rel.attributes?.comment || '',
          id: idMatch ? parseInt(idMatch[1]) : null,
          url: rel.url,
        });
      }
    });

    const comments = (commentsData.comments || []).map(c => ({
      id: c.id,
      text: proxyHtmlImages(c.text || ''),
      author: c.createdBy ? c.createdBy.displayName : '',
      date: c.createdDate || '',
    }));

    json(res, {
      id: wi.id,
      title: f['System.Title'],
      state: f['System.State'],
      type: f['System.WorkItemType'],
      assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : '',
      createdBy: f['System.CreatedBy'] ? f['System.CreatedBy'].displayName : '',
      tags: f['System.Tags'] || '',
      createdDate: f['System.CreatedDate'] || '',
      changedDate: f['System.ChangedDate'],
      priority: f['Microsoft.VSTS.Common.Priority'] || 0,
      severity: f['Microsoft.VSTS.Common.Severity'] || '',
      storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] || '',
      effort: f['Microsoft.VSTS.Scheduling.Effort'] || '',
      reason: f['System.Reason'] || '',
      description: proxyHtmlImages(f['System.Description'] || ''),
      acceptanceCriteria: proxyHtmlImages(f['Microsoft.VSTS.Common.AcceptanceCriteria'] || ''),
      reproSteps: proxyHtmlImages(f['Microsoft.VSTS.TCM.ReproSteps'] || ''),
      areaPath: f['System.AreaPath'] || '',
      iterationPath: f['System.IterationPath'] || '',
      attachments,
      linkedItems,
      comments,
      webUrl: org && project ? `https://dev.azure.com/${org}/${project}/_workitems/edit/${wi.id}` : '',
    });
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
  }
}

// ── Update Work Item (with busy guard) ──────────────────────────────────────
async function handleUpdateWorkItem(id, req, res) {
  try {
    await guard.run(`workitem:${id}`, `Updating work item ${id}`, async () => {
      const body = await readBody(req);
      const patchDoc = [];

      const fieldMap = {
        title: '/fields/System.Title',
        description: '/fields/System.Description',
        state: '/fields/System.State',
        assignedTo: '/fields/System.AssignedTo',
        priority: '/fields/Microsoft.VSTS.Common.Priority',
        tags: '/fields/System.Tags',
        iterationPath: '/fields/System.IterationPath',
        areaPath: '/fields/System.AreaPath',
        storyPoints: '/fields/Microsoft.VSTS.Scheduling.StoryPoints',
        acceptanceCriteria: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
      };

      const textFields = ['title', 'description', 'tags', 'acceptanceCriteria'];
      for (const [key, path] of Object.entries(fieldMap)) {
        if (body[key] !== undefined) {
          const val = textFields.includes(key) ? sanitizeText(body[key]) : body[key];
          patchDoc.push({ op: 'replace', path, value: val });
        }
      }

      if (patchDoc.length === 0) return json(res, { error: 'No fields to update' }, 400);

      const result = await adoRequest('PATCH', `/wit/workitems/${id}?api-version=7.1`, patchDoc, 'application/json-patch+json');
      workItemsCache = { data: null, ts: 0 };
      swrWorkItems.invalidate('wi:');
      broadcast({ type: 'ui-action', action: 'refresh-workitems' });
      json(res, { ok: true, id: result.id });
    });
  } catch (e) {
    const status = e.message.includes('busy') ? 409 : 502;
    json(res, { error: e.message }, status);
  }
}

// ── Change Work Item State ──────────────────────────────────────────────────
async function handleWorkItemState(id, req, res) {
  try {
    const { state } = await readBody(req);
    if (!state) return json(res, { error: 'state is required' }, 400);

    const result = await adoRequest('PATCH',
      `/wit/workitems/${id}?api-version=7.1`,
      [{ op: 'replace', path: '/fields/System.State', value: state }],
      'application/json-patch+json'
    );
    workItemsCache = { data: null, ts: 0 };
    swrWorkItems.invalidate('wi:');
    broadcast({ type: 'ui-action', action: 'refresh-workitems' });
    json(res, { ok: true, id: result.id, state: result.fields['System.State'] });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Add Work Item Comment ──────────────────────────────────────────────────
async function handleAddWorkItemComment(id, req, res) {
  try {
    const { text } = await readBody(req);
    if (!text) return json(res, { error: 'text is required' }, 400);
    const result = await adoRequest('POST',
      `/wit/workitems/${id}/comments?api-version=7.1-preview.4`,
      { text: sanitizeText(text) }
    );
    json(res, { ok: true, id: result.id, text: result.text, author: result.createdBy?.displayName || '', date: result.createdDate || '' });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Create Work Item ────────────────────────────────────────────────────────
// Strip non-ASCII control chars and replacement characters (U+FFFD, etc.)
// Keeps standard printable ASCII, common Unicode letters/symbols, and whitespace.
function sanitizeText(str) {
  if (!str) return str;
  return str
    .replace(/[\u2014]/g, '--')                   // em dash -> --
    .replace(/[\u2013]/g, '-')                    // en dash -> -
    .replace(/[\u2018\u2019\u201A]/g, "'")        // smart single quotes -> '
    .replace(/[\u201C\u201D\u201E]/g, '"')        // smart double quotes -> "
    .replace(/[\u2026]/g, '...')                   // ellipsis -> ...
    .replace(/[\u00A0]/g, ' ')                     // non-breaking space -> space
    .replace(/[\uFFFD\uFFFE\uFFFF]/g, '')         // replacement/noncharacters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // control chars (keep \t \n \r)
    .replace(/[\uD800-\uDFFF]/g, '')              // lone surrogates
    .trim();
}

async function handleCreateWorkItem(req, res) {
  try {
    const { type, title, description, priority, tags, assignedTo, iterationPath, storyPoints, acceptanceCriteria } = await readBody(req);
    if (!type || !title) return json(res, { error: 'type and title are required' }, 400);

    const patchDoc = [
      { op: 'add', path: '/fields/System.Title', value: sanitizeText(title) },
    ];
    if (description)       patchDoc.push({ op: 'add', path: '/fields/System.Description', value: sanitizeText(description) });
    if (priority)          patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: parseInt(priority, 10) || 2 });
    if (tags)              patchDoc.push({ op: 'add', path: '/fields/System.Tags', value: sanitizeText(tags) });
    if (assignedTo)        patchDoc.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignedTo });
    if (iterationPath)     patchDoc.push({ op: 'add', path: '/fields/System.IterationPath', value: iterationPath });
    if (storyPoints)       patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: parseFloat(storyPoints) });
    if (acceptanceCriteria) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: sanitizeText(acceptanceCriteria) });

    const wiType = encodeURIComponent(type);
    const result = await adoRequest('POST', `/wit/workitems/$${wiType}?api-version=7.1`, patchDoc, 'application/json-patch+json');
    workItemsCache = { data: null, ts: 0 };
    broadcast({ type: 'ui-action', action: 'refresh-workitems' });

    const cfg = getConfig();
    json(res, {
      ok: true,
      id: result.id,
      title: result.fields['System.Title'],
      url: cfg.AzureDevOpsOrg && cfg.AzureDevOpsProject
        ? `https://dev.azure.com/${cfg.AzureDevOpsOrg}/${cfg.AzureDevOpsProject}/_workitems/edit/${result.id}`
        : null,
    });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Velocity (story points per completed sprint) ────────────────────────────
async function handleVelocity(res) {
  try {
    // Get all iterations
    const iterData = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
    const now = new Date();
    // Only past (finished) sprints — last 10
    const pastIterations = (iterData.value || [])
      .filter(it => {
        const finish = it.attributes?.finishDate ? new Date(it.attributes.finishDate) : null;
        return finish && finish < now;
      })
      .sort((a, b) => new Date(a.attributes.startDate) - new Date(b.attributes.startDate))
      .slice(-10);

    const velocity = [];
    for (const it of pastIterations) {
      // Get completed items in this iteration
      const wiql = await adoRequest('POST', '/wit/wiql?$top=200&api-version=7.1', {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${it.path}' AND [System.State] IN ('Closed', 'Resolved', 'Done') ORDER BY [System.Id]`,
      });
      const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);
      let totalPoints = 0;
      let completedCount = 0;

      if (ids.length > 0) {
        const details = await adoRequest('GET',
          `/wit/workitems?ids=${ids.join(',')}&fields=Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort&api-version=7.1`
        );
        for (const wi of (details.value || [])) {
          const pts = wi.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || wi.fields['Microsoft.VSTS.Scheduling.Effort'] || 0;
          totalPoints += pts;
          completedCount++;
        }
      }

      velocity.push({
        iteration: it.name,
        path: it.path,
        startDate: it.attributes?.startDate,
        finishDate: it.attributes?.finishDate,
        completedPoints: totalPoints,
        completedCount,
      });
    }

    const avg = velocity.length > 0
      ? velocity.reduce((sum, v) => sum + v.completedPoints, 0) / velocity.length
      : 0;

    json(res, { velocity, averageVelocity: Math.round(avg * 10) / 10 });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Burndown ────────────────────────────────────────────────────────────────
async function handleBurndown(url, res) {
  const iterationPath = url.searchParams.get('iteration') || '';
  if (!iterationPath) return json(res, { error: 'iteration parameter required' }, 400);

  try {
    // Get iteration dates
    const iterData = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
    const iteration = (iterData.value || []).find(it => it.path === iterationPath);
    if (!iteration) return json(res, { error: 'Iteration not found' }, 404);

    const startDate = new Date(iteration.attributes?.startDate);
    const finishDate = new Date(iteration.attributes?.finishDate);

    // Get all items in this iteration with points
    const wiql = await adoRequest('POST', '/wit/wiql?$top=200&api-version=7.1', {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${iterationPath}' AND [System.State] NOT IN ('Removed') ORDER BY [System.Id]`,
    });
    const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);

    let totalPoints = 0;
    let completedPoints = 0;
    let items = [];

    if (ids.length > 0) {
      const details = await adoRequest('GET',
        `/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort,System.ChangedDate&api-version=7.1`
      );
      items = (details.value || []).map(wi => {
        const pts = wi.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || wi.fields['Microsoft.VSTS.Scheduling.Effort'] || 0;
        const state = wi.fields['System.State'];
        const isDone = ['Closed', 'Resolved', 'Done'].includes(state);
        totalPoints += pts;
        if (isDone) completedPoints += pts;
        return { id: wi.id, title: wi.fields['System.Title'], state, points: pts, isDone, changedDate: wi.fields['System.ChangedDate'] };
      });
    }

    json(res, {
      iteration: iteration.name,
      startDate: iteration.attributes?.startDate,
      finishDate: iteration.attributes?.finishDate,
      totalPoints,
      completedPoints,
      remainingPoints: totalPoints - completedPoints,
      totalItems: items.length,
      completedItems: items.filter(i => i.isDone).length,
      items,
    });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Team Members ────────────────────────────────────────────────────────────
// List all teams in the project
async function handleTeams(res) {
  try {
    const cfg = getConfig();
    const project = cfg.AzureDevOpsProject;
    const data = await adoOrgRequest('GET',
      `/projects/${encodeURIComponent(project)}/teams?api-version=7.1`
    );
    const teams = (data.value || []).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description || '',
    }));
    json(res, teams);
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Area Paths ──────────────────────────────────────────────────────────────
async function handleAreas(res) {
  try {
    const areas = await swrAreas.get('areas', async () => {
      const data = await adoRequest('GET',
        `/wit/classificationnodes/Areas?$depth=10&api-version=7.1`, null, null, true
      );
      const result = [];
      function walk(node, prefix) {
        const p = prefix ? `${prefix}\\${node.name}` : node.name;
        result.push(p);
        if (node.children) {
          for (const child of node.children) walk(child, p);
        }
      }
      if (data.name) walk(data, '');
      areasCache = { data: result, ts: Date.now() };
      return result;
    });
    json(res, areas);
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// List members — collect from ALL teams to get full picture
async function handleTeamMembers(res) {
  try {
    const cfg = getConfig();
    const project = cfg.AzureDevOpsProject;

    // Get all teams first
    const teamsData = await adoOrgRequest('GET',
      `/projects/${encodeURIComponent(project)}/teams?api-version=7.1`
    );

    // Fetch members from all teams in parallel
    const memberMap = new Map();
    const fetches = (teamsData.value || []).map(t =>
      adoOrgRequest('GET',
        `/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(t.name)}/members?api-version=7.1`
      ).catch(() => ({ value: [] }))
    );
    const results = await Promise.all(fetches);

    for (const data of results) {
      for (const m of (data.value || [])) {
        const id = m.identity?.id;
        if (id && !memberMap.has(id)) {
          memberMap.set(id, {
            id,
            displayName: m.identity?.displayName || '',
            uniqueName: m.identity?.uniqueName || '',
            imageUrl: m.identity?.imageUrl || '',
          });
        }
      }
    }

    const members = [...memberMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    json(res, members);
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Repos Management ────────────────────────────────────────────────────────
function handleGetRepos(res) {
  const cfg = getConfig();
  json(res, cfg.Repos || {});
}

async function handleSaveRepo(req, res) {
  const { name, path: repoPath } = await readBody(req);
  if (!name || !repoPath) return json(res, { error: 'name and path are required' }, 400);
  const cfg = getConfig();
  cfg.Repos = cfg.Repos || {};
  cfg.Repos[name] = repoPath;
  atomicWriteSync(configPath, JSON.stringify(cfg, null, 2));
  broadcast({ type: 'config-changed' });
  json(res, { ok: true });
}

// ── Start Working on a Work Item ────────────────────────────────────────────
async function handleStartWorking(req, res) {
  try {
    const { workItemId, repoName } = await readBody(req);
    const cfg = getConfig();
    const repoPath = cfg.Repos?.[repoName];
    if (!repoPath) return json(res, { error: `Repo "${repoName}" not found in config` }, 400);
    if (!fs.existsSync(repoPath)) return json(res, { error: `Path does not exist: ${repoPath}` }, 400);

    // Fetch work item for branch name
    const wi = await adoRequest('GET', `/wit/workitems/${workItemId}?fields=System.Title,System.WorkItemType,System.Description&api-version=7.1`);
    const title = wi.fields['System.Title'] || 'work';
    const description = (wi.fields['System.Description'] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const wiType = wi.fields['System.WorkItemType'] || 'feature';
    const prefix = wiType.toLowerCase() === 'bug' ? 'bugfix' : 'feature';

    // Use AI to generate a concise branch slug from the work item context.
    // Pass the prompt via stdin (not argv) so titles/descriptions with quotes,
    // commas, backticks, etc. don't break shell escaping and cause Claude to
    // reply with a clarifying question instead of a slug.
    const fallbackSlug = () => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const sanitizeSlug = (s) => String(s || '').trim().split('\n')[0].trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const looksLikeQuestion = (s) => /\?|^(which|what|can|could|should|how|who|where|why)\b/i.test(String(s || '').trim());

    let slug;
    try {
      const prompt = `Generate a short git branch slug (2 to 5 words, lowercase, hyphen-separated, no special chars) that clearly describes this work item. Reply with ONLY the slug, nothing else. Do not ask questions. Do not add quotes or commentary.\n\nTitle: ${title}\nType: ${wiType}${description ? `\nDescription: ${description}` : ''}`;
      const result = spawnSync('claude', ['--print'], {
        input: prompt,
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        shell: true,
      });
      const raw = (result.stdout || '').trim();
      if (result.status === 0 && raw && !looksLikeQuestion(raw)) {
        slug = sanitizeSlug(raw);
      }
    } catch (_) { /* fall through to fallback */ }
    if (!slug) slug = fallbackSlug();
    const branchName = `${prefix}/AB#${workItemId}-${slug}`;

    // Move work item to Active
    try {
      await adoRequest('PATCH',
        `/wit/workitems/${workItemId}?api-version=7.1`,
        [{ op: 'replace', path: '/fields/System.State', value: 'Active' }],
        'application/json-patch+json'
      );
      workItemsCache = { data: null, ts: 0 };
    } catch (_) { /* may already be active */ }

    // Perform git operations server-side so they don't collide with the AI prompt in the terminal PTY.
    const gitSteps = [];
    try {
      let baseBranch = 'main';
      try {
        gitExec(repoPath, 'checkout main');
      } catch (_) {
        baseBranch = 'master';
        gitExec(repoPath, 'checkout master');
      }
      gitSteps.push(`checked out ${baseBranch}`);
      try { gitExec(repoPath, 'fetch origin'); gitSteps.push('fetched origin'); } catch (e) { gitSteps.push(`fetch failed: ${e.message}`); }
      try { gitExec(repoPath, 'pull'); gitSteps.push('pulled'); } catch (e) { gitSteps.push(`pull failed: ${e.message}`); }
      gitExec(repoPath, `checkout -b ${branchName}`);
      gitSteps.push(`created branch ${branchName}`);
    } catch (e) {
      return json(res, { error: `Git operation failed: ${e.message}`, steps: gitSteps }, 500);
    }

    json(res, { ok: true, branchName, repoPath, steps: gitSteps });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Pull Request Creation (GitHub) ───────────────────────────────────────────
async function handleCreatePullRequest(req, res) {
  try {
    const { repoName, title, description, sourceBranch, targetBranch, workItemId } = await readBody(req);
    const cfg = getConfig();

    if (!repoName) return json(res, { error: 'repoName is required' }, 400);
    if (!title) return json(res, { error: 'title is required' }, 400);

    // Resolve GitHub owner/repo from git remote
    const gh = resolveGitHub(repoName);
    if (gh.error) return json(res, gh, 400);

    // Determine source branch — use provided or detect from local git
    let source = sourceBranch;
    if (!source) {
      const repoPath = cfg.Repos?.[repoName];
      if (repoPath) source = gitExec(repoPath, 'rev-parse --abbrev-ref HEAD');
    }
    if (!source) return json(res, { error: 'Could not determine source branch' }, 400);

    const target = targetBranch || 'main';

    // Build PR description — append AB# link if work item provided
    let body = description || '';
    if (workItemId) {
      const adoUrl = `https://dev.azure.com/${cfg.AzureDevOpsOrg}/${encodeURIComponent(cfg.AzureDevOpsProject)}/_workitems/edit/${workItemId}`;
      body += `${body ? '\n\n' : ''}AB#${workItemId} - [View in Azure DevOps](${adoUrl})`;
    }

    const pr = await ghRequest('POST', `/repos/${gh.owner}/${gh.repo}/pulls`, {
      title: sanitizeText(title),
      body: sanitizeText(body),
      head: source,
      base: target,
    });

    json(res, { ok: true, pullRequestId: pr.number, url: pr.html_url, title: pr.title });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── GitHub Pull Request Handlers ─────────────────────────────────────────────
function resolveGitHub(repoName) {
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return { error: 'Repo not found' };
  const gh = parseGitHubRemote(repoPath);
  if (!gh) return { error: 'Not a GitHub repository' };
  return gh;
}

function handleGitHubRepoInfo(url, res) {
  const gh = resolveGitHub(url.searchParams.get('repo'));
  if (gh.error) return json(res, gh, 400);
  json(res, gh);
}

async function handleGitHubPulls(url, res) {
  try {
    const gh = resolveGitHub(url.searchParams.get('repo'));
    if (gh.error) return json(res, gh, 400);
    const state = url.searchParams.get('state') || 'open';
    const cacheKey = `pulls:${gh.owner}/${gh.repo}:${state}`;

    const result = await swrGitHub.get(cacheKey, async () => {
      const data = await ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`);
      const reviewResults = await Promise.all(data.map(pr =>
        ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/pulls/${pr.number}/reviews`).catch(() => [])
      ));
      const pulls = data.map((pr, i) => {
        const reviews = reviewResults[i] || [];
        const byUser = {};
        for (const r of reviews) {
          if (r.state && r.state !== 'PENDING' && r.state !== 'COMMENTED') byUser[r.user?.login] = r.state;
        }
        const reviewStates = Object.values(byUser);
        const reviewStatus = reviewStates.includes('CHANGES_REQUESTED') ? 'changes_requested'
          : reviewStates.includes('APPROVED') ? 'approved' : null;
        return {
          number: pr.number, title: pr.title, state: pr.state, draft: pr.draft,
          author: pr.user?.login || '', authorAvatar: pr.user?.avatar_url || '',
          createdAt: pr.created_at, updatedAt: pr.updated_at,
          headRef: pr.head?.ref || '', baseRef: pr.base?.ref || '',
          labels: (pr.labels || []).map(l => ({ name: l.name, color: l.color })),
          reviewers: (pr.requested_reviewers || []).map(r => r.login),
          additions: pr.additions, deletions: pr.deletions,
          comments: (pr.comments || 0) + (pr.review_comments || 0),
          reviewStatus,
        };
      });
      return { pulls };
    });
    json(res, result);
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleGitHubPullDetail(url, res) {
  try {
    const gh = resolveGitHub(url.searchParams.get('repo'));
    if (gh.error) return json(res, gh, 400);
    const num = url.searchParams.get('number');
    // Request with html media type to get body_html with signed image URLs
    const [pr, reviews] = await Promise.all([
      ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/pulls/${num}`, null, 'application/vnd.github.html+json'),
      ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/pulls/${num}/reviews`).catch(() => []),
    ]);
    // Determine latest review state per reviewer
    const byUser = {};
    for (const r of reviews) {
      if (r.state && r.state !== 'PENDING' && r.state !== 'COMMENTED') byUser[r.user?.login] = r.state;
    }
    const reviewStates = Object.values(byUser);
    const reviewStatus = reviewStates.includes('CHANGES_REQUESTED') ? 'changes_requested'
      : reviewStates.includes('APPROVED') ? 'approved' : null;
    json(res, {
      number: pr.number, title: pr.title, state: pr.state, draft: pr.draft,
      body: pr.body || '', bodyHtml: pr.body_html || '',
      mergeable: pr.mergeable, merged: pr.merged,
      author: pr.user?.login || '', authorAvatar: pr.user?.avatar_url || '',
      createdAt: pr.created_at, updatedAt: pr.updated_at,
      headRef: pr.head?.ref || '', baseRef: pr.base?.ref || '',
      additions: pr.additions, deletions: pr.deletions,
      changedFiles: pr.changed_files,
      labels: (pr.labels || []).map(l => ({ name: l.name, color: l.color })),
      reviewers: (pr.requested_reviewers || []).map(r => r.login),
      htmlUrl: pr.html_url || '',
      reviewStatus,
      comments: (pr.comments || 0) + (pr.review_comments || 0),
    });
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleGitHubPullFiles(url, res) {
  try {
    const gh = resolveGitHub(url.searchParams.get('repo'));
    if (gh.error) return json(res, gh, 400);
    const num = url.searchParams.get('number');
    const data = await ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/pulls/${num}/files?per_page=100`);
    const files = data.map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions,
      patch: f.patch || null,
    }));
    json(res, { files });
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleGitHubPullComments(url, res) {
  try {
    const gh = resolveGitHub(url.searchParams.get('repo'));
    if (gh.error) return json(res, gh, 400);
    const num = url.searchParams.get('number');
    const [issueComments, reviewComments] = await Promise.all([
      ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/issues/${num}/comments?per_page=100`),
      ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/pulls/${num}/comments?per_page=100`),
    ]);
    const all = [
      ...issueComments.map(c => ({ id: c.id, author: c.user?.login || '', avatar: c.user?.avatar_url || '', body: c.body, createdAt: c.created_at, type: 'comment' })),
      ...reviewComments.map(c => ({ id: c.id, author: c.user?.login || '', avatar: c.user?.avatar_url || '', body: c.body, createdAt: c.created_at, type: 'review', path: c.path, line: c.line })),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    json(res, { comments: all });
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleGitHubPullTimeline(url, res) {
  try {
    const gh = resolveGitHub(url.searchParams.get('repo'));
    if (gh.error) return json(res, gh, 400);
    const num = url.searchParams.get('number');
    // Fetch timeline and review comments in parallel
    const [data, reviewComments] = await Promise.all([
      ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/issues/${num}/timeline?per_page=100`, null, 'application/vnd.github.html+json'),
      ghRequest('GET', `/repos/${gh.owner}/${gh.repo}/pulls/${num}/comments?per_page=100`),
    ]);
    // Group review comments by pull_request_review_id
    const reviewCommentsMap = {};
    for (const c of reviewComments) {
      const rid = c.pull_request_review_id;
      if (!rid) continue;
      if (!reviewCommentsMap[rid]) reviewCommentsMap[rid] = [];
      reviewCommentsMap[rid].push({
        id: c.id, author: c.user?.login || '', avatar: c.user?.avatar_url || '',
        body: c.body || '', bodyHtml: c.body_html || '',
        path: c.path || '', line: c.line || c.original_line || null,
        createdAt: c.created_at || '',
        diffHunk: c.diff_hunk || '',
      });
    }
    const events = [];
    for (const e of data) {
      const ev = { type: e.event || e.node_id?.split('/')[0] || 'unknown', createdAt: e.created_at || e.submitted_at || e.timestamp || '' };
      if (e.event === 'commented' || (!e.event && e.body !== undefined)) {
        ev.type = 'commented';
        ev.author = e.user?.login || e.actor?.login || '';
        ev.avatar = e.user?.avatar_url || e.actor?.avatar_url || '';
        ev.body = e.body || '';
        ev.bodyHtml = e.body_html || '';
      } else if (e.event === 'reviewed') {
        ev.author = e.user?.login || '';
        ev.avatar = e.user?.avatar_url || '';
        ev.state = e.state; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
        ev.body = e.body || '';
        ev.bodyHtml = e.body_html || '';
        // Attach inline review comments to this review event
        const rid = e.id;
        if (rid && reviewCommentsMap[rid]) {
          ev.comments = reviewCommentsMap[rid];
          delete reviewCommentsMap[rid]; // mark as used
        }
      } else if (e.event === 'committed') {
        ev.sha = e.sha;
        ev.message = e.message;
        ev.author = e.author?.name || '';
      } else if (e.event === 'review_requested') {
        ev.actor = e.actor?.login || '';
        ev.reviewer = e.requested_reviewer?.login || '';
      } else if (e.event === 'assigned' || e.event === 'unassigned') {
        ev.actor = e.actor?.login || '';
        ev.assignee = e.assignee?.login || '';
      } else if (e.event === 'labeled' || e.event === 'unlabeled') {
        ev.actor = e.actor?.login || '';
        ev.label = e.label?.name || '';
        ev.labelColor = e.label?.color || '';
      } else if (e.event === 'head_ref_force_pushed' || e.event === 'head_ref_deleted') {
        ev.actor = e.actor?.login || '';
      } else if (e.event === 'merged') {
        ev.actor = e.actor?.login || '';
        ev.commitId = e.commit_id || '';
      } else if (e.event === 'closed' || e.event === 'reopened') {
        ev.actor = e.actor?.login || '';
      } else {
        ev.actor = e.actor?.login || '';
      }
      events.push(ev);
    }
    // Add any orphaned review comments (not attached to a timeline review event)
    for (const [, comments] of Object.entries(reviewCommentsMap)) {
      for (const c of comments) {
        events.push({
          type: 'review_comment', createdAt: c.createdAt,
          author: c.author, avatar: c.avatar,
          body: c.body, bodyHtml: c.bodyHtml,
          path: c.path, line: c.line, diffHunk: c.diffHunk,
        });
      }
    }
    // Re-sort by createdAt to keep chronological order
    events.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    json(res, { events });
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleGitHubAddComment(req, res) {
  try {
    const { repo, number, body } = await readBody(req);
    if (!repo || !number || !body) return json(res, { error: 'repo, number, and body are required' }, 400);
    const gh = resolveGitHub(repo);
    if (gh.error) return json(res, gh, 400);
    const result = await ghRequest('POST', `/repos/${gh.owner}/${gh.repo}/issues/${number}/comments`, { body: sanitizeText(body) });
    json(res, { ok: true, id: result.id });
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleGitHubSubmitReview(req, res) {
  try {
    const { repo, number, event, body } = await readBody(req);
    if (!repo || !number || !event) return json(res, { error: 'repo, number, and event are required' }, 400);
    const gh = resolveGitHub(repo);
    if (gh.error) return json(res, gh, 400);
    const payload = { event };
    if (body) payload.body = sanitizeText(body);
    const result = await ghRequest('POST', `/repos/${gh.owner}/${gh.repo}/pulls/${number}/reviews`, payload);
    json(res, { ok: true, state: result.state });
  } catch (e) { json(res, { error: e.message }, 500); }
}

function handleGitHubImageProxy(url, res) {
  const imgUrl = url.searchParams.get('url');
  if (!imgUrl || !imgUrl.startsWith('https://github.com/')) {
    res.writeHead(400); res.end('Invalid URL'); return;
  }
  const cfg = getConfig();
  const pat = cfg.GitHubPAT;
  const parsed = new URL(imgUrl);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'Authorization': `token ${pat}`,
      'User-Agent': 'DevOps-Pilot',
      'Accept': '*/*',
    },
  };
  const proxy = https.request(options, (upstream) => {
    // Follow redirects (GitHub returns 302 to the actual blob URL)
    if (upstream.statusCode === 301 || upstream.statusCode === 302) {
      const loc = upstream.headers.location;
      if (loc) {
        const redir = new URL(loc);
        const redirOpts = {
          hostname: redir.hostname,
          path: redir.pathname + redir.search,
          method: 'GET',
          headers: { 'User-Agent': 'DevOps-Pilot', 'Accept': '*/*' },
        };
        // The redirected URL is usually publicly accessible with a token in the query
        const r2 = https.request(redirOpts, (resp2) => {
          res.writeHead(resp2.statusCode, {
            'Content-Type': resp2.headers['content-type'] || 'image/png',
            'Cache-Control': 'public, max-age=3600',
          });
          resp2.pipe(res);
        });
        r2.on('error', () => { res.writeHead(502); res.end(); });
        r2.end();
        return;
      }
    }
    res.writeHead(upstream.statusCode, {
      'Content-Type': upstream.headers['content-type'] || 'image/png',
      'Cache-Control': 'public, max-age=3600',
    });
    upstream.pipe(res);
  });
  proxy.on('error', () => { res.writeHead(502); res.end(); });
  proxy.end();
}

// ── GitHub: List user repos ──────────────────────────────────────────────────
async function handleGitHubUserRepos(url, res) {
  try {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const page = parseInt(url.searchParams.get('page')) || 1;
    const perPage = 50;
    // Fetch repos the authenticated user has access to, sorted by recent push
    const repos = await ghRequest('GET', `/user/repos?sort=pushed&per_page=${perPage}&page=${page}&affiliation=owner,collaborator,organization_member`);
    const items = repos.map(r => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description || '',
      private: r.private,
      clone_url: r.clone_url,
      ssh_url: r.ssh_url,
      html_url: r.html_url,
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
      language: r.language,
    }));
    const filtered = query ? items.filter(r =>
      r.name.toLowerCase().includes(query) || r.full_name.toLowerCase().includes(query)
    ) : items;
    json(res, { repos: filtered, page, hasMore: repos.length === perPage });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── GitHub: Clone repo ──────────────────────────────────────────────────────
async function handleGitHubClone(req, res) {
  try {
    const { cloneUrl, destPath } = await readBody(req);
    if (!cloneUrl || !destPath) return json(res, { error: 'cloneUrl and destPath are required' }, 400);
    if (!fs.existsSync(destPath)) return json(res, { error: `Destination does not exist: ${destPath}` }, 400);
    // Extract repo name from clone URL for the folder name
    const match = cloneUrl.match(/\/([^/]+?)(?:\.git)?$/);
    const repoFolder = match ? match[1] : 'repo';
    const fullDest = path.join(destPath, repoFolder);
    if (fs.existsSync(fullDest)) return json(res, { error: `Folder already exists: ${fullDest}` }, 400);
    // Inject PAT for HTTPS clone
    const cfg = getConfig();
    let authUrl = cloneUrl;
    if (cfg.GitHubPAT && cloneUrl.startsWith('https://')) {
      authUrl = cloneUrl.replace('https://', `https://${cfg.GitHubPAT}@`);
    }
    execSync(`git clone "${authUrl}" "${fullDest}"`, { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
    json(res, { ok: true, path: fullDest, name: repoFolder });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── UI Actions (AI -> Dashboard) ─────────────────────────────────────────────
// ── File Browser ────────────────────────────────────────────────────────────
function getRepoPath(repoName) {
  const cfg = getConfig();
  const repos = cfg.Repos || {};
  return repos[repoName] || null;
}

function handleFileTree(url, res) {
  const repoName = url.searchParams.get('repo');
  const subPath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const fullPath = path.join(repoPath, subPath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => {
        const SKIP = ['.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache'];
        return !SKIP.includes(e.name);
      })
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
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!query) return json(res, { results: [] });

  const SKIP = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', 'bin', 'obj']);
  const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock']);
  const results = [];
  const MAX = 80;

  function walk(dir, rel) {
    if (results.length >= MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (results.length >= MAX) return;
      if (SKIP.has(e.name)) continue;
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
  walk(repoPath, '');
  json(res, { results });
}

// ── Content grep (search inside files, returns matches with line numbers) ──
function handleFileGrep(url, res) {
  const repoName = url.searchParams.get('repo');
  const query = url.searchParams.get('q') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!query || query.length < 2) return json(res, { results: [] });

  const SKIP = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', 'bin', 'obj']);
  const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock','map']);
  const results = [];
  const MAX_FILES = 50;
  const MAX_MATCHES = 150;
  let fileCount = 0;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);

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
      if (SKIP.has(e.name)) continue;
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
  walk(repoPath, '');
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
    const boundary = '----DevOpsPilotVoice' + Date.now();
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
function handleImageProxy(url, res) {
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) { res.writeHead(400); return res.end('Missing url param'); }

  const cfg = getConfig();
  const pat = cfg.AzureDevOpsPAT;
  const parsedUrl = new URL(imageUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: { 'Accept': '*/*' },
  };
  if (pat && parsedUrl.hostname.includes('dev.azure.com')) {
    options.headers['Authorization'] = 'Basic ' + Buffer.from(':' + pat).toString('base64');
  }

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
let _uiContext = { selectedIteration: null, selectedIterationName: 'All Iterations', activeRepo: null, activeRepoPath: null };

function getUiContextWithPath() {
  // Always resolve the repo path from config so it's up to date
  const ctx = { ..._uiContext };
  if (ctx.activeRepo) {
    const cfg = getConfig();
    ctx.activeRepoPath = (cfg.Repos || {})[ctx.activeRepo] || null;
  }
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

// ── Utilities ───────────────────────────────────────────────────────────────
// ── Notes Management ────────────────────────────────────────────────────────
const notesDir = path.join(repoRoot, 'notes');

function handleListNotes(res) {
  try {
    fs.mkdirSync(notesDir, { recursive: true });
    const files = fs.readdirSync(notesDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const st = fs.statSync(path.join(notesDir, f));
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
  const filePath = path.join(notesDir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(notesDir))) return json(res, { error: 'Invalid path' }, 403);
  try {
    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    json(res, { name, content });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function handleSaveNote(req, res) {
  const { name, content } = await readBody(req);
  if (!name) return json(res, { error: 'name required' }, 400);
  const filePath = path.join(notesDir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(notesDir))) return json(res, { error: 'Invalid path' }, 403);
  fs.mkdirSync(notesDir, { recursive: true });
  atomicWriteSync(resolved, content || '');
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  hybridSearch.indexNote(resolved).catch(() => {});
  json(res, { ok: true });
}

async function handleCreateNote(req, res) {
  const { name } = await readBody(req);
  if (!name) return json(res, { error: 'name required' }, 400);
  const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  if (!safeName) return json(res, { error: 'Invalid name' }, 400);
  const filePath = path.join(notesDir, safeName + '.md');
  if (fs.existsSync(filePath)) return json(res, { error: 'Note already exists' }, 409);
  fs.mkdirSync(notesDir, { recursive: true });
  atomicWriteSync(filePath, `# ${safeName}\n\n`);
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true, name: safeName });
}

async function handleDeleteNote(req, res) {
  const { name } = await readBody(req);
  if (!name) return json(res, { error: 'name required' }, 400);
  const filePath = path.join(notesDir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(notesDir))) return json(res, { error: 'Invalid path' }, 403);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true });
}

// Rewrite ADO-hosted image src URLs to go through our proxy
function proxyHtmlImages(html) {
  if (!html) return html;
  return html.replace(/<img([^>]+)src=["']([^"']+)["']/gi, (match, before, url) => {
    if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) {
      return `<img${before}src="/api/image-proxy?url=${encodeURIComponent(url)}"`;
    }
    return match;
  });
}

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
      DEVOPS_PILOT_TERM_ID: termId,
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
    block += 'Plugins extend DevOps Pilot with extra capabilities. Each plugin may provide:\n';
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
    { out: path.join(repoRoot, '.github', 'copilot-instructions.md'), filename: 'copilot-instructions.md' },
  ];
  const START = '<!-- PLUGIN_INSTRUCTIONS_START -->';
  const END = '<!-- PLUGIN_INSTRUCTIONS_END -->';
  const ORCH_START = '<!-- ORCHESTRATION_START -->';
  const ORCH_END = '<!-- ORCHESTRATION_END -->';
  const REPO_START = '<!-- REPO_CONTEXT_START -->';
  const REPO_END = '<!-- REPO_CONTEXT_END -->';
  const INCOGNITO_START = '<!-- INCOGNITO_START -->';
  const INCOGNITO_END = '<!-- INCOGNITO_END -->';
  const GRAPH_START = '<!-- GRAPH_RUNS_START -->';
  const GRAPH_END = '<!-- GRAPH_RUNS_END -->';
  const cfg = getConfig();
  const orchestrationEnabled = cfg.OrchestrateMode === true; // default: off
  // Graph runs are part of orchestration; same toggle controls both.
  const graphRunsEnabled = orchestrationEnabled;
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
      // Strip orchestration section if disabled
      if (!orchestrationEnabled) {
        const orchStart = content.indexOf(ORCH_START);
        const orchEnd = content.indexOf(ORCH_END);
        if (orchStart !== -1 && orchEnd !== -1) {
          content = content.substring(0, orchStart) + content.substring(orchEnd + ORCH_END.length);
        }
      }
      // Strip graph-runs BETA section if disabled
      if (!graphRunsEnabled) {
        const gStart = content.indexOf(GRAPH_START);
        const gEnd = content.indexOf(GRAPH_END);
        if (gStart !== -1 && gEnd !== -1) {
          content = content.substring(0, gStart) + content.substring(gEnd + GRAPH_END.length);
        }
      }
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
  mountBrowserRoutes(addRoute, json, { getConfig, repoRoot });
  console.log('  Browser agent mounted (/api/browser/*)');
} catch (e) {
  console.log('  Browser agent skipped (playwright-core not installed)');
}

// ── Load plugins ─────────────────────────────────────────────────────────────
loadedPlugins = loadPlugins(pluginsDir, { addRoute, getConfig, broadcast, json, writePluginHints, swrCache: swrPlugins });
if (loadedPlugins.length) console.log(`  Loaded ${loadedPlugins.length} plugin(s)`);
writePluginHints();

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
  // Merged: returns all instruction files concatenated (config-aware)
  addRoute('GET', '/api/instructions', (req, res) => {
    try {
      const cfg = getConfig();
      const orchestrationEnabled = cfg.OrchestrateMode === true;
      // Order: behavioral rules first (survive compaction better), reference tables last
      const priorityOrder = ['workflows.md', 'orchestrator.md', 'api-reference.md'];
      const files = fs.readdirSync(instrDir).filter(f => {
        if (!f.endsWith('.md')) return false;
        if (f === 'orchestrator.md' && !orchestrationEnabled) return false;
        return true;
      }).sort((a, b) => {
        const ai = priorityOrder.indexOf(a), bi = priorityOrder.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
      const sections = files.map(f => fs.readFileSync(path.join(instrDir, f), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(sections.join('\n\n---\n\n'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  // Individual: /api/instructions/{name} serves a single file
  addRoute('__PREFIX__', '/api/instructions/', (req, res, url, subpath) => {
    const name = (subpath || '').replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) { json(res, { error: 'Missing instruction name' }, 400); return; }
    const content = readInstrFile(name);
    if (!content) { json(res, { error: `Instruction "${name}" not found` }, 404); return; }
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(content);
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
    console.log(`\n  DevOps Pilot running at ${url}\n`);
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
