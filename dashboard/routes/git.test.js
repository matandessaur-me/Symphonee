'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { mountGit } = require('./git');
const { SWRCache } = require('../utils/swr-cache');
const { BusyGuard } = require('../utils/busy-guard');

const repoRoot = path.resolve(__dirname, '..', '..'); // the Symphonee repo (a git repo)

function harness(getRepoPath) {
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountGit(addRoute, json, {
    getRepoPath: getRepoPath || (() => repoRoot),
    broadcast: () => {},
    swrGit: new SWRCache({ staleTTL: 1000, maxAge: 5000 }),
    guard: new BusyGuard(),
  });
  return routes;
}

test('git routes are all registered', () => {
  const r = harness();
  for (const key of [
    'GET /api/git/status', 'GET /api/git/diff', 'GET /api/git/branches',
    'GET /api/git/log', 'GET /api/git/commit-diff', 'GET /api/git/split-diff',
    'POST /api/git/checkout', 'POST /api/git/pull', 'POST /api/git/push',
    'POST /api/git/fetch', 'POST /api/git/discard',
  ]) assert.ok(r[key], `missing route ${key}`);
});

test('git status returns {branch, files, clean}', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/status']({}, res, new URL('http://x/api/git/status?repo=test'));
  assert.ok(res._data, 'responded');
  assert.ok('branch' in res._data && 'files' in res._data && 'clean' in res._data, 'shape');
  assert.equal(typeof res._data.branch, 'string');
  assert.ok(Array.isArray(res._data.files));
});

test('git branches returns current + branches[]', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/branches']({}, res, new URL('http://x/?repo=test'));
  assert.ok(Array.isArray(res._data.branches), 'branches array');
  assert.equal(typeof res._data.current, 'string');
});

test('git log returns commits[]', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/log']({}, res, new URL('http://x/?repo=test&count=3'));
  assert.ok(Array.isArray(res._data.commits));
});

test('missing repo -> 400', async () => {
  const r = harness(() => null);
  const res = {};
  await r['GET /api/git/status']({}, res, new URL('http://x/?repo=nope'));
  assert.equal(res._status, 400);
});

test('git diff blocks path traversal (untracked-file read stays in repo)', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/diff']({}, res, new URL('http://x/?repo=test&path=../../../../etc/passwd'));
  // Must never leak file content from outside the repo
  const diff = (res._data && res._data.diff) || '';
  assert.ok(!diff.includes('root:'), 'no /etc/passwd content in diff');
});

test('split-diff blocks path traversal -> no disk content from outside repo', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/split-diff']({}, res, new URL('http://x/?repo=test&path=../../../../etc/passwd'));
  assert.equal((res._data && res._data.modified) || '', '', 'modified must be empty for escaped path');
});

test('split-diff rejects flag-injection base ref -> 400', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/split-diff']({}, res, new URL('http://x/?repo=test&path=package.json&base=--output%3Dpwn'));
  assert.equal(res._status, 400);
});

test('commit-diff rejects flag-injection hash -> 400', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/commit-diff']({}, res, new URL('http://x/?repo=test&hash=--output%3Dpwn'));
  assert.equal(res._status, 400);
});
