'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call, node, edge, seed } = require('./routes.testkit');
const { register } = require('./routes-graph-reads');

const SPACE = '_global';
function mount(repoRoot, jobs = new Map()) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, { repoRoot, getSpace: () => SPACE, jobs });
  return handlers;
}

test('GET /api/mind/graph returns empty marker then the seeded graph', async () => {
  const repoRoot = tmpRepo();
  let r = await call(mount(repoRoot), 'GET /api/mind/graph');
  assert.equal(r.data.empty, true);
  seed(repoRoot, SPACE, [node('a', 'concept')]);
  r = await call(mount(repoRoot), 'GET /api/mind/graph');
  assert.equal(r.data.nodes.length, 1);
});

test('GET /api/mind/jobs reads the shared jobs table', async () => {
  const repoRoot = tmpRepo();
  const jobs = new Map([['j1', { id: 'j1', status: 'completed' }]]);
  const handlers = mount(repoRoot, jobs);
  const list = await call(handlers, 'GET /api/mind/jobs');
  assert.equal(list.data.jobs.length, 1);
  const one = await call(handlers, 'GET /api/mind/jobs', { url: '/api/mind/jobs?id=j1' });
  assert.equal(one.data.status, 'completed');
  assert.equal((await call(handlers, 'GET /api/mind/jobs', { url: '/api/mind/jobs?id=nope' })).status, 404);
});

test('GET /api/mind/quality computes resolved-import ratio', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE,
    [node('f1', 'code'), node('f2', 'code')],
    [edge('f1', 'f2', 'imports'), edge('f1', 'ext_x', 'imports')]);
  const r = await call(mount(repoRoot), 'GET /api/mind/quality');
  assert.equal(r.data.totalImportEdges, 2);
  assert.equal(r.data.resolvedCount, 1);
});

test('GET /api/mind/anchors folds repos/entities into subjects', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('r1', 'repo', { label: 'My Repo' }), node('e1', 'entity', { label: 'Thing' })]);
  const r = await call(mount(repoRoot), 'GET /api/mind/anchors');
  assert.ok(r.data.subjects.length >= 1);
});
