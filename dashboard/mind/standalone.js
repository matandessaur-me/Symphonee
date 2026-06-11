/**
 * @symphonee/mind - standalone server (Stage 7 / mind-extraction Phase 2-3).
 *
 * Runs Mind's 62-route HTTP surface with NO Electron, NO server.js, NO plugins -
 * just a plain config object in place of the host ctx. This is the packaging
 * payoff the plan promised ("Mind runs standalone via npx") and it composes
 * with the Stage-1 seam: lib/mind-client.js { transport:'http' } talks to this
 * exact server, so the brain can consume a LOCAL in-process Mind or a REMOTE
 * standalone Mind through one identical contract.
 *
 * Usage (programmatic):
 *   const { createMindServer } = require('./mind/standalone');
 *   const app = createMindServer({ repoRoot, space: '_global' });
 *   await app.listen(3900);
 *
 * Usage (CLI / npx-style):
 *   node dashboard/mind/standalone.js --repo <path> --port 3900 --space _global
 *
 * The host ctx (mountMind's ~10 fields) collapses to a config object with safe
 * defaults: no broadcaster, no plugins, no learnings, no knowledge-event hook.
 * Mind needs none of them to serve query/recall/teach/save-result/stats/build.
 */

'use strict';

const http = require('http');
const path = require('path');
const { mountMind } = require('./index');

function createMindServer(config = {}) {
  const repoRoot = config.repoRoot || process.cwd();
  const space = config.space || '_global';

  const routes = [];
  const addRoute = (method, pathname, handler) => routes.push({ method: method.toUpperCase(), pathname, handler });
  const json = (res, data, status = 200) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Host ctx -> plain config object. Optional Electron-only hooks degrade to
  // no-ops / empty sources, exactly as the extraction-scope note prescribed.
  const ctx = {
    repoRoot,
    broadcast: config.broadcast || (() => {}),
    getUiContext: config.getUiContext || (() => ({
      activeRepo: config.activeRepo || null,
      activeRepoPath: config.activeRepoPath || repoRoot,
      notesNamespace: space,
      activeSpace: space,
    })),
    getLearnings: config.getLearnings || (() => null),
    getPlugins: config.getPlugins || (() => []),
    getAllRepos: config.getAllRepos || (() => ({})),
    getAiApiKeys: config.getAiApiKeys || (() => ({})),
    getConfig: config.getConfig || (() => ({})),
    getNotesDir: config.getNotesDir || (() => path.join(repoRoot, 'notes', space)),
    onKnowledgeEvent: config.onKnowledgeEvent || (() => {}),
    // Gate the post-boot auto-embed timer off by default (it is the only
    // non-unref'd timer). Opt in with autoBootstrapEmbeddings:true.
    _autoBootstrapStarted: config.autoBootstrapEmbeddings ? false : true,
  };

  const mind = mountMind(addRoute, json, ctx);

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return json(res, { error: 'bad url' }, 400); }
    let route = routes.find(r => r.method === req.method && r.pathname === url.pathname);
    let subpath;
    if (!route) {
      route = routes.find(r => r.method === '__PREFIX__' && (url.pathname === r.pathname || url.pathname.startsWith(r.pathname + '/')));
      if (route) subpath = url.pathname.slice(route.pathname.length) || '/';
    }
    if (!route) return json(res, { error: 'not found', path: url.pathname }, 404);
    try {
      const out = route.handler(req, res, url, subpath);
      if (out && typeof out.then === 'function') out.catch(e => json(res, { error: e.message }, 500));
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });

  return {
    server,
    mind,
    routeList: () => routes.map(r => `${r.method} ${r.pathname}`),
    listen(port = config.port || 3900, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() { return new Promise((resolve) => server.close(() => resolve())); },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
  const repoRoot = path.resolve(get('--repo', process.cwd()));
  const space = get('--space', '_global');
  const port = parseInt(get('--port', '3900'), 10);
  const autoEmbed = args.includes('--auto-embed');
  const app = createMindServer({ repoRoot, space, port, autoBootstrapEmbeddings: autoEmbed });
  app.listen(port).then((addr) => {
    console.log(`@symphonee/mind standalone listening on http://127.0.0.1:${addr.port}`);
    console.log(`repo: ${repoRoot} | space: ${space} | ${app.routeList().length} routes mounted`);
    console.log('Try: curl -s -X POST http://127.0.0.1:' + addr.port + '/api/mind/query -d \'{"question":"..."}\'');
  }).catch((e) => { console.error('[mind/standalone] failed:', e.message); process.exit(1); });
}

module.exports = { createMindServer };
