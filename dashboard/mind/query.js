/**
 * Query the graph: BFS from seed nodes (or from the best label/BM25 match for the
 * question) until a token budget is hit. Returns the sub-graph plus a
 * suggested-answer scaffold the calling AI fills in and saves back via
 * /api/mind/save-result.
 *
 * Seed selection is hybrid: BM25 over (label + tags + description + answer)
 * with a god-node prior. Substring matching is kept as a fallback when BM25
 * yields nothing — that should be rare since BM25 finds anything substring
 * does, but the fallback covers tokenization edge cases (e.g. all query
 * terms shorter than the BM25 token regex's 2-char floor).
 *
 * Temporal awareness: pass { asOf: ISO-date } to ask "what was true at that
 * moment?". Edges with validFrom/validTo are filtered through
 * schema.isEdgeValidAt during BFS and in the final sub-graph projection.
 * Edges without those fields are timeless and always visible.
 */

const { normLabel } = require('./ids');
const { bm25Scores } = require('./bm25');
const { isEdgeValidAt } = require('./schema');
const { fuse: rrfFuse } = require('./rrf');

const APPROX_TOKENS_PER_NODE = 30;
const APPROX_TOKENS_PER_EDGE = 8;

function nodeSearchableText(n) {
  const parts = [n.label || '', ...(n.tags || [])];
  if (typeof n.description === 'string') parts.push(n.description);
  if (typeof n.answer === 'string') parts.push(n.answer);
  if (typeof n.summary === 'string') parts.push(n.summary);
  return parts.join(' ');
}

function bestSeeds(graph, question, max = 3) {
  if (!question) return graph.nodes.slice(0, max).map(n => n.id);
  const q = normLabel(question);
  if (!q) return graph.nodes.slice(0, max).map(n => n.id);

  const docs = graph.nodes.map(nodeSearchableText);
  const raw = bm25Scores(q, docs);
  const maxBm = Math.max(...raw, 0);

  if (maxBm > 0) {
    // Min-score threshold: when no query term is even moderately
    // discriminative in the corpus (e.g. user asks about "bathfitter" but
    // the brain has never seen that word — only the stop words "what" and
    // "is" survive in the corpus), bm25Scores returns mostly tiny scores
    // from incidental matches. Cut those off so the UI shows "no relevant
    // context" instead of a misleading top-5 of unrelated headings.
    const MIN_ABSOLUTE_BM25 = 0.5;
    if (maxBm < MIN_ABSOLUTE_BM25) return [];

    const godSet = new Set((graph.gods || []).map(g => (typeof g === 'string' ? g : g && g.id)).filter(Boolean));
    const scored = graph.nodes.map((n, i) => {
      const base = raw[i] / maxBm;
      const godBoost = (base > 0 && godSet.has(n.id)) ? 0.15 : 0;
      return { id: n.id, score: base + godBoost, raw: raw[i] };
    }).filter(r => r.score > 0 && r.raw >= MIN_ABSOLUTE_BM25 * 0.4); // also cut weak hits
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, max).map(r => r.id);
  }

  // Fallback: substring scoring on label + tags. Reaches BM25's blind spots
  // (single-letter tokens, exotic punctuation that the token regex strips).
  const tokens = q.split(/\s+/).filter(t => t.length >= 1);
  if (tokens.length === 0) return graph.nodes.slice(0, max).map(n => n.id);
  const fallback = graph.nodes.map(n => {
    const lbl = normLabel(n.label || n.id);
    let s = 0;
    for (const t of tokens) if (lbl.includes(t)) s += 1;
    for (const tag of (n.tags || [])) for (const t of tokens) if (normLabel(tag).includes(t)) s += 0.5;
    return { id: n.id, score: s };
  }).filter(r => r.score > 0);
  fallback.sort((a, b) => b.score - a.score);
  return fallback.slice(0, max).map(r => r.id);
}

function buildAdjacency(edges, asOf) {
  const adj = new Map();
  for (const e of edges) {
    if (asOf && !isEdgeValidAt(e, asOf)) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push({ peer: e.target, edge: e });
    adj.get(e.target).push({ peer: e.source, edge: e });
  }
  return adj;
}

