'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const contradict = require('./contradict');
const { recall } = require('./recall');

function mem(id, label, body, createdAt) {
  return { id, kind: 'memory', label, body, kindOfMemory: 'fact', createdAt, tags: [] };
}

test('analyze detects supersession of an older card by a newer one', () => {
  const graph = {
    nodes: [
      mem('m_old', 'helper scripts miss the api token', 'node helper scripts miss the api auth token', '2026-01-01T00:00:00Z'),
      mem('m_new', 'token fix', 'the missing api token in helper scripts is now superseded by this fix', '2026-02-01T00:00:00Z'),
    ],
    edges: [],
  };
  const a = contradict.analyze(graph);
  assert.equal(a.supersessions.length, 1);
  assert.equal(a.supersessions[0].superseder, 'm_new');
  assert.equal(a.supersessions[0].superseded, 'm_old');
  assert.deepEqual(a.dormantIds, ['m_old']);
});

test('analyze does NOT let an older card supersede a newer one', () => {
  const graph = {
    nodes: [
      // supersede language on the OLDER card; the newer card must not go dormant
      mem('m_old', 'cache rule', 'caching of results is now superseded by a new policy', '2026-01-01T00:00:00Z'),
      mem('m_new', 'cache rule v2', 'cache the results with the new policy', '2026-03-01T00:00:00Z'),
    ],
    edges: [],
  };
  const a = contradict.analyze(graph);
  assert.equal(a.dormantIds.includes('m_new'), false);
});

test('analyze detects an opposite-polarity conflict on a shared topic', () => {
  const graph = {
    nodes: [
      mem('m_a', 'cache strategy', 'always cache the results aggressively', '2026-01-01T00:00:00Z'),
      mem('m_b', 'cache strategy', 'never cache the results, avoid caching', '2026-01-02T00:00:00Z'),
    ],
    edges: [],
  };
  const a = contradict.analyze(graph);
  assert.ok(a.conflicts.length >= 1);
  const ids = [a.conflicts[0].a, a.conflicts[0].b].sort();
  assert.deepEqual(ids, ['m_a', 'm_b']);
});

test('annotate flags superseded + contradicted hits', () => {
  const analysis = { supersessions: [], conflicts: [{ a: 'x', b: 'y' }], dormantIds: ['z'] };
  const out = contradict.annotate([{ id: 'x' }, { id: 'z' }, { id: 'q' }], analysis);
  assert.equal(out.find(h => h.id === 'z').superseded, true);
  assert.equal(out.find(h => h.id === 'x').contradicted, true);
  assert.equal(out.find(h => h.id === 'q').superseded, false);
});

test('recall down-ranks superseded memory below the live card', () => {
  const graph = {
    nodes: [
      mem('m_old', 'helper scripts miss the api token', 'node helper scripts miss the api auth token entirely', '2026-01-01T00:00:00Z'),
      mem('m_new', 'token fix for helper scripts', 'the missing api token in helper scripts is now superseded by this fix', '2026-02-01T00:00:00Z'),
    ],
    edges: [],
  };
  const r = recall(graph, { question: 'helper scripts api token' });
  assert.ok(r.hits.length >= 2);
  const oldIdx = r.hits.findIndex(h => h.id === 'm_old');
  const newIdx = r.hits.findIndex(h => h.id === 'm_new');
  assert.ok(newIdx < oldIdx, 'live card must rank above superseded card');
  assert.equal(r.hits[oldIdx].superseded, true);
  assert.ok(r.contradictions && r.contradictions.superseded >= 1);
});

test('recall contradictionAware:false leaves hits unannotated', () => {
  const graph = {
    nodes: [
      mem('m_old', 'api token helpers', 'helpers miss the api token', '2026-01-01T00:00:00Z'),
      mem('m_new', 'api token helpers fix', 'helpers api token is now superseded by the fix', '2026-02-01T00:00:00Z'),
    ],
    edges: [],
  };
  const r = recall(graph, { question: 'api token helpers', contradictionAware: false });
  assert.equal(r.contradictions, undefined);
});
