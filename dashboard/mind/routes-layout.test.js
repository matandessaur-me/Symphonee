'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call } = require('./routes.testkit');
const { register } = require('./routes-layout');

const SPACE = '_global';
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
  });
}
function mount(repoRoot) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, { repoRoot, getSpace: () => SPACE, readBody });
  return handlers;
}

test('layout POST then GET round-trips persisted positions', async () => {
  const repoRoot = tmpRepo();
  const handlers = mount(repoRoot);
  const miss = await call(handlers, 'GET /api/mind/layout', { url: '/api/mind/layout?mode=3d' });
  assert.equal(miss.data.cached, false);

  const positions = { n1: [1, 2, 3], n2: [4, 5, 6] };
  const saved = await call(handlers, 'POST /api/mind/layout', { body: { mode: '3d', positions } });
  assert.equal(saved.data.ok, true);
  assert.equal(saved.data.nodeCount, 2);

  const hit = await call(handlers, 'GET /api/mind/layout', { url: '/api/mind/layout?mode=3d' });
  assert.equal(hit.data.cached, true);
  assert.deepEqual(hit.data.positions.n1, [1, 2, 3]);
});

test('layout POST 400 without positions; DELETE is ok', async () => {
  const repoRoot = tmpRepo();
  const handlers = mount(repoRoot);
  assert.equal((await call(handlers, 'POST /api/mind/layout', { body: {} })).status, 400);
  assert.equal((await call(handlers, 'DELETE /api/mind/layout', { url: '/api/mind/layout?mode=3d' })).data.ok, true);
});
