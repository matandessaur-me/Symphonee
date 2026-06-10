/**
 * Kind-scoped dense retrieval provider for THE EVAL (Stage 0 completion).
 *
 * The raw vector index mixes ~6.8k code + ~4.3k drawer vectors in with the
 * notes/memories a recall-style query actually wants. Unscoped cosine buries
 * the right note under incidental code/CLI-log matches, which is why naive
 * dense RRF underperformed BM25. This provider restricts dense hits to the
 * RECALLABLE prose kinds, the same way mind/recall.js scopes its candidate set.
 *
 * The harness retriever signature is SYNC, but embedding a query is async, so
 * the provider pre-warms: call `await warm(questions)` once to embed + cache
 * every query vector, then `hits(question, k)` is a pure cache lookup + a sync
 * cosine query. This also keeps measured retrieval latency free of embedding
 * round-trips (embedding is shared infra, identical for every retriever).
 */

'use strict';

const store = require('../mind/store');
const { VectorStore } = require('../mind/vectors');
const embeddings = require('../mind/embeddings');

const DEFAULT_KINDS = ['note', 'doc', 'memory', 'conversation', 'recipe', 'skill', 'insight'];

function createDenseProvider({ repoRoot, space = '_global', kinds = DEFAULT_KINDS, provider = 'ollama' } = {}) {
  const vs = new VectorStore(repoRoot, space);
  const loaded = vs.load();
  const graph = store.loadGraph(repoRoot, space);
  const kindById = new Map((graph ? graph.nodes : []).map(n => [n.id, n.kind]));
  const allow = new Set(kinds);
  const cache = new Map(); // question -> vector

  async function warm(questions) {
    for (const q of questions) {
      if (cache.has(q)) continue;
      const v = await embeddings.embedSingle(q, { provider });
      if (v) cache.set(q, v);
    }
    return cache.size;
  }

  // Sync: returns [{ id, score }] restricted to allowed kinds. Over-fetches
  // then filters so the kind cap does not starve results.
  function hits(question, k = 10) {
    const v = cache.get(question);
    if (!v || !loaded) return [];
    const raw = vs.query(v, Math.max(k * 8, 64));
    const out = [];
    for (const h of raw) {
      if (allow.has(kindById.get(h.id))) out.push(h);
      if (out.length >= k) break;
    }
    return out;
  }

  return { warm, hits, ready: loaded && !!graph, count: vs.count(), kinds: [...allow] };
}

module.exports = { createDenseProvider, DEFAULT_KINDS };
