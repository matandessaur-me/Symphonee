'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { mountCliInstall } = require('./cli-install');
const { detectCli, detectPwsh } = require('../lib/detect-cli');

function harness() {
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountCliInstall(addRoute, json, { configPath: 'definitely-missing-config.json' });
  return routes;
}

test('cli-install routes registered', () => {
  const r = harness();
  assert.ok(r['GET /api/prerequisites']);
  assert.ok(r['POST /api/cli/install']);
});

test('detectCli returns a shape for an unknown tool', () => {
  const r = detectCli('definitely-not-a-cli-xyz');
  assert.equal(typeof r.installed, 'boolean');
  assert.equal(r.installed, false);
  assert.equal(typeof r.path, 'string');
});

test('detectPwsh returns a shape', () => {
  const r = detectPwsh();
  assert.equal(typeof r.installed, 'boolean');
});

test('prerequisites returns the expected envelope', () => {
  const r = harness();
  const res = {};
  r['GET /api/prerequisites']({}, res);
  assert.ok(res._data.cliTools && typeof res._data.cliTools === 'object');
  assert.ok(res._data.nodeJs.installed);
  assert.equal(res._data.config.exists, false); // missing config path
  assert.equal(typeof res._data.ready, 'boolean');
});

test('cli/install unknown cli -> 400 (no exec)', async () => {
  const r = harness();
  const res = {};
  r['POST /api/cli/install'](Readable.from([JSON.stringify({ cli: '__nope__' })]), res);
  await new Promise(rs => setTimeout(rs, 40)); // let req 'end' fire
  assert.equal(res._status, 400);
});
