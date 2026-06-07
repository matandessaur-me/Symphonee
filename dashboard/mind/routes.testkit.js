'use strict';
// Shared helpers for the routes-*.test.js suites: mock req/res, a handler
// collector, and a graph seeder built on the real store so tests exercise the
// extracted handlers exactly as the server invokes them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

function tmpRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sym-mindroutes-')); }

function collector() {
  const handlers = new Map();
  const addRoute = (m, p, fn) => handlers.set(m + ' ' + p, fn);
  const json = (res, data, status) => { res._json = { data, status: status || 200 }; };
  return { handlers, addRoute, json };
}

function mockReq(method, url, body) {
  const req = { method, url, headers: {} };
  req.on = (ev, cb) => {
    if (ev === 'data' && body != null) cb(Buffer.from(JSON.stringify(body)));
    if (ev === 'end') cb();
    return req;
  };
  return req;
}
function mockRes() {
  return { writeHead() { return this; }, setHeader() {}, end() {}, _json: null };
}

async function call(handlers, key, { url, body } = {}) {
  const fn = handlers.get(key);
  if (!fn) throw new Error('handler not registered: ' + key);
  const [method, p] = key.split(' ');
  const res = mockRes();
  await fn(mockReq(method, (url || p), body), res);
  return res._json;
}

function node(id, kind, extra = {}) {
  return {
    id, label: extra.label || id, kind,
    source: extra.source || { type: 'manual', ref: null },
    sourceLocation: extra.sourceLocation || null,
    createdBy: 'test', createdAt: new Date(0).toISOString(),
    tags: extra.tags || [],
    ...extra,
  };
}
function edge(source, target, relation) {
  return { source, target, relation, confidence: 'EXTRACTED', confidenceScore: 1, weight: 1, createdBy: 'test', createdAt: new Date(0).toISOString() };
}

function seed(repoRoot, space, nodes = [], edges = []) {
  const g = store.emptyGraph({ space });
  g.nodes.push(...nodes);
  g.edges.push(...edges);
  store.saveGraph(repoRoot, space, g);
  return g;
}

module.exports = { tmpRepo, collector, mockReq, mockRes, call, node, edge, seed, store };
