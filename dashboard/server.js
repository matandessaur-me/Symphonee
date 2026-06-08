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
const { readProcessTree: _readProcessTree, detectAiUnder: _detectAiUnder } = require('./lib/ai-tree-detect');
const { createPluginHints } = require('./lib/plugin-hints');
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

const PORT = Number(process.env.SYMPHONEE_PORT) || 3800;
const HOST = '127.0.0.1';
const repoRoot = path.resolve(__dirname, '..');

// Action Ledger holder. The module is initialised once `broadcast` is available
// (see below); `permGate` and other early code reference this holder, which is
// null until then and a no-op-safe instance after. Declared here so functions
// defined above the init site can close over it without a TDZ hazard.
let _ledger = null;

// ── Origin / Host firewall (anti-CSRF, anti-DNS-rebinding) ──────────────────
// The local API runs high-privilege actions (terminals, git, file I/O,
// automation, plugins) and has no auth token yet, so it MUST reject any request
// that didn't come from the app's own renderer or a local CLI. Rules:
//   - A browser cross-site request ALWAYS carries an Origin header; CLIs / curl
//     / server-to-server send NONE. So "no Origin" = trusted local caller.
//   - The renderer is same-origin (http://127.0.0.1:PORT) -> allowed.
//   - Any foreign Origin (a malicious page the user merely opens) -> 403.
//   - The Host header must be loopback; a DNS-rebinding page rebinds its domain
//     to 127.0.0.1 but still sends Host: attacker.com -> 403.
const ALLOWED_ORIGINS = new Set([
  `http://${HOST}:${PORT}`, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
]);
const ALLOWED_HOSTS = new Set([
  `${HOST}:${PORT}`, `localhost:${PORT}`, `127.0.0.1:${PORT}`,
  HOST, 'localhost', '127.0.0.1', `[::1]:${PORT}`, '[::1]',
]);
function _hostIsLoopback(host) {
  if (!host) return true; // HTTP/1.0 / some local clients omit Host
  return ALLOWED_HOSTS.has(String(host).toLowerCase());
}
function _originAllowed(origin) {
  if (!origin) return true;            // not a browser cross-site request
  const o = String(origin).toLowerCase();
  if (o === 'null') return false;      // opaque/sandboxed origin -> reject
  return ALLOWED_ORIGINS.has(o);
}
// True if the request may proceed. Used for both HTTP (below) and WS upgrades.
function isRequestAllowed(req) {
  return _hostIsLoopback(req.headers && req.headers.host) && _originAllowed(req.headers && req.headers.origin);
}

const publicDir = path.join(__dirname, 'public');
const notesDir = path.join(repoRoot, 'notes'); // shared: hybrid-search index + note path-guards (note ROUTES live in routes/notes.js)
const nodeModules = path.join(repoRoot, 'node_modules');
const configPath = path.join(repoRoot, 'config', 'config.json');
const templatePath = path.join(repoRoot, 'config', 'config.template.json');

