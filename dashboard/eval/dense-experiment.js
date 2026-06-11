/**
 * Conclusive cognition re-test (the honest version of the Stage-2 gate).
 *
 * The lexical-only gate was inconclusive in one direction: activation looked
 * bad partly because its BM25 restart vector was empty on the hard paraphrased
 * queries. This experiment removes that excuse by giving BOTH sides proper
 * DENSE (semantic) seeds from the already-built embedding index:
 *
 *   1. BM25 RRF        - the original lexical baseline (reference point).
 *   2. dense-fused RRF - BM25 (+) dense via RRF: the STRONG retrieval baseline.
 *   3. activation      - settle-loop seeded with the bm25(+)dense hybrid, then
 *                        fused with that hybrid (augment, not replace).
 *
 * If dense RRF already rescues the hard queries and activation cannot beat it,
 * the cognition NO-GO is CONCLUSIVE: better retrieval, not spreading
 * activation, is the win. If activation beats dense RRF by the pre-committed
 * criterion, that flips the gate to GO.
 *
 * Requires the ollama embedding model (nomic-embed-text) at runtime to embed
 * the 15 gold queries once. NOT part of the offline test suite (it needs a
 * model); run it on demand:  node dashboard/eval/dense-experiment.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../mind/store');
const { VectorStore } = require('../mind/vectors');
const embeddings = require('../mind/embeddings');
const { bestSeedsRanked } = require('../mind/query');
const { fuse } = require('../mind/rrf');
const { activate } = require('../mind/dynamics/activation');
const harness = require('./harness');
const retrievers = require('./retrievers');

const REPO_ROOT = path.join(__dirname, '..', '..');
const gold = JSON.parse(fs.readFileSync(path.join(__dirname, 'gold', 'retrieval.json'), 'utf8'));
const criterion = JSON.parse(fs.readFileSync(path.join(__dirname, 'criterion.json'), 'utf8'));

function aggLine(label, agg) {
  const f = k => (agg[k] == null ? '  -  ' : String(agg[k]).padEnd(6));
  return `${label.padEnd(16)} mrr=${f('mrr')} hit@1=${f('hit@1')} hit@3=${f('hit@3')} recall@5=${f('recall@5')} ndcg@5=${f('ndcg@5')}`;
}

(async () => {
  const space = gold.space || '_global';
  const graph = store.loadGraph(REPO_ROOT, space);
  if (!graph) throw new Error('no graph');
  const vs = new VectorStore(REPO_ROOT, space);
  if (!vs.load()) throw new Error('no vectors.bin for ' + space);
  console.log(`graph ${graph.nodes.length} nodes | vectors ${vs.count()} x ${vs.dim}`);

  // One-time embed of every gold query (the only async/model-dependent step).
  const qvec = new Map();
  for (const q of gold.queries) {
    const v = await embeddings.embedSingle(q.question, { provider: 'ollama', task: 'search_query' });
    if (!v || v.length !== vs.dim) throw new Error(`embed dim mismatch for ${q.id}: got ${v && v.length}, want ${vs.dim}`);
    qvec.set(q.question, v);
  }
  console.log(`embedded ${qvec.size} gold queries (nomic-embed-text)\n`);

  // Sync dense provider over cached query vectors -> [{id, score}].
  function denseHits(_graph, question, k) {
    const v = qvec.get(question);
    return v ? vs.query(v, k) : [];
  }
  function hybridRanked(g, question, count) {
    const bm = bestSeedsRanked(g, question, count).map(r => ({ id: r.id, score: r.score })); bm._label = 'bm25';
    const dn = denseHits(g, question, count).map(r => ({ id: r.id, score: r.score })); dn._label = 'dense';
    if (!dn.length) return bm;
    return fuse([bm, dn], { k: 60, limit: count });
  }

  // 1. BM25 RRF (lexical only)
  const bm25Rrf = (g, q, k) => retrievers.rrf(g, q, k);
  // 2. dense-fused RRF (strong baseline)
  const denseRrf = (g, q, k) => retrievers.rrf(g, q, k, { denseProvider: denseHits });
  // 3. activation seeded with the hybrid, fused with the hybrid (augment)
  function activationChallenger(g, question, k) {
    const seeds = hybridRanked(g, question, 25).map((r, i) => ({ id: r.id, score: 1 / (1 + i) }));
    const { ranking } = activate(g, question, { seeds });
    const act = ranking.slice(0, k * 5).map(r => ({ id: r.id, score: r.score })); act._label = 'activation';
    const hyb = hybridRanked(g, question, k * 5).map(r => ({ id: r.id, score: r.score })); hyb._label = 'hybrid';
    if (!act.length) return hyb.slice(0, k).map(r => r.id);
    return fuse([hyb, act], { k: 60, limit: k }).map(r => r.id);
  }

  const { resolved } = harness.resolveGold(graph, gold);
  const r1 = harness.evaluate(graph, bm25Rrf, resolved);
  const r2 = harness.evaluate(graph, denseRrf, resolved);
  const r3 = harness.evaluate(graph, activationChallenger, resolved);

  console.log('=== aggregates (' + resolved.length + ' queries) ===');
  console.log(aggLine('1 bm25 RRF', r1.aggregate));
  console.log(aggLine('2 dense RRF', r2.aggregate));
  console.log(aggLine('3 activation', r3.aggregate));
  console.log(`\nlatency p50: dense-RRF ${r2.latency.p50}ms  activation ${r3.latency.p50}ms (max ${r3.latency.max}ms)`);

  console.log('\n=== per-query MRR (bm25 -> dense -> activation) ===');
  const m = (res, id) => { const q = res.perQuery.find(x => x.id === id); return q ? Math.round(q.scores.mrr * 100) / 100 : 0; };
  for (const q of gold.queries) {
    console.log(`  ${q.id.padEnd(22)} ${String(m(r1, q.id)).padEnd(5)} -> ${String(m(r2, q.id)).padEnd(5)} -> ${m(r3, q.id)}`);
  }

  // Pre-committed gate: activation (challenger) vs dense RRF (baseline).
  const verdict = harness.compareToBaseline(r2.aggregate, r3.aggregate, r3.latency, criterion);
  console.log('\n=== GATE: activation vs dense-RRF baseline (pre-committed criterion) ===');
  console.log(`>>> ${verdict.verdict} <<<  pass=${verdict.pass}`);
  if (verdict.failures.length) console.log('failures: ' + verdict.failures.join('; '));
})().catch(err => { console.error('[dense-experiment] FAILED:', err.message); process.exit(1); });
