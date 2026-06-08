'use strict';
// Executes the BUILT permissions module in isolation (over util, window===global)
// to prove the extraction is self-contained: window exports, top-level state
// init, and the approval-resolution guard + request behavior.
//
// Run: node --test dashboard/public/permissions/permissions.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'permissions.js');
const UTIL = path.resolve(__dirname, '..', 'js', 'util.js');

function loadModule() {
  const calls = [];
  const ctx = {
    state: {}, // app.js declares the global `var state`; provide it (module reads it at load)
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {}, body: { appendChild() {} }, createElement: () => ({ style: {} }) },
    fetch: (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
    setInterval: () => 0,
    setTimeout: () => 0,
    console,
  };
  ctx.window = ctx; // window === global so window.x exposes a bare global
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(UTIL, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return { win: ctx, calls };
}

test('loads in isolation and exposes its 4 onclick handlers on window', () => {
  const { win } = loadModule();
  for (const fn of ['openPermModeMenu', 'setPermMode', 'resolveApproval', 'resolveGraphApproval']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds permission state on the shared state object at load', () => {
  const { win } = loadModule();
  assert.deepEqual(win.state.permModeCache, { mode: 'edit' });
  assert.equal(win.state._approvalShown, null);
});

test('resolveApproval is a no-op when nothing is awaiting approval', async () => {
  const { win, calls } = loadModule();
  win.state._approvalShown = null;
  await win.resolveApproval('allow', true);
  assert.equal(calls.length, 0, 'must not POST when no approval is shown');
});

test('resolveApproval posts the decision and clears the shown approval', async () => {
  const { win, calls } = loadModule();
  win.state._approvalShown = { kind: 'permission', data: { id: 'abc' } };
  await win.resolveApproval('deny', false);
  const post = calls.find(c => String(c.url).includes('/api/permissions/resolve'));
  assert.ok(post, 'expected a POST to /api/permissions/resolve');
  assert.deepEqual(JSON.parse(post.opts.body), { id: 'abc', decision: 'deny', promote: false });
  assert.equal(win.state._approvalShown, null);
});
