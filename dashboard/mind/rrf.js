/**
 * Reciprocal Rank Fusion: given multiple ranked lists of {id, score}, produce
 * one fused ranking. Score is the sum of 1 / (k + rank) across each list,
 * with rank starting at 0.
 *
 * Per the standard RRF paper, k=60 is robust for most retrieval mixes.
 */

const DEFAULT_K = 60;

function fuse(rankings, { k = DEFAULT_K, limit = 50 } = {}) {
  const fused = new Map();
  for (const ranking of rankings) {
    if (!Array.isArray(ranking)) continue;
    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i];
      const id = typeof item === 'string' ? item : item && item.id;
      if (!id) continue;
      const contribution = 1 / (k + i);
      const slot = fused.get(id) || { id, score: 0, sources: {} };
      slot.score += contribution;
      const srcKey = ranking._label || `list${rankings.indexOf(ranking)}`;
      slot.sources[srcKey] = { rank: i, score: typeof item === 'object' ? item.score : null };
      fused.set(id, slot);
    }
  }
  const sorted = Array.from(fused.values()).sort((a, b) => b.score - a.score);
  return sorted.slice(0, limit);
}

module.exports = { fuse, DEFAULT_K };
