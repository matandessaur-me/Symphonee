'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const m = require('./metrics');

test('hitAtK respects the cutoff', () => {
  assert.equal(m.hitAtK(['a', 'b', 'c'], ['b'], 1), 0);
  assert.equal(m.hitAtK(['a', 'b', 'c'], ['b'], 2), 1);
  assert.equal(m.hitAtK(['a', 'b', 'c'], ['z'], 3), 0);
});

test('recallAtK is fraction of relevant found in top k', () => {
  assert.equal(m.recallAtK(['a', 'b', 'c'], ['b', 'x'], 3), 0.5); // found 1 of 2
  assert.equal(m.recallAtK(['a', 'b'], ['a', 'b'], 5), 1);
  assert.equal(m.recallAtK(['a'], [], 5), 0); // empty gold -> 0, no NaN
});

test('reciprocalRank uses 1-based rank of the first hit', () => {
  assert.equal(m.reciprocalRank(['a', 'b', 'c'], ['a']), 1);
  assert.equal(m.reciprocalRank(['a', 'b', 'c'], ['b']), 1 / 2);
  assert.equal(m.reciprocalRank(['a', 'b', 'c'], ['c']), 1 / 3);
  assert.equal(m.reciprocalRank(['a', 'b', 'c'], ['z']), 0);
});

test('ndcgAtK rewards higher placement', () => {
  // single relevant at rank 1 -> perfect
  assert.equal(m.ndcgAtK(['b', 'a'], ['b'], 2), 1);
  // single relevant at rank 2 -> dcg=1/log2(3), idcg=1
  const v = m.ndcgAtK(['a', 'b'], ['b'], 2);
  assert.ok(Math.abs(v - (1 / Math.log2(3))) < 1e-9);
  assert.equal(m.ndcgAtK(['a', 'b'], [], 2), 0); // empty gold safe
});

test('scoreOne produces all requested k metrics plus mrr', () => {
  const s = m.scoreOne(['a', 'b', 'c'], ['b'], [1, 3]);
  assert.equal(s.mrr, 0.5);
  assert.equal(s['hit@1'], 0);
  assert.equal(s['hit@3'], 1);
  assert.equal(s['recall@3'], 1);
  assert.ok('ndcg@1' in s && 'ndcg@3' in s);
});

test('aggregate averages key-by-key and rounds', () => {
  const agg = m.aggregate([
    { mrr: 1, 'hit@1': 1 },
    { mrr: 0, 'hit@1': 0 },
    { mrr: 0.5, 'hit@1': 0 },
  ]);
  assert.equal(agg.mrr, 0.5);
  assert.ok(Math.abs(agg['hit@1'] - 0.3333) < 1e-4);
});

test('aggregate ignores non-numeric and missing keys', () => {
  const agg = m.aggregate([
    { mrr: 1, note: 'x' },
    { mrr: 0 },
  ]);
  assert.equal(agg.mrr, 0.5);
  assert.equal(agg.note, undefined);
});