// ── Static file routes ─────────────────────────────────────────────────────
const ROUTES = {
  '/':                        { file: path.join(publicDir, 'index.html'),                                          type: 'text/html' },
  '/styles/app.css':          { file: path.join(publicDir, 'styles', 'app.css'),                                   type: 'text/css' },
  '/js/app.js':               { file: path.join(publicDir, 'js', 'app.js'),                                        type: 'application/javascript' },
  // Extracted renderer ES-module bundles (built by scripts/build-renderer.js).
  // The server allow-lists static files, so every bundle index.html loads MUST
  // be registered here or it 404s and its window.* exports never define.
  '/js/util.js':              { file: path.join(publicDir, 'js', 'util.js'),                                       type: 'application/javascript' },
  '/js/pinned-tabs.js':       { file: path.join(publicDir, 'js', 'pinned-tabs.js'),                                type: 'application/javascript' },
  '/js/local-model-prompt.js':{ file: path.join(publicDir, 'js', 'local-model-prompt.js'),                         type: 'application/javascript' },
  '/js/mcp.js':               { file: path.join(publicDir, 'js', 'mcp.js'),                                        type: 'application/javascript' },
  '/js/notes-search.js':      { file: path.join(publicDir, 'js', 'notes-search.js'),                               type: 'application/javascript' },
  '/js/permissions.js':       { file: path.join(publicDir, 'js', 'permissions.js'),                                type: 'application/javascript' },
  '/js/activity-timeline.js': { file: path.join(publicDir, 'js', 'activity-timeline.js'),                          type: 'application/javascript' },
  '/js/activity-ledger.js':   { file: path.join(publicDir, 'js', 'activity-ledger.js'),                            type: 'application/javascript' },
  '/js/browser-credentials.js':{ file: path.join(publicDir, 'js', 'browser-credentials.js'),                       type: 'application/javascript' },
  '/js/plugin-registry.js':   { file: path.join(publicDir, 'js', 'plugin-registry.js'),                            type: 'application/javascript' },
  '/js/themes.js':            { file: path.join(publicDir, 'js', 'themes.js'),                                     type: 'application/javascript' },
  '/js/notifications.js':     { file: path.join(publicDir, 'js', 'notifications.js'),                              type: 'application/javascript' },
  '/js/pull-requests.js':     { file: path.join(publicDir, 'js', 'pull-requests.js'),                              type: 'application/javascript' },
  '/js/git.js':               { file: path.join(publicDir, 'js', 'git.js'),                                        type: 'application/javascript' },
  '/js/files.js':             { file: path.join(publicDir, 'js', 'files.js'),                                      type: 'application/javascript' },
  '/js/notes.js':             { file: path.join(publicDir, 'js', 'notes.js'),                                      type: 'application/javascript' },
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
  // Ledger recording happens centrally inside permissions.gate() via the
  // registered recorder (see permissions.setRecorder below), so EVERY gate
  // caller -- this wrapper, the orchestrator's gateSpawn, the apps routes --
  // is captured uniformly. Nothing to do here but delegate.
  return permissions.gate(res, { type, value }, { configPath, actionLabel: label });
}

// ── Learnings (collective intelligence) ──────────────────────────────────────
const { mountLearnings } = require('./learnings');
let _learningsInstance = null;
trace.mark('server:top-requires-done');

// ── Shared HTTP helpers (extracted to lib/http-helpers.js) ──────────────────
const { readBody, json, formatAge } = require('./lib/http-helpers');

