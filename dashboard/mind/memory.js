/**
 * Memory cards: durable knowledge the user (or an AI on their behalf)
 * teaches Mind mid-conversation.
 *
 * The mental model: most of Mind's content (notes, code, drawers,
 * conversations) is HISTORICAL ARTIFACTS - things that happened. A
 * memory card is a DISTILLED FACT - the takeaway. "DYOB doesn't follow
 * the Bath Fitter design system." "For Playdate development, prefer
 * pulldown for menu navigation over the d-pad."
 *
 * Cards are first-class graph nodes (kind:memory) with rich metadata:
 *   title             short imperative-mood headline (<= 200 chars)
 *   body              the actual fact / why / how (<= 10000 chars)
 *   kindOfMemory      decision | preference | constraint | lesson |
 *                     gotcha | pattern | fact
 *   tags              array of canonical tag strings
 *   scope             { repo?, space? } - context the card applies to
 *   source            { type?, ref? } - what conversation/note inspired
 *                     this. If ref points at an existing node we emit
 *                     a derived_from edge so the citation survives.
 *   createdBy         which CLI / actor wrote the card
 *   createdAt         ISO timestamp
 *   referencedAt      ISO[] - lazy-updated when the card is recalled,
 *                     for recency ranking
 *
 * Auto-derived edges on creation:
 *   - derived_from   to source.ref if that node exists
 *   - mentions       to entity_<key> for each tag whose canonical key
 *                    matches a known entity node
 *   - in_repo        to cwd_<slug> when scope.repo names a known repo
 *
 * No graph rebuild required. Cards land via incremental merge under the
 * existing graph lock.
 */

'use strict';

const path = require('path');
const store = require('./store');
const { build } = require('./build');
const lock = require('./lock');
const { canonicalize } = require('./extractors/entities');

const ALLOWED_KINDS = new Set([
  'decision', 'preference', 'constraint',
  'lesson', 'gotcha', 'pattern', 'fact',
]);

const MAX_TITLE_LEN = 200;
const MAX_BODY_LEN = 10000;
const MAX_TAGS = 20;

function _genId() {
  // Sortable + collision-resistant. base36(now) gives natural ordering;
  // 6 chars of randomness handles the same-millisecond case.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `memory_${t}_${r}`;
}

function _normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function _validate(spec) {
  if (!spec || typeof spec !== 'object') {
    return 'spec must be an object';
  }
  if (typeof spec.title !== 'string' || !spec.title.trim()) {
    return 'title is required (non-empty string)';
  }
  if (spec.title.length > MAX_TITLE_LEN) {
    return `title too long (${spec.title.length} > ${MAX_TITLE_LEN})`;
  }
  if (spec.body !== undefined && typeof spec.body !== 'string') {
    return 'body must be a string';
  }
  if (typeof spec.body === 'string' && spec.body.length > MAX_BODY_LEN) {
    return `body too long (${spec.body.length} > ${MAX_BODY_LEN})`;
  }
  if (spec.kindOfMemory !== undefined && !ALLOWED_KINDS.has(spec.kindOfMemory)) {
    return `kindOfMemory must be one of: ${Array.from(ALLOWED_KINDS).join(', ')}`;
  }
  if (spec.scope !== undefined && (spec.scope === null || typeof spec.scope !== 'object')) {
    return 'scope must be an object';
  }
  if (spec.source !== undefined && (spec.source === null || typeof spec.source !== 'object')) {
    return 'source must be an object';
  }
  return null;
}

/**
 * Build the memory node + its edges from a spec, given a graph context.
 * Pure function: no I/O. Returns { node, edges }.
 *
 * Exported for testability — addMemoryCard() wraps this with disk I/O.
 */
