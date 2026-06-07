'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call } = require('./routes.testkit');
const { register } = require('./routes-builds');

const SPACE = '_global';
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
  });
}
function mount(repoRoot, activeRepoPath = null) {
  const { handlers, addRoute, json } = collector();
  let n = 0;
  register(addRoute, json, {
    repoRoot, getSpace: () => SPACE,
    getUiContext: () => ({ activeRepo: activeRepoPath ? 'r' : null, activeRepoPath }),
    readBody, broadcast: () => {}, ctx: {},
    jobs: new Map(), makeJobId: () => 'mj_' + (++n),
    DEFAULT_BUILD_SOURCES: ['notes'],
  });
  return handlers;
}

test('GET /api/mind/lock reports lock status for all ops', async () => {
  const r = await call(mount(tmpRepo()), 'GET /api/mind/lock');
  assert.equal(r.data.space, SPACE);
  for (const k of ['build', 'update', 'graph', 'watch']) assert.ok(k in r.data, `${k} present`);
});

test('GET /api/mind/checkpoint returns the space + checkpoint', async () => {
  const r = await call(mount(tmpRepo()), 'GET /api/mind/checkpoint');
  assert.equal(r.data.space, SPACE);
  assert.ok('checkpoint' in r.data);
});

test('POST /api/mind/build returns a job id and starts async', async () => {
  const r = await call(mount(tmpRepo()), 'POST /api/mind/build', { body: {} });
  assert.ok(r.data.jobId, 'jobId returned');
  assert.deepEqual(r.data.sources, ['notes']);
});

test('POST /api/mind/patch-file 400 without a file, 400 without an active repo', async () => {
  assert.equal((await call(mount(tmpRepo()), 'POST /api/mind/patch-file', { body: {} })).status, 400);
  assert.equal((await call(mount(tmpRepo(), null), 'POST /api/mind/patch-file', { body: { file: 'x.js' } })).status, 400);
});
