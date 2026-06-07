'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call, node, edge, seed } = require('./routes.testkit');
const { register } = require('./routes-graph-detail');

const SPACE = '_global';
function mount(repoRoot) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, { repoRoot, getSpace: () => SPACE });
  return handlers;
}

test('GET /api/mind/node returns the node + its neighbors', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('a', 'concept'), node('b', 'concept')], [edge('a', 'b', 'references')]);
  const handlers = mount(repoRoot);
  const r = await call(handlers, 'GET /api/mind/node', { url: '/api/mind/node?id=a' });
  assert.equal(r.data.node.id, 'a');
  assert.equal(r.data.neighbors.length, 1);
  assert.equal(r.data.neighbors[0].peer.id, 'b');
});

test('GET /api/mind/node 400 without id, 404 for missing', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('a', 'concept')]);
  const handlers = mount(repoRoot);
  assert.equal((await call(handlers, 'GET /api/mind/node', { url: '/api/mind/node' })).status, 400);
  assert.equal((await call(handlers, 'GET /api/mind/node', { url: '/api/mind/node?id=zzz' })).status, 404);
});

test('GET /api/mind/gods and /surprises read graph fields', async () => {
  const repoRoot = tmpRepo();
  const g = seed(repoRoot, SPACE, [node('a', 'concept')]);
  g.gods = [{ id: 'a', score: 9 }];
  require('./routes.testkit').store.saveGraph(repoRoot, SPACE, g);
  const handlers = mount(repoRoot);
  const gods = await call(handlers, 'GET /api/mind/gods');
  assert.equal(gods.data.gods[0].id, 'a');
  const surprises = await call(handlers, 'GET /api/mind/surprises');
  assert.ok(Array.isArray(surprises.data.surprises));
});
