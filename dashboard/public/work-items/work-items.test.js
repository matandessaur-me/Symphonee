'use strict';
// Runs the built work-items module in isolation (window===global). It registers
// global listeners + reads state at load, so this proves it loads without
// throwing and exposes its surface -- including the app-wide config plumbing
// (loadConfig/pushUiContext/currentNotesNs/notesFetch) and the kanban drag
// handlers.
//
// Run: node --test dashboard/public/work-items/work-items.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'work-items.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    CLI_CONFIG: new Proxy({}, { get: () => ({ label: 'AI' }) }), // owned by terminals.js on window
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    setTimeout: () => 0,
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation (incl. listeners) and exposes its public surface', () => {
  const win = loadModule();
  for (const fn of ['loadConfig', 'loadIterations', 'pushUiContext', 'currentNotesNs', 'notesFetch',
    'loadWorkItems', 'renderBoard', 'renderBacklog', 'viewWorkItem', 'onCardDragStart', 'onCardDragEnd',
    'highlightFamily', 'applyBacklogFilters', 'addWIComment', 'loadVelocity', 'loadTeams', 'loadAreas']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds config state on the shared state object at load', () => {
  const win = loadModule();
  assert.equal(win.state._configLoaded, false);
});
