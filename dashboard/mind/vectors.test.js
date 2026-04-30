'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VectorStore } = require('./vectors');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-test-vec-'));
}

function ensureSpace(root, space) {
  fs.mkdirSync(path.join(root, '.symphonee', 'mind', 'spaces', space), { recursive: true });
}

test('upsert + query returns nearest by cosine', () => {
  const root = tmpRoot();
  ensureSpace(root, 's');
  const v = new VectorStore(root, 's');
  v.init({ dim: 3, provider: 'test', model: 'm' });
  v.upsert('a', new Float32Array([1, 0, 0]));
  v.upsert('b', new Float32Array([0, 1, 0]));
  v.upsert('c', new Float32Array([0.9, 0.1, 0]));
  const r = v.query(new Float32Array([1, 0, 0]), 2);
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 'a');
  assert.equal(r[1].id, 'c');
});

test('save + load roundtrip', () => {
  const root = tmpRoot();
  ensureSpace(root, 's');
  const v = new VectorStore(root, 's');
  v.init({ dim: 2, provider: 'test', model: 'm' });
  v.upsert('a', new Float32Array([1, 0]));
  v.upsert('b', new Float32Array([0, 1]));
  v.save();
  const v2 = new VectorStore(root, 's');
  assert.equal(v2.load(), true);
  assert.equal(v2.count(), 2);
  assert.equal(v2.dim, 2);
  assert.equal(v2.provider, 'test');
});

test('upsert overwrites in place', () => {
  const root = tmpRoot();
  ensureSpace(root, 's');
  const v = new VectorStore(root, 's');
  v.init({ dim: 2 });
  v.upsert('a', new Float32Array([1, 0]));
  v.upsert('a', new Float32Array([0, 1]));
  assert.equal(v.count(), 1);
  const r = v.query(new Float32Array([0, 1]), 1);
  assert.ok(r[0].score > 0.99, 'overwritten vector wins');
});

test('remove deletes a row', () => {
  const root = tmpRoot();
  ensureSpace(root, 's');
  const v = new VectorStore(root, 's');
  v.init({ dim: 2 });
  v.upsert('a', new Float32Array([1, 0]));
  v.upsert('b', new Float32Array([0, 1]));
  assert.equal(v.remove('a'), true);
  assert.equal(v.count(), 1);
  assert.equal(v.remove('a'), false, 'second remove is a no-op');
});

test('query on mismatched dim returns empty', () => {
  const root = tmpRoot();
  ensureSpace(root, 's');
  const v = new VectorStore(root, 's');
  v.init({ dim: 3 });
  v.upsert('a', new Float32Array([1, 0, 0]));
  const r = v.query(new Float32Array([1, 0]), 1);
  assert.deepEqual(r, []);
});
