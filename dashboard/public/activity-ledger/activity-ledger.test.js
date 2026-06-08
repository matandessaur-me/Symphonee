'use strict';
// Runs the built activity-ledger module in isolation (window===global) to prove
// self-containment, load-time state init, and a real patch operation.
//
// Run: node --test dashboard/public/activity-ledger/activity-ledger.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'activity-ledger.js');

function loadModule() {
  const ctx = {
    state: {}, // app.js declares the global `var state`; module reads it at load
    document: { getElementById: () => null },
    toast: () => {},
    switchTab: () => {},
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its 7 public functions on window', () => {
  const win = loadModule();
  for (const fn of ['openHistory', 'ledgerLoad', 'ledgerSetFilter', 'ledgerCheckpointNow',
    'ledgerUndo', 'ledgerOnAction', 'ledgerOnActionPatch']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds ledger collections + filter on the shared state object at load', () => {
  const win = loadModule();
  assert.deepEqual(win.state.ledgerEntries, []);
  assert.deepEqual(win.state.ledgerCheckpoints, []);
  assert.deepEqual(win.state.ledgerFilter, { category: '', outcome: '', q: '' });
});

test('ledgerOnActionPatch merges fields into the matching entry', () => {
  const win = loadModule();
  win.state.ledgerEntries = [{ id: 'a', n: 1 }, { id: 'b', n: 9 }];
  win.ledgerOnActionPatch('a', { n: 2, outcome: 'ok' });
  assert.deepEqual(win.state.ledgerEntries[0], { id: 'a', n: 2, outcome: 'ok' });
  assert.deepEqual(win.state.ledgerEntries[1], { id: 'b', n: 9 }); // untouched
});
