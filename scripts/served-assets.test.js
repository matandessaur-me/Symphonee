'use strict';
// Guardrail: every local asset index.html loads MUST be served by server.js.
//
// The renderer is served from an explicit allow-list (server.js ROUTES), not
// generic static serving. So a <script>/<link> added to index.html that points
// at an unregistered path 404s in the real app while every unit test passes --
// this is exactly how the extracted ES-module bundles broke the permission-mode
// chip, notes search, tab drag, and the MCP panel until they were registered.
//
// This test closes that gap generically: it diffs index.html's local asset
// references against the ROUTES map, so ANY future "added a script, forgot the
// route" fails here instead of silently in the running app.
//
// Run: node --test scripts/served-assets.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'dashboard', 'public', 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.js'), 'utf8');

// Static routes the server actually serves (the file-backed ROUTES map entries).
const routeKeys = new Set(
  [...serverJs.matchAll(/'(\/[^']+)':\s*\{\s*file:/g)].map(m => m[1])
);

// Local assets index.html pulls in (skip http/https CDNs and inline scripts).
const assetRefs = [...new Set(
  [
    ...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g),
    ...indexHtml.matchAll(/<link[^>]+href="([^"]+)"/g),
  ]
    .map(m => m[1])
    .filter(src => src.startsWith('/'))   // local only
    .map(src => src.split('?')[0])         // ignore cache-busting query strings
)];

test('index.html references at least the core renderer bundles (sanity)', () => {
  // Guards against a broken regex silently matching nothing.
  assert.ok(assetRefs.includes('/js/app.js'), 'expected to find /js/app.js among index.html assets');
  assert.ok(routeKeys.size >= 10, `expected to parse the ROUTES map (got ${routeKeys.size} keys)`);
});

test('every local asset index.html loads is registered in server.js ROUTES', () => {
  const missing = assetRefs.filter(ref => !routeKeys.has(ref));
  assert.deepEqual(missing, [],
    'index.html loads local assets the server does not serve (they will 404 in the real app): ' + missing.join(', '));
});
