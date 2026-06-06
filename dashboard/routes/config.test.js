'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { mountConfig } = require('./config');
const { createConfigStore } = require('../lib/config-store');

function scaffold() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-cfgroute-'));
  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'plugins'), { recursive: true });
  const configPath = path.join(repoRoot, 'config', 'config.json');
  const templatePath = path.join(repoRoot, 'config', 'config.template.json');
  const pluginsDir = path.join(repoRoot, 'plugins');
  fs.writeFileSync(templatePath, JSON.stringify({ A: 1 }));
  fs.writeFileSync(configPath, JSON.stringify({ B: 2 }));
  return { repoRoot, configPath, templatePath, pluginsDir };
}
function harness() {
  const p = scaffold();
  const store = createConfigStore({ templatePath: p.templatePath, configPath: p.configPath, pluginsDir: p.pluginsDir });
  const routes = {};
  const addRoute = (m, pa, h) => { routes[`${m} ${pa}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  const noopCache = { clear() {} };
  mountConfig(addRoute, json, {
    getConfig: store.getConfig, normalizeRootConfig: store.normalizeRootConfig,
    configPath: p.configPath, templatePath: p.templatePath, repoRoot: p.repoRoot, pluginsDir: p.pluginsDir,
    swrGit: noopCache, swrPlugins: noopCache, broadcast: () => {}, writePluginHints: () => {}, getPlugins: () => [],
  });
  return { routes, p };
}
const req = (body) => Readable.from([JSON.stringify(body)]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('config routes registered', () => {
  const { routes } = harness();
  for (const k of ['GET /api/themes', 'POST /api/themes', 'GET /api/config', 'POST /api/config',
    'GET /api/config/export', 'POST /api/config/import', 'POST /api/config/reset']) {
    assert.ok(routes[k], `missing ${k}`);
  }
});

test('GET /api/config returns merged config', () => {
  const { routes } = harness();
  const res = {};
  routes['GET /api/config']({}, res); // wrapper is (req,res)=>handleGetConfig(res)
  assert.equal(res._data.A, 1, 'template key');
  assert.equal(res._data.B, 2, 'root key');
});

test('save + get config round-trip', async () => {
  const { routes, p } = harness();
  let res = {};
  await routes['POST /api/config'](req({ C: 3 }), res);
  assert.ok(res._data.ok, 'saved');
  const saved = JSON.parse(fs.readFileSync(p.configPath, 'utf8'));
  assert.equal(saved.C, 3, 'new key persisted');
  assert.equal(saved.B, 2, 'existing key kept');
});

test('themes default + save', async () => {
  const { routes, p } = harness();
  let res = {};
  routes['GET /api/themes']({}, res);
  assert.deepEqual(res._data, { themes: [], active: null });
  res = {};
  await routes['POST /api/themes'](req({ themes: [{ name: 'X' }], active: 'X' }), res);
  assert.ok(res._data.ok);
  const t = JSON.parse(fs.readFileSync(path.join(p.repoRoot, 'config', 'themes.json'), 'utf8'));
  assert.equal(t.active, 'X');
});

test('export returns a settings payload (no Repos)', () => {
  const { routes } = harness();
  let body = '';
  const res = { writeHead() {}, end(s) { body = s; } };
  routes['GET /api/config/export']({}, res);
  const parsed = JSON.parse(body);
  assert.equal(parsed._exportedFrom, 'Symphonee');
  assert.equal('Repos' in parsed, false);
});

test('factory reset requires confirm, then wipes config', async () => {
  const { routes, p } = harness();
  let res = {};
  await routes['POST /api/config/reset'](req({}), res);
  assert.equal(res._status, 400, 'no confirm -> 400');
  assert.ok(fs.existsSync(p.configPath), 'config still there');
  res = {};
  await routes['POST /api/config/reset'](req({ confirm: true }), res);
  assert.ok(res._data.ok, 'reset ok');
  assert.equal(fs.existsSync(p.configPath), false, 'config wiped');
});