function buildMemoryFragment(spec, { existingNodeIds = new Set() } = {}) {
  const tags = _normalizeTags(spec.tags);
  const id = _genId();
  const createdAt = new Date().toISOString();
  const node = {
    id,
    label: spec.title.trim().slice(0, MAX_TITLE_LEN),
    kind: 'memory',
    body: typeof spec.body === 'string' ? spec.body : '',
    kindOfMemory: spec.kindOfMemory || 'fact',
    tags: ['memory', ...tags],
    scope: spec.scope ? { ...spec.scope } : null,
    source: spec.source ? { ...spec.source } : { type: 'teach' },
    referencedAt: [],
    createdBy: spec.createdBy || 'user',
    createdAt,
  };

  const edges = [];

  // derived_from to source.ref if that node exists in the graph already.
  if (spec.source && typeof spec.source.ref === 'string' && existingNodeIds.has(spec.source.ref)) {
    edges.push({
      source: id,
      target: spec.source.ref,
      relation: 'derived_from',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      weight: 1,
      createdBy: 'mind/memory',
      createdAt,
    });
  }

  // mentions to entity_<key> for any tag matching a canonical entity.
  // Every entity key in the graph is the lowercased + separator-stripped
  // form of its label, so canonicalize() does the same normalization.
  // Whether the entity actually exists is checked via existingNodeIds.
  const seen = new Set();
  for (const t of tags) {
    const key = canonicalize(t);
    if (!key || key.length < 2) continue;
    const entityId = `entity_${key.replace(/[^a-z0-9]+/g, '_')}`;
    if (!existingNodeIds.has(entityId)) continue;
    if (seen.has(entityId)) continue;
    seen.add(entityId);
    edges.push({
      source: id,
      target: entityId,
      relation: 'mentions',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      weight: 1,
      createdBy: 'mind/memory',
      createdAt,
    });
  }

  // in_repo to cwd_<slug> when scope.repo names a known repo.
  if (spec.scope && typeof spec.scope.repo === 'string' && spec.scope.repo) {
    const slug = spec.scope.repo.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
    const cwdId = `cwd_${slug}`;
    if (existingNodeIds.has(cwdId)) {
      edges.push({
        source: id,
        target: cwdId,
        relation: 'in_repo',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 1,
        createdBy: 'mind/memory',
        createdAt,
      });
    }
  }

  return { node, edges };
}

/**
 * Persist a memory card to the graph on disk.
 *
 * Acquires the same graph lock the build pipeline uses, loads the
 * existing graph, merges the new node + edges via build() (which runs
 * the same dedup + endpoint sanitisation as a regular build fragment),
 * and writes back.
 */
async function addMemoryCard({ repoRoot, space, spec }) {
  const err = _validate(spec);
  if (err) throw new Error(err);

  const acq = lock.acquire(space, 'graph');
  if (!acq.ok) {
    const e = new Error(`mind graph operation already running (pid ${acq.holderPid || 'unknown'})`);
    e.code = 'MIND_LOCKED';
    e.holderPid = acq.holderPid || null;
    throw e;
  }
  try {
    const existing = store.loadGraph(repoRoot, space) || {
      version: 1,
      scope: { space, isGlobal: false },
      nodes: [],
      edges: [],
      hyperedges: [],
      communities: {},
      gods: [],
      surprises: [],
      stats: { nodes: 0, edges: 0, communities: 0, tokenCost: 0 },
    };
    const existingNodeIds = new Set(existing.nodes.map(n => n.id));
    const { node, edges } = buildMemoryFragment(spec, { existingNodeIds });

    // Merge via build() so dedup + edge endpoint resolution run the same
    // way they do for the rest of the pipeline. The fragment shape is
    // exactly what extractors emit, so this is a no-op for everything
    // already in the graph.
    const merged = build(
      [
        { nodes: existing.nodes, edges: existing.edges, hyperedges: existing.hyperedges || [] },
        { nodes: [node], edges },
      ],
      { directed: true },
    );

    const out = {
      ...existing,
      generatedAt: new Date().toISOString(),
      nodes: merged.nodes,
      edges: merged.edges,
      hyperedges: merged.hyperedges,
      stats: {
        ...(existing.stats || {}),
        nodes: merged.nodes.length,
        edges: merged.edges.length,
      },
    };

    store.saveGraph(repoRoot, space, out);
    return { node, edges };
  } finally {
    lock.release(space, 'graph');
  }
}

module.exports = {
  ALLOWED_KINDS,
  buildMemoryFragment,
  addMemoryCard,
};
