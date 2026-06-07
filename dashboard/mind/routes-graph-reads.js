'use strict';
// Mind graph reads: full graph, stats, jobs table, import-quality, subject anchors.

const store = require('./store');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, jobs } = deps;

  addRoute('GET', '/api/mind/graph', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { space, empty: true, nodes: [], edges: [] });
    return json(res, g);
  });

  addRoute('GET', '/api/mind/stats', (req, res) => {
    const space = getSpace();
    const stats = store.statsFor(repoRoot, space);
    return json(res, { space, stats });
  });

  addRoute('GET', '/api/mind/jobs', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (id) {
      const j = jobs.get(id);
      if (!j) return json(res, { error: 'not found' }, 404);
      return json(res, j);
    }
    return json(res, { jobs: Array.from(jobs.values()).slice(-50) });
  });

  // ── Quality (resolved-import ratio + unresolved examples) ────────────────
  // Surfaced even before Phase 1 ships ast-grep so the UI pill has something
  // to render. Returns { totalImportEdges, resolvedPct, unresolvedExamples }.
  addRoute('GET', '/api/mind/quality', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { space, totalImportEdges: 0, resolvedPct: null, unresolvedExamples: [] });
    let total = 0, resolved = 0;
    const unresolved = [];
    const nodeIds = new Set(g.nodes.map(n => n.id));
    for (const e of g.edges) {
      if (e.relation !== 'imports') continue;
      total += 1;
      const targetExists = nodeIds.has(e.target);
      const targetMarkedExternal = e.unresolved === true || (typeof e.target === 'string' && e.target.startsWith('ext_'));
      if (targetExists && !targetMarkedExternal) resolved += 1;
      else if (unresolved.length < 25) unresolved.push({ from: e.source, spec: e.target });
    }
    return json(res, {
      space,
      totalImportEdges: total,
      resolvedPct: total ? Math.round((resolved / total) * 1000) / 10 : null,
      resolvedCount: resolved,
      unresolvedExamples: unresolved,
      lastBuildAt: g.generatedAt,
    });
  });

  addRoute('GET', '/api/mind/anchors', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g || !Array.isArray(g.nodes)) return json(res, { subjects: [], anchors: [], space });

    const byId = new Map();
    for (const n of g.nodes) if (n && n.id) byId.set(n.id, n);

    const deg = new Map();
    const adj = new Map();
    for (const e of (g.edges || [])) {
      if (!e) continue;
      deg.set(e.source, (deg.get(e.source) || 0) + 1);
      deg.set(e.target, (deg.get(e.target) || 0) + 1);
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source).push(e.target);
      adj.get(e.target).push(e.source);
    }

    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/^@+/, '').replace(/[_\s\-/]+/g, ' ').trim();
    const rank = (k) => k === 'repo' ? 0 : k === 'entity' ? 1 : k === 'tag' ? 2 : 3;

    // 1) Seed subjects from repos + entities; merge by normalized label.
    const subjects = new Map();
    function fold(node) {
      const key = norm(node.label);
      if (!key) return;
      let s = subjects.get(key);
      if (!s) { s = { key, label: node.label, kind: node.kind, primaryId: node.id, seedIds: [] }; subjects.set(key, s); }
      if (rank(node.kind) < rank(s.kind)) { s.kind = node.kind; s.label = node.label; s.primaryId = node.id; }
      if (!s.seedIds.includes(node.id)) s.seedIds.push(node.id);
    }
    for (const n of g.nodes) { if (n && n.label && (n.kind === 'repo' || n.kind === 'entity')) fold(n); }
    // 2) Fold tags ONLY into subjects that already exist (an @cwd tag joins its
    //    repo; a tag with no repo/entity does NOT become its own noisy row).
    for (const n of g.nodes) { if (n && n.kind === 'tag' && n.label && subjects.has(norm(n.label))) fold(n); }

    // 3) Tally the 1-hop neighborhood kinds so the UI shows what an export pulls.
    function tally(seedIds) {
      const seen = new Set(seedIds);
      const counts = {};
      for (const sid of seedIds) {
        for (const nb of (adj.get(sid) || [])) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          const k = (byId.get(nb) || {}).kind || 'node';
          counts[k] = (counts[k] || 0) + 1;
        }
      }
      return { counts, reach: seen.size };
    }

    const subjectsOut = [];
    for (const s of subjects.values()) {
      const t = tally(s.seedIds);
      const degree = s.seedIds.reduce((a, id) => a + (deg.get(id) || 0), 0);
      subjectsOut.push({
        id: s.primaryId,
        label: String(s.label).slice(0, 120),
        kind: s.kind,
        seedIds: s.seedIds.slice(0, 16),
        degree,
        counts: t.counts,
        reach: t.reach,
      });
    }
    subjectsOut.sort((a, b) => b.degree - a.degree);

    // `anchors` kept as an alias for any existing caller.
    return json(res, { subjects: subjectsOut, anchors: subjectsOut, space, total: subjectsOut.length });
  });
}

module.exports = { register };
