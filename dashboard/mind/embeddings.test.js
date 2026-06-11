'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyTaskPrefix } = require('./embeddings');

test('applyTaskPrefix: prepends nomic search_document/search_query prefixes', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', 'search_document'), 'search_document: hello');
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', 'search_query'), 'search_query: hello');
  assert.strictEqual(applyTaskPrefix('x', 'nomic-embed-text-v1.5', 'classification'), 'classification: x');
  assert.strictEqual(applyTaskPrefix('x', 'nomic-embed-text', 'clustering'), 'clustering: x');
});

test('applyTaskPrefix: no-op without a task (preserves prior behaviour)', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', null), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', undefined), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', ''), 'hello');
});

test('applyTaskPrefix: only nomic models get prefixed', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'text-embedding-3-small', 'search_query'), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', 'text-embedding-004', 'search_document'), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', null, 'search_query'), 'hello');
});

test('applyTaskPrefix: unknown task is ignored, not blindly prepended', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', 'banana'), 'hello');
});
