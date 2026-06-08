'use strict';
// Runs the built plugin-registry module in isolation (window===global) to prove
// self-containment, load-time state init, and the search/sort logic.
//
// Run: node --test dashboard/public/plugin-registry/plugin-registry.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'plugin-registry.js');

function loadModule() {
  const ctx = {
    state: {}, // app.js declares the global `var state`; module reads it at load
    document: { getElementById: () => null, querySelectorAll: () => [] },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its 10 public functions on window', () => {
  const win = loadModule();
  for (const fn of ['browsePlugins', 'filterRegistry', 'installFromRegistry', 'updatePlugin',
    'uninstallPlugin', 'installPluginPrompt', 'closeRegistryModal', 'savePluginSettings',
    'loadPluginRecommendations', 'sortPluginsWithRecommendations']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds registry collections on the shared state object at load', () => {
  const win = loadModule();
  assert.deepEqual(win.state._registryPlugins, []);
  assert.deepEqual(win.state._pluginRecommendations, {});
});

test('sortPluginsWithRecommendations ranks recommended-but-not-installed first', () => {
  const win = loadModule();
  const plugins = [
    { id: 'a', name: 'A', installed: false },
    { id: 'b', name: 'B', installed: false },
    { id: 'c', name: 'C', installed: true },
  ];
  const recs = { b: { score: 10 }, c: { score: 99 } }; // c is installed -> its score ignored
  const sorted = win.sortPluginsWithRecommendations(plugins, recs).map(p => p.id);
  assert.equal(sorted[0], 'b');               // highest score among not-installed
  assert.deepEqual(sorted.slice(1).sort(), ['a', 'c']); // remainder alphabetical
});
