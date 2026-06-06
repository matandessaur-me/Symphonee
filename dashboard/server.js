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
const { exec, execSync, spawnSync, spawn } = require('child_process');

// ── New utility modules ────────────────────────────────────────────────────
const { gitAsync, gitSync } = require('./utils/git-async');
const { SWRCache } = require('./utils/swr-cache');
const { atomicWriteSync } = require('./utils/atomic-write');
const { namespaceFromName } = require('./lib/notes-ns');
const { detectPwsh } = require('./lib/detect-cli');
const { BusyGuard } = require('./utils/busy-guard');
const instructionAudit = require('./instruction-audit');
const trace = require('./startup-trace');
trace.mark('server:module-eval:start');

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
const notesDir = path.join(repoRoot, 'notes'); // shared: hybrid-search index + note path-guards (note ROUTES live in routes/notes.js)
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
  '/launch.png':              { file: path.join(publicDir, 'launch.png'),                                          type: 'image/png' },
  '/launch-logo.png':         { file: path.join(publicDir, 'launch-logo.png'),                                     type: 'image/png' },
  '/contributions-client.js': { file: path.join(publicDir, 'contributions-client.js'),                             type: 'application/javascript' },
  '/mind-ui.js':              { file: path.join(publicDir, 'mind-ui.js'),                                          type: 'application/javascript' },
  '/vis-network.min.js':      { file: path.join(nodeModules, 'vis-network/standalone/umd/vis-network.min.js'),     type: 'application/javascript' },
  '/vis-network.min.css':     { file: path.join(nodeModules, 'vis-network/dist/dist/vis-network.min.css'),         type: 'text/css' },
  '/3d-force-graph.min.js':   { file: path.join(nodeModules, '3d-force-graph/dist/3d-force-graph.min.js'),         type: 'application/javascript' },
  '/force-graph.min.js':      { file: path.join(nodeModules, 'force-graph/dist/force-graph.min.js'),                type: 'application/javascript' },
};

// ── Pluggable route handlers (Electron adds its own via addRoute) ────────────
const extraRoutes = [];
function addRoute(method, pathname, handler) {
  extraRoutes.push({ method: method.toUpperCase(), pathname, handler });
}

// ── Plugin system ────────────────────────────────────────────────────────────
const { loadPlugins, checkActivation } = require('./plugin-loader');
const pluginsDir = path.join(__dirname, 'plugins');

// ── Config store (merge/normalize infrastructure behind getConfig) ───────────
const { createConfigStore } = require('./lib/config-store');
const { getConfig, readAllPluginConfigs, getPluginConfigKeyMap, persistPluginConfigKeys, normalizeRootConfig } =
  createConfigStore({ templatePath, configPath, pluginsDir });
let loadedPlugins = [];

// ── Orchestrator (cross-AI communication bus) ────────────────────────────────
const { mountOrchestrator, pretrustFolderForCli } = require('./orchestrator');
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
const { HybridSearchEngine } = require('./hybrid-search');
const { buildRepoMap } = require('./repo-map');
const hybridSearch = new HybridSearchEngine({ repoRoot });

async function permGate(res, type, value, label) {
  return permissions.gate(res, { type, value }, { configPath, actionLabel: label });
}

// ── Learnings (collective intelligence) ──────────────────────────────────────
const { mountLearnings } = require('./learnings');
let _learningsInstance = null;
trace.mark('server:top-requires-done');

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

