'use strict';
// Executes the BUILT mcp module in isolation (Node vm + stubbed browser globals)
// to prove the extraction is self-contained and renders/loads servers correctly.
//
// Run: node --test dashboard/public/mcp/mcp.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'mcp.js');
const UTIL = path.resolve(__dirname, '..', 'js', 'util.js');

// mcp depends on window.escapeHtml (shared util) and toast; provide both, plus a
// stub #mcpServersList element and a controllable fetch.
function loadModule({ servers = [], fetchImpl } = {}) {
  const listEl = { innerHTML: '' };
  const ctx = {
    document: { getElementById: id => (id === 'mcpServersList' ? listEl : null) },
    fetch: fetchImpl || (() => Promise.resolve({ ok: true, json: () => Promise.resolve(servers) })),
    toast: () => {},
    console,
  };
  // In the browser, `window` IS the global object, so `window.escapeHtml = ...`
  // makes a bare `escapeHtml` reference resolve. Model that (window === global)
  // so the util -> mcp dependency chain is exercised faithfully.
  ctx.window = ctx;
  vm.createContext(ctx);
  // Load the shared util first so window.escapeHtml exists (real load order).
  vm.runInContext(fs.readFileSync(UTIL, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return { win: ctx, listEl };
}

test('loads in isolation and exposes its 5 onclick handlers on window', () => {
  const { win } = loadModule();
  for (const fn of ['refreshMcpServers', 'addMcpServer', 'toggleMcp', 'refreshMcp', 'removeMcp']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('refreshMcpServers renders the empty state when no servers', async () => {
  const { win, listEl } = loadModule({ servers: [] });
  await win.refreshMcpServers();
  assert.match(listEl.innerHTML, /No servers configured/);
});

test('refreshMcpServers renders a card (escaped) for each server', async () => {
  const { win, listEl } = loadModule({ servers: [{ name: '<x>', command: 'node', enabled: true, connected: true, tools: [] }] });
  await win.refreshMcpServers();
  assert.match(listEl.innerHTML, /Connected/);
  assert.match(listEl.innerHTML, /&lt;x&gt;/);          // name HTML-escaped via shared util
  assert.doesNotMatch(listEl.innerHTML, /<x>/);          // raw name never injected
});
