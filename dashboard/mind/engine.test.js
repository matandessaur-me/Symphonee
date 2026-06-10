'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { embedText, BODY_EMBED_KINDS } = require('./engine');

test('embedText includes the full body for prose kinds (notes, memory)', () => {
  const note = { id: 'note_x', kind: 'note', label: 'the plan', body: 'sequenced staged build with go and no-go gates' };
  const t = embedText(note);
  assert.match(t, /the plan/);
  assert.match(t, /no-go gates/, 'note body must be in the embed text, not just the title');

  const mem = { id: 'm1', kind: 'memory', label: 'a rule', body: 'always prefix nomic queries with search_query' };
  assert.match(embedText(mem), /search_query/);
});

test('embedText does NOT embed code bodies (cost/scope decision)', () => {
  const code = { id: 'repo_a', kind: 'code', label: 'parseConfig', body: 'function parseConfig(){ /* 5000 lines */ }' };
  const t = embedText(code);
  assert.match(t, /parseConfig/);          // label still embedded
  assert.doesNotMatch(t, /5000 lines/);    // body NOT embedded for code
});

test('embedText is unchanged for kinds without a body', () => {
  const concept = { id: 'c1', kind: 'concept', label: 'alpha', description: 'a desc', tags: ['t1'] };
  const t = embedText(concept);
  assert.match(t, /alpha/);
  assert.match(t, /a desc/);
  assert.match(t, /t1/);
});

test('embedText returns null for an empty node', () => {
  assert.equal(embedText({ id: 'x', kind: 'note' }), null);
});

test('embedText caps very long bodies', () => {
  const huge = { id: 'note_h', kind: 'note', label: 'h', body: 'x'.repeat(20000) };
  assert.ok(embedText(huge).length <= 6000);
});

test('BODY_EMBED_KINDS covers prose kinds but not code', () => {
  assert.ok(BODY_EMBED_KINDS.has('note'));
  assert.ok(BODY_EMBED_KINDS.has('memory'));
  assert.ok(!BODY_EMBED_KINDS.has('code'));
});
