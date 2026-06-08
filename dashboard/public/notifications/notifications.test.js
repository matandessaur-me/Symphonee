'use strict';
// Runs the built notifications module in isolation (window===global). It does
// real load-time work (registers global listeners, loads saved notifications),
// so this proves it loads without throwing and exposes its surface -- including
// `notify` (used by 6 parts) and the shared `_paletteNotifyTasks` Set.
//
// Run: node --test dashboard/public/notifications/notifications.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'notifications.js');

function loadModule() {
  const store = {};
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    setTimeout: () => 0,
    CLI_CONFIG: new Proxy({}, { get: () => ({ label: 'AI' }) }), // owned by terminals.js on window
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation (incl. its load-time setup) and exposes its 13 functions', () => {
  const win = loadModule();
  for (const fn of ['notify', 'openActivityStats', '_notifToggleSound', 'playNotifSound',
    '_showPaletteDispatchToast', '_schedulePaletteDispatchToast', '_clearPaletteDispatchToast',
    'notifClearAll', '_focusInlineReply', '_inlineReplySend', 'renderReplyChip', 'toggleNotifPanel',
    '_cancelFollowup']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('re-exposes the shared _paletteNotifyTasks Set (the command-palette/orchestrator contract)', () => {
  const win = loadModule();
  // Duck-type (the module's Set is from the vm realm, so cross-realm instanceof
  // would be false). The cross-part contract is add/has/delete -- exercise it.
  const s = win._paletteNotifyTasks;
  assert.equal(typeof s.add, 'function');
  assert.equal(typeof s.has, 'function');
  assert.equal(typeof s.delete, 'function');
  win._paletteNotifyTasks.add('task-1');
  assert.ok(win._paletteNotifyTasks.has('task-1'));
  win._paletteNotifyTasks.delete('task-1');
  assert.ok(!win._paletteNotifyTasks.has('task-1'));
});

test('seeds the notifications list on the shared state object at load', () => {
  const win = loadModule();
  assert.ok(Array.isArray(win.state._notifs));
});