// Shared sync git helper (git routes live in routes/git.js; this stays here
// because plugins receive it via shellDeps).
function gitExec(repoPath, cmd, timeoutMs) {
  return gitSync(repoPath, cmd, timeoutMs);
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Origin/Host firewall: block cross-site (CSRF) and DNS-rebinding before any
  // route runs. Local CLIs (no Origin) and the same-origin renderer pass.
  if (!isRequestAllowed(req)) {
    try { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cross-origin request blocked' })); } catch (_) {}
    return;
  }
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
        { const _r = path.resolve(candidate), _b = path.resolve(notesDir); if (_r !== _b && !_r.startsWith(_b + path.sep)) return json(res, { error: 'Invalid path' }, 403); }
        target = candidate;
      } else if (type === 'file') {
        const repoName = String(body.repo || '').trim();
        const rel = String(body.path || '').replace(/\.\./g, '');
        const cfg = getConfig();
        const repoPath = (cfg.Repos || {})[repoName];
        if (!repoPath) return json(res, { error: `Repo '${repoName}' not configured` }, 400);
        const candidate = rel ? path.join(repoPath, rel) : repoPath;
        { const _r = path.resolve(candidate), _b = path.resolve(repoPath); if (_r !== _b && !_r.startsWith(_b + path.sep)) return json(res, { error: 'Invalid path' }, 403); }
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
    // Spaces: non-git workspaces (Personal, Business, Freelance, ...). Stored
    // like repos but flagged so the UI hides git actions. Live at a separate
    // route so existing repo consumers are unaffected.
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

    // ── Open External URL ─────────────────────────────────────────────────

    // ── UI Actions (AI → Dashboard) ───────────────────────────────────────
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

// ── UI Actions (AI -> Dashboard) ─────────────────────────────────────────────
// ── File Browser ────────────────────────────────────────────────────────────
function getRepoPath(repoName) {
  const cfg = getConfig();
  const repos = cfg.Repos || {};
  return repos[repoName] || null;
}

// ── UI Context (tracks what's selected in the dashboard) ────────────────────
// activeSpace is the organizational container (e.g. "Business"); activeRepo is
// the specific working repo inside that space. They can be independent.
//
// Persisted to <repoRoot>/.symphonee/ui-state.json so the user's selection
// survives an app restart. Restoring on boot is best-effort - if the saved
// repo no longer exists in config, fall back to nothing.
const { createUiContextStore } = require('./lib/ui-context');
const { createTerminalHub } = require('./lib/terminal-hub');
const _termHub = createTerminalHub({ httpServer: server, repoRoot, getConfig, verifyUpgrade: isRequestAllowed });
const { broadcast, terminals, termAiMeta, createTerminal, killTerminal } = _termHub;
const _uiCtxStore = createUiContextStore({ repoRoot, getConfig, broadcast, onActiveRepoChange: () => { try { writePluginHints(); } catch (_) {} } });
const getUiContextWithPath = _uiCtxStore.getUiContext;

// Resolve the active space (the ledger + Mind both partition by it).
const getSpace = () => { try { return getUiContextWithPath().activeSpace || null; } catch (_) { return null; } };

// ── Action Ledger ───────────────────────────────────────────────────────────
// Initialise now that broadcast exists. `permGate` (defined above) and the
// orchestrator/git routes (below) record through this. Lives beside Mind under
// <repoRoot>/.symphonee/ledger/<space>.jsonl.
_ledger = require('./lib/ledger').init({ dir: path.join(repoRoot, '.symphonee', 'ledger'), broadcast });
const ledger = _ledger;

// Register the ledger as the permission engine's recorder. Every gate decision
// (allow/ask/deny/rejected) -- from permGate, the orchestrator's gateSpawn, the
// apps routes, anywhere -- now lands in the ledger from one chokepoint. This is
// where permission DENIALS finally get recorded; before, they vanished.
permissions.setRecorder(({ action, decision, outcome, label }) => {
  const ui = getUiContextWithPath();
  const type = (action && action.type) || 'api';
  const category = type === 'cli' ? 'cli' : (type === 'plugin' ? 'plugin' : (type === 'tool' ? 'system' : 'api'));
  ledger.record({
    category,
    action: (action && action.value) || 'unknown',
    resource: label || (action && action.value) || null,
    decision,
    outcome,
    actor: 'main',
    space: (ui && ui.activeSpace) || null,
    repo: (ui && ui.activeRepo) || null,
    detail: label || null,
  });
});

// Git-based checkpoints (the "undo" behind the ledger). Stored alongside the
// ledger under .symphonee/ledger/checkpoints/<id>.json.
const checkpoint = require('./lib/checkpoint').init({ dir: path.join(repoRoot, '.symphonee', 'ledger', 'checkpoints') });

const writePluginHints = createPluginHints({ repoRoot, pluginsDir, getConfig, getUiContext: getUiContextWithPath, broadcast });

function handleHealthCheck(res) {
  json(res, {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    terminals: terminals.size,
    activeLocks: guard.activeLocks().length,
  });
}

// ── AI CLI detection (process tree) ─────────────────────────────────────────
// Given a parent PID, find whether any known AI CLI is running as a
// descendant. Lets the frontend reliably decide whether to show "Launch AI"
// or "Restart Shell" even after a page refresh.
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

// ── Write .claude/CLAUDE.md with plugin instructions for AI ─────────────────
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
const { mountSpaces } = require('./routes/spaces');
mountSpaces(addRoute, json, { getConfig, normalizeRootConfig, configPath, broadcast });
const { mountImageProxy } = require('./routes/image-proxy');
mountImageProxy(addRoute, json, { getConfig, getPlugins: () => loadedPlugins, host: HOST, port: PORT });
const { mountPluginRecommendations } = require('./routes/plugin-recommendations');
mountPluginRecommendations(addRoute, json, { getConfig, getUiContext: getUiContextWithPath, pluginsDir, getPlugins: () => loadedPlugins });
_uiCtxStore.mountRoutes(addRoute, json);
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

// ── Action Ledger routes ────────────────────────────────────────────────────
// GET /api/ledger        - newest-first action history (filterable)
// GET /api/ledger/stats  - aggregate counts for the activity summary
addRoute('GET', '/api/ledger', (req, res, url) => {
  const p = url.searchParams;
  const space = p.get('space') || getSpace();
  const entries = ledger.query({
    space,
    since: p.get('since') || undefined,
    until: p.get('until') || undefined,
    category: p.get('category') || undefined,
    actor: p.get('actor') || undefined,
    outcome: p.get('outcome') || undefined,
    decision: p.get('decision') || undefined,
    q: p.get('q') || undefined,
    limit: Number(p.get('limit')) || 200,
  });
  json(res, { space, entries, count: entries.length });
});
addRoute('GET', '/api/ledger/stats', (req, res, url) => {
  const p = url.searchParams;
  json(res, ledger.stats({ space: p.get('space') || getSpace(), since: p.get('since') || undefined }));
});

// Checkpoints (undo). create = non-destructive snapshot (ungated, like a read).
// undo = mutates the working tree, so it goes through permGate.
addRoute('GET', '/api/ledger/checkpoints', (req, res, url) => {
  const repo = url.searchParams.get('repo') || undefined;
  json(res, { checkpoints: checkpoint.list({ repo, limit: Number(url.searchParams.get('limit')) || 50 }) });
});
addRoute('POST', '/api/ledger/checkpoint', async (req, res) => {
  const body = await readBody(req);
  const ui = getUiContextWithPath();
  const repoName = body.repo || (ui && ui.activeRepo);
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'No repo selected or repo not found' }, 400);
  try {
    const cp = await checkpoint.create(repoPath, { label: body.label, repo: repoName });
    ledger.record({
      category: 'git', action: 'checkpoint.create', resource: repoName,
      decision: null, outcome: 'ok', actor: body.actor || 'main',
      space: (ui && ui.activeSpace) || null, repo: repoName,
      detail: (cp.label ? cp.label + ' -- ' : '') + cp.changed + ' changed', checkpointId: cp.id,
    });
    json(res, { checkpoint: cp });
  } catch (e) { json(res, { error: e.message }, 400); }
});
addRoute('POST', '/api/ledger/undo', async (req, res) => {
  const body = await readBody(req);
  const cp = checkpoint.get(body.checkpointId);
  if (!cp) return json(res, { error: 'Checkpoint not found' }, 404);
  if (!await permGate(res, 'api', 'POST /api/ledger/undo', 'Undo ' + (cp.repo || 'repo') + ' to checkpoint "' + (cp.label || cp.id) + '"')) return;
  const ui = getUiContextWithPath();
  try {
    const r = await checkpoint.restore(body.checkpointId);
    ledger.record({
      category: 'git', action: 'checkpoint.undo', resource: cp.repo,
      decision: 'allow', outcome: 'ok', actor: body.actor || 'main',
      space: (ui && ui.activeSpace) || null, repo: cp.repo,
      detail: 'Reverted to "' + (cp.label || cp.id) + '"' + (r.safety ? ' (safety ' + r.safety.id + ')' : ''),
      checkpointId: cp.id,
    });
    json(res, { ok: true, ...r });
  } catch (e) {
    ledger.record({ category: 'git', action: 'checkpoint.undo', resource: cp.repo, outcome: 'error', detail: e.message, repo: cp.repo, space: (ui && ui.activeSpace) || null, checkpointId: cp.id });
    json(res, { error: e.message }, 400);
  }
});
console.log('  Ledger mounted (/api/ledger) - cross-CLI action history + checkpoints');
// Wire orchestrator -> Mind so every dispatched worker prompt is prefixed
// with the brain's current state (node count, staleness, query URL), and
// every completed task gets saved back as a shared conversation node.
if (orchestrator) {
  orchestrator.getMindHint = (opts) => mind.orchestratorHint(opts || {});
  orchestrator.saveTaskToMind = (task) => mind.saveTaskToMind(task);
  // Context pack: a short "what just happened" digest from the action ledger so
  // a dispatched worker starts aware of recent actions/changes in the active
  // repo and the checkpoints it could revert to -- it inherits the same
  // cross-CLI activity view the user has, instead of starting blind.
  orchestrator.getLedgerHint = () => {
    try {
      const ui = getUiContextWithPath();
      const space = (ui && ui.activeSpace) || null;
      const repo = (ui && ui.activeRepo) || null;
      let rows = ledger.query({ space, limit: 40 });
      if (repo) rows = rows.filter((r) => !r.repo || r.repo === repo);
      rows = rows.slice(0, 12);
      if (!rows.length) return '';
      const lines = rows.map((r) => {
        const t = String(r.ts || '').slice(11, 16);
        const res = r.resource ? ' (' + String(r.resource).slice(0, 60) + ')' : '';
        const dec = (r.decision && r.decision !== 'allow') ? ' [' + r.decision + ']' : '';
        return `  - ${t} ${r.actor} ${r.action}${res} -> ${r.outcome}${dec}`;
      });
      let cpLine = '';
      try {
        const cps = checkpoint.list({ repo, limit: 3 });
        if (cps.length) cpLine = `\nRecent checkpoints (revert via POST /api/ledger/undo {"checkpointId"}): ${cps.map((c) => c.id + (c.label ? '="' + c.label + '"' : '')).join(', ')}`;
      } catch (_) {}
      return `[recent activity: last ${rows.length} server action(s)${repo ? ' in ' + repo : ''}]\n${lines.join('\n')}${cpLine}`;
    } catch (_) { return ''; }
  };
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
    // The heavy reasoning model (~16 GB) is NOT auto-pulled. Forcing that
    // download -- plus a restart -- on someone's first launch is hostile. It is
    // installed on demand from Settings > Local AI ("Install brain models").
    // Just surface that it's optional; memory + triage work fine without it.
    if (!status.reasoningModelInstalled && typeof broadcast === 'function') {
      broadcast({
        type: 'notification',
        title: 'Optional: deeper reasoning model',
        body: `${status.reasoningModel} (~16 GB) is optional and not downloaded automatically. Install it any time from Settings > Local AI.`,
        level: 'info', icon: 'cpu',
      });
    }
    if (!toPull.length) {
      console.log('[brain/setup] all auto brain dependencies present.');
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
          // (No auto-restart: only the small triage model is auto-pulled now,
          // and we never force a restart on the user during boot.)
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
        // Arg array (no shell) so a crafted/MITM'd registry `repo` value can't
        // inject shell commands.
        const { spawnSync } = require('child_process');
        const cloneRes = spawnSync('git', ['clone', entry.repo + '.git', destDir], { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        if (cloneRes.status !== 0) throw new Error('git clone failed: ' + String(cloneRes.stderr || cloneRes.error || '').slice(0, 200));
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

// ── AI Instructions endpoint (extracted to routes/instructions.js) ──────────
require('./routes/instructions').mountInstructions(addRoute, json, { getConfig, repoRoot, broadcast });

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
