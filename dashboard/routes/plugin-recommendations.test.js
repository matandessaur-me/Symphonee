'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { mountPluginRecommendations } = require('./plugin-recommendations');

function harness(cfg) {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-precs-'));
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountPluginRecommendations(addRoute, json, {
    getConfig: () => cfg || { Repos: {} }, getUiContext: () => ({}), pluginsDir, getPlugins: () => [],
  });
  return routes;
}

test('recommendations route registered', () => {
  assert.ok(harness()['GET /api/plugins/recommendations']);
});

test('no repos -> empty recommendations', () => {
  const r = harness({ Repos: {} });
  const res = {};
  r['GET /api/plugins/recommendations']({}, res);
  assert.ok(Array.isArray(res._data.recommendations));
  assert.equal(res._data.recommendations.length, 0);
  assert.equal(res._data.scannedRepos, 0);
});

test('nonexistent repo paths are skipped (no crash)', () => {
  const r = harness({ Repos: { Ghost: 'C:/does/not/exist/xyz' } });
  const res = {};
  r['GET /api/plugins/recommendations']({}, res);
  assert.equal(res._data.scannedRepos, 1);
  assert.equal(res._data.recommendations.length, 0);
});
