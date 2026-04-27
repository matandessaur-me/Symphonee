const assert = require('node:assert/strict');
const test = require('node:test');

const { buildMerge, deduplicateEdges } = require('./build');

test('deduplicateEdges collapses semantic duplicates and keeps the stronger edge', () => {
  const edges = deduplicateEdges([
    {
      source: 'a',
      target: 'b',
      relation: 'imports',
      confidence: 'INFERRED',
      confidenceScore: 0.5,
      weight: 0.5,
      createdAt: '2026-04-27T20:00:00.000Z',
    },
    {
      source: 'a',
      target: 'b',
      relation: 'imports',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      weight: 1,
      createdAt: '2026-04-27T20:01:00.000Z',
    },
  ]);

  assert.equal(edges.length, 1);
  assert.equal(edges[0].confidence, 'EXTRACTED');
  assert.equal(edges[0].confidenceScore, 1);
  assert.equal(edges[0].weight, 1);
});

test('buildMerge incremental path does not double-count mirrored cached edges', () => {
  const existing = {
    nodes: [
      { id: 'code_a', label: 'a.ts', kind: 'code' },
      { id: 'code_b', label: 'b.ts', kind: 'code' },
    ],
    edges: [
      {
        source: 'code_a',
        target: 'code_b',
        relation: 'imports',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 1,
        createdAt: '2026-04-27T20:00:00.000Z',
      },
    ],
  };

  const merged = buildMerge(existing, [{
    nodes: [
      { id: 'code_a', label: 'a.ts', kind: 'code' },
      { id: 'code_b', label: 'b.ts', kind: 'code' },
    ],
    edges: [
      {
        source: 'code_a',
        target: 'code_b',
        relation: 'imports',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 1,
        createdAt: '2026-04-27T20:05:00.000Z',
      },
    ],
  }]);

  assert.equal(merged.nodes.length, 2);
  assert.equal(merged.edges.length, 1);
});
