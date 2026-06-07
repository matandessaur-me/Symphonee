'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call } = require('./routes.testkit');
const { register } = require('./routes-insights');

const SPACE = '_global';
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
  });
}
function mount(repoRoot, generateInsights = async () => ({ ok: true, generated: 0 })) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, {
    repoRoot, getSpace: () => SPACE,
    getUiContext: () => ({ activeRepo: null, activeRepoPath: null }),
    readBody, broadcast: () => {}, notifyKnowledgeEvent: () => {}, generateInsights,
  });
  return handlers;
}

test('GET /api/mind/insights returns an items list', async () => {
  const r = await call(mount(tmpRepo()), 'GET /api/mind/insights', { url: '/api/mind/insights?status=pending' });
  assert.ok(Array.isArray(r.data.items));
  assert.equal(r.data.status, 'pending');
});

test('GET /api/mind/suggestions returns items for a topic', async () => {
  const r = await call(mount(tmpRepo()), 'GET /api/mind/suggestions', { url: '/api/mind/suggestions?topic=x' });
  assert.ok(Array.isArray(r.data.items));
});

test('POST /api/mind/insights/generate kicks off generation', async () => {
  let called = false;
  const handlers = mount(tmpRepo(), async () => { called = true; return { ok: true }; });
  const r = await call(handlers, 'POST /api/mind/insights/generate', { body: {} });
  assert.equal(r.data.started, true);
  await new Promise(res => setTimeout(res, 10));
  assert.equal(called, true, 'generateInsights invoked async');
});

test('POST /api/mind/insights/act 404 for an unknown id', async () => {
  const r = await call(mount(tmpRepo()), 'POST /api/mind/insights/act', { body: { id: 'nope' } });
  assert.equal(r.status, 404);
});

test('POST /api/mind/insights/act and /dismiss require an id', async () => {
  const handlers = mount(tmpRepo());
  assert.equal((await call(handlers, 'POST /api/mind/insights/act', { body: {} })).status, 400);
  assert.equal((await call(handlers, 'POST /api/mind/insights/dismiss', { body: {} })).status, 400);
});
