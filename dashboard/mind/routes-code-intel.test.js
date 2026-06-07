'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call, node, edge, seed } = require('./routes.testkit');
const { register } = require('./routes-code-intel');

const SPACE = '_global';
function mount(repoRoot) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, { repoRoot, getSpace: () => SPACE, readBody });
  return handlers;
}
// readBody is provided by the controller in prod; supply an equivalent here.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
  });
}

test('POST /api/mind/files lists code files with import/dependent counts', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE,
    [node('f1', 'code', { source: { type: 'file', ref: 'a.js' } }),
     node('f2', 'code', { source: { type: 'file', ref: 'b.js' } })],
    [edge('f1', 'f2', 'imports')]);
  const handlers = mount(repoRoot);
  const r = await call(handlers, 'POST /api/mind/files', { body: {} });
  assert.equal(r.data.total, 2);
  const b = r.data.files.find(f => f.path === 'b.js');
  assert.equal(b.dependentsCount, 1);
});

test('POST /api/mind/entrypoints and /circular return arrays on a seeded graph', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('f1', 'code', { source: { type: 'file', ref: 'a.js' } })]);
  const handlers = mount(repoRoot);
  const ep = await call(handlers, 'POST /api/mind/entrypoints', { body: {} });
  assert.ok(Array.isArray(ep.data.entrypoints));
  const circ = await call(handlers, 'POST /api/mind/circular', { body: {} });
  assert.ok(Array.isArray(circ.data.cycles));
});

test('POST /api/mind/impact 400 without a target', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('f1', 'code')]);
  const handlers = mount(repoRoot);
  const r = await call(handlers, 'POST /api/mind/impact', { body: {} });
  assert.equal(r.status, 400);
});
