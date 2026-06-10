/**
 * THE EVAL runner - records the RRF baseline (Stage 0) and, when handed a
 * challenger, judges it against the pre-committed criterion (Stage 2+).
 *
 *   node dashboard/eval/run.js              # run + record the RRF baseline
 *   node dashboard/eval/run.js --quiet      # same, summary only
 *
 * The Stage-0 deliverable from the plan is simply: "eval harness runs and
 * records an RRF baseline." That is what the default invocation does - it loads
 * the live Mind graph, runs the real retrieval over the frozen gold set, scores
 * it, prints a human summary, and writes a durable baseline record under
 * .symphonee/eval/baselines/ so Stage 2 has something concrete to beat.
 *
 * Stage 2 will require('./run').judgeChallenger(retriever) to score its
 * activation kernel by the identical ruler and apply compareToBaseline.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const store = require('../mind/store');
const harness = require('./harness');
const retrievers = require('./retrievers');

const REPO_ROOT = path.join(__dirname, '..', '..');
const GOLD_PATH = path.join(__dirname, 'gold', 'retrieval.json');
const CRITERION_PATH = path.join(__dirname, 'criterion.json');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function baselinesDir(repoRoot) {
  return path.join(repoRoot, '.symphonee', 'eval', 'baselines');
}

/**
 * Run a single retriever over the gold set and return the full result bundle
 * plus the resolved/unresolved report. Shared by baseline + challenger paths.
 */
function runRetriever(retriever, { repoRoot = REPO_ROOT, gold = null, opts = {} } = {}) {
  const goldSet = gold || loadJson(GOLD_PATH);
  const graph = store.loadGraph(repoRoot, goldSet.space || '_global');
  if (!graph || !graph.nodes || !graph.nodes.length) {
    throw new Error(`no graph for space "${goldSet.space}" under ${repoRoot} - build Mind first`);
  }
  const { resolved, unresolved } = harness.resolveGold(graph, goldSet);
  const result = harness.evaluate(graph, retriever, resolved, opts);
  return { goldSet, graph, resolved, unresolved, result };
}

/**
 * Stage 0: record the RRF baseline. Returns the written record.
 */
function runBaseline({ repoRoot = REPO_ROOT, write = true, stamp = null } = {}) {
  const { goldSet, graph, resolved, unresolved, result } =
    runRetriever((g, q, k) => retrievers.rrf(g, q, k), { repoRoot });

  const record = {
    kind: 'rrf-baseline',
    goldSet: goldSet.name,
    goldFrozenAt: goldSet.frozenAt,
    recordedAt: stamp || new Date().toISOString(),
    retriever: 'rrf (mind/query.bestSeedsHybrid)',
    denseUsed: false,
    denseNote: 'Stage-0 offline run uses the lexical leg only; with no dense provider RRF reduces to BM25. Re-run with a denseProvider once embeddings are loaded to capture the fused baseline.',
    graphStats: { nodes: graph.nodes.length, edges: graph.edges.length },
    nQueries: result.n,
    unresolvedGold: unresolved,
    aggregate: result.aggregate,
    latency: result.latency,
    perQuery: result.perQuery.map(q => ({
      id: q.id, mrr: q.scores.mrr, 'recall@5': q.scores['recall@5'],
      'hit@1': q.scores['hit@1'], 'hit@3': q.scores['hit@3'],
      topHit: q.retrievedTop && q.retrievedTop[0], relevant: q.relevant,
    })),
  };

  if (write) {
    const dir = baselinesDir(repoRoot);
    fs.mkdirSync(dir, { recursive: true });
    const fname = `rrf-baseline-${(record.recordedAt).replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(record, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(record, null, 2), 'utf8');
    record._writtenTo = path.join(dir, fname);
  }
  return record;
}

/**
 * Stage 2+: score a challenger retriever and apply the pre-committed criterion
 * against the most recent recorded baseline (or a fresh one if none on disk).
 */
function judgeChallenger(challenger, { repoRoot = REPO_ROOT, baseline = null } = {}) {
  const base = baseline || _latestBaseline(repoRoot) || runBaseline({ repoRoot, write: false });
  const { result } = runRetriever(challenger, { repoRoot });
  const criterion = loadJson(CRITERION_PATH);
  const verdict = harness.compareToBaseline(base.aggregate, result.aggregate, result.latency, criterion);
  return { verdict, challengerAggregate: result.aggregate, challengerLatency: result.latency, baselineAggregate: base.aggregate };
}

function _latestBaseline(repoRoot) {
  const p = path.join(baselinesDir(repoRoot), 'latest.json');
  try { return loadJson(p); } catch (_) { return null; }
}

function _printSummary(record) {
  const a = record.aggregate;
  console.log('\n=== THE EVAL - RRF baseline ===');
  console.log(`gold set     : ${record.goldSet} (frozen ${record.goldFrozenAt})`);
  console.log(`graph        : ${record.graphStats.nodes} nodes / ${record.graphStats.edges} edges`);
  console.log(`queries      : ${record.nQueries}`);
  console.log(`retriever    : ${record.retriever}  [denseUsed=${record.denseUsed}]`);
  if (record.unresolvedGold.length) {
    console.log(`UNRESOLVED   : ${record.unresolvedGold.length} gold entries reference missing nodes:`);
    for (const u of record.unresolvedGold) console.log(`   - ${u.id}: ${u.missing.join(', ')}`);
  }
  console.log('\nmetric        value');
  console.log('------------- -------');
  for (const key of ['mrr', 'hit@1', 'hit@3', 'recall@5', 'ndcg@5', 'recall@10', 'ndcg@10']) {
    if (a[key] != null) console.log(`${key.padEnd(13)} ${a[key]}`);
  }
  console.log(`\nlatency       p50=${record.latency.p50}ms p95=${record.latency.p95}ms max=${record.latency.max}ms`);
  console.log('\nper-query MRR (sorted worst first):');
  const rows = record.perQuery.slice().sort((x, y) => x.mrr - y.mrr);
  for (const r of rows) {
    const flag = r.mrr === 0 ? ' MISS' : (r.mrr === 1 ? '' : '  ~');
    console.log(`  ${String(r.mrr).padEnd(6)} ${r.id}${flag}`);
  }
  if (record._writtenTo) console.log(`\nrecorded -> ${record._writtenTo}`);
}

if (require.main === module) {
  try {
    const rec = runBaseline({});
    _printSummary(rec);
  } catch (err) {
    console.error('[eval] FAILED:', err.message);
    process.exit(1);
  }
}

module.exports = { runRetriever, runBaseline, judgeChallenger, baselinesDir };
