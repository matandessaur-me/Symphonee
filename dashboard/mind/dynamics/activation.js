/**
 * Activation kernel (Stage 2 of the Symphonee 2.0 plan - the cognition bet).
 *
 * A pure settle-loop over a sub-graph: encode -> spread -> compare -> settle ->
 * read-out. No writes, no plasticity (that is Stage 3). The thesis it tests:
 * spreading activation closes the semantic gap that pure lexical retrieval
 * (BM25/RRF) misses. A paraphrased question that only weakly matches the answer
 * node's NEIGHBOURS (e.g. a note's extracted heading/concept children) can
 * still activate the answer node through the graph - which RRF, scoring each
 * node independently, can never do.
 *
 * Mechanism: this is Personalized PageRank with a BM25 restart vector. The
 * restart (teleport) vector is the lexical seed distribution; activation then
 * spreads across weighted edges and re-anchors to the seeds each step (the
 * `alpha` restart). PPR is a well-understood, convergent process, which is what
 * locked decision #5 demands: "determinism per (query, graphVersion, seed);
 * converge within a hard cap or fall back to retrieval and log."
 *
 * Bounded for latency: activation runs over a LOCAL sub-graph grown by a
 * fanout-capped BFS from the seeds (hubs would otherwise explode the frontier),
 * so cost is independent of total graph size. The settle loop is capped at
 * MAX_ITERS and stops early on convergence. Always returns a trace.
 *
 * Pure + deterministic: no Math.random, no Date.now in the math. Same
 * (graph, question, params) -> same ranking, same trace.
 */

'use strict';

const { bestSeedsRanked } = require('../query');
const { fuse: rrfFuse } = require('../rrf');

const DEFAULTS = {
  seedCount: 25,     // how many BM25 hits seed the restart vector
  maxNodes: 1500,    // sub-graph node cap (bounds latency, hub-safe)
  maxFanout: 16,     // per-node strongest edges followed when growing the graph
  maxDepth: 3,       // BFS depth from seeds
  alpha: 0.55,       // restart strength: anchor to the query vs. spread (PPR teleport)
  maxIters: 30,      // settle-loop cap
  epsilon: 1e-4,     // convergence threshold on max per-node delta
};

// Edge weight = relation-tier weight * confidence multiplier. Structural edges
// (imports/calls/defines) conduct activation best; taxonomic hub edges conduct
// least, so a brand hub does not wash activation across unrelated nodes.
const TIER_WEIGHT = { 0: 1.0, 1: 0.7, 2: 0.5, 3: 0.25 };
const RELATION_TIER = {
  imports: 0, calls: 0, defines: 0, contains: 0, extends: 0, implements: 0,
  describes: 1, cites: 1, references: 1, links_to: 1, derived_from: 1, answers: 1,
  conceptually_related_to: 2, semantically_similar_to: 2, participate_in: 2,
  mentions: 3, member_of: 3, in_repo: 3, tagged_with: 3,
};
function edgeWeight(edge) {
  const tier = RELATION_TIER[edge && edge.relation];
  const tw = TIER_WEIGHT[typeof tier === 'number' ? tier : 1];
  const c = edge && edge.confidence;
  const cm = c === 'EXTRACTED' ? 1.0 : c === 'INFERRED' ? 0.7 : c === 'AMBIGUOUS' ? 0.4 : 0.7;
  return tw * cm;
}

/**
 * Grow a fanout-capped, depth-limited sub-graph around the seed ids. Returns
 * { ids:Set, adj:Map<id,[{peer,w}]> } restricted to included nodes. Hubs are
 * tamed by only following each node's MAX_FANOUT strongest edges and by the
 * global node cap.
 */
function _localSubgraph(graph, seedIds, params) {
  const nodeById = new Map();
  for (const n of graph.nodes) nodeById.set(n.id, n);

  // Pre-bucket edges per node so we can pick the strongest few without a global
  // sort. One pass over edges.
  const incident = new Map(); // id -> [{peer, w}]
  for (const e of graph.edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    const w = edgeWeight(e);
    if (!incident.has(e.source)) incident.set(e.source, []);
    if (!incident.has(e.target)) incident.set(e.target, []);
    incident.get(e.source).push({ peer: e.target, w });
    incident.get(e.target).push({ peer: e.source, w });
  }

  const included = new Set();
  let frontier = [];
  for (const id of seedIds) {
    if (nodeById.has(id) && !included.has(id)) { included.add(id); frontier.push(id); }
  }
  for (let depth = 0; depth < params.maxDepth && frontier.length && included.size < params.maxNodes; depth++) {
    const next = [];
    for (const id of frontier) {
      const edges = incident.get(id) || [];
      // strongest-first, capped fanout
      const top = edges.length > params.maxFanout
        ? edges.slice().sort((a, b) => b.w - a.w).slice(0, params.maxFanout)
        : edges;
      for (const { peer } of top) {
        if (included.size >= params.maxNodes) break;
        if (!included.has(peer)) { included.add(peer); next.push(peer); }
      }
      if (included.size >= params.maxNodes) break;
    }
    frontier = next;
  }

  // Build the restricted adjacency among included nodes (full edge set between
  // them, weighted; symmetric).
  const adj = new Map();
  for (const id of included) adj.set(id, []);
  for (const e of graph.edges) {
    if (!included.has(e.source) || !included.has(e.target)) continue;
    const w = edgeWeight(e);
    adj.get(e.source).push({ peer: e.target, w });
    adj.get(e.target).push({ peer: e.source, w });
  }
  return { ids: included, adj };
}

