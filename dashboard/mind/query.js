/**
 * Query the graph: BFS from seed nodes (or from the best label match for the
 * question) until a token budget is hit. Returns the sub-graph plus a
 * suggested-answer scaffold the calling AI fills in and saves back via
 * /api/mind/save-result.
 */

const { normLabel } = require('./ids');

const APPROX_TOKENS_PER_NODE = 30;
const APPROX_TOKENS_PER_EDGE = 8;

function bestSeeds(graph, question, max = 3) {
  if (!question) return graph.nodes.slice(0, max).map(n => n.id);
  const q = normLabel(question);
  if (!q) return graph.nodes.slice(0, max).map(n => n.id);
  const tokens = q.split(/\s+/).filter(t => t.length > 2);
  if (tokens.length === 0) return graph.nodes.slice(0, max).map(n => n.id);
  const scored = graph.nodes.map(n => {
    const lbl = normLabel(n.label || n.id);
    let score = 0;
    for (const t of tokens) if (lbl.includes(t)) score += 1;
    // Boost by tag matches and god-node priors
    for (const tag of (n.tags || [])) for (const t of tokens) if (normLabel(tag).includes(t)) score += 0.5;
    return { id: n.id, score };
  }).filter(r => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(r => r.id);
}

function buildAdjacency(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push({ peer: e.target, edge: e });
    adj.get(e.target).push({ peer: e.source, edge: e });
  }
  return adj;
}

function runQuery(graph, { question = '', mode = 'bfs', budget = 2000, seedIds = null } = {}) {
  if (!graph || !graph.nodes.length) {
    return { question, empty: true, nodes: [], edges: [], answer: null };
  }
  const seeds = seedIds && seedIds.length ? seedIds : bestSeeds(graph, question);
  if (seeds.length === 0) {
    return { question, empty: true, nodes: [], edges: [], answer: null };
  }

  const adj = buildAdjacency(graph.edges);
  const visitedNodes = new Map(); // id -> node
  const visitedEdges = new Set();
  const queue = [];
  for (const id of seeds) {
    const n = graph.nodes.find(x => x.id === id);
    if (n) { visitedNodes.set(id, n); queue.push({ id, depth: 0 }); }
  }

  let tokenEst = visitedNodes.size * APPROX_TOKENS_PER_NODE;
  while (queue.length && tokenEst < budget) {
    const { id, depth } = (mode === 'dfs') ? queue.pop() : queue.shift();
    if (depth > 4) continue;
    const neighbors = adj.get(id) || [];
    // Sort neighbors so EXTRACTED edges are explored before INFERRED before AMBIGUOUS.
    neighbors.sort((a, b) => confRank(a.edge) - confRank(b.edge));
    for (const { peer, edge } of neighbors) {
      const ekey = edgeKey(edge);
      if (!visitedEdges.has(ekey)) { visitedEdges.add(ekey); tokenEst += APPROX_TOKENS_PER_EDGE; }
      if (!visitedNodes.has(peer)) {
        const node = graph.nodes.find(x => x.id === peer);
        if (node) {
          visitedNodes.set(peer, node);
          tokenEst += APPROX_TOKENS_PER_NODE;
          queue.push({ id: peer, depth: depth + 1 });
        }
      }
      if (tokenEst >= budget) break;
    }
  }

  const subNodes = Array.from(visitedNodes.values());
  const subIds = new Set(subNodes.map(n => n.id));
  const subEdges = graph.edges.filter(e => subIds.has(e.source) && subIds.has(e.target));

  return {
    question,
    seedIds: seeds,
    nodes: subNodes,
    edges: subEdges,
    estTokens: tokenEst,
    answer: scaffoldAnswer(question, subNodes, subEdges),
  };
}

function confRank(edge) {
  const c = edge.confidence;
  if (c === 'EXTRACTED') return 0;
  if (c === 'INFERRED') return 1;
  return 2;
}

function edgeKey(e) { return `${e.source}|${e.relation}|${e.target}`; }

function scaffoldAnswer(question, nodes, edges) {
  const byKind = {};
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  return {
    suggestion: `Use the ${nodes.length} nodes / ${edges.length} edges below as ground truth. Cite node IDs in your answer and POST them back to /api/mind/save-result so the brain learns.`,
    summary: `Sub-graph for "${question.slice(0, 80)}": ${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
    note: 'Solid edges = EXTRACTED (explicit in source). Dashed = INFERRED. Dotted = AMBIGUOUS - prefer EXTRACTED when in doubt.',
  };
}

module.exports = { runQuery, bestSeeds };
