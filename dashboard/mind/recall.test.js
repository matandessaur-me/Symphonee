'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { recall, parseDateHint, RECALL_KINDS, KIND_BASE_SCORE } = require('./recall');

const NOW = new Date('2026-05-02T12:00:00Z');

function fixture() {
  return {
    nodes: [
      // memory cards (highest priority)
      { id: 'mem_recent_dyob', label: 'DYOB does not follow Bath Fitter brand',
        kind: 'memory', kindOfMemory: 'constraint',
        body: 'DYOB has its own design system - different colours.',
        scope: { repo: 'DYOB3' }, tags: ['memory', 'DYOB', 'design'],
        createdAt: '2026-05-01T10:00:00Z' },
      { id: 'mem_old_pg', label: 'use Postgres for listing manager',
        kind: 'memory', kindOfMemory: 'decision',
        body: 'After review we decided to use Postgres over Mongo.',
        scope: { repo: 'Bath-Fitter-Listing-Manager' }, tags: ['memory', 'database'],
        createdAt: '2026-01-15T10:00:00Z' },

      // conversation nodes
      { id: 'qa_recent', label: 'How does DYOB differ from Bath Fitter?',
        kind: 'conversation',
        answer: 'DYOB has different brand. The colour palette and typography differ.',
        createdAt: '2026-05-02T08:00:00Z' },
      { id: 'qa_old', label: 'Setting up the Postgres replica',
        kind: 'conversation',
        answer: 'Configure read-replicas at the Postgres tier.',
        createdAt: '2025-11-01T08:00:00Z' },

      // drawer (verbatim turn)
      { id: 'drawer_recent', label: 'commit and push',
        kind: 'drawer', content: 'commit and push the DYOB constraint change',
        createdAt: '2026-05-02T07:00:00Z' },

      // non-recall kinds (should NEVER appear in results)
      { id: 'code_x', label: 'foo.ts', kind: 'code', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'doc_x', label: 'CLAUDE.md', kind: 'doc', createdAt: '2026-05-01T00:00:00Z' },
    ],
    edges: [],
  };
}

test('parseDateHint: null/undefined -> null', () => {
  assert.equal(parseDateHint(null), null);
  assert.equal(parseDateHint(undefined), null);
});

test('parseDateHint: ISO string -> Date', () => {
  const d = parseDateHint('2026-05-01T00:00:00Z');
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), '2026-05-01T00:00:00.000Z');
});

test('parseDateHint: "10 days ago" relative to now', () => {
  const d = parseDateHint('10 days ago', NOW);
  const expected = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
  assert.equal(d.toISOString(), expected.toISOString());
});

test('parseDateHint: "yesterday" / "last week" / "last month"', () => {
  assert.equal(parseDateHint('yesterday',   NOW).toISOString(), new Date(NOW - 24 * 3600 * 1000).toISOString());
  assert.equal(parseDateHint('last week',   NOW).toISOString(), new Date(NOW - 7 * 24 * 3600 * 1000).toISOString());
  assert.equal(parseDateHint('last month',  NOW).toISOString(), new Date(NOW - 30 * 24 * 3600 * 1000).toISOString());
});

test('parseDateHint: garbage string throws', () => {
  assert.throws(() => parseDateHint('asdfgh nonsense xyz'), /could not parse/);
});

test('recall: empty graph returns empty hits', () => {
  const r = recall({ nodes: [], edges: [] }, {});
  assert.deepEqual(r.hits, []);
  assert.equal(r.total, 0);
});

test('recall: only RECALL_KINDS appear in results', () => {
  const r = recall(fixture(), {});
  assert.ok(r.hits.length > 0);
  for (const h of r.hits) {
    assert.ok(RECALL_KINDS.includes(h.kind), `unexpected kind: ${h.kind}`);
  }
  // The code/doc nodes from the fixture must NOT appear.
  assert.equal(r.hits.find(h => h.id === 'code_x'), undefined);
  assert.equal(r.hits.find(h => h.id === 'doc_x'), undefined);
});

test('recall: memories rank above conversations rank above drawers', () => {
  const r = recall(fixture(), { question: 'DYOB design' });
  // Find the first hit of each kind
  const firstMemory = r.hits.findIndex(h => h.kind === 'memory');
  const firstConv = r.hits.findIndex(h => h.kind === 'conversation');
  const firstDrawer = r.hits.findIndex(h => h.kind === 'drawer');
  assert.ok(firstMemory >= 0 && firstMemory < firstConv, 'memory should rank before conversation');
  assert.ok(firstConv < firstDrawer || firstDrawer < 0, 'conversation should rank before drawer');
});

test('recall: since filter excludes older nodes', () => {
  const r = recall(fixture(), { since: '2026-04-01T00:00:00Z' });
  assert.equal(r.hits.find(h => h.id === 'mem_old_pg'), undefined);
  assert.equal(r.hits.find(h => h.id === 'qa_old'), undefined);
  // Recent memory is in
  assert.ok(r.hits.find(h => h.id === 'mem_recent_dyob'));
});

test('recall: until filter excludes newer nodes', () => {
  const r = recall(fixture(), { until: '2026-02-01T00:00:00Z' });
  assert.ok(r.hits.find(h => h.id === 'mem_old_pg'));
  assert.equal(r.hits.find(h => h.id === 'mem_recent_dyob'), undefined);
});

test('recall: repo scope restricts to scope.repo match', () => {
  const r = recall(fixture(), { repo: 'DYOB3' });
  // mem_recent_dyob has scope.repo === 'DYOB3' -> in
  assert.ok(r.hits.find(h => h.id === 'mem_recent_dyob'));
  // mem_old_pg has scope.repo === 'Bath-Fitter-Listing-Manager' -> out
  assert.equal(r.hits.find(h => h.id === 'mem_old_pg'), undefined);
});

test('recall: kinds filter restricts to subset', () => {
  const r = recall(fixture(), { kinds: ['memory'] });
  for (const h of r.hits) assert.equal(h.kind, 'memory');
});

test('recall: question filter scores by BM25', () => {
  // A question that hits "Postgres" should rank the Postgres-related
  // items above unrelated ones.
  const r = recall(fixture(), { question: 'Postgres' });
  const top = r.hits[0];
  assert.ok(top.label.toLowerCase().includes('postgres') || top.snippet.toLowerCase().includes('postgres'));
});

test('recall: hit shape', () => {
  const r = recall(fixture(), { limit: 5 });
  for (const h of r.hits) {
    assert.equal(typeof h.id, 'string');
    assert.equal(typeof h.kind, 'string');
    assert.equal(typeof h.label, 'string');
    assert.equal(typeof h.score, 'number');
    assert.ok(h.snippet === '' || typeof h.snippet === 'string');
  }
});

test('KIND_BASE_SCORE: memory > conversation > drawer', () => {
  assert.ok(KIND_BASE_SCORE.memory > KIND_BASE_SCORE.conversation);
  assert.ok(KIND_BASE_SCORE.conversation > KIND_BASE_SCORE.drawer);
});