/**
 * Run the activation settle-loop. Returns:
 *   { ranking:[{id,score}], trace:{iters,deltas,settled,subgraphSize,seeds}, settled }
 */
function activate(graph, question, options = {}) {
  const params = { ...DEFAULTS, ...options };
  if (!graph || !graph.nodes || !graph.nodes.length) {
    return { ranking: [], trace: { iters: 0, deltas: [], settled: true, subgraphSize: 0, seeds: 0, reason: 'empty-graph' }, settled: true };
  }
  // Encode: seeds form the restart (teleport) vector. Default is the BM25
  // lexical ranking; callers may inject a stronger seed distribution (e.g. a
  // dense/hybrid ranking) via options.seeds to test whether activation adds
  // value on top of better seeds.
  const seeded = (options.seeds && options.seeds.length)
    ? options.seeds.slice(0, params.seedCount)
    : bestSeedsRanked(graph, question, params.seedCount); // [{id,score}]
  if (!seeded.length) {
    return { ranking: [], trace: { iters: 0, deltas: [], settled: true, subgraphSize: 0, seeds: 0, reason: 'no-seeds' }, settled: true };
  }
  const maxSeed = Math.max(...seeded.map(s => s.score), 1e-9);
  const restart = new Map();
  for (const s of seeded) restart.set(s.id, s.score / maxSeed); // normalized to [0,1]

  const { ids, adj } = _localSubgraph(graph, seeded.map(s => s.id), params);

  // Pre-compute weighted out-degree for outflow normalization.
  const degW = new Map();
  for (const id of ids) {
    let d = 0;
    for (const { w } of adj.get(id)) d += w;
    degW.set(id, d || 1);
  }

  // Initialise activation at the restart vector.
  let a = new Map();
  for (const id of ids) a.set(id, restart.get(id) || 0);

  const deltas = [];
  let settled = false;
  let iter = 0;
  for (; iter < params.maxIters; iter++) {
    const next = new Map();
    let maxDelta = 0;
    for (const id of ids) {
      // Inflow: sum over neighbours of w(m,id) * a[m] / degW[m]
      let inflow = 0;
      for (const { peer, w } of adj.get(id)) {
        inflow += (w * (a.get(peer) || 0)) / degW.get(peer);
      }
      const val = params.alpha * (restart.get(id) || 0) + (1 - params.alpha) * inflow;
      next.set(id, val);
    }
    // Normalise to max 1 so scores are comparable + the delta is scale-stable.
    let mx = 0;
    for (const v of next.values()) if (v > mx) mx = v;
    if (mx > 0) for (const [k, v] of next) next.set(k, v / mx);
    for (const id of ids) {
      const d = Math.abs((next.get(id) || 0) - (a.get(id) || 0));
      if (d > maxDelta) maxDelta = d;
    }
    a = next;
    deltas.push(Math.round(maxDelta * 1e6) / 1e6);
    if (maxDelta < params.epsilon) { settled = true; iter++; break; }
  }

  const ranking = Array.from(a.entries())
    .map(([id, score]) => ({ id, score: Math.round(score * 1e6) / 1e6 }))
    .filter(r => r.score > 0)
    .sort((x, y) => y.score - x.score);

  return {
    ranking,
    settled,
    trace: {
      iters: iter,
      deltas,
      settled,
      subgraphSize: ids.size,
      seeds: seeded.length,
      converged: settled,
      finalDelta: deltas.length ? deltas[deltas.length - 1] : null,
    },
  };
}

/**
 * Retriever adapter for THE EVAL harness: (graph, question, k) => string[].
 * Falls back cleanly to the BM25 seed order if activation produced nothing
 * (locked decision #5: "converge within a hard cap or fall back to retrieval").
 */
function activationRetriever(graph, question, k, options = {}) {
  const { ranking } = activate(graph, question, options);
  if (ranking.length) return ranking.slice(0, k).map(r => r.id);
  return bestSeedsRanked(graph, question, k).map(r => r.id);
}

/**
 * Augmenting retriever (locked decision #1: AUGMENT-THEN-MEASURE; the plan's
 * "activation as a SHADOW result ALONGSIDE RRF"). RRF-fuses the lexical BM25
 * ranking with the activation ranking, so activation can only PULL IN good
 * neighbours - it can never demote an exact lexical match below where BM25 had
 * it. This is the fair form of the cognition thesis: does spreading activation
 * ADD signal on top of retrieval, not REPLACE it.
 */
function activationFusedRetriever(graph, question, k, options = {}) {
  const lexical = bestSeedsRanked(graph, question, k * 5).map(r => ({ id: r.id, score: r.score }));
  lexical._label = 'bm25';
  const { ranking } = activate(graph, question, options);
  const act = ranking.slice(0, k * 5).map(r => ({ id: r.id, score: r.score }));
  act._label = 'activation';
  if (!act.length) return lexical.slice(0, k).map(r => r.id);
  return rrfFuse([lexical, act], { k: 60, limit: k }).map(r => r.id);
}

module.exports = { activate, activationRetriever, activationFusedRetriever, edgeWeight, DEFAULTS };
