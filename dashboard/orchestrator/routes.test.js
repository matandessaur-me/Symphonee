'use strict';
const test = require('node:test');
const assert = require('node:assert');
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
