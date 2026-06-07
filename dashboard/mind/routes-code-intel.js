'use strict';
// Mind code-intelligence: impact, call-flow, symbols, entrypoints, circular, file graph.

const store = require('./store');
const impact = require('./impact');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, readBody } = deps;

  // ── Impact / call-flow / symbols / entrypoints / circular ───────────────
  // The "Mind got smarter" surface. Every endpoint reads the persisted graph
  // and computes on demand - no extra storage. Cheap because the graph is
  // already in memory after the first read.
  addRoute('POST', '/api/mind/impact', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const target = body.target || body.symbol || body.file;
    const depth = Number.isFinite(body.depth) ? body.depth : 3;
    if (!target) return json(res, { error: 'target required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, impact.getImpact(g, String(target), depth));
  });

  addRoute('POST', '/api/mind/flow', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const entry = body.entrypoint || body.target;
    const depth = Number.isFinite(body.depth) ? body.depth : 5;
    if (!entry) return json(res, { error: 'entrypoint required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const flow = impact.getCallFlow(g, String(entry), depth);
    if (!flow) return json(res, { error: 'entrypoint not found' }, 404);
    return json(res, { entrypoint: String(entry), depth, flow });
  });

  addRoute('POST', '/api/mind/symbol', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.name) return json(res, { error: 'name required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, { name: body.name, results: impact.getSymbolContext(g, body.name, body.file) });
  });

  addRoute('POST', '/api/mind/symbols', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, {
      results: impact.listSymbols(g, {
        file: body.file,
        query: body.query,
        limit: Number.isFinite(body.limit) ? body.limit : 200,
      }),
    });
  });

  addRoute('POST', '/api/mind/entrypoints', async (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, { entrypoints: impact.detectEntrypoints(g) });
  });

  addRoute('POST', '/api/mind/circular', async (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const cycles = impact.detectCircular(g);
    return json(res, { count: cycles.length, cycles });
  });

  // ── File-level browsing for the Impact UI ───────────────────────────────
  // The symbol-level call graph is approximate (regex-based) so its results
  // are noisy. The file-import graph is comprehensive and reliable. This
  // endpoint exposes it: a list of every code file with its imports +
  // dependents counts so the UI can build a file-first browser.
  addRoute('POST', '/api/mind/files', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);

    // Build adjacency for 'imports' edges only.
    const incoming = new Map();
    const outgoing = new Map();
    for (const e of g.edges) {
      if (e.relation !== 'imports') continue;
      if (!outgoing.has(e.source)) outgoing.set(e.source, []);
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      outgoing.get(e.source).push(e.target);
      incoming.get(e.target).push(e.source);
    }

    const files = [];
    for (const n of g.nodes) {
      if (n.kind !== 'code') continue;
      if (!n.source || n.source.type !== 'file') continue;
      const rel = n.source.ref || (n.sourceLocation && n.sourceLocation.file) || n.label;
      files.push({
        id: n.id,
        path: rel,
        label: n.label,
        importsCount: (outgoing.get(n.id) || []).length,
        dependentsCount: (incoming.get(n.id) || []).length,
        unresolvedImports: (outgoing.get(n.id) || []).filter(t => String(t).startsWith('ext_')).length,
      });
    }
    files.sort((a, b) => (b.dependentsCount + b.importsCount) - (a.dependentsCount + a.importsCount));

    if (body.path) {
      const target = files.find(f => f.path === body.path || f.id === body.path);
      if (!target) return json(res, { error: 'file not found', total: files.length });
      const idToFile = new Map(files.map(f => [f.id, f]));
      const importsList = (outgoing.get(target.id) || []).map(id => idToFile.get(id) || { id, path: id, external: String(id).startsWith('ext_') });
      const dependentsList = (incoming.get(target.id) || []).map(id => idToFile.get(id) || { id, path: id });
      // Symbols inside this file (best-effort)
      const symbols = g.nodes.filter(n => n.kind === 'code' && n.source && n.source.type === 'symbol' && (n.source.file === target.path || (n.sourceLocation && n.sourceLocation.file === target.path)));
      return json(res, {
        file: target,
        imports: importsList.slice(0, 200),
        dependents: dependentsList.slice(0, 200),
        symbols: symbols.map(s => ({ id: s.id, name: s.label, line: s.sourceLocation && s.sourceLocation.line || null })),
      });
    }
    return json(res, {
      total: files.length,
      files: files.slice(0, body.limit || 2000),
    });
  });
}

module.exports = { register };
