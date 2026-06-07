'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { mountNotes } = require('./notes');

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-notes-'));
  fs.mkdirSync(path.join(d, 'notes'), { recursive: true });
  return d;
}
function harness(repoRoot) {
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountNotes(addRoute, json, {
    repoRoot, broadcast: () => {}, hybridSearch: null,
    getUiContext: () => ({ notesNamespace: '_global' }),
  });
  return routes;
}
const req = (body) => Readable.from([JSON.stringify(body)]);

test('notes routes are all registered', () => {
  const r = harness(tmpRepo());
  for (const key of [
    'GET /api/notes', 'GET /api/notes/read', 'POST /api/notes/save',
    'DELETE /api/notes/delete', 'POST /api/notes/create', 'GET /api/notes/export',
    'GET /api/notes/export-all', 'POST /api/notes/import',
  ]) assert.ok(r[key], `missing route ${key}`);
});

test('save -> list -> read -> delete round-trip', async () => {
  const r = harness(tmpRepo());
  let res = {};
  await r['POST /api/notes/save'](req({ name: 'Hello', content: '# hi\nbody' }), res);
  assert.ok(res._data.ok, 'saved');

  res = {};
  r['GET /api/notes']({}, res, new URL('http://x/api/notes'));
  assert.ok(Array.isArray(res._data), 'list is array');
  assert.ok(res._data.some(n => n.name === 'Hello'), 'note listed');

  res = {};
  r['GET /api/notes/read']({}, res, new URL('http://x/?name=Hello'));
  assert.equal(res._data.content, '# hi\nbody');

  res = {};
  await r['DELETE /api/notes/delete'](req({ name: 'Hello' }), res);
  assert.ok(res._data.ok, 'deleted');

  res = {};
  r['GET /api/notes']({}, res, new URL('http://x/api/notes'));
  assert.ok(!res._data.some(n => n.name === 'Hello'), 'gone after delete');
});

test('create duplicate -> 409', async () => {
  const r = harness(tmpRepo());
  let res = {};
  await r['POST /api/notes/create'](req({ name: 'Dup' }), res);
  assert.ok(res._data.ok, 'created');
  res = {};
  await r['POST /api/notes/create'](req({ name: 'Dup' }), res);
  assert.equal(res._status, 409);
});

test('read missing name -> 400', () => {
  const r = harness(tmpRepo());
  const res = {};
  r['GET /api/notes/read']({}, res, new URL('http://x/api/notes/read'));
  assert.equal(res._status, 400);
});

test('export-all returns namespaced json payload', () => {
  const repo = tmpRepo();
  const r = harness(repo);
  fs.mkdirSync(path.join(repo, 'notes', '_global'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'notes', '_global', 'A.md'), '# A');
  const res = {};
  let body = '';
  res.writeHead = () => {}; res.end = (s) => { body = s; };
  r['GET /api/notes/export-all']({}, res);
  const parsed = JSON.parse(body);
  assert.ok(parsed.namespaces, 'has namespaces');
});
