/**
 * Retrieval metrics - pure, dependency-free scoring for THE EVAL.
 *
 * Every function takes a ranked list of retrieved node ids (best first) and a
 * Set of relevant ("gold") node ids, and returns a number. No graph, no IO, no
 * opinion about WHAT was retrieved - that lives in the harness. Keeping the
 * math pure means the Stage-2 activation kernel is scored by exactly the same
 * ruler as the RRF baseline, with no chance of a metric quietly drifting
 * between the two.
 *
 * These are the standard known-item / ad-hoc retrieval metrics:
 *   hit@k        - 1 if any relevant id appears in the top k, else 0
 *   recall@k     - fraction of all relevant ids found in the top k
 *   reciprocalRank - 1 / (1-based rank of the FIRST relevant id), 0 if none
 *   ndcg@k       - normalized discounted cumulative gain (binary relevance)
 *
 * Ranks are 1-based in every user-facing sense (MRR of a first-place hit = 1).
 */

'use strict';

function _asSet(relevant) {
  return relevant instanceof Set ? relevant : new Set(relevant || []);
}

function hitAtK(retrieved, relevant, k) {
  const rel = _asSet(relevant);
  const top = retrieved.slice(0, k);
  return top.some(id => rel.has(id)) ? 1 : 0;
}

function recallAtK(retrieved, relevant, k) {
  const rel = _asSet(relevant);
  if (rel.size === 0) return 0;
  const top = retrieved.slice(0, k);
  let found = 0;
  for (const id of rel) if (top.includes(id)) found += 1;
  return found / rel.size;
}

function precisionAtK(retrieved, relevant, k) {
  const rel = _asSet(relevant);
  if (k <= 0) return 0;
  const top = retrieved.slice(0, k);
  let hit = 0;
  for (const id of top) if (rel.has(id)) hit += 1;
  return hit / Math.min(k, top.length || k);
}

function reciprocalRank(retrieved, relevant) {
  const rel = _asSet(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (rel.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

function ndcgAtK(retrieved, relevant, k) {
  const rel = _asSet(relevant);
  if (rel.size === 0) return 0;
  const top = retrieved.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) dcg += 1 / Math.log2(i + 2); // gain 1, discount log2(rank+1)
  }
  // Ideal DCG: all relevant items packed at the top (up to k).
  const idealHits = Math.min(rel.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Score one ranked result against one gold target across a set of k values.
 * Returns { 'hit@1': .., 'recall@5': .., mrr: .., 'ndcg@10': .. }.
 */
function scoreOne(retrieved, relevant, ks = [1, 3, 5, 10]) {
  const rel = _asSet(relevant);
  const out = { mrr: reciprocalRank(retrieved, rel) };
  for (const k of ks) {
    out[`hit@${k}`] = hitAtK(retrieved, rel, k);
    out[`recall@${k}`] = recallAtK(retrieved, rel, k);
    out[`ndcg@${k}`] = ndcgAtK(retrieved, rel, k);
  }
  return out;
}

/**
 * Average a list of per-query score objects key-by-key. Missing keys are
 * treated as absent (not zero) so a heterogeneous mix does not silently
 * deflate. Rounds to 4 decimals.
 */
function aggregate(perQuery) {
  const sums = Object.create(null);
  const counts = Object.create(null);
  for (const row of perQuery) {
    for (const key of Object.keys(row)) {
      if (typeof row[key] !== 'number') continue;
      sums[key] = (sums[key] || 0) + row[key];
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  const mean = Object.create(null);
  for (const key of Object.keys(sums)) {
    mean[key] = Math.round((sums[key] / counts[key]) * 10000) / 10000;
  }
  return mean;
}

module.exports = {
  hitAtK,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  scoreOne,
  aggregate,
};