// Shared sync git helper (git routes live in routes/git.js; this stays here
// because plugins receive it via shellDeps).
function gitExec(repoPath, cmd, timeoutMs) {
  return gitSync(repoPath, cmd, timeoutMs);
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

    // ── Model Router ──────────────────────────────────────────────────────
    if (url.pathname === '/api/models/catalog' && req.method === 'GET') {
      return json(res, modelRouter.publicCatalog(configPath));
    }
    if (url.pathname === '/api/models/recommend' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, modelRouter.recommend({ ...body, configPath }));
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
    // of v0.4.0 - registered via ctx.addAbsoluteRoute against the same
    // URLs. Same story for GitHub (/api/github/*, /api/pull-request):
    // owned by the github plugin v0.4.0. When a plugin is uninstalled or
    // unconfigured, the route 404s naturally because no handler is
    // registered - no explicit gate needed in core.

    // ── Notes ─────────────────────────────────────────────────────────────

    // ── File Browser & Git ─────────────────────────────────────────────────
    // git routes -> routes/git.js (mountGit)

    // ── Project Scripts (package.json) ──────────────────────────────────────

    // ── File Search ────────────────────────────────────────────────────────

    // ── Serve repo files (images, etc.) ────────────────────────────────────


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
        // Mind: shared knowledge graph status, exposed so every CLI sees it
        // on session start regardless of which CLI it is.
        let mindField = null;
        try { mindField = mind && typeof mind.bootstrapField === 'function' ? mind.bootstrapField() : null; } catch (_) {}
        // Skills: the procedural catalog -- every CLI sees which reusable
        // procedures exist and fetches the body of the one it needs.
        let skillsField = null;
        try { skillsField = skills && typeof skills.bootstrapField === 'function' ? skills.bootstrapField() : null; } catch (_) {}
        // Append mind instructions to the main instructions blob so every CLI
        // is told how to query and contribute to the shared brain.
        try {
          const mindInstr = fs.readFileSync(path.join(__dirname, 'mind', 'instructions.md'), 'utf8');
          instructions = instructions + '\n\n---\n\n' + mindInstr;
        } catch (_) {}
        // Symphonee brain: current intent snapshot + dependency state.
        // Every CLI sees this so it can read the live theory of what the
        // user is doing before answering AND know whether the brain has
        // the local models it needs. Also appends brain instructions so
        // CLIs know how to interact with the planner front door. The
        // brain is always on - no mode field, no toggle.
        let brainField = null;
        try {
          if (brain && typeof brain.getIntent === 'function') {
            const brainSetup = await require('./mind/ollama-setup').detectBrainSetup();
            brainField = {
              intent: brain.getIntent(),
              triageModel: require('./brain/planner').TRIAGE_MODEL,
              reasoningModel: require('./brain/planner').REASONING_MODEL,
              setup: brainSetup,
            };
          }
        } catch (_) {}
        try {
          const brainInstr = fs.readFileSync(path.join(__dirname, 'brain', 'instructions.md'), 'utf8');
          instructions = instructions + '\n\n---\n\n' + brainInstr;
        } catch (_) {}
        // Instruction-coherence audit. Every CLI sees this on bootstrap so
        // it can warn the user if the instruction system has degraded.
        // Cached from the last writePluginHints / boot run; cheap on miss.
        let auditField = instructionAudit.getCached();
        if (!auditField) {
          try { auditField = instructionAudit.run({ repoRoot }); } catch (_) { auditField = null; }
        }
        // Compose payload
        const payload = {
          context, instructions, plugins, learnings, permissions: permissionsData,
          mind: mindField,
          skills: skillsField,
          brain: brainField,
          instructionsAudit: auditField,
          loadedAt: new Date().toISOString(),
          features: {
            orchestrateMode: true,
            graphRunsMode: true,
            mindMode: true,
            brainMode: true,
          },
        };
        // Checksum: short hash so the CLI can echo it. Computed over a stable view.
        const stable = JSON.stringify({
          activeRepo: context.activeRepo, mode: permissionsData.settings.mode,
          pluginCount: plugins.length, learningCount: learnings.length,
          features: payload.features, instructionsLen: instructions.length,
          mindNodes: mindField?.graphStats?.nodes || 0,
          auditOk: auditField ? auditField.ok : null,
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
    // Cache-Control: no-store on dashboard assets. Without this header
    // Electron's renderer was holding onto /mind-ui.js and /index.html
    // across reloads, so code changes silently didn't show up until a full
    // app restart. The asset server is on localhost - no CDN, no bandwidth
    // concern - so always-fresh is the right default.
    const route = ROUTES[url.pathname];
    if (route && fs.existsSync(route.file)) {
      res.writeHead(200, {
        'Content-Type': route.type,
        'Cache-Control': 'no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      fs.createReadStream(route.file).pipe(res);
    } else {
      // Plugin-aware 404 for /api/ paths owned by extracted plugins. Keeps the
      // UI and AI seeing a structured 'this feature lives in a plugin - install
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
// ── Themes ────────────────────────────────────────────────────────────────
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
const CORE_SPACE_PLUGIN_IDS = new Set(['browser-use', 'video-use', 'stagehand']);
function normalizeSpacePluginList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    if (CORE_SPACE_PLUGIN_IDS.has(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }
  return out;
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
    plugins: Array.isArray(plugins) ? normalizeSpacePluginList(plugins) : normalizeSpacePluginList(prev.plugins || []),
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
  if (CORE_SPACE_PLUGIN_IDS.has(plugin)) return json(res, { ok: true, plugins: normalizeSpacePluginList(((getConfig().Spaces || {})[space] || {}).plugins || []) });
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
  cfg.Spaces[space] = { ...s, plugins: normalizeSpacePluginList(list) };
  atomicWriteSync(configPath, JSON.stringify(normalizeRootConfig(cfg), null, 2));
  broadcast({ type: 'config-changed' });
  json(res, { ok: true, plugins: cfg.Spaces[space].plugins });
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
// auth headers. Core never hardcodes service-specific auth - it just walks
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
//
// Persisted to <repoRoot>/.symphonee/ui-state.json so the user's selection
// survives an app restart. Restoring on boot is best-effort - if the saved
// repo no longer exists in config, fall back to nothing.
const _uiStatePath = path.join(repoRoot, '.symphonee', 'ui-state.json');

function _loadUiState() {
  try {
    if (!fs.existsSync(_uiStatePath)) return null;
    return JSON.parse(fs.readFileSync(_uiStatePath, 'utf8'));
  } catch (_) { return null; }
}

function _saveUiState(state) {
  try {
    fs.mkdirSync(path.dirname(_uiStatePath), { recursive: true });
    fs.writeFileSync(_uiStatePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) { /* best effort */ }
}

let _uiContext = (() => {
  const saved = _loadUiState() || {};
  return {
    selectedIteration: saved.selectedIteration ?? null,
    selectedIterationName: saved.selectedIterationName || 'All Iterations',
    selectedArea: saved.selectedArea ?? null,
    selectedAreaName: saved.selectedAreaName || 'Team Default',
    activeSpace: saved.activeSpace ?? null,
    activeRepo: saved.activeRepo ?? null,
    activeRepoPath: null, // re-derived from config below
  };
})();

function getUiContextWithPath() {
  // Always resolve the repo path from config so it's up to date
  const ctx = { ..._uiContext };
  if (ctx.activeRepo) {
    const cfg = getConfig();
    ctx.activeRepoPath = (cfg.Repos || {})[ctx.activeRepo] || null;
  }
  // Derive the notes namespace: active space name, or '_global' when none.
  ctx.notesNamespace = ctx.activeSpace ? namespaceFromName(ctx.activeSpace) : '_global';
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
  // Persist so the selection survives an app restart.
  _saveUiState({
    selectedIteration: _uiContext.selectedIteration,
    selectedIterationName: _uiContext.selectedIterationName,
    selectedArea: _uiContext.selectedArea,
    selectedAreaName: _uiContext.selectedAreaName,
    activeSpace: _uiContext.activeSpace,
    activeRepo: _uiContext.activeRepo,
  });
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
const terminals = new Map(); // termId -> { pty, cols, rows, cwd, label }
const termAiMeta = new Map(); // termId -> { cli, launched, updatedAt }
let defaultCols = 120, defaultRows = 30;

// ── Terminal session persistence ────────────────────────────────────────────
// PTYs are in-memory and die with the process, so to bring the user's shells
// (name + working dir) back after an app restart we persist a small manifest of
// open shells and recreate them on the first client connection. Local state, so
// it lives under .ai-workspace (gitignored).
const termSessionsFile = path.join(repoRoot, '.ai-workspace', 'terminal-sessions.json');
let _sessionsRestored = false;
function loadTermSessions() {
  try { return JSON.parse(fs.readFileSync(termSessionsFile, 'utf8')) || {}; }
  catch (_) { return { shells: [], mainLabel: null }; }
}
function saveTermSessions() {
  try {
    fs.mkdirSync(path.dirname(termSessionsFile), { recursive: true });
    const shells = [];
    let mainLabel = null;
    for (const [id, t] of terminals) {
      if (id === 'main') { mainLabel = t.label || null; continue; }
      shells.push({ id, label: t.label || null, cwd: t.cwd || null });
    }
    atomicWriteSync(termSessionsFile, JSON.stringify({ shells, mainLabel }, null, 2));
  } catch (_) { /* best-effort */ }
}
// Recreate persisted non-main shells once, on the first client connection after
// a server (app) restart. Guarded so reconnects do not duplicate.
function restoreTermSessionsOnce() {
  if (_sessionsRestored) return;
  _sessionsRestored = true;
  let saved;
  try { saved = loadTermSessions(); } catch (_) { return; }
  for (const s of (saved && saved.shells) || []) {
    if (!s || !s.id || s.id === 'main' || terminals.has(s.id)) continue;
    let cwd = repoRoot;
    try { if (s.cwd && fs.existsSync(s.cwd)) cwd = s.cwd; } catch (_) {}
    try { createTerminal(s.id, defaultCols, defaultRows, cwd, s.label || null); } catch (_) {}
  }
}

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

function _normFsPath(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

function _repoForPath(cwd) {
  const cfg = getConfig();
  const repos = cfg.Repos || {};
  const nCwd = _normFsPath(cwd);
  let best = null;
  let bestLen = -1;
  for (const [name, repoPath] of Object.entries(repos)) {
    const nRepo = _normFsPath(repoPath);
    if (!nRepo) continue;
    if ((nCwd === nRepo || nCwd.startsWith(nRepo + '\\')) && nRepo.length > bestLen) {
      best = name;
      bestLen = nRepo.length;
    }
  }
  return best;
}

function _handleTerminalCwd(termId, cwd) {
  if (!cwd) return;
  const t = terminals.get(termId);
  if (t) t.cwd = cwd;
  broadcast({ type: 'term-cwd', termId, cwd, repo: _repoForPath(cwd) });
}

function createTerminal(termId, cols = 120, rows = 30, cwd = null, label = null) {
  // Default new terminals to Symphonee's repoRoot (where scripts/*.ps1 live)
  // so the user always has access to Symphonee's tools regardless of which
  // repo is active. The "active repo" is metadata Symphonee uses to know
  // WHICH repo it's helping you with - it is NOT a working directory the
  // user gets dropped into. Symphonee operates ON other repos from its own
  // directory, not FROM inside them.
  if (!cwd) cwd = repoRoot;
  // Kill existing if same ID
  if (terminals.has(termId)) {
    try { terminals.get(termId).pty.kill(); } catch (_) {}
    terminals.delete(termId);
  }
  termAiMeta.delete(termId);

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

  terminals.set(termId, { pty: ptyProcess, cols, rows, cwd, label: label || null });

  ptyProcess.onData(data => {
    broadcast({ type: 'output', termId, data });
  });
  ptyProcess.onExit(() => {
    terminals.delete(termId);
    termAiMeta.delete(termId);
    broadcast({ type: 'term-exited', termId });
  });

  broadcast({ type: 'term-started', termId, cwd, isNew: true });
  _handleTerminalCwd(termId, cwd);
  return ptyProcess;
}

function killTerminal(termId) {
  const t = terminals.get(termId);
  if (t) {
    try { t.pty.kill(); } catch (_) {}
    terminals.delete(termId);
  }
  termAiMeta.delete(termId);
}

// ── AI CLI detection (process tree) ─────────────────────────────────────────
// Given a parent PID, find whether any known AI CLI is running as a
// descendant. Lets the frontend reliably decide whether to show "Launch AI"
// or "Restart Shell" even after a page refresh.
const AI_CLI_PROCESS_NAMES = {
  claude:  ['claude.exe', 'claude'],
  codex:   ['codex.exe',  'codex'],
  gemini:  ['gemini.exe', 'gemini'],
  copilot: ['copilot.exe','copilot'],
  grok:    ['grok.exe',   'grok'],
  qwen:    ['qwen.exe',   'qwen'],
};
// Some CLIs (e.g. gemini, qwen, codex) are Node.js scripts wrapped in a .cmd
// shim, so their OS process name is node.exe rather than the CLI name.
// These substrings are matched against the full CommandLine of node.exe
// processes to identify which CLI is actually running.
const AI_CLI_NODE_MARKERS = {
  gemini:  ['@google/gemini-cli', 'gemini-cli', 'gemini.js'],
  copilot: ['@github/copilot-cli', 'copilot-cli'],
  codex:   ['@openai/codex', 'codex.js'],
  qwen:    ['qwen-code', 'qwen.js'],
};
let _aiDetectCache = { ts: 0, tree: null };
async function _readProcessTree() {
  // Cache for ~1s so multiple terminals polling back-to-back share one snapshot.
  if (Date.now() - _aiDetectCache.ts < 1000 && _aiDetectCache.tree) return _aiDetectCache.tree;
  // wmic was removed in Windows 11 24H2, so we use Get-CimInstance via PowerShell
  // which is present on every supported Windows SKU.
  // CommandLine is included so node.exe processes can be matched by script path.
  return await new Promise((resolve) => {
    try {
      const psCmd = '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress';
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
      let out = '';
      ps.stdout.on('data', (b) => { out += b.toString('utf8'); });
      ps.on('error', () => resolve(null));
      ps.on('close', () => {
        try {
          const arr = JSON.parse(out || '[]');
          const list = Array.isArray(arr) ? arr : [arr];
          const byParent = new Map();
          for (const p of list) {
            const pid = Number(p && p.ProcessId);
            const ppid = Number(p && p.ParentProcessId);
            const name = String((p && p.Name) || '').trim().toLowerCase();
            const cmdline = String((p && p.CommandLine) || '').toLowerCase();
            if (!pid || !name) continue;
            if (!byParent.has(ppid)) byParent.set(ppid, []);
            byParent.get(ppid).push({ pid, name, cmdline });
          }
          _aiDetectCache = { ts: Date.now(), tree: byParent };
          resolve(byParent);
        } catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
  });
}
function _detectAiUnder(tree, rootPid) {
  if (!tree || !rootPid) return null;
  const visited = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const kids = tree.get(pid) || [];
    for (const k of kids) {
      // Direct name match (compiled binaries like claude.exe).
      for (const cli of Object.keys(AI_CLI_PROCESS_NAMES)) {
        if (AI_CLI_PROCESS_NAMES[cli].includes(k.name)) return cli;
      }
      // Node.js-based CLIs: match via CommandLine when process is node.exe.
      if ((k.name === 'node.exe' || k.name === 'node') && k.cmdline) {
        for (const cli of Object.keys(AI_CLI_NODE_MARKERS)) {
          if (AI_CLI_NODE_MARKERS[cli].some(m => k.cmdline.includes(m))) return cli;
        }
      }
      stack.push(k.pid);
    }
  }
  return null;
}
addRoute('POST', '/api/term/detect-ai', async (req, res) => {
  try {
    const body = await readBody(req);
    const termIds = Array.isArray(body.termIds) && body.termIds.length
      ? body.termIds
      : Array.from(terminals.keys());
    if (process.platform !== 'win32') {
      // Non-Windows: skip for now (wmic is Windows). Return empty so the
      // frontend just keeps whatever state it already has.
      return json(res, { ok: true, byTerm: {}, platform: process.platform });
    }
    const tree = await _readProcessTree();
    const byTerm = {};
    for (const id of termIds) {
      const t = terminals.get(id);
      if (!t || !t.pty || !t.pty.pid) continue;
      const detected = _detectAiUnder(tree, t.pty.pid) || null;
      byTerm[id] = detected;
      if (detected) {
        termAiMeta.set(id, { cli: detected, launched: true, updatedAt: Date.now(), source: 'process-detect' });
      } else {
        const existing = termAiMeta.get(id);
        if (existing && existing.source === 'process-detect') termAiMeta.delete(id);
      }
    }
    return json(res, { ok: true, byTerm });
  } catch (e) {
    return json(res, { ok: false, error: e && e.message ? e.message : String(e) }, 500);
  }
});

// Backward compat: currentPty getter for start-working feature
Object.defineProperty(global, 'currentPty', {
  get() { return terminals.has('main') ? terminals.get('main').pty : null; },
});

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // On the first connection after an app restart, bring back the user's saved
  // shells (name + cwd) so renaming/opening shells survives a restart.
  restoreTermSessionsOnce();
  // Send list of active terminals with their labels + cwd so the client can
  // rebuild the tabs (a fresh renderer has none).
  const active = [];
  let mainLabel = null;
  for (const [id, t] of terminals) {
    if (id === 'main') mainLabel = t.label || null;
    active.push({ id, label: t.label || null, cwd: t.cwd || null });
  }
  if (mainLabel == null) { try { mainLabel = loadTermSessions().mainLabel || null; } catch (_) {} }
  ws.send(JSON.stringify({ type: 'term-list', terminals: active, mainLabel }));

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
          createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows, msg.cwd, msg.label || null);
          saveTermSessions();
          break;
        }
        case 'kill-term': {
          if (termId !== 'main') { killTerminal(termId); saveTermSessions(); }
          break;
        }
        case 'rename-term': {
          // Persist a user-renamed shell so the name survives an app restart.
          const t = terminals.get(termId);
          if (t) { t.label = (String(msg.label || '').slice(0, 60)) || null; saveTermSessions(); }
          break;
        }
        case 'restart': {
          createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows);
          break;
        }
        case 'term-ai-state': {
          const cli = typeof msg.cli === 'string' ? msg.cli.trim() : '';
          const launched = msg.launched !== false;
          if (!cli || !launched) termAiMeta.delete(termId);
          else termAiMeta.set(termId, { cli, launched: true, updatedAt: Date.now() });
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
  const cfg = getConfig();
  // Orchestration (and Graph Runs) are always on; BETA toggle is gone.
  const uiCtx = getUiContextWithPath();
  const hasRepo = !!uiCtx.activeRepo;

  if (!fs.existsSync(templatePath)) {
    console.warn('  [writePluginHints] template not found: INSTRUCTIONS.base.md');
    return;
  }
  const template = fs.readFileSync(templatePath, 'utf8');

  for (const { out, filename } of outputFiles) {
    try {
      // Replace the filename placeholder
      let content = template.replace('{{FILENAME}}', filename);
      // Orchestration and Graph Runs are always on - the ORCH_* and GRAPH_*
      // marker pairs are always kept. Markers themselves get cleaned up by
      // the generic pass below so they don't leak into the rendered file.
      // Strip repo-specific context when in No Repo mode (handles multiple marker pairs)
      if (!hasRepo) {
        let rStart, rEnd;
        while ((rStart = content.indexOf(REPO_START)) !== -1 && (rEnd = content.indexOf(REPO_END, rStart)) !== -1) {
          content = content.substring(0, rStart) + content.substring(rEnd + REPO_END.length);
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
  // After (re)generating instruction files, re-run the instruction-coherence
  // audit so /api/bootstrap reflects the latest state. Broadcast on failure
  // so the dashboard can show a toast.
  try {
    const audit = instructionAudit.run({ repoRoot });
    if (!audit.ok) {
      console.warn(`  [audit] FAILED: ${audit.failedChecks.join(', ')}`);
      try { broadcast({ type: 'instructions-audit', audit }); } catch (_) {}
    } else {
      console.log(`  [audit] PASS - ${audit.checks.length} checks, ${audit.ranAt}`);
    }
  } catch (e) { console.warn('  [audit] error running audit:', e.message); }
}

// ── Pre-trust folder for a CLI (called from the frontend before launching) ─
addRoute('POST', '/api/cli/pretrust', async (req, res) => {
  try {
    const body = await readBody(req);
    const cli = String(body.cli || '').trim();
    const cwd = String(body.cwd || '').trim();
    if (!cli || !cwd) return json(res, { ok: false, error: 'cli and cwd are required' }, 400);
    try { pretrustFolderForCli(cli, cwd); } catch (_) {}
    return json(res, { ok: true });
  } catch (e) {
    return json(res, { ok: false, error: e && e.message ? e.message : String(e) }, 500);
  }
});

// ── Mount orchestrator ───────────────────────────────────────────────────────
const orchestrator = mountOrchestrator(addRoute, json, { terminals, broadcast, repoRoot, createTerminal, getConfig, getLearnings: () => _learningsInstance, getUiContext: getUiContextWithPath });
const { mountJobs } = require('./jobs-scheduler');
mountJobs(addRoute, json, { repoRoot, orchestrator, broadcast });
const { mountGit } = require('./routes/git');
mountGit(addRoute, json, { getRepoPath, broadcast, swrGit, guard });
const { mountFiles } = require('./routes/files');
mountFiles(addRoute, json, { getRepoPath, broadcast });
const { mountNotes } = require('./routes/notes');
mountNotes(addRoute, json, { repoRoot, broadcast, hybridSearch, getUiContext: getUiContextWithPath });
const { mountCliInstall } = require('./routes/cli-install');
mountCliInstall(addRoute, json, { configPath });
const { mountConfig } = require('./routes/config');
mountConfig(addRoute, json, {
  getConfig, normalizeRootConfig, configPath, templatePath, repoRoot, pluginsDir,
  swrGit, swrPlugins, broadcast, writePluginHints, getPlugins: () => loadedPlugins,
});
console.log('  Orchestrator bus mounted (/api/orchestrator/*)');
trace.mark('server:orchestrator-mounted');

// ── Mount Mind (shared knowledge graph for every dispatched CLI) ────────────
const { mountMind } = require('./mind');
// Brain reference holder - mountMind closes over this so it can call
// brain.notifyIntent + sequences.recordEvent from inside its internal
// notifyKnowledgeEvent function. We populate _brainForKnowledgeEvents
// after mountBrain runs; the hook function only executes lazily on
// real knowledge events, by which time the holder is set.
let _brainForKnowledgeEvents = null;
const _brainSequences = require('./brain/sequences');
const mind = mountMind(addRoute, json, {
  repoRoot, broadcast,
  getUiContext: getUiContextWithPath,
  getLearnings: () => _learningsInstance,
  getPlugins: () => loadedPlugins,
  // Multi-repo ingestion: when allRepos:true is passed to /api/mind/build
  // or /api/mind/update, the engine pulls every repo Symphonee manages
  // (cfg.Repos) instead of just the active one.
  getAllRepos: () => (getConfig().Repos || {}),
  getAiApiKeys: () => (getConfig().AiApiKeys || {}),
  // Reflection scheduler reads EnableContinuousLearning from here. Passed
  // as a getter so settings changes take effect without restart.
  getConfig,
  // Knowledge-event hook: fires from inside Mind on save-result, teach,
  // /add, learnings, etc. Feeds the brain's intent model AND the sequence
  // recorder so workflow synthesis has signal. Best-effort; must never
  // throw or block the Mind path.
  onKnowledgeEvent: (ev) => {
    try {
      if (!_brainForKnowledgeEvents) return;
      const ui = getUiContextWithPath();
      const kind = ev.kind || ev.reason || 'knowledge-event';
      const repo = ui && ui.activeRepo || null;
      _brainForKnowledgeEvents.notifyIntent({ kind, detail: ev.reason || null, repo, source: 'mind/notify' });
      _brainSequences.recordEvent(repoRoot, { kind, repo, detail: ev.reason || null, source: 'mind/notify' });
    } catch (_) { /* swallow */ }
  },
});
console.log('  Mind mounted (/api/mind/*) - shared knowledge graph');
trace.mark('server:mind-mounted');
// Wire orchestrator -> Mind so every dispatched worker prompt is prefixed
// with the brain's current state (node count, staleness, query URL), and
// every completed task gets saved back as a shared conversation node.
if (orchestrator) {
  orchestrator.getMindHint = (opts) => mind.orchestratorHint(opts || {});
  orchestrator.saveTaskToMind = (task) => mind.saveTaskToMind(task);
}

// ── Mount Skill Corpus (the procedural layer of the cognitive loop) ─────────
// Model-neutral SKILL.md recipes for HOW to do tasks the same way every time.
// Surfaced in /api/bootstrap (so every direct CLI session sees the catalog) and
// injected into dispatched-worker prompts (so delegated work follows the same
// procedures). The body of each skill is fetched on demand from /api/skills/item.
const { mountSkills } = require('./skill-corpus');
const skills = mountSkills(addRoute, json, { repoRoot, broadcast });
console.log(`  Skill corpus mounted (/api/skills/*) -- ${skills.catalog().length} skill(s)`);
if (orchestrator) {
  orchestrator.getSkillsHint = () => skills.catalogText();
}
// Skill Reflection: the REFLECT->LEARN arc -- mines Mind's corrections into
// PROPOSED skills (propose-only; the user accepts). Closes the loop so the
// system improves its own procedures, not just its knowledge.
const { mountReflection } = require('./skill-reflection');
const skillReflection = mountReflection(addRoute, json, { repoRoot, getUiContext: getUiContextWithPath, broadcast });
console.log('  Skill reflection mounted (/api/skills/reflect, /api/skills/proposals)');
// Contracts: the INTEND arc -- commit substantial/autonomous work to a reviewable
// plan with acceptance criteria + per-unit evidence, so it is trustworthy and
// auditable (see the run-a-contract skill).
const { mountContracts } = require('./contracts');
const contracts = mountContracts(addRoute, json, { repoRoot, broadcast });
console.log('  Contracts mounted (/api/contracts/*)');

// ── Mount Symphonee brain (planner + live intent model) ─────────────────────
// The brain is the reasoning layer above Mind. Mind is memory; the brain
// classifies inputs, picks tools, and (when planner mode is "active")
// dispatches CLIs as tools via the orchestrator. Lives at /api/symphonee/*.
// The brain is always on. When the orchestrator gets a spawn call without
// a cli, the brain picks; otherwise the explicit cli wins. No mode toggle.
const { mountBrain } = require('./brain');
const brain = mountBrain(addRoute, json, {
  repoRoot, broadcast,
  getUiContext: getUiContextWithPath,
  getConfig,
});
console.log('  Brain mounted (/api/symphonee/*) - planner + intent');
trace.mark('server:brain-mounted');

// Give the orchestrator a reference to the brain so /api/orchestrator/spawn
// can consult brain.plan() when no cli was supplied. Set after both mount
// so dependency direction stays one-way: orchestrator uses brain, not the
// other way round.
if (orchestrator && typeof brain.plan === 'function') {
  orchestrator.brain = brain;
}

// Populate the brain holder Mind's onKnowledgeEvent hook closes over.
// From this line forward, every knowledge event (save-result, teach,
// learnings, /add, file watch trigger) feeds brain.notifyIntent AND
// sequences.recordEvent. Best-effort, fail-silent.
_brainForKnowledgeEvents = brain;

// ── Boot-time brain setup check ─────────────────────────────────────────────
// Auto-install everything the brain needs. The user never has to think about
// model installs - Symphonee handles it.
//
// Policy:
//   - Ollama missing      -> toast points at the download URL (we cannot
//                            install Ollama itself silently; it requires
//                            an installer with admin rights).
//   - Ollama stopped      -> auto-start via `ollama serve`.
//   - Triage missing      -> auto-pull (~1 GB).
//   - Reasoning missing   -> auto-pull (~16 GB). Yes it is big. It happens
//                            once. Progress streams via the existing
//                            ollama-pull WebSocket events so the UI can
//                            render a real progress bar. Brain features
//                            degrade until the pull completes but never
//                            crash. No user click required.
//
// Pulls run serially so we don't slam Ollama with two concurrent
// multi-gig streams. Deferred 4 s so the WS layer is ready.
// Brain dependency setup (Ollama running + models pulled). Heavy: detection,
// process spawn, and potentially multi-GB pulls. Invoked from the deferred boot
// work AFTER the dashboard has rendered (see runDeferredBootWork) so it does not
// starve the renderer's event loop during first paint.
function runBrainSetup() {
  const setupMod = require('./mind/ollama-setup');
  return setupMod.detectBrainSetup().then(async (status) => {
    if (!status.ollamaInstalled) {
      console.log('[brain/setup] Ollama not installed - brain features disabled until you install it from https://ollama.com/download');
      if (typeof broadcast === 'function') broadcast({
        type: 'notification',
        title: 'Symphonee brain: Ollama not installed',
        body: 'Install Ollama from https://ollama.com/download to enable the brain features.',
        level: 'warning', icon: 'cpu',
      });
      return;
    }
    if (!status.ollamaRunning) {
      const r = await setupMod.ensureRunning({ installPath: status.installPath });
      if (!r.ok) {
        console.log('[brain/setup] Ollama installed but not running and could not be started.');
        return;
      }
      status = await setupMod.detectBrainSetup();
    }
    const toPull = [];
    if (!status.triageModelInstalled) toPull.push({ model: status.triageModel, sizeHint: '~1 GB' });
    if (!status.reasoningModelInstalled) toPull.push({ model: status.reasoningModel, sizeHint: '~16 GB' });
    if (!toPull.length) {
      console.log('[brain/setup] all brain dependencies present.');
      return;
    }
    for (const { model, sizeHint } of toPull) {
      console.log(`[brain/setup] Auto-pulling "${model}" (${sizeHint})...`);
      if (typeof broadcast === 'function') broadcast({
        type: 'notification',
        title: 'Symphonee brain: downloading ' + model,
        body: `Pulling ${model} (${sizeHint}). One-time. Watch the progress in the activity feed.`,
        level: 'info', icon: 'download',
      });
      try {
        const r = await setupMod.ensureModel({ model, broadcast });
        if (r && r.ok) {
          console.log(`[brain/setup] "${model}" installed.`);
          if (typeof broadcast === 'function') broadcast({
            type: 'notification',
            title: 'Symphonee brain: ' + model + ' ready',
            body: 'Download complete. Brain features now active.',
            level: 'success', icon: 'check-circle',
          });
          // When the heavy reasoning model lands, Symphonee restarts so
          // every cached chat-status / llm-status / brain-faculty state
          // starts fresh against the upgraded model. We notify the user
          // first and wait 10 s so they see what is about to happen and
          // can save any in-flight work.
          if (model === status.reasoningModel) {
            console.log('[brain/setup] reasoning model installed -- scheduling restart in 10 s.');
            if (typeof broadcast === 'function') broadcast({
              type: 'notification',
              title: 'Restarting Symphonee in 10 s',
              body: `Reasoning model ${model} just installed. Symphonee will restart to activate brain features fully. Save any unfinished work.`,
              level: 'info', icon: 'rotate-cw',
            });
            setTimeout(() => {
              try {
                const req = http.request({
                  hostname: '127.0.0.1', port: PORT, path: '/api/restart-app', method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
                });
                req.on('error', () => { /* server already going down */ });
                req.write('{}');
                req.end();
              } catch (_) { /* swallow */ }
            }, 10_000);
          }
        } else {
          console.warn(`[brain/setup] failed to pull "${model}":`, r && r.error);
          if (typeof broadcast === 'function') broadcast({
            type: 'notification',
            title: 'Symphonee brain: ' + model + ' pull failed',
            body: (r && r.error) || 'Pull failed; retry on next boot or POST /api/symphonee/setup/pull.',
            level: 'warning', icon: 'alert-triangle',
          });
        }
      } catch (err) {
        console.warn(`[brain/setup] error pulling "${model}":`, err.message);
      }
    }
  }).catch((err) => {
    console.warn('[brain/setup] error:', err.message);
  });
}

// ── Deferred boot work (de-congestion) ──────────────────────────────────────
// The Mind graph refresh (a full incremental rebuild) and the brain setup above
// are CPU/IO heavy and run on this single event loop. Firing them on fixed
// timers used to overlap the dashboard's first render and starve its asset/API
// requests (renderer load regressed once the splash fix made first-paint
// earlier). Instead, run them ONCE, triggered by whichever comes first:
//   - POST /api/internal/app-ready  (electron-main posts this after the
//     dashboard finishes loading, plus a short settle), or
//   - a fallback timer, so a headless `node server.js` still runs them.
// After the incremental graph refresh we regenerate the splash/boot-overlay
// quote pool so the next boot shows fresh, personal quotes.
let _deferredBootWorkStarted = false;
function runDeferredBootWork(trigger) {
  if (_deferredBootWorkStarted) return;
  _deferredBootWorkStarted = true;
  console.log(`[boot] running deferred boot work (trigger: ${trigger || 'unknown'})`);
  Promise.resolve()
    // awaitStartupSettle runs the refresh AND waits for the graph build lock to
    // free, so /api/startup/status.ready (which the boot overlay polls) only
    // flips true once the Mind + repos are genuinely done -- not mid-build.
    .then(() => (typeof mind.awaitStartupSettle === 'function'
      ? mind.awaitStartupSettle()
      : (typeof mind.kickoffStartupRefresh === 'function' ? mind.kickoffStartupRefresh() : null)))
    .catch(() => {})
    .then(() => (typeof mind.regenerateSplashQuotes === 'function' ? mind.regenerateSplashQuotes() : null))
    .catch(() => {})
    // After Mind has settled, reflect on accumulated corrections and propose
    // skills (propose-only -- the user accepts). Cheap, deduped, never auto-edits.
    .then(() => (skillReflection && typeof skillReflection.runDigest === 'function'
      ? skillReflection.runDigest({ max: 6 }).then(r => { if (r && r.proposals && r.proposals.length) console.log(`  [reflect] proposed ${r.proposals.length} skill(s) from Mind corrections`); })
      : null))
    .catch(() => {});
  // Stagger the brain setup slightly so the graph refresh gets the loop first.
  setTimeout(() => { try { runBrainSetup(); } catch (e) { console.warn('[brain/setup] start error:', e.message); } }, 1200);
  // Daily reflection so corrections accumulated during long-running sessions
  // become proposed skills without needing a restart.
  if (!_skillReflectionInterval) {
    _skillReflectionInterval = setInterval(() => {
      try { if (skillReflection && skillReflection.runDigest) skillReflection.runDigest({ max: 6 }).catch(() => {}); } catch (_) {}
    }, 24 * 60 * 60 * 1000);
  }
}
let _skillReflectionInterval = null;

// Trigger 1: explicit signal from the renderer once the dashboard has loaded.
addRoute('POST', '/api/internal/app-ready', (req, res) => {
  setTimeout(() => runDeferredBootWork('app-ready'), 500);
  json(res, { ok: true });
});
// Trigger 2: fallback so a headless server (no Electron renderer) still runs it.
setTimeout(() => runDeferredBootWork('fallback-timer'), 9000);

// ── Mount learnings ─────────────────────────────────────────────────────────
const learningsDataDir = path.join(repoRoot, '.ai-workspace');
_learningsInstance = mountLearnings(addRoute, json, {
  dataDir: learningsDataDir, getConfig, readBody,
  onChange: (event) => {
    // Wire learning ledger mutations into Mind so the brain reacts the
    // same way it does to save-result / teach / file edits.
    try { if (mind && mind.notifyKnowledgeEvent) mind.notifyKnowledgeEvent({ kind: event.kind, reason: event.kind, nodeIds: [] }); } catch (_) {}
  },
});
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

// ── Mount browser router (auto-picks between Stagehand and browser-use) ─────
try {
  const { mountBrowserRouterRoutes } = require('./browser-router');
  mountBrowserRouterRoutes(addRoute, json, { getConfig, broadcast, port: PORT });
  console.log('  Browser router mounted (/api/browser/router/*)');
} catch (e) {
  console.log('  Browser router skipped:', e.message);
}

// ── Mount apps agent (desktop control) ──────────────────────────────────────
try {
  const { mountAppsRoutes } = require('./apps-agent');
  mountAppsRoutes(addRoute, json, {
    getConfig,
    broadcast,
    permGate,
    resolveTermCli: (termId) => {
      const meta = termAiMeta.get(String(termId || ''));
      return meta && meta.cli ? meta.cli : null;
    },
  });
  console.log('  Apps agent mounted (/api/apps/*)');
} catch (e) {
  console.log('  Apps agent skipped:', e.message);
}

// ── Load plugins ─────────────────────────────────────────────────────────────
loadedPlugins = loadPlugins(pluginsDir, {
  addRoute, getConfig, broadcast, json, writePluginHints,
  swrCache: swrPlugins,
  shellDeps: {
    gitExec, sanitizeText, permGate,
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
trace.mark('server:plugins-loaded', { count: loadedPlugins.length });
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
    // Skip anything the user uninstalled on purpose - re-cloning a plugin the
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
  // Lists AI providers Symphonee can talk to via SDK, marking which ones the
  // user actually has keys for (saved in Settings -> AI Keys, or in env). Used
  // by plugin settings dropdowns so users only see models they can actually run.
  addRoute('GET', '/api/ai/providers', (req, res) => {
    const cfg = getConfig() || {};
    const saved = cfg.AiApiKeys || {};
    const providers = [
      {
        key: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY',
        models: [
          { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
          { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
          { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
        ],
      },
      {
        key: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY',
        models: [
          { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
          { id: 'openai/gpt-4o', label: 'GPT-4o' },
          { id: 'openai/o3', label: 'o3' },
          { id: 'openai/o4-mini', label: 'o4-mini' },
        ],
      },
      {
        key: 'google', label: 'Google Gemini', envKey: 'GEMINI_API_KEY',
        models: [
          { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
          { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
          { id: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)' },
        ],
      },
      {
        key: 'xai', label: 'xAI Grok', envKey: 'XAI_API_KEY',
        models: [
          { id: 'xai/grok-4', label: 'Grok 4' },
          { id: 'xai/grok-3', label: 'Grok 3' },
          { id: 'xai/grok-3-mini-fast', label: 'Grok 3 Mini Fast' },
        ],
      },
    ].map(p => ({
      ...p,
      configured: !!saved[p.envKey] || !!process.env[p.envKey],
    }));
    json(res, { ok: true, providers });
  });

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
  // Coherence audit. GET returns the cached result; POST forces a refresh.
  // Every /api/bootstrap response also embeds the cached audit so every CLI
  // sees the audit state at session start. This is the self-healing chain.
  addRoute('GET', '/api/instructions/audit', (req, res) => {
    let result = instructionAudit.getCached();
    if (!result) { try { result = instructionAudit.run({ repoRoot }); } catch (e) { return json(res, { error: e.message }, 500); } }
    return json(res, result);
  });
  addRoute('POST', '/api/instructions/audit', async (req, res) => {
    try {
      const result = instructionAudit.run({ repoRoot });
      try { broadcast({ type: 'instructions-audit', audit: result }); } catch (_) {}
      return json(res, result);
    } catch (e) { return json(res, { error: e.message }, 500); }
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
trace.mark('server:module-eval:done');
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
    trace.mark('server:listen-callback');
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
