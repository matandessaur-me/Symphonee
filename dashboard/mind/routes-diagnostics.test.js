'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpRepo, collector, call, node, seed } = require('./routes.testkit');
const { register } = require('./routes-diagnostics');

const SPACE = '_global';
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
  });
}
function mount(repoRoot) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, {
    repoRoot, getSpace: () => SPACE, readBody,
    getUiContext: () => ({ activeRepo: 'r', activeRepoPath: repoRoot }),
    ctx: { getAllRepos: () => ({}) },
  });
  return handlers;
}

test('POST /api/mind/suggest-cli 400 without a question', async () => {
  const r = await call(mount(tmpRepo()), 'POST /api/mind/suggest-cli', { body: {} });
  assert.equal(r.status, 400);
});

test('POST /api/mind/visualize returns mermaid text for a seeded graph', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('a', 'concept'), node('b', 'concept')]);
  const r = await call(mount(repoRoot), 'POST /api/mind/visualize', { body: { mode: 'mermaid' } });
  assert.equal(r.data.mode, 'mermaid');
  assert.equal(typeof r.data.mermaid, 'string');
});

test('GET /api/mind/cli-coverage returns a per-CLI counts structure', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('climem_claude', 'memory', { id: 'climem_claude' })]);
  const r = await call(mount(repoRoot), 'GET /api/mind/cli-coverage');
  assert.ok(Array.isArray(r.data.cliKnown));
  assert.ok(r.data.counts.claude);
});
