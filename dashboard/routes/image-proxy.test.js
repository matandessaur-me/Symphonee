'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { mountImageProxy } = require('./image-proxy');

function harness() {
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountImageProxy(addRoute, json, { getConfig: () => ({}), getPlugins: () => [], host: '127.0.0.1', port: 3800 });
  return routes;
}
const req = (b) => Readable.from([JSON.stringify(b)]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('image-proxy routes registered', () => {
  const r = harness();
  assert.ok(r['GET /api/image-proxy']);
  assert.ok(r['POST /api/open-external']);
});

test('open-external rejects missing url (no exec)', async () => {
  const r = harness();
  const res = {};
  r['POST /api/open-external'](req({}), res);
  await sleep(20);
  assert.equal(res._status, 400);
});

test('open-external rejects invalid url (no exec)', async () => {
  const r = harness();
  const res = {};
  r['POST /api/open-external'](req({ url: 'not a url' }), res);
  await sleep(20);
  assert.equal(res._status, 400);
});

test('image-proxy rejects missing url param', () => {
  const r = harness();
  let code;
  const res = { writeHead(c) { code = c; }, end() {} };
  r['GET /api/image-proxy']({}, res, new URL('http://x/api/image-proxy'));
  assert.equal(code, 400);
});
