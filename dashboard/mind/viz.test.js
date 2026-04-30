'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const { mermaidGraph, interactiveHtml, writeInteractive } = require('./viz');

const tinyGraph = {
  nodes: [
    { id: 'a', label: 'a.ts', kind: 'code' },
    { id: 'b', label: 'b.ts', kind: 'code' },
  ],
  edges: [{ source: 'a', target: 'b', relation: 'imports', confidence: 'EXTRACTED' }],
};

test('mermaidGraph emits a flowchart header + a node + an edge', () => {
  const m = mermaidGraph(tinyGraph);
  assert.match(m, /flowchart (LR|TB)/);
  assert.match(m, /a\["a\.ts"\]/);
  assert.match(m, /a -->/);
});

test('mermaidGraph respects max', () => {
  const big = { nodes: Array.from({ length: 500 }, (_, i) => ({ id: 'n' + i, label: 'n' + i, kind: 'code' })), edges: [] };
  const m = mermaidGraph(big, { max: 50 });
  const nodeLines = m.split('\n').filter(l => /\["/.test(l));
  assert.ok(nodeLines.length <= 50);
});

test('interactiveHtml is a self-contained HTML document', () => {
  const html = interactiveHtml(tinyGraph, { layout: 'cose' });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /cytoscape\.min\.js/);
  assert.ok(html.includes('"a.ts"'));
});

test('writeInteractive writes a file and returns its path', () => {
  const r = writeInteractive(tinyGraph);
  assert.ok(r.path);
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.bytes > 0);
  fs.unlinkSync(r.path);
});
