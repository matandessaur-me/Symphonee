'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpRepo, collector, call, seed } = require('./routes.testkit');
const { register } = require('./routes-artifacts');

const SPACE = '_global';
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject);
  });
}
function mount(repoRoot, activeRepoPath) {
  const { handlers, addRoute, json } = collector();
  register(addRoute, json, {
    repoRoot,
    getSpace: () => SPACE,
    getUiContext: () => ({ activeRepo: 'r', activeRepoPath }),
    readBody,
    ctx: { getAllRepos: () => ({ r: activeRepoPath }) },
    tryDenseSeeds: async () => null,
  });
  return handlers;
}

test('artifacts/suggest detects a README in the scanned repo', async () => {
  const repoRoot = tmpRepo();
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi');
  const handlers = mount(repoRoot, repo);
  const r = await call(handlers, 'POST /api/mind/artifacts/suggest', { body: { scope: 'all' } });
  const group = r.data.groups.find(g => g.repoPath === repo);
  assert.ok(group, 'repo group present');
  assert.ok(group.suggestions.some(s => s.name === 'readme'), 'README detected');
});

test('artifacts/init writes a starter config; 400 with no artifacts', async () => {
  const repoRoot = tmpRepo();
  const repo = tmpRepo();
  const handlers = mount(repoRoot, repo);
  assert.equal((await call(handlers, 'POST /api/mind/artifacts/init', { body: {} })).status, 400);
  const ok = await call(handlers, 'POST /api/mind/artifacts/init', { body: { artifacts: [{ name: 'readme', path: './README.md' }] } });
  assert.equal(ok.data.ok, true);
  assert.ok(fs.existsSync(path.join(repo, '.symphonee', 'context-artifacts.json')));
});

test('artifacts/search 404 on empty graph, results on a seeded artifact', async () => {
  const repoRoot = tmpRepo();
  const handlers = mount(repoRoot, tmpRepo());
  assert.equal((await call(handlers, 'POST /api/mind/artifacts/search', { body: { q: 'x' } })).status, 404);

  seed(repoRoot, SPACE, [{ id: 'art1', label: 'schema', kind: 'artifact', source: { type: 'manual' }, sourceLocation: null, createdBy: 'test', createdAt: new Date(0).toISOString(), tags: [], description: 'db schema' }]);
  const r = await call(handlers, 'POST /api/mind/artifacts/search', { body: { q: 'schema' } });
  assert.ok(r.data.results.length >= 1);
});
