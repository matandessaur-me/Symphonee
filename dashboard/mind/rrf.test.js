'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fuse } = require('./rrf');

test('RRF prefers an item that ranks high in BOTH lists over one that ranks high in only one', () => {
  const bm = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const dn = [{ id: 'b' }, { id: 'c' }, { id: 'a' }];
  const f = fuse([bm, dn]);
  // b appears at rank 1 in dn AND rank 1 in bm -> highest
  assert.equal(f[0].id, 'b');
});

test('RRF honors the limit', () => {
  const bm = Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i }));
  const f = fuse([bm], { limit: 5 });
  assert.equal(f.length, 5);
});

test('RRF works with string-only entries', () => {
  const f = fuse([['a', 'b', 'c'], ['c', 'b', 'a']]);
  assert.ok(f[0].id === 'b' || f[0].id === 'a' || f[0].id === 'c');
});

test('RRF skips non-array inputs gracefully', () => {
  const f = fuse([null, [{ id: 'a' }], undefined, [{ id: 'b' }, { id: 'a' }]]);
  assert.ok(f.find(r => r.id === 'a'));
  assert.ok(f.find(r => r.id === 'b'));
});
