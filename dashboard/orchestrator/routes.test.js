'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerOrchestratorRoutes } = require('./routes');

test('registerOrchestratorRoutes wires the orchestrator API surface', () => {
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  // stub orch + deps: registration must not call handlers, just store them
  registerOrchestratorRoutes(addRoute, () => {}, {}, { getConfig: () => ({}), broadcast: () => {}, getUiContext: () => ({}) });
  const keys = Object.keys(routes);
  assert.ok(keys.length >= 10, `expected many routes, got ${keys.length}`);
  for (const k of ['GET /api/orchestrator/status', 'POST /api/orchestrator/spawn', 'GET /api/orchestrator/task']) {
    assert.ok(routes[k], `missing ${k}`);
  }
});

// Regression: gateSpawn must be DEFINED and reachable. It previously lived in
// orchestrator.js and was left behind when the routes were extracted, so every
// gated spawn route threw ReferenceError at call time (and hung the request) -
// a failure a load-check / registration-only test can't catch. Here we actually
// INVOKE the spawn handler with a deny config: it must reach the gate and return
// 403 (proof gateSpawn ran) instead of throwing.
test('POST /api/orchestrator/spawn reaches the permission gate (gateSpawn defined)', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-orch-gate-'));
  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  // Deny cli:*:spawn so the gate resolves immediately (no real CLI is spawned).
  fs.writeFileSync(
    path.join(repoRoot, 'config', 'config.json'),
    JSON.stringify({ Permissions: { mode: 'review', deny: ['cli:*:spawn'], ask: [], allow: [] } })
  );

  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  registerOrchestratorRoutes(addRoute, () => {}, { brain: null }, {
    getConfig: () => ({}), broadcast: () => {}, getUiContext: () => ({}), repoRoot,
  });

  const handler = routes['POST /api/orchestrator/spawn'];
  const req = { on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify({ cli: 'claude', prompt: 'x' }))); if (ev === 'end') cb(); if (ev === 'error') {} return req; } };
  let status = null;
  const res = { writeHead(code) { status = code; return this; }, end() {} };

  await handler(req, res); // must NOT throw ReferenceError: gateSpawn is not defined
  assert.equal(status, 403, 'deny config should make the gate respond 403, proving gateSpawn ran');
});
