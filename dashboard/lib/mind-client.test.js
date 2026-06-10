'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');

const { createMindClient } = require('./mind-client');
const { tmpRepo, seed, node, store } = require('../mind/routes.testkit');
const { register } = require('../mind/routes-knowledge');

const SPACE = '_global';

// ── in-process transport ──────────────────────────────────────────────────

test('inproc recall returns hits from the seeded graph', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [
    node('m1', 'memory', { label: 'X is a constraint', body: 'X is a hard constraint we hit' }),
    node('m2', 'memory', { label: 'we chose Y', body: 'we decided to use Y instead' }),
  ]);
  const client = createMindClient({ transport: 'inproc', repoRoot, space: SPACE });
  const r = await client.recall({ question: 'constraint' });
  assert.ok(Array.isArray(r.hits));
  assert.ok(r.hits.length >= 1);
});

test('inproc recall on an empty/missing graph degrades to no hits (no throw)', async () => {
  const repoRoot = tmpRepo(); // nothing seeded
  const client = createMindClient({ transport: 'inproc', repoRoot, space: SPACE });
  const r = await client.recall({ question: 'anything' });
  assert.deepEqual(r.hits, []);
});

test('inproc query returns a sub-graph for a seeded concept', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('a', 'concept', { label: 'alpha widget' })]);
  const client = createMindClient({ transport: 'inproc', repoRoot, space: SPACE });
  const r = await client.query({ question: 'alpha' });
  assert.ok(Array.isArray(r.nodes));
});

test('inproc query on empty graph returns the empty marker', async () => {
  const client = createMindClient({ transport: 'inproc', repoRoot: tmpRepo(), space: SPACE });
  const r = await client.query({ question: 'x' });
  assert.equal(r.empty, true);
});

test('getSpace resolver is honored when no per-call space is given', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, 'other', [node('m1', 'memory', { label: 'scoped fact', body: 'lives in other space' })]);
  const client = createMindClient({ transport: 'inproc', repoRoot, getSpace: () => 'other' });
  const r = await client.recall({ question: 'scoped' });
  assert.ok(r.hits.length >= 1);
});

// ── http transport against the REAL route handlers ──────────────────────────
// Stands up an ephemeral server wrapping the actual /api/mind/recall + /query
// handlers (no auth gate - that lives in server.js, not the handlers) and
// proves the http transport round-trips correctly. This is what makes the
// route-based contract safe to flip on for the extracted deployment.

function realJson(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function realReadBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function mountRealServer(repoRoot) {
  const handlers = new Map();
  register((m, p, fn) => handlers.set(m + ' ' + p, fn), realJson, {
    repoRoot,
    getSpace: () => SPACE,
    getUiContext: () => ({ activeRepo: null, activeRepoPath: null }),
    readBody: realReadBody,
    tryDenseSeeds: async () => null,
    persistDerivedGraph: (space, g) => store.saveGraph(repoRoot, space, g),
    notifyKnowledgeEvent: () => {},
    broadcast: () => {},
  });
  const server = http.createServer((req, res) => {
    const key = req.method + ' ' + req.url.split('?')[0];
    const fn = handlers.get(key);
    if (!fn) { res.writeHead(404); res.end('{}'); return; }
    Promise.resolve(fn(req, res)).catch(() => { try { res.writeHead(500); res.end('{}'); } catch (_) {} });
  });
  return server;
}

test('http recall round-trips against the real /api/mind/recall handler', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('m1', 'memory', { label: 'a durable fact', body: 'a durable fact about X' })]);
  const server = mountRealServer(repoRoot);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const client = createMindClient({ transport: 'http', baseUrl: `http://127.0.0.1:${server.address().port}` });
    const r = await client.recall({ question: 'fact' });
    assert.ok(Array.isArray(r.hits), 'recall returned a hits array over http');
  } finally {
    server.close();
  }
});

test('http query round-trips against the real /api/mind/query handler', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [node('a', 'concept', { label: 'alpha widget' })]);
  const server = mountRealServer(repoRoot);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const client = createMindClient({ transport: 'http', baseUrl: `http://127.0.0.1:${server.address().port}` });
    const r = await client.query({ question: 'alpha' });
    assert.ok(Array.isArray(r.nodes), 'query returned a nodes array over http');
  } finally {
    server.close();
  }
});

test('http transport surfaces a connection failure as a rejected promise', async () => {
  // Nothing listening on this port -> the caller (brain/answer) catches and escalates.
  const client = createMindClient({ transport: 'http', baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
  await assert.rejects(() => client.recall({ question: 'x' }));
});
