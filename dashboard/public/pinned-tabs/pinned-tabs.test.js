'use strict';
// Executes the BUILT pinned-tabs module in isolation (Node vm + stubbed browser
// globals) to prove the extraction is self-contained and its public API behaves.
// This is the test that catches a broken module boundary -- e.g. a missing
// window export, or an accidental dependency on an app.js global.
//
// Run: node --test dashboard/public/pinned-tabs/pinned-tabs.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'pinned-tabs.js');

// Load the built bundle into a fresh VM context with the only host globals it
// touches. If the module reached for anything else (toast/state/fetch/...), it
// would throw here -- which is the point.
function loadModule(seed = null) {
  const store = {};
  if (seed) store['symphonee-tab-order-v2'] = JSON.stringify(seed);
  const noop = () => {};
  const win = {};
  const ctx = {
    window: win,
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: noop },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    setTimeout: () => 0,
    MutationObserver: function () { return { observe: noop }; },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return { win, store };
}

test('loads in isolation and exposes its public API on window', () => {
  const { win } = loadModule();
  assert.equal(typeof win.getSavedTabOrderOverrides, 'function');
  assert.equal(typeof win._placeTabAtEnd, 'function');
});

test('getSavedTabOrderOverrides returns {} when nothing is saved', () => {
  const { win } = loadModule();
  assert.deepEqual(win.getSavedTabOrderOverrides(), {});
});

test('getSavedTabOrderOverrides returns the parsed saved overrides', () => {
  const { win } = loadModule({ 'plugin:foo': 10000, 'plugin:bar': 10001 });
  assert.deepEqual(win.getSavedTabOrderOverrides(), { 'plugin:foo': 10000, 'plugin:bar': 10001 });
});

test('one-shot migration drops core-tab overrides but keeps plugin reorders', () => {
  // _migrateAppsTabOrder runs at module load against this seed.
  const { win } = loadModule({ apps: 5, browser: 6, 'plugin:foo': 10000 });
  assert.deepEqual(win.getSavedTabOrderOverrides(), { 'plugin:foo': 10000 });
});
