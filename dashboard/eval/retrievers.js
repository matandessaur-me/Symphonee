/**
 * Baseline retrievers for THE EVAL - thin adapters over the REAL product
 * retrieval code in mind/query.js. We deliberately do NOT reimplement ranking
 * here: the baseline the Stage-2 activation kernel must beat has to be the
 * retrieval Symphonee actually ships, or the comparison is meaningless.
 *
 * Each retriever has the harness shape: (graph, question, k) => string[] of
 * node ids, best first.
 *
 *   rrf  - mind/query.bestSeedsHybrid. With dense vectors present it fuses
 *          BM25 + dense via Reciprocal Rank Fusion (the literal "RRF" in the
 *          plan). With no dense hits it degenerates to the BM25 leg, which is
 *          the honest Stage-0 baseline on a machine without a loaded embedding
 *          index. The record stamps which mode ran (see run.js -> denseUsed).
 *   bm25 - mind/query.bestSeedsRanked, the pure lexical leg. Kept as a
 *          separate, fully-deterministic reference point.
 */

'use strict';

const { bestSeedsHybrid, bestSeedsRanked } = require('../mind/query');

/**
 * RRF baseline. `opts.denseProvider`, when supplied, is
 * `(graph, question, k) => [{ id, score }]` producing dense (vector) hits to
 * fuse. Omitted on Stage-0 offline runs, where this cleanly reduces to BM25.
 */
function rrf(graph, question, k, opts = {}) {
  let dense = null;
  if (typeof opts.denseProvider === 'function') {
    try { dense = opts.denseProvider(graph, question, k * 5); } catch (_) { dense = null; }
  }
  return bestSeedsHybrid(graph, question, k, { dense });
}

/** Pure lexical BM25 baseline (deterministic, no embeddings). */
function bm25(graph, question, k) {
  return bestSeedsRanked(graph, question, k).map(r => r.id);
}

module.exports = { rrf, bm25 };
