/**
 * THE EVAL harness - the gate-maker for the Symphonee 2.0 cognition bet.
 *
 * Per the development plan (note: symphonee-2.0-development-plan):
 *
 *   "THE EVAL: a frozen query set + an explicit scoring rule + a PRE-COMMITTED
 *    kill criterion ('if the activation path is not better than RRF by X on
 *    metric Y within Z, cognition stops'). Without this the Stage-2 gate is
 *    theater and the romance of the idea wins by default."
 *
 * This module is deliberately retriever-AGNOSTIC. It knows how to:
 *   1. run ANY retriever over a frozen gold set and score it (evaluate), and
 *   2. decide whether a challenger beats a baseline by the pre-committed
 *      criterion (compareToBaseline).
 *
 * A "retriever" is just `(graph, question, k) => string[]` returning a ranked
 * list of node ids, best first. The RRF baseline (eval/retrievers.js) and the
 * Stage-2 activation kernel both satisfy this shape, so they are scored by the
 * identical ruler with zero chance of metric drift between them. That equality
 * is the whole point - it is what makes the Stage-2 gate real instead of a
 * story we tell ourselves.
 */

'use strict';

const metrics = require('./metrics');

/**
 * Resolve and validate a gold set against a live graph. Every gold target must
 * be an id that actually exists in the graph; a target that does not resolve is
 * reported loudly (not silently scored as a miss) so a stale gold set fails
 * visibly instead of quietly deflating the baseline.
 *
 * @returns { resolved: [...gold entries with a verified `relevant` Set],
 *            unresolved: [{ id, missing: [...] }] }
 */
function resolveGold(graph, gold) {
  const present = new Set(graph.nodes.map(n => n.id));
  const resolved = [];
  const unresolved = [];
  for (const entry of gold.queries) {
    const targets = Array.isArray(entry.relevant) ? entry.relevant : [];
    const missing = targets.filter(id => !present.has(id));
    if (missing.length) unresolved.push({ id: entry.id, missing });
    const ok = targets.filter(id => present.has(id));
    if (ok.length) {
      resolved.push({ ...entry, relevant: new Set(ok) });
    }
  }
  return { resolved, unresolved };
}

/**
 * Run a retriever over a resolved gold set and score every query.
 *
 * @param graph      the live Mind graph ({ nodes, edges, gods, ... })
 * @param retriever  (graph, question, k) => string[]   ranked node ids
 * @param resolved   output of resolveGold().resolved
 * @param opts       { ks?: number[], topK?: number }
 * @returns {
 *   perQuery: [{ id, question, retrievedTop, scores, latencyMs }],
 *   aggregate: { mrr, 'recall@5', ... },
 *   latency: { p50, p95, max, meanMs },
 *   n
 * }
 */
function evaluate(graph, retriever, resolved, opts = {}) {
  const ks = opts.ks || [1, 3, 5, 10];
  const topK = opts.topK || Math.max(...ks);
  const perQuery = [];
  const latencies = [];
  for (const entry of resolved) {
    const t0 = Date.now();
    let ranked;
    try {
      ranked = retriever(graph, entry.question, topK) || [];
    } catch (err) {
      ranked = [];
      perQuery.push({ id: entry.id, question: entry.question, error: err.message, scores: metrics.scoreOne([], entry.relevant, ks), latencyMs: Date.now() - t0 });
      latencies.push(Date.now() - t0);
      continue;
    }
    const latencyMs = Date.now() - t0;
    latencies.push(latencyMs);
    const scores = metrics.scoreOne(ranked, entry.relevant, ks);
    perQuery.push({
      id: entry.id,
      question: entry.question,
      relevant: Array.from(entry.relevant),
      retrievedTop: ranked.slice(0, Math.max(...ks)),
      scores,
      latencyMs,
    });
  }
  return {
    n: resolved.length,
    perQuery,
    aggregate: metrics.aggregate(perQuery.map(q => q.scores)),
    latency: _latencyStats(latencies),
  };
}

function _latencyStats(latencies) {
  if (!latencies.length) return { p50: null, p95: null, max: null, meanMs: null };
  const sorted = latencies.slice().sort((a, b) => a - b);
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    p50: pct(0.5),
    p95: pct(0.95),
    max: sorted[sorted.length - 1],
    meanMs: Math.round(mean * 100) / 100,
  };
}

/**
 * The pre-committed kill criterion. Decides whether a CHALLENGER (e.g. the
 * Stage-2 activation kernel) is allowed to be promoted over the BASELINE
 * (RRF) given a criterion loaded from eval/criterion.json.
 *
 * criterion shape (see criterion.json):
 *   {
 *     primaryMetric: "mrr",
 *     minMargin: 0.05,           // challenger must beat baseline by >= this
 *     secondaryMetric: "recall@5",
 *     secondaryMinMargin: 0,     // and must not REGRESS the secondary
 *     maxP50LatencyMs: 50,       // convergence budget Z
 *     rule: "<human-readable restatement>"
 *   }
 *
 * Returns a verdict object. `pass: true` means cognition may proceed; `false`
 * means - per the plan - cognition stops here and Stages 0-1 still leave the
 * product ahead. The verdict is intentionally explicit and self-describing so
 * the decision is auditable, not vibes.
 */
function compareToBaseline(baselineAgg, challengerAgg, challengerLatency, criterion) {
  const pm = criterion.primaryMetric;
  const sm = criterion.secondaryMetric;
  const baseP = baselineAgg[pm] ?? 0;
  const challP = challengerAgg[pm] ?? 0;
  const primaryMargin = Math.round((challP - baseP) * 10000) / 10000;
  const primaryPass = primaryMargin >= criterion.minMargin;

  let secondaryPass = true;
  let secondaryMargin = null;
  if (sm) {
    const baseS = baselineAgg[sm] ?? 0;
    const challS = challengerAgg[sm] ?? 0;
    secondaryMargin = Math.round((challS - baseS) * 10000) / 10000;
    secondaryPass = secondaryMargin >= (criterion.secondaryMinMargin ?? 0);
  }

  const p50 = challengerLatency && challengerLatency.p50;
  const latencyPass = criterion.maxP50LatencyMs == null || (typeof p50 === 'number' && p50 <= criterion.maxP50LatencyMs);

  const pass = primaryPass && secondaryPass && latencyPass;
  const reasons = [];
  if (!primaryPass) reasons.push(`${pm} margin ${primaryMargin} < required ${criterion.minMargin}`);
  if (!secondaryPass) reasons.push(`${sm} regressed by ${secondaryMargin} (limit ${criterion.secondaryMinMargin ?? 0})`);
  if (!latencyPass) reasons.push(`p50 latency ${p50}ms > budget ${criterion.maxP50LatencyMs}ms`);

  return {
    pass,
    verdict: pass ? 'PROCEED' : 'STOP',
    primaryMetric: pm,
    primaryMargin,
    primaryPass,
    secondaryMetric: sm || null,
    secondaryMargin,
    secondaryPass,
    latencyP50: p50 ?? null,
    latencyPass,
    failures: reasons,
    criterion,
  };
}

module.exports = { resolveGold, evaluate, compareToBaseline, _latencyStats };
