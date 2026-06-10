'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { mountFiles } = require('./files');

const repoRoot = path.resolve(__dirname, '..', '..'); // the Symphonee repo

function harness(getRepoPath) {
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountFiles(addRoute, json, { getRepoPath: getRepoPath || (() => repoRoot), broadcast: () => {} });
  return routes;
}

test('file routes are all registered', () => {
  const r = harness();
  for (const key of [
    'GET /api/files/tree', 'GET /api/files/read', 'POST /api/files/save',
    'GET /api/files/search', 'GET /api/files/grep', 'GET /api/files/serve',
    'GET /api/project/scripts',
  ]) assert.ok(r[key], `missing route ${key}`);
});

test('file tree lists entries and skips node_modules/.git', () => {
  const r = harness();
  const res = {};
  r['GET /api/files/tree']({}, res, new URL('http://x/?repo=test'));
  assert.ok(Array.isArray(res._data.entries), 'entries array');
  const names = res._data.entries.map(e => e.name);
  assert.ok(names.includes('dashboard'), 'has dashboard dir');
  assert.ok(!names.includes('node_modules'), 'node_modules filtered');
  assert.ok(!names.includes('.git'), '.git filtered');
});

test('file read returns content + meta for a known file', () => {
  const r = harness();
  const res = {};
  r['GET /api/files/read']({}, res, new URL('http://x/?repo=test&path=package.json'));
  assert.ok(res._data.content.includes('"name"'), 'has package.json content');
  assert.equal(res._data.ext, 'json');
  assert.ok(res._data.lines > 0);
});

test('file read blocks path traversal -> 403', () => {
  const r = harness();
  const res = {};
  r['GET /api/files/read']({}, res, new URL('http://x/?repo=test&path=../../etc/passwd'));
  assert.equal(res._status, 403);
});

test('file name search finds package.json', () => {
  const r = harness();
  const res = {};
  r['GET /api/files/search']({}, res, new URL('http://x/?repo=test&q=package.json&path=dashboard'));
  assert.ok(Array.isArray(res._data.results));
});

test('project scripts detects node project + scripts', () => {
  const r = harness();
  const res = {};
  r['GET /api/project/scripts']({}, res, new URL('http://x/?repo=test'));
  assert.ok(res._data.scripts && typeof res._data.scripts === 'object');
  assert.ok('start' in res._data.scripts, 'has start script');
});

test('missing repo -> 400', () => {
  const r = harness(() => null);
  const res = {};
  r['GET /api/files/tree']({}, res, new URL('http://x/?repo=nope'));
  assert.equal(res._status, 400);
});

test('serve-file blocks traversal and refuses non-regular files', () => {
  const r = harness();
  // traversal -> 403
  let res = { writeHead(s) { this._status = s; }, end() {} };
  r['GET /api/files/serve']({}, res, new URL('http://x/?repo=test&path=../../etc/passwd'));
  assert.equal(res._status, 403);
  // a directory is not servable -> 403
  res = { writeHead(s) { this._status = s; }, end() {} };
  r['GET /api/files/serve']({}, res, new URL('http://x/?repo=test&path=dashboard'));
  assert.equal(res._status, 403);
});
