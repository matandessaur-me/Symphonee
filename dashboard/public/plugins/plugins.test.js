'use strict';
// Runs the built plugins module in isolation (window===global) to prove self-
// containment + load-time state init. (Source public/plugins/ -- distinct from
// the dashboard/plugins/ install dir.)
//
// Run: node --test dashboard/public/plugins/plugins.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'plugins.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    setTimeout: () => 0,
    addEventListener: () => {}, // window.addEventListener (iframe message bridge)
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation (incl. the scroll-arrow IIFE + listeners) and exposes its shell API', () => {
  const win = loadModule();
  for (const fn of ['registerPluginTab', 'applyPluginPinnedTabs', 'injectPinnedCenterTab', 'openPluginTab',
    'ensurePluginTabOpen', 'reconcilePluginShellSurfaces', 'refreshPluginActivation', 'injectSidebarAction',
    'injectAiAction', 'injectIntelPanel', '_syncPluginToggleVisual', '_populatePluginSettingOptions',
    'switchPluginSettingsTab', 'toggleSecretField', 'notifyPluginIframes']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds plugin state on the shared state object at load', () => {
  const win = loadModule();
  assert.deepEqual(win.state._loadedPlugins, []);
  assert.deepEqual(win.state.closedIntelPanels, []);
});
