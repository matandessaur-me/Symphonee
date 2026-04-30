'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const impact = require('./impact');

function fixture() {
  return {
    nodes: [
      { id: 'fA', kind: 'code', label: 'a.ts', source: { type: 'file', ref: 'a.ts' } },
      { id: 'fB', kind: 'code', label: 'b.ts', source: { type: 'file', ref: 'b.ts' } },
      { id: 'fC', kind: 'code', label: 'c.ts', source: { type: 'file', ref: 'c.ts' } },
      { id: 'sA', kind: 'code', label: 'foo()', source: { type: 'symbol', ref: 'foo', file: 'a.ts' }, sourceLocation: { file: 'a.ts', line: 1 } },
      { id: 'sB', kind: 'code', label: 'bar()', source: { type: 'symbol', ref: 'bar', file: 'b.ts' }, sourceLocation: { file: 'b.ts', line: 1 } },
      { id: 'sC', kind: 'code', label: 'baz()', source: { type: 'symbol', ref: 'baz', file: 'c.ts' }, sourceLocation: { file: 'c.ts', line: 1 } },
      { id: 'sMain', kind: 'code', label: 'main()', source: { type: 'symbol', ref: 'main', file: 'main.ts' }, sourceLocation: { file: 'main.ts', line: 1 } },
    ],
    edges: [
      { source: 'fA', target: 'sA', relation: 'defines', confidence: 'EXTRACTED' },
      { source: 'fB', target: 'sB', relation: 'defines', confidence: 'EXTRACTED' },
      { source: 'fC', target: 'sC', relation: 'defines', confidence: 'EXTRACTED' },
      { source: 'sB', target: 'sA', relation: 'calls', confidence: 'EXTRACTED' },
      { source: 'sC', target: 'sB', relation: 'calls', confidence: 'EXTRACTED' },
      { source: 'fB', target: 'fA', relation: 'imports', confidence: 'EXTRACTED' },
      { source: 'fC', target: 'fB', relation: 'imports', confidence: 'EXTRACTED' },
    ],
  };
}

test('getImpact on a symbol returns reverse-call file set', () => {
  const r = impact.getImpact(fixture(), 'foo', 3);
  assert.equal(r.targetKind, 'symbol');
  assert.ok(r.totalFiles >= 1, 'at least one caller file detected');
  // hop 1 must contain b.ts (calls foo)
  assert.ok((r.filesByDepth['1'] || []).includes('b.ts'));
});

test('getImpact respects depth', () => {
  const r1 = impact.getImpact(fixture(), 'foo', 1);
  const r3 = impact.getImpact(fixture(), 'foo', 3);
  assert.ok(r3.totalFiles >= r1.totalFiles);
});

test('getCallFlow walks calls + defines forward', () => {
  const r = impact.getCallFlow(fixture(), 'baz', 5);
  assert.ok(r);
  assert.ok(Array.isArray(r.children));
});

test('getSymbolContext returns callers + callees', () => {
  const r = impact.getSymbolContext(fixture(), 'bar');
  assert.equal(r.length, 1);
  assert.ok(r[0].callers.length >= 1, 'bar should have a caller (baz)');
  assert.ok(r[0].callees.length >= 1, 'bar should have a callee (foo)');
});

test('listSymbols with file filter', () => {
  const r = impact.listSymbols(fixture(), { file: 'a.ts' });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'foo()');
});

test('detectEntrypoints surfaces well-known names', () => {
  const r = impact.detectEntrypoints(fixture());
  const main = r.find(e => e.label === 'main()');
  assert.ok(main, 'main symbol detected as entrypoint');
  assert.ok(main.reasons.includes('well-known-name:main'));
});

test('detectCircular finds A -> B -> A cycle', () => {
  const g = {
    nodes: [
      { id: 'fA', kind: 'code', source: { type: 'file', ref: 'a.ts' }, label: 'a.ts' },
      { id: 'fB', kind: 'code', source: { type: 'file', ref: 'b.ts' }, label: 'b.ts' },
    ],
    edges: [
      { source: 'fA', target: 'fB', relation: 'imports' },
      { source: 'fB', target: 'fA', relation: 'imports' },
    ],
  };
  const cycles = impact.detectCircular(g);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].length, 2);
});

test('detectCircular returns empty when DAG', () => {
  const g = {
    nodes: [
      { id: 'fA', kind: 'code', source: { type: 'file', ref: 'a.ts' }, label: 'a' },
      { id: 'fB', kind: 'code', source: { type: 'file', ref: 'b.ts' }, label: 'b' },
    ],
    edges: [{ source: 'fA', target: 'fB', relation: 'imports' }],
  };
  assert.equal(impact.detectCircular(g).length, 0);
});
