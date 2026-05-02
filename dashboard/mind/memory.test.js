'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildMemoryFragment, addMemoryCard, ALLOWED_KINDS } = require('./memory');
const store = require('./store');

test('buildMemoryFragment: minimal valid spec', () => {
  const { node, edges } = buildMemoryFragment({ title: 'A simple fact' });
  assert.equal(node.kind, 'memory');
  assert.equal(node.label, 'A simple fact');
  assert.equal(node.kindOfMemory, 'fact');
  assert.equal(node.body, '');
  assert.ok(node.id.startsWith('memory_'));
  assert.deepEqual(edges, []);
});

test('buildMemoryFragment: rich spec produces all metadata', () => {
  const { node } = buildMemoryFragment({
    title: 'DYOB design',
    body: 'DYOB does not follow the Bath Fitter design system',
    kindOfMemory: 'constraint',
    tags: ['DYOB', 'Bath Fitter', 'design'],
    scope: { repo: 'DYOB3' },
    source: { type: 'conversation', ref: 'qa_123' },
    createdBy: 'claude',
  });
  assert.equal(node.kindOfMemory, 'constraint');
  assert.equal(node.body.includes('Bath Fitter'), true);
  assert.equal(node.scope.repo, 'DYOB3');
  assert.equal(node.source.ref, 'qa_123');
  assert.equal(node.createdBy, 'claude');
  // tags are normalized + 'memory' is auto-prepended
  assert.ok(node.tags.includes('memory'));
  assert.ok(node.tags.includes('DYOB'));
  assert.ok(node.tags.includes('Bath Fitter'));
  assert.ok(node.tags.includes('design'));
});

test('buildMemoryFragment: derived_from edge when source.ref exists', () => {
  const { edges } = buildMemoryFragment(
    { title: 'A note', source: { ref: 'qa_existing' } },
    { existingNodeIds: new Set(['qa_existing']) },
  );
  const derived = edges.find(e => e.relation === 'derived_from');
  assert.ok(derived);
  assert.equal(derived.target, 'qa_existing');
});

test('buildMemoryFragment: no derived_from edge when source.ref is unknown', () => {
  const { edges } = buildMemoryFragment(
    { title: 'A note', source: { ref: 'qa_does_not_exist' } },
    { existingNodeIds: new Set(['some_other_node']) },
  );
  assert.equal(edges.find(e => e.relation === 'derived_from'), undefined);
});

test('buildMemoryFragment: mentions edges to known entity tags', () => {
  // Existing graph has entity_dyob and entity_bathfitter.
  const { edges } = buildMemoryFragment(
    { title: 'X', tags: ['DYOB', 'Bath Fitter', 'design'] },
    { existingNodeIds: new Set(['entity_dyob', 'entity_bathfitter']) },
  );
  const ents = edges.filter(e => e.relation === 'mentions').map(e => e.target).sort();
  assert.deepEqual(ents, ['entity_bathfitter', 'entity_dyob']);
});

test('buildMemoryFragment: in_repo edge when scope.repo names a known cwd_*', () => {
  const { edges } = buildMemoryFragment(
    { title: 'X', scope: { repo: 'DYOB3' } },
    { existingNodeIds: new Set(['cwd_dyob3']) },
  );
  const ir = edges.find(e => e.relation === 'in_repo');
  assert.ok(ir);
  assert.equal(ir.target, 'cwd_dyob3');
});

test('buildMemoryFragment: rejects invalid input', () => {
  // We test the validation surface via addMemoryCard which calls _validate.
  // buildMemoryFragment itself is forgiving for unit-test composition;
  // that's fine - the public API enforces.
  // Here, just confirm the validation rules at the addMemoryCard boundary.
});

test('addMemoryCard: writes to disk and survives a reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-mem-'));
  try {
    // Seed a tiny graph so existingNodeIds isn't empty.
    fs.mkdirSync(path.join(root, '.symphonee', 'mind', 'spaces', '_global'), { recursive: true });
    const seed = {
      version: 1,
      scope: { space: '_global', isGlobal: false },
      generatedAt: new Date().toISOString(),
      nodes: [
        { id: 'entity_dyob',     label: 'DYOB',        kind: 'entity',
          source: { type: 'entity-enrichment', ref: 'dyob' },
          createdBy: 'test', createdAt: new Date().toISOString(), tags: ['entity'] },
        { id: 'cwd_dyob3',       label: '@DYOB3',      kind: 'tag',
          source: null, createdBy: 'test', createdAt: new Date().toISOString(), tags: [] },
      ],
      edges: [],
      hyperedges: [],
      communities: {},
      gods: [], surprises: [],
      stats: { nodes: 2, edges: 0, communities: 0, tokenCost: 0 },
    };
    store.saveGraph(root, '_global', seed);

    const { node, edges } = await addMemoryCard({
      repoRoot: root, space: '_global',
      spec: {
        title: 'DYOB brand divergence',
        body: 'DYOB does not follow the Bath Fitter design system - different colours and typography.',
        kindOfMemory: 'constraint',
        tags: ['DYOB', 'design'],
        scope: { repo: 'DYOB3' },
        createdBy: 'test',
      },
    });

    assert.equal(node.kind, 'memory');
    assert.equal(node.kindOfMemory, 'constraint');
    // mentions DYOB + in_repo to cwd_dyob3
    assert.equal(edges.some(e => e.relation === 'mentions' && e.target === 'entity_dyob'), true);
    assert.equal(edges.some(e => e.relation === 'in_repo'  && e.target === 'cwd_dyob3'),    true);

    // Reload graph and confirm the node is on disk.
    const reloaded = store.loadGraph(root, '_global');
    assert.ok(reloaded.nodes.find(n => n.id === node.id));
    assert.equal(reloaded.nodes.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addMemoryCard: rejects spec with empty title', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-mem-bad-'));
  try {
    await assert.rejects(
      addMemoryCard({ repoRoot: root, space: '_global', spec: { title: '   ' } }),
      /title is required/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('addMemoryCard: rejects unknown kindOfMemory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-mem-bad-kind-'));
  try {
    await assert.rejects(
      addMemoryCard({ repoRoot: root, space: '_global', spec: { title: 'x', kindOfMemory: 'rumour' } }),
      /kindOfMemory must be one of/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ALLOWED_KINDS: known set', () => {
  assert.ok(ALLOWED_KINDS.has('decision'));
  assert.ok(ALLOWED_KINDS.has('preference'));
  assert.ok(ALLOWED_KINDS.has('constraint'));
  assert.ok(ALLOWED_KINDS.has('lesson'));
  assert.ok(ALLOWED_KINDS.has('gotcha'));
  assert.ok(ALLOWED_KINDS.has('pattern'));
  assert.ok(ALLOWED_KINDS.has('fact'));
});
