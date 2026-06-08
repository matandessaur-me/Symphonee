'use strict';
// Runs the built settings module in isolation (window===global) to prove self-
// containment + load-time state init, and the shared _aiInstalling Set contract.
//
// Run: node --test dashboard/public/settings/settings.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'settings.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    setTimeout: () => 0,
    addEventListener: () => {}, // window.addEventListener
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its public surface on window', () => {
  const win = loadModule();
  for (const fn of ['openSettings', 'closeSettings', 'switchSettingsTab', 'saveSettings', 'openCreateModal',
    'submitCreateWorkItem', 'addProjectFromSettings', 'deleteRepoFromSettings', 'repoAddBrowse',
    'openFactoryResetModal', 'factoryResetConfirm', 'exportSettings', 'importSettings']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('re-exposes the shared _aiInstalling Set (the onboarding.js contract)', () => {
  const win = loadModule();
  const s = win._aiInstalling;
  assert.equal(typeof s.add, 'function');
  assert.equal(typeof s.has, 'function');
  s.add('claude');
  assert.ok(s.has('claude'));
  s.delete('claude');
  assert.ok(!s.has('claude'));
});