function runQuery(graph, { question = '', mode = 'bfs', budget = 2000, seedIds = null, asOf = null } = {}) {
  if (!graph || !graph.nodes.length) {
    return { question, empty: true, nodes: [], edges: [], answer: null };
  }
  const seeds = seedIds && seedIds.length ? seedIds : bestSeeds(graph, question);
  if (seeds.length === 0) {
    return { question, empty: true, nodes: [], edges: [], answer: null };
  }

  const adj = buildAdjacency(graph.edges, asOf);
  const visitedNodes = new Map();
  const visitedEdges = new Set();
  const queue = [];
  // O(1) node lookup - the previous .find() per neighbour was O(N)
  // and quietly turned the whole BFS quadratic on big graphs.
  const nodeById = new Map();
  for (const n of graph.nodes) nodeById.set(n.id, n);
  for (const id of seeds) {
    const n = nodeById.get(id);
    if (n) { visitedNodes.set(id, n); queue.push({ id, depth: 0 }); }
  }

  // Mode auto-detection: if every seed is a code/symbol node, the user
  // is asking about code structure. Suppress tier-3 (taxonomic) edges
  // entirely - brand hubs and repo-membership are noise for "fix this
  // function" / "what does X call". Saves budget for the actual code
  // graph and keeps the response light. Any non-code seed flips back
  // to full traversal.
  const codeKinds = new Set(['code', 'doc', 'symbol']);
  const codeOnlyMode = seeds.every(id => {
    const n = nodeById.get(id);
    return n && codeKinds.has(n.kind);
  });

  let tokenEst = visitedNodes.size * APPROX_TOKENS_PER_NODE;
  while (queue.length && tokenEst < budget) {
    const { id, depth } = (mode === 'dfs') ? queue.pop() : queue.shift();
    if (depth > 4) continue;
    const neighbors = adj.get(id) || [];
    neighbors.sort((a, b) => confRank(a.edge) - confRank(b.edge));
    for (const { peer, edge } of neighbors) {
      // In code-only mode, skip taxonomic edges so the answer stays
      // about the code, not about the brand it lives under.
      if (codeOnlyMode && relationTier(edge) >= 3) continue;
      const ekey = edgeKey(edge);
      if (!visitedEdges.has(ekey)) { visitedEdges.add(ekey); tokenEst += APPROX_TOKENS_PER_EDGE; }
      if (!visitedNodes.has(peer)) {
        const node = nodeById.get(peer);
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
  const subEdges = graph.edges.filter(e =>
    subIds.has(e.source) && subIds.has(e.target) && (!asOf || isEdgeValidAt(e, asOf))
  );

  return {
    question,
    seedIds: seeds,
    asOf: asOf || null,
    nodes: subNodes,
    edges: subEdges,
    estTokens: tokenEst,
    answer: scaffoldAnswer(question, subNodes, subEdges),
  };
}

// Relation-tier classification. Code-structural edges (imports, calls,
// defines, ...) traverse FIRST so a query seeded at a code symbol fills
// its budget with the structure the user actually needs. Conceptual /
// taxonomic edges (mentions, member_of, in_repo, tagged_with) are
// high-fanout - a single brand entity hub can have hundreds of mention
// edges - and would otherwise drown out the answer. They run last and
// only burn whatever budget remains.
//
//   Tier 0: code structure (imports, calls, defines, contains,
//           extends, implements). The literal "what calls what" graph
//           the user usually wants when asking about a symbol.
//   Tier 1: documentary + derivative (describes, references,
//           derived_from, ...). Real semantic links, less central
//           than code structure.
//   Tier 2: conceptual (conceptually_related_to,
//           semantically_similar_to, participate_in). Useful but
//           should not crowd out structure.
//   Tier 3: taxonomic / hub (mentions, member_of, in_repo,
//           tagged_with). High-fanout brand-aware edges, only useful
//           after the answer set has the actual context filled in.
const RELATION_TIER = {
  imports: 0, calls: 0, defines: 0, contains: 0, extends: 0, implements: 0,
  describes: 1, cites: 1, references: 1, links_to: 1, derived_from: 1, answers: 1,
  conceptually_related_to: 2, semantically_similar_to: 2, participate_in: 2,
  mentions: 3, member_of: 3, in_repo: 3, tagged_with: 3,
};
function relationTier(edge) {
  const t = RELATION_TIER[edge && edge.relation];
  return typeof t === 'number' ? t : 1; // unknown relations default mid-tier
}

function confRank(edge) {
  // Compose tier (relation-type priority) and confidence (signal quality).
  // Tier dominates: code structure ranks before taxonomy regardless of
  // confidence; within a tier prefer EXTRACTED > INFERRED > AMBIGUOUS.
  const c = edge.confidence;
  const conf = (c === 'EXTRACTED') ? 0 : (c === 'INFERRED') ? 1 : 2;
  return relationTier(edge) * 4 + conf;
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

// ── Hybrid seed selection (BM25 + dense via RRF) ───────────────────────────
//
// Same surface as bestSeeds but accepts an optional { vectors, queryVector }
// pair. When dense hits are available, we fuse them with BM25 via RRF and
// return the fused top-K. When dense isn't available, falls through to
// existing bestSeeds.
function bestSeedsHybrid(graph, question, max = 3, opts = {}) {
  const bm25 = bestSeedsRanked(graph, question, max * 5);
  const denseHits = opts.dense || null; // [{ id, score }, ...]
  if (!denseHits || !denseHits.length) {
    return bm25.slice(0, max).map(r => r.id);
  }
  const bmList = bm25.map(r => ({ id: r.id, score: r.score }));
  bmList._label = 'bm25';
  const dnList = denseHits.slice();
  dnList._label = 'dense';
  const fused = rrfFuse([bmList, dnList], { k: 60, limit: max });
  return fused.map(r => r.id);
}

function bestSeedsRanked(graph, question, max = 5) {
  if (!question) return [];
  const q = normLabel(question);
  if (!q) return [];
  const docs = graph.nodes.map(nodeSearchableText);
  const raw = bm25Scores(q, docs);
  const maxBm = Math.max(...raw, 0);
  if (maxBm <= 0) return [];
  const godSet = new Set((graph.gods || []).map(g => (typeof g === 'string' ? g : g && g.id)).filter(Boolean));
  const scored = graph.nodes.map((n, i) => {
    const base = raw[i] / maxBm;
    const godBoost = (base > 0 && godSet.has(n.id)) ? 0.15 : 0;
    return { id: n.id, score: base + godBoost, raw: raw[i] };
  }).filter(r => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

module.exports = { runQuery, bestSeeds, bestSeedsHybrid, bestSeedsRanked, nodeSearchableText };
