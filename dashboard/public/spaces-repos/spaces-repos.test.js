'use strict';
// Runs the built spaces-repos module in isolation (window===global). It starts
// git-status polling + registers global listeners at load, so this proves it
// loads without throwing and exposes its surface -- including the core selectRepo
// and the CORE_SPACE_PLUGIN_IDS Set used by plugins.js.
//
// Run: node --test dashboard/public/spaces-repos/spaces-repos.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'spaces-repos.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, body: {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    setInterval: () => 0,
    setTimeout: () => 0,
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation (incl. listeners + polling) and exposes its functions', () => {
  const win = loadModule();
  for (const fn of ['isCoreSpacePluginId', 'openAddSpaceDialog', 'openEditSpaceDialog', 'deleteSpace',
    'renderSettingsSpaces', '_repoNamesForSpace', 'loadRepoList', 'selectRepo', 'selectSpace',
    '_msSwitchTab', '_saveManageSpace', 'applyPluginSpaceFilter']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('re-exposes CORE_SPACE_PLUGIN_IDS (the plugins.js contract) and isCoreSpacePluginId works', () => {
  const win = loadModule();
  assert.equal(typeof win.CORE_SPACE_PLUGIN_IDS.has, 'function');
  assert.equal(win.isCoreSpacePluginId('browser-use'), true);
  assert.equal(win.isCoreSpacePluginId('stagehand'), true);
  assert.equal(win.isCoreSpacePluginId('not-a-core-plugin'), false);
});
