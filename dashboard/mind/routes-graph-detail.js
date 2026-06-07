'use strict';
// Mind graph-detail reads: single node + community + god/surprise lists.

const store = require('./store');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace } = deps;

  addRoute('GET', '/api/mind/node', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (!id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'no graph' }, 404);
    const node = g.nodes.find(n => n.id === id);
    if (!node) return json(res, { error: 'not found' }, 404);
    const neighbors = [];
    for (const e of g.edges) {
      if (e.source === id) neighbors.push({ direction: 'out', edge: e, peer: g.nodes.find(n => n.id === e.target) });
      else if (e.target === id) neighbors.push({ direction: 'in', edge: e, peer: g.nodes.find(n => n.id === e.source) });
    }
    return json(res, { node, neighbors, communityId: node.communityId ?? null });
  });

  addRoute('GET', '/api/mind/community', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'no graph' }, 404);
    if (id == null) return json(res, { communities: g.communities || {} });
    const c = g.communities?.[id];
    if (!c) return json(res, { error: 'community not found' }, 404);
    const nodes = c.nodeIds.map(nid => g.nodes.find(n => n.id === nid)).filter(Boolean);
    return json(res, { id, ...c, nodes });
  });

  addRoute('GET', '/api/mind/gods', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { gods: [] });
    return json(res, { gods: g.gods || [] });
  });

  addRoute('GET', '/api/mind/surprises', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { surprises: [] });
    return json(res, { surprises: g.surprises || [] });
  });
}

module.exports = { register };
