/**
 * build(extractions): merge a list of {nodes, edges} fragments into one
 * canonical graph, normalize IDs, deduplicate by label.
 *
 * buildMerge(existing, newGraph, prune): incremental merge with the
 * refuse-silent-shrinkage invariant (lifted from graphify/build.py).
 */

const { normalizeId, deduplicateByLabel } = require('./ids');
const { sanitizeLabel } = require('./security');

function edgeKey(edge) {
  return [
    edge.source || '',
    edge.target || '',
    edge.relation || '',
    edge.validFrom || '',
    edge.validTo || '',
  ].join('\u0001');
}

function deduplicateEdges(edges) {
  const byKey = new Map();
  for (const edge of edges) {
    const key = edgeKey(edge);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, edge);
      continue;
    }

    const prevScore = typeof prev.confidenceScore === 'number' ? prev.confidenceScore : -1;
    const nextScore = typeof edge.confidenceScore === 'number' ? edge.confidenceScore : -1;
    const prevWeight = typeof prev.weight === 'number' ? prev.weight : 0;
    const nextWeight = typeof edge.weight === 'number' ? edge.weight : 0;

    if (nextScore > prevScore || (nextScore === prevScore && nextWeight > prevWeight)) {
      byKey.set(key, { ...prev, ...edge });
    }
  }
  return Array.from(byKey.values());
}

function build(extractions, { directed = true } = {}) {
  const allNodes = [];
  const allEdges = [];
  const allHyper = [];
  let tokenCost = 0;

  for (const ext of extractions) {
    if (!ext) continue;
    if (Array.isArray(ext.nodes)) allNodes.push(...ext.nodes);
    if (Array.isArray(ext.edges)) allEdges.push(...ext.edges);
    if (Array.isArray(ext.hyperedges)) allHyper.push(...ext.hyperedges);
    if (typeof ext.tokenCost === 'number') tokenCost += ext.tokenCost;
  }

  // Sanitize labels everywhere (XSS hardening before they hit the renderer).
  for (const n of allNodes) n.label = sanitizeLabel(n.label || n.id);

  // Deduplicate identical IDs, last-wins (semantic overwrites AST).
  const byId = new Map();
  for (const n of allNodes) byId.set(n.id, n);
  let nodes = Array.from(byId.values());

  // Dedup by normalized label - merges achille_varzi + achille_varzi_c4 style.
  const dedup = deduplicateByLabel(nodes, allEdges);
  nodes = dedup.nodes;
  let edges = dedup.edges;

  // Drop edges whose endpoints don't exist (stdlib imports, external refs).
  // Try ID-normalization remapping first to catch case/punctuation drift.
  const nodeIdSet = new Set(nodes.map(n => n.id));
  const normToId = new Map();
  for (const id of nodeIdSet) normToId.set(normalizeId(id), id);
  const survivingEdges = [];
  for (const e of edges) {
    let src = e.source, tgt = e.target;
    if (!nodeIdSet.has(src)) src = normToId.get(normalizeId(src)) || src;
    if (!nodeIdSet.has(tgt)) tgt = normToId.get(normalizeId(tgt)) || tgt;
    if (!nodeIdSet.has(src) || !nodeIdSet.has(tgt)) continue;
    survivingEdges.push({ ...e, source: src, target: tgt });
  }
  edges = deduplicateEdges(survivingEdges);

  return {
    nodes, edges, hyperedges: allHyper,
    directed,
    stats: { tokenCost, dedupedCount: dedup.dedupedCount, droppedEdges: allEdges.length - edges.length },
  };
}

/**
 * Refuse silent graph shrinkage. If a rebuild produces fewer nodes than the
 * previous graph WITHOUT an explicit deletion list, abort. From graphify
 * v0.5.0 - patches a class of bug where partial chunk lists silently
 * truncated the persisted graph.
 */
function buildMerge(existingGraph, newFragments, { pruneSources = null, directed = true } = {}) {
  const existingNodes = (existingGraph?.nodes) || [];
  const existingEdges = (existingGraph?.edges) || [];

  const baseFragment = existingNodes.length || existingEdges.length
    ? [{ nodes: existingNodes, edges: existingEdges }]
    : [];

  let combined = build([...baseFragment, ...newFragments], { directed });

  if (pruneSources && pruneSources.length) {
    const pruneSet = new Set(pruneSources);
    const before = combined.nodes.length;
    combined.nodes = combined.nodes.filter(n => {
      const ref = n.source?.ref;
      const file = n.sourceLocation?.file;
      return !pruneSet.has(ref) && !pruneSet.has(file);
    });
    const surviving = new Set(combined.nodes.map(n => n.id));
    combined.edges = combined.edges.filter(e => surviving.has(e.source) && surviving.has(e.target));
    combined.stats.pruned = before - combined.nodes.length;
  }

  if (existingNodes.length > 0 && combined.nodes.length < existingNodes.length) {
    if (!pruneSources) {
      throw new Error(
        `mind/buildMerge would shrink graph from ${existingNodes.length} to ${combined.nodes.length} nodes ` +
        `without an explicit prune list. Refusing to write. Pass pruneSources to confirm intent.`
      );
    }
  }

  return combined;
}

module.exports = { build, buildMerge, deduplicateEdges };
