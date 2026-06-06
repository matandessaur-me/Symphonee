'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { mountSpaces } = require('./spaces');
const { createConfigStore } = require('../lib/config-store');

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-spaces-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  const configPath = path.join(root, 'config', 'config.json');
  const templatePath = path.join(root, 'config', 'config.template.json');
  fs.writeFileSync(configPath, '{}');
  const store = createConfigStore({ templatePath, configPath, pluginsDir: path.join(root, 'plugins') });
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountSpaces(addRoute, json, { getConfig: store.getConfig, normalizeRootConfig: store.normalizeRootConfig, configPath, broadcast: () => {} });
  return routes;
}
const req = (b) => Readable.from([JSON.stringify(b)]);

test('repos/spaces routes registered', () => {
  const r = harness();
  for (const k of ['GET /api/repos', 'POST /api/repos', 'GET /api/spaces', 'POST /api/spaces',
    'DELETE /api/spaces', 'POST /api/spaces/attach-repo', 'POST /api/spaces/toggle-plugin']) {
    assert.ok(r[k], `missing ${k}`);
  }
});

test('save + get repo', async () => {
  const r = harness();
  let res = {};
  await r['POST /api/repos'](req({ name: 'My Repo', path: 'C:/x' }), res);
  assert.ok(res._data.ok);
  res = {};
  r['GET /api/repos']({}, res);
  assert.equal(res._data['My Repo'], 'C:/x');
});

test('save repo requires name+path -> 400', async () => {
  const r = harness();
  const res = {};
  await r['POST /api/repos'](req({ name: 'x' }), res);
  assert.equal(res._status, 400);
});

test('space create + attach single-membership + delete', async () => {
  const r = harness();
  let res = {};
  await r['POST /api/spaces'](req({ name: 'A' }), res);
  await r['POST /api/spaces'](req({ name: 'B' }), res = {});
  // attach repo to A
  await r['POST /api/spaces/attach-repo'](req({ space: 'A', repo: 'R1' }), res = {});
  assert.ok(res._data.ok);
  // attach same repo to B -> should leave A
  await r['POST /api/spaces/attach-repo'](req({ space: 'B', repo: 'R1' }), res = {});
  res = {}; r['GET /api/spaces']({}, res);
  assert.ok(!(res._data.A.repos || []).includes('R1'), 'removed from A');
  assert.ok((res._data.B.repos || []).includes('R1'), 'added to B');
  // delete B
  await r['DELETE /api/spaces'](req({ name: 'B' }), res = {});
  res = {}; r['GET /api/spaces']({}, res);
  assert.equal('B' in res._data, false, 'B deleted');
});

test('toggle-plugin ignores core space plugins', async () => {
  const r = harness();
  let res = {};
  await r['POST /api/spaces'](req({ name: 'A' }), res);
  res = {};
  await r['POST /api/spaces/toggle-plugin'](req({ space: 'A', plugin: 'browser-use' }), res);
  assert.ok(res._data.ok); // core plugin -> no-op ok
});
