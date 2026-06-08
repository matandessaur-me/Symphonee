'use strict';
// Runs the built orchestrator module in isolation (window===global) to prove
// self-containment + load-time state init.
//
// Run: node --test dashboard/public/orchestrator/orchestrator.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'orchestrator.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    CLI_CONFIG: new Proxy({}, { get: () => ({ label: 'AI' }) }), // owned by terminals.js on window
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    setTimeout: () => 0, setInterval: () => 0,
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its public surface on window', () => {
  const win = loadModule();
  for (const fn of ['orchRefresh', 'orchRefreshAgents', 'orchRefreshTasks', 'orchToggleTask', 'orchSelectAgent',
    'orchCancelTask', 'orchDeleteTask', 'orchShareTask', 'orchCleanup', 'orchShowDispatchDialog',
    'orchDoDispatch', 'handleOrchestratorEvent', 'formatOrchDuration']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds orchestrator state on the shared state object at load', () => {
  const win = loadModule();
  assert.deepEqual(win.state.orchTasks, []);
  assert.deepEqual(win.state.orchAgents, []);
});

test('formatOrchDuration produces a human duration', () => {
  const win = loadModule();
  assert.equal(typeof win.formatOrchDuration(1000), 'string');
});
