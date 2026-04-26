/**
 * ID and label utilities.
 *
 * normalizeId mirrors graphify/build.py::_normalize_id and is used to
 * reconcile edge endpoints when two extractors generate IDs with slightly
 * different casing or punctuation.
 *
 * deduplicateByLabel collapses nodes that share a normalized label, with
 * preference for IDs without chunk-suffixes (_c\\d+) and shorter IDs when
 * tied. Lifted from graphify/build.py::deduplicate_by_label, which was
 * written after a bug where parallel subagents emitted both `achille_varzi`
 * and `achille_varzi_c4` for the same entity.
 */

const CHUNK_SUFFIX = /_c\d+$/;

function normalizeId(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function normLabel(label) {
  if (typeof label !== 'string') return '';
  return label.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

function makeIdFromLabel(label, kindPrefix) {
  const base = normalizeId(label || '');
  return kindPrefix ? `${kindPrefix}_${base}` : base;
}

function deduplicateByLabel(nodes, edges) {
  const canonical = new Map(); // normLabel -> surviving node
  const remap = new Map();     // old id -> surviving id

  for (const node of nodes) {
    const key = normLabel(node.label || node.id || '');
    if (!key) continue;
    const existing = canonical.get(key);
    if (!existing) { canonical.set(key, node); continue; }
    const nodeHasSuffix = CHUNK_SUFFIX.test(node.id);
    const existingHasSuffix = CHUNK_SUFFIX.test(existing.id);
    if (nodeHasSuffix && !existingHasSuffix) {
      remap.set(node.id, existing.id);
    } else if (existingHasSuffix && !nodeHasSuffix) {
      remap.set(existing.id, node.id);
      canonical.set(key, node);
    } else if (node.id.length < existing.id.length) {
      remap.set(existing.id, node.id);
      canonical.set(key, node);
    } else {
      remap.set(node.id, existing.id);
    }
  }

  if (remap.size === 0) return { nodes, edges, dedupedCount: 0 };

  const dedupedNodes = Array.from(canonical.values());
  const dedupedEdges = [];
  for (const edge of edges) {
    const e = { ...edge };
    e.source = remap.get(e.source) || e.source;
    e.target = remap.get(e.target) || e.target;
    if (e.source !== e.target) dedupedEdges.push(e);
  }
  return { nodes: dedupedNodes, edges: dedupedEdges, dedupedCount: remap.size };
}

module.exports = { normalizeId, normLabel, makeIdFromLabel, deduplicateByLabel, CHUNK_SUFFIX };
