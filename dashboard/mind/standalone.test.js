'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMindServer } = require('./standalone');
const { createMindClient } = require('../lib/mind-client');
const { tmpRepo, seed, node } = require('./routes.testkit');

const SPACE = '_global';

test('createMindServer boots and mounts the mind route surface', async () => {
  const app = createMindServer({ repoRoot: tmpRepo(), space: SPACE });
  const routes = app.routeList();
  assert.ok(routes.length > 10, `expected many mind routes, got ${routes.length}`);
  assert.ok(routes.some(r => r.includes('/api/mind/query')), 'query route mounted');
  assert.ok(routes.some(r => r.includes('/api/mind/recall')), 'recall route mounted');
});

test('standalone Mind serves query + recall over HTTP via the mind-client', async () => {
  const repoRoot = tmpRepo();
  seed(repoRoot, SPACE, [
    node('m1', 'memory', { label: 'a durable fact', body: 'a durable fact about alpha widgets' }),
    node('c1', 'concept', { label: 'alpha widget spec' }),
  ]);
  const app = createMindServer({ repoRoot, space: SPACE });
  const addr = await app.listen(0);
  try {
    // Dogfood the Stage-1 seam: the brain's own client, http transport, against
    // the Stage-7 standalone server. Local in-process Mind and remote Mind are
    // the SAME contract.
    const client = createMindClient({ transport: 'http', baseUrl: `http://127.0.0.1:${addr.port}` });

    const recalled = await client.recall({ question: 'fact' });
    assert.ok(Array.isArray(recalled.hits), 'recall returned a hits array over http');

    const queried = await client.query({ question: 'alpha' });
    assert.ok(Array.isArray(queried.nodes), 'query returned a nodes array over http');
  } finally {
    await app.close();
  }
});

test('standalone Mind 404s an unknown route without crashing', async () => {
  const app = createMindServer({ repoRoot: tmpRepo(), space: SPACE });
  const addr = await app.listen(0);
  try {
    const client = createMindClient({ transport: 'http', baseUrl: `http://127.0.0.1:${addr.port}` });
    // query() posts to a real route; hit a bogus path directly instead.
    const http = require('http');
    const status = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${addr.port}/api/mind/does-not-exist`, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(status, 404);
  } finally {
    await app.close();
  }
});
