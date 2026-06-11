'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { activate, activationRetriever, activationFusedRetriever, edgeWeight, DEFAULTS } = require('./activation');

// Synthetic graph: a query that lexically matches a concept which is linked to
// the "answer" note - the case spreading activation is meant to help with.
function graph() {
  return {
    nodes: [
      { id: 'note_x', kind: 'note', label: 'the master plan', tags: [] },
      { id: 'c1', kind: 'concept', label: 'alpha widget spec', tags: [] },
      { id: 'c2', kind: 'concept', label: 'beta gadget notes', tags: [] },
      { id: 'c3', kind: 'concept', label: 'gamma module', tags: [] },
    ],
    edges: [
      { source: 'c1', target: 'note_x', relation: 'describes', confidence: 'EXTRACTED' },
      { source: 'c2', target: 'note_x', relation: 'mentions', confidence: 'INFERRED' },
      { source: 'c3', target: 'c1', relation: 'conceptually_related_to', confidence: 'INFERRED' },
    ],
    gods: [],
  };
}

test('activate returns a ranking and a trace, settling within the cap', () => {
  const r = activate(graph(), 'alpha widget');
  assert.ok(Array.isArray(r.ranking));
  assert.ok(r.ranking.length >= 1);
  assert.equal(typeof r.trace.settled, 'boolean');
  assert.ok(r.trace.iters <= DEFAULTS.maxIters);
  assert.ok(r.trace.subgraphSize >= 1);
  assert.ok(Array.isArray(r.trace.deltas));
});

test('activation is deterministic for the same (graph, question)', () => {
  const a = activate(graph(), 'alpha widget').ranking;
  const b = activate(graph(), 'alpha widget').ranking;
  assert.deepEqual(a, b);
});

test('spreading reaches the linked note from a concept-only lexical match', () => {
  // 'alpha widget' lexically hits c1; note_x should get activation via the edge.
  const r = activate(graph(), 'alpha widget');
  const ids = r.ranking.map(x => x.id);
  assert.ok(ids.includes('c1'));
  assert.ok(ids.includes('note_x'), 'activation spread from c1 to the linked note');
});

test('empty graph -> empty ranking, settled', () => {
  const r = activate({ nodes: [], edges: [] }, 'x');
  assert.deepEqual(r.ranking, []);
  assert.equal(r.settled, true);
});

test('no-seed question -> empty ranking with reason', () => {
  const r = activate(graph(), 'zzzznomatch');
  assert.equal(r.ranking.length, 0);
  assert.equal(r.trace.reason, 'no-seeds');
});

test('activationRetriever returns at most k ids and falls back to BM25 when empty', () => {
  const ids = activationRetriever(graph(), 'alpha widget', 2);
  assert.ok(ids.length <= 2);
  // no-seed -> falls back to bm25 (also empty here), never throws
  assert.deepEqual(activationRetriever(graph(), 'zzzznomatch', 3), []);
});

test('activationFusedRetriever returns ids and keeps the strong lexical match', () => {
  const ids = activationFusedRetriever(graph(), 'alpha widget', 3);
  assert.ok(ids.length <= 3);
  assert.ok(ids.includes('c1'), 'fusion preserves the exact lexical hit');
});

test('edgeWeight: structural edges conduct more than taxonomic hub edges', () => {
  const structural = edgeWeight({ relation: 'calls', confidence: 'EXTRACTED' });
  const taxonomic = edgeWeight({ relation: 'mentions', confidence: 'EXTRACTED' });
  assert.ok(structural > taxonomic);
  // confidence lowers weight
  assert.ok(edgeWeight({ relation: 'calls', confidence: 'AMBIGUOUS' }) < structural);
});

test('subgraph growth is bounded by maxNodes', () => {
  const r = activate(graph(), 'alpha widget', { maxNodes: 2 });
  assert.ok(r.trace.subgraphSize <= 2);
});
