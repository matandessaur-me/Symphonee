'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const checkpoint = require('./checkpoint');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-test-cp-'));
}

test('write then read returns the same payload', () => {
  const root = tmpRoot();
  checkpoint.write(root, 's', { phase: 'test', sources: ['notes'] });
  const r = checkpoint.read(root, 's');
  assert.equal(r.phase, 'test');
  assert.deepEqual(r.sources, ['notes']);
  assert.ok(r.ts);
});

test('clear removes the file', () => {
  const root = tmpRoot();
  checkpoint.write(root, 's', { phase: 'x' });
  checkpoint.clear(root, 's');
  assert.equal(checkpoint.read(root, 's'), null);
});

test('read returns null when no checkpoint exists', () => {
  const root = tmpRoot();
  assert.equal(checkpoint.read(root, 's'), null);
});
