'use strict';
// Runs the built command-palette module in isolation (window===global) to prove
// self-containment + load-time state init. Consumes HOTKEY_ACTIONS/CLI_CONFIG
// (provided on window by keyboard.js/terminals.js in the real app).
//
// Run: node --test dashboard/public/command-palette/command-palette.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'command-palette.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    HOTKEY_ACTIONS: [], // owned by keyboard.js on window
    CLI_CONFIG: new Proxy({}, { get: () => ({ label: 'AI' }) }),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
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

test('loads in isolation and exposes its public surface on window', () => {
  const win = loadModule();
  for (const fn of ['openCmdPalette', 'openAIFocusPalette', 'openShortcutHelp', 'askAIFromPalette',
    'closeCmdPalette', 'filterCmdPalette', 'openRepoMapModal', 'setRepoMapView', 'copyRepoMap',
    'saveRepoMapAsNote', 'analyzeActiveRepo', 'cmdPaletteKeydown', 'loadPluginCmdItems']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds command-palette state on the shared state object at load', () => {
  const win = loadModule();
  assert.equal(win.state._cmdSelectedIdx, 0);
  assert.deepEqual(win.state._cmdFiltered, []);
});
