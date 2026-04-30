const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('./store');

test('saveGraph repairs invalid optional graph items instead of failing the build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-store-repair-'));
  const graph = {
    version: 1,
    scope: { space: '_test', isGlobal: false },
    nodes: [
      { id: 'good', label: 'Good', kind: 'note' },
      { id: 'bad', label: 'Bad', kind: 'unknown-kind' },
    ],
    edges: [
      {
        source: 'good',
        target: 'missing',
        relation: 'contains',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
      },
    ],
    hyperedges: [],
    communities: {},
    gods: [],
    surprises: [],
    stats: {},
  };

  const stats = store.saveGraph(root, '_test', graph);
  const saved = store.loadGraph(root, '_test');

  assert.equal(stats.nodes, 1);
  assert.equal(stats.edges, 0);
  assert.equal(saved.nodes[0].id, 'good');
  assert.equal(saved.stats.validationWarningCount, 2);
});
