'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call, node, seed, store } = require('./routes.testkit');
const { register } = require('./routes-knowledge');

const SPACE = '_global';
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
  });
}
function mount(repoRoot) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, {
    repoRoot,
    getSpace: () => SPACE,
    getUiContext: () => ({ activeRepo: null, activeRepoPath: null }),
    readBody,
    tryDenseSeeds: async () => null,
    // controller helpers (simplified but behavior-equivalent for these tests)
    persistDerivedGraph: (space, g) => store.saveGraph(repoRoot, space, g),
    notifyKnowledgeEvent: () => {},
    broadcast: () => {},
  });
  return handlers;
}

test('POST /api/mind/save-result 400 without question+answer; writes a node otherwise', async () => {
  const repoRoot = tmpRepo();
  const handlers = mount(repoRoot);
  assert.equal((await call(handlers, 'POST /api/mind/save-result', { body: { question: 'q' } })).status, 400);
  const r = await call(handlers, 'POST /api/mind/save-result', { body: { question: 'why', answer: 'because' } });
  assert.equal(r.data.ok, true);
  const g = store.loadGraph(repoRoot, SPACE);
  assert.ok(g.nodes.find(n => n.id === r.data.nodeId), 'conversation node persisted');
});

test('POST /api/mind/add persists a manual node', async () => {
  const repoRoot = tmpRepo();
  const r = await call(mount(repoRoot), 'POST /api/mind/add', { body: { label: 'a manual fact' } });
  assert.equal(r.data.ok, true);
  const g = store.loadGraph(repoRoot, SPACE);
  assert.ok(g.nodes.find(n => n.id === r.data.nodeId));
});

test('POST /api/mind/query returns empty marker, then a result on a seeded graph', async () => {
  const repoRoot = tmpRepo();
  let r = await call(mount(repoRoot), 'POST /api/mind/query', { body: { question: 'x' } });
  assert.equal(r.data.empty, true);
  seed(repoRoot, SPACE, [node('a', 'concept', { label: 'alpha' })]);
  r = await call(mount(repoRoot), 'POST /api/mind/query', { body: { question: 'alpha' } });
  assert.ok(Array.isArray(r.data.nodes));
});

test('POST /api/mind/kit/ingest rejects an invalid kit', async () => {
  const r = await call(mount(tmpRepo()), 'POST /api/mind/kit/ingest', { body: {} });
  assert.equal(r.data.reason, 'invalid-kit');
});

test('POST /api/mind/recall returns a hits array', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('m1', 'memory', { body: 'a fact', kindOfMemory: 'fact' })]);
  const r = await call(mount(repoRoot), 'POST /api/mind/recall', { body: { question: 'fact' } });
  assert.ok(Array.isArray(r.data.hits));
});

test('GET /api/mind/wakeup returns the space + wake-up payload', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('a', 'concept')]);
  const r = await call(mount(repoRoot), 'GET /api/mind/wakeup', { url: '/api/mind/wakeup' });
  assert.equal(r.data.space, SPACE);
});
