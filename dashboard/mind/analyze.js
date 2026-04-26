/**
 * Analyze a built+clustered graph: god nodes (most connected), surprising
 * connections (cross-community bridges), suggested questions.
 */

function analyze(graph) {
  const { nodes, edges, communities } = graph;
  const degree = new Map();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // God nodes: top-N by degree, excluding low-signal node kinds (tags).
  const candidates = nodes
    .filter(n => n.kind !== 'tag')
    .map(n => ({ id: n.id, label: n.label, kind: n.kind, degree: degree.get(n.id) || 0 }))
    .sort((a, b) => b.degree - a.degree);
  const gods = candidates.slice(0, 12);

  // Surprises: edges that bridge two distinct communities, ranked by the
  // sum of degrees on either side (a bridge between two big hubs is more
  // surprising than between two leaves).
  const idCommunity = new Map();
  for (const [cid, c] of Object.entries(communities || {})) {
    for (const nid of c.nodeIds) idCommunity.set(nid, +cid);
  }
  const seen = new Set();
  const surprises = [];
  for (const e of edges) {
    const ca = idCommunity.get(e.source);
    const cb = idCommunity.get(e.target);
    if (ca == null || cb == null || ca === cb) continue;
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    surprises.push({
      source: e.source,
      target: e.target,
      relation: e.relation,
      confidence: e.confidence,
      crossesCommunities: [ca, cb],
      score: (degree.get(e.source) || 0) + (degree.get(e.target) || 0),
    });
  }
  surprises.sort((a, b) => b.score - a.score);

  // Suggested questions are placeholders for now - templated off the strongest
  // signals so an agent has something to ask without round-tripping an LLM.
  const suggested = [];
  if (gods.length) suggested.push(`What does ${gods[0].label} do, and why is it the most connected entity?`);
  if (surprises.length) {
    const s = surprises[0];
    suggested.push(`Why is ${s.source} connected to ${s.target}? They live in different communities.`);
  }
  if (Object.keys(communities || {}).length > 1) {
    const cs = Object.entries(communities);
    const biggest = cs.sort((a, b) => b[1].size - a[1].size)[0];
    suggested.push(`What is the role of community "${biggest[1].label}" and which nodes anchor it?`);
  }

  return { gods, surprises: surprises.slice(0, 12), suggested };
}

module.exports = { analyze };
