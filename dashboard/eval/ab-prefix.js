/**
 * Non-destructive A/B: does using nomic's asymmetric task prefixes
 * (search_document on the corpus, search_query on the query) improve retrieval
 * vs the current prefix-less usage?
 *
 * Touches NOTHING on disk. Embeds the prose corpus + gold queries BOTH ways in
 * memory, then scores each config through the REAL eval harness (run.runRetriever
 * -> harness.evaluate), so the metrics are apples-to-apples with the live eval.
 *
 *   node dashboard/eval/ab-prefix.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../mind/store');
const embeddings = require('./../mind/embeddings');
const engine = require('../mind/engine');
const run = require('./run');
const { bestSeedsRanked } = require('../mind/query');
const { fuse } = require('../mind/rrf');

const REPO_ROOT = path.join(__dirname, '..', '..');
const GOLD_PATH = path.join(__dirname, 'gold', 'retrieval.json');
const PROSE_KINDS = new Set(['note', 'doc', 'memory', 'conversation', 'recipe', 'skill', 'insight']);

function cos(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }

async function embedMap(items, getText, task) {
  const m = new Map();
  let i = 0;
  for (const it of items) {
    const text = getText(it);
    if (!text) continue;
    const v = await embeddings.embedSingle(text, task ? { provider: 'ollama', task } : { provider: 'ollama' });
    if (v) m.set(it.key, v);
    if (++i % 100 === 0) process.stdout.write(`  embedded ${i}/${items.length}\r`);
  }
  return m;
}

function denseRetriever(qVecByQuestion, docVecById) {
  return (graph, question, k) => {
    const qv = qVecByQuestion.get(question);
    if (!qv) return [];
    const scored = [];
    for (const [id, dv] of docVecById) scored.push({ id, score: cos(qv, dv) });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(h => h.id);
  };
}

function hybridRetriever(qVecByQuestion, docVecById) {
  const dense = (graph, q, k) => {
    const qv = qVecByQuestion.get(q);
    if (!qv) return [];
    const scored = [];
    for (const [id, dv] of docVecById) scored.push({ id, score: cos(qv, dv) });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  };
  return (graph, q, k) => {
    const bm = bestSeedsRanked(graph, q, k * 5).map(r => ({ id: r.id, score: r.score }));
    const dn = dense(graph, q, k * 5);
    if (!dn.length) return bm.slice(0, k).map(r => r.id);
    return fuse([bm, dn], { k: 60, limit: k }).map(r => r.id);
  };
}

(async () => {
  const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'));
  const space = gold.space || '_global';
  const graph = store.loadGraph(REPO_ROOT, space);
  const prose = graph.nodes.filter(n => PROSE_KINDS.has(n.kind))
    .map(n => ({ key: n.id, text: engine.embedText(n) })).filter(d => d.text);
  const queries = gold.queries.map(q => ({ key: q.question, text: q.question }));
  console.log(`A/B prefix test | space=${space} | ${prose.length} prose docs | ${queries.length} gold queries\n`);

  console.log('Embedding corpus + queries (unprefixed / OLD)...');
  const docOld = await embedMap(prose, d => d.text, null);
  const qOld = await embedMap(queries, q => q.text, null);
  console.log('\nEmbedding corpus + queries (search_document / search_query / NEW)...');
  const docNew = await embedMap(prose, d => d.text, 'search_document');
  const qNew = await embedMap(queries, q => q.text, 'search_query');

  const configs = {
    'BM25 (reference)': (g, q, k) => bestSeedsRanked(g, q, k).map(r => r.id),
    'dense OLD (no prefix)': denseRetriever(qOld, docOld),
    'dense NEW (prefixed)': denseRetriever(qNew, docNew),
    'hybrid OLD (no prefix)': hybridRetriever(qOld, docOld),
    'hybrid NEW (prefixed)': hybridRetriever(qNew, docNew),
  };

  const rows = {};
  for (const [name, retr] of Object.entries(configs)) {
    rows[name] = run.runRetriever(retr, { repoRoot: REPO_ROOT }).result.aggregate;
  }

  const keys = ['mrr', 'hit@1', 'hit@3', 'recall@5', 'ndcg@5'];
  console.log('\n=== A/B: nomic task prefixes vs no prefixes ===');
  console.log('config'.padEnd(24) + keys.map(k => k.padEnd(9)).join(''));
  console.log('-'.repeat(24 + keys.length * 9));
  for (const [name, agg] of Object.entries(rows)) {
    console.log(name.padEnd(24) + keys.map(k => String(agg[k] ?? '-').padEnd(9)).join(''));
  }
  const dDense = (rows['dense NEW (prefixed)'].mrr - rows['dense OLD (no prefix)'].mrr).toFixed(4);
  const dHyb = (rows['hybrid NEW (prefixed)'].mrr - rows['hybrid OLD (no prefix)'].mrr).toFixed(4);
  console.log(`\ndense  MRR delta (NEW - OLD): ${dDense >= 0 ? '+' : ''}${dDense}`);
  console.log(`hybrid MRR delta (NEW - OLD): ${dHyb >= 0 ? '+' : ''}${dHyb}`);
})().catch(e => { console.error('AB FAILED:', e.stack || e.message); process.exit(1); });
