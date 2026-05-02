'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runQuery, bestSeeds } = require('./query');
const { isEdgeValidAt, validateEdge, validateGraph } = require('./schema');

function makeNode(id, label, extra = {}) {
  return {
    id, label, kind: extra.kind || 'concept',
    source: null, sourceLocation: null,
    createdBy: 'test', createdAt: new Date().toISOString(),
    tags: extra.tags || [],
    ...extra,
  };
}

function makeEdge(s, t, extra = {}) {
  return {
    source: s, target: t,
    relation: extra.relation || 'conceptually_related_to',
    confidence: extra.confidence || 'EXTRACTED',
    confidenceScore: 0.9, weight: 1, createdBy: 'test',
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

function fixtureGraph() {
  return {
    version: 1,
    scope: { space: 'test', isGlobal: false },
    generatedAt: new Date().toISOString(),
    nodes: [
      makeNode('n_router', 'browser router stagehand fallback', { tags: ['browser', 'router'] }),
      makeNode('n_other',  'cooking recipes for tuesday'),
      makeNode('n_partial', 'browser tab focus'),
      makeNode('n_old',    'we use Postgres', { tags: ['db'] }),
      makeNode('n_new',    'we migrated to Cassandra', { tags: ['db'] }),
    ],
    edges: [
      makeEdge('n_router', 'n_partial'),
      makeEdge('n_old', 'n_new', { relation: 'derived_from', validFrom: '2025-01-01', validTo: '2025-06-01' }),
      makeEdge('n_old', 'n_partial', { validFrom: '2024-01-01' }), // open-ended start
    ],
    hyperedges: [], communities: {}, gods: ['n_router'], surprises: [],
    stats: { nodes: 5, edges: 3, communities: 0, tokenCost: 0 },
  };
}

test('bestSeeds: BM25 ranks the multi-term-matching node first', () => {
  const g = fixtureGraph();
  const seeds = bestSeeds(g, 'browser router stagehand');
  assert.equal(seeds[0], 'n_router');
});

test('bestSeeds: god prior breaks ties toward god nodes', () => {
  const g = fixtureGraph();
  // Query that hits two nodes equally on bm25 substance -- god prior tips it.
  const seeds = bestSeeds(g, 'browser');
  assert.equal(seeds[0], 'n_router', 'router is a god node and shares the term -> first');
});

test('bestSeeds: zero matches falls back to first-N', () => {
  const g = fixtureGraph();
  const seeds = bestSeeds(g, 'klingon spaceship blueprints');
  assert.equal(seeds.length, 0, 'no candidates means empty seeds, not garbage');
});

test('runQuery returns a sub-graph and includes asOf in the response', () => {
  const g = fixtureGraph();
  const result = runQuery(g, { question: 'browser router', budget: 1000 });
  assert.ok(result.nodes.length >= 1);
  assert.equal(result.asOf, null);
  assert.ok(result.seedIds.includes('n_router'));
});

test('runQuery with asOf hides edges that have already expired', () => {
  const g = fixtureGraph();
  // 2025-06-01 is the validTo (exclusive) of the n_old -> n_new edge.
  // Anything at or after that moment must NOT see it.
  const r1 = runQuery(g, { question: 'postgres', asOf: '2025-03-15' });
  const r2 = runQuery(g, { question: 'postgres', asOf: '2025-09-01' });

  const has = (r, src, tgt) => r.edges.some(e => e.source === src && e.target === tgt);
  assert.ok(has(r1, 'n_old', 'n_new'), 'edge should be visible while still valid');
  assert.ok(!has(r2, 'n_old', 'n_new'), 'edge must be hidden after validTo');
});

test('runQuery with asOf hides edges before they begin', () => {
  const g = fixtureGraph();
  const before = runQuery(g, { question: 'postgres', asOf: '2023-01-01' });
  const has = (r, src, tgt) => r.edges.some(e => e.source === src && e.target === tgt);
  assert.ok(!has(before, 'n_old', 'n_partial'), 'edge with validFrom 2024-01-01 must not show in 2023');
});

test('runQuery with no asOf returns all edges including temporal ones', () => {
  const g = fixtureGraph();
  const r = runQuery(g, { question: 'postgres' });
  // The seed chosen for "postgres" is n_old; BFS reaches its neighbours.
  assert.ok(r.edges.length >= 1);
});

test('isEdgeValidAt: half-open interval', () => {
  const e = { validFrom: '2025-01-01', validTo: '2025-06-01' };
  assert.equal(isEdgeValidAt(e, '2025-01-01'), true,  'validFrom is inclusive');
  assert.equal(isEdgeValidAt(e, '2025-05-31T23:59:59Z'), true);
  assert.equal(isEdgeValidAt(e, '2025-06-01'), false, 'validTo is exclusive');
  assert.equal(isEdgeValidAt(e, '2024-12-31'), false);
});

test('isEdgeValidAt: timeless edge always valid', () => {
  assert.equal(isEdgeValidAt({}, '2025-01-01'), true);
  assert.equal(isEdgeValidAt({}, null), true);
});

test('validateEdge accepts valid temporal fields and rejects bad ones', () => {
  const ids = new Set(['a', 'b']);
  const ok = { source: 'a', target: 'b', relation: 'describes', confidence: 'EXTRACTED', confidenceScore: 1, validFrom: '2025-01-01' };
  assert.equal(validateEdge(ok, ids), null);

  const inverted = { ...ok, validFrom: '2025-06-01', validTo: '2025-01-01' };
  assert.match(validateEdge(inverted, ids), /validTo must be > validFrom/);

  const garbage = { ...ok, validFrom: 'not-a-date' };
  assert.match(validateEdge(garbage, ids), /validFrom must be ISO/);
});

test('validateGraph accepts a drawer-kind node', () => {
  const g = {
    version: 1, scope: { space: null, isGlobal: false },
    generatedAt: new Date().toISOString(),
    nodes: [makeNode('d1', 'verbatim user turn', { kind: 'drawer' })],
    edges: [], hyperedges: [], communities: {}, gods: [], surprises: [],
    stats: { nodes: 1, edges: 0, communities: 0, tokenCost: 0 },
  };
  assert.deepEqual(validateGraph(g), []);
});

test('runQuery: code-only seeds skip taxonomic edges (mentions/member_of)', () => {
  // Seed at a code node. The graph contains both a code-structural
  // edge (calls -> auth_helper) AND a taxonomic edge (member_of ->
  // repo node) AND a brand mention. Code-only mode should pull the
  // structural neighbour and skip the brand/repo noise.
  const g = {
    version: 1,
    scope: { space: 'test', isGlobal: false },
    generatedAt: new Date().toISOString(),
    nodes: [
      makeNode('code_login', 'login.ts', { kind: 'code' }),
      makeNode('code_auth_helper', 'auth_helper.ts', { kind: 'code' }),
      makeNode('repo_node_app', 'app', { kind: 'repo' }),
      makeNode('entity_brand', 'BrandX', { kind: 'entity' }),
    ],
    edges: [
      makeEdge('code_login', 'code_auth_helper', { relation: 'calls' }),
      makeEdge('code_login', 'repo_node_app',    { relation: 'member_of' }),
      makeEdge('code_login', 'entity_brand',     { relation: 'mentions' }),
    ],
    hyperedges: [], communities: {}, gods: [], surprises: [],
    stats: { nodes: 4, edges: 3, communities: 0, tokenCost: 0 },
  };
  const r = runQuery(g, { seedIds: ['code_login'], budget: 600 });
  const ids = new Set(r.nodes.map(n => n.id));
  assert.ok(ids.has('code_auth_helper'), 'should reach code-structural neighbour');
  assert.ok(!ids.has('repo_node_app'), 'should skip member_of (tier 3)');
  assert.ok(!ids.has('entity_brand'),  'should skip mentions (tier 3)');
});

test('runQuery: non-code seed allows full traversal including taxonomic', () => {
  // Same graph, but seeded at a note (not code). The taxonomic edges
  // are now allowed because the user might be asking about brand /
  // repo membership.
  const g = {
    version: 1,
    scope: { space: 'test', isGlobal: false },
    generatedAt: new Date().toISOString(),
    nodes: [
      makeNode('note_q', 'a question note', { kind: 'note' }),
      makeNode('repo_node_app', 'app', { kind: 'repo' }),
      makeNode('entity_brand', 'BrandX', { kind: 'entity' }),
    ],
    edges: [
      makeEdge('note_q', 'repo_node_app', { relation: 'member_of' }),
      makeEdge('note_q', 'entity_brand',  { relation: 'mentions' }),
    ],
    hyperedges: [], communities: {}, gods: [], surprises: [],
    stats: { nodes: 3, edges: 2, communities: 0, tokenCost: 0 },
  };
  const r = runQuery(g, { seedIds: ['note_q'], budget: 600 });
  const ids = new Set(r.nodes.map(n => n.id));
  assert.ok(ids.has('repo_node_app'), 'note seed should reach taxonomic neighbour');
  assert.ok(ids.has('entity_brand'));
});
