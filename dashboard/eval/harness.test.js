'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const harness = require('./harness');

// A tiny synthetic graph + gold set so the harness is tested without touching
// the real Mind graph or any model.
const GRAPH = {
  nodes: [
    { id: 'n1', kind: 'note', label: 'alpha' },
    { id: 'n2', kind: 'note', label: 'beta' },
    { id: 'n3', kind: 'note', label: 'gamma' },
  ],
  edges: [],
  gods: [],
};
const GOLD = {
  name: 'synthetic',
  space: '_global',
  queries: [
    { id: 'g1', question: 'find alpha', relevant: ['n1'] },
    { id: 'g2', question: 'find beta', relevant: ['n2'] },
    { id: 'g3', question: 'find ghost', relevant: ['n_missing'] }, // unresolved
  ],
};

test('resolveGold separates resolvable targets from missing ones', () => {
  const { resolved, unresolved } = harness.resolveGold(GRAPH, GOLD);
  assert.equal(resolved.length, 2); // g1, g2
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, 'g3');
  assert.deepEqual(unresolved[0].missing, ['n_missing']);
  assert.ok(resolved[0].relevant instanceof Set);
});

test('evaluate scores a perfect retriever as mrr 1', () => {
  const { resolved } = harness.resolveGold(GRAPH, GOLD);
  // retriever that always returns the correct node first
  const perfect = (g, q) => (q.includes('alpha') ? ['n1', 'n2'] : ['n2', 'n1']);
  const r = harness.evaluate(GRAPH, perfect, resolved, { ks: [1, 3] });
  assert.equal(r.n, 2);
  assert.equal(r.aggregate.mrr, 1);
  assert.equal(r.aggregate['hit@1'], 1);
});

test('evaluate scores a useless retriever as mrr 0', () => {
  const { resolved } = harness.resolveGold(GRAPH, GOLD);
  const useless = () => ['n3']; // never the answer
  const r = harness.evaluate(GRAPH, useless, resolved, { ks: [1, 3] });
  assert.equal(r.aggregate.mrr, 0);
  assert.equal(r.aggregate['hit@1'], 0);
});

test('evaluate survives a throwing retriever (scores it as a miss)', () => {
  const { resolved } = harness.resolveGold(GRAPH, GOLD);
  const boom = () => { throw new Error('kaboom'); };
  const r = harness.evaluate(GRAPH, boom, resolved, { ks: [1] });
  assert.equal(r.aggregate.mrr, 0);
  assert.ok(r.perQuery.every(q => q.error === 'kaboom'));
});

// ── compareToBaseline: the pre-committed kill criterion ──────────────────

const CRITERION = {
  primaryMetric: 'mrr', minMargin: 0.05,
  secondaryMetric: 'recall@5', secondaryMinMargin: 0,
  maxP50LatencyMs: 50,
};

test('compareToBaseline PROCEEDS when challenger clears every bar', () => {
  const base = { mrr: 0.5, 'recall@5': 0.6 };
  const chall = { mrr: 0.6, 'recall@5': 0.65 };
  const v = harness.compareToBaseline(base, chall, { p50: 20 }, CRITERION);
  assert.equal(v.pass, true);
  assert.equal(v.verdict, 'PROCEED');
  assert.equal(v.primaryMargin, 0.1);
});

test('compareToBaseline STOPS when primary margin too small', () => {
  const base = { mrr: 0.5, 'recall@5': 0.6 };
  const chall = { mrr: 0.52, 'recall@5': 0.6 }; // +0.02 < 0.05
  const v = harness.compareToBaseline(base, chall, { p50: 20 }, CRITERION);
  assert.equal(v.pass, false);
  assert.equal(v.verdict, 'STOP');
  assert.ok(v.failures.some(f => f.includes('mrr')));
});

test('compareToBaseline STOPS on a secondary regression even if primary passes', () => {
  const base = { mrr: 0.5, 'recall@5': 0.7 };
  const chall = { mrr: 0.7, 'recall@5': 0.6 }; // primary great, recall regressed
  const v = harness.compareToBaseline(base, chall, { p50: 20 }, CRITERION);
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('recall@5')));
});

test('compareToBaseline STOPS when latency blows the convergence budget', () => {
  const base = { mrr: 0.5, 'recall@5': 0.6 };
  const chall = { mrr: 0.7, 'recall@5': 0.7 };
  const v = harness.compareToBaseline(base, chall, { p50: 120 }, CRITERION);
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('latency')));
});
