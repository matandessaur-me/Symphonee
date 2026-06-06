'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectAiUnder, readProcessTree } = require('./ai-tree-detect');

test('detectAiUnder matches a direct binary name', () => {
  const tree = new Map([[100, [{ pid: 200, name: 'claude.exe', cmdline: '' }]]]);
  assert.equal(detectAiUnder(tree, 100), 'claude');
});

test('detectAiUnder matches a node.exe CLI via cmdline marker', () => {
  const tree = new Map([[100, [{ pid: 200, name: 'node.exe', cmdline: 'node c:/x/@google/gemini-cli/index.js' }]]]);
  assert.equal(detectAiUnder(tree, 100), 'gemini');
});

test('detectAiUnder walks nested descendants', () => {
  const tree = new Map([
    [100, [{ pid: 200, name: 'cmd.exe', cmdline: '' }]],
    [200, [{ pid: 300, name: 'qwen.exe', cmdline: '' }]],
  ]);
  assert.equal(detectAiUnder(tree, 100), 'qwen');
});

test('detectAiUnder returns null when nothing matches', () => {
  const tree = new Map([[100, [{ pid: 200, name: 'notepad.exe', cmdline: '' }]]]);
  assert.equal(detectAiUnder(tree, 100), null);
  assert.equal(detectAiUnder(null, 100), null);
});

test('readProcessTree resolves to a Map or null', async () => {
  const t = await readProcessTree();
  assert.ok(t === null || t instanceof Map);
});
