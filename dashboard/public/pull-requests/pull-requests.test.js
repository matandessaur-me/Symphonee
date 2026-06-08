'use strict';
// Runs the built pull-requests module in isolation (window===global) to prove
// self-containment, load-time state init, and the repo-select population logic.
//
// Run: node --test dashboard/public/pull-requests/pull-requests.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'pull-requests.js');

function loadModule({ repos = {}, activeRepo = '' } = {}) {
  const sel = { innerHTML: '', value: '' };
  const ctx = {
    state: { configData: { Repos: repos }, activeRepo },
    document: { getElementById: id => (id === 'prsRepoSelect' ? sel : null) },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return { win: ctx, sel };
}

test('loads in isolation and exposes its 12 public functions on window', () => {
  const { win } = loadModule();
  for (const fn of ['populatePRsRepoSelect', 'loadPRs', 'viewPR', 'selectPRFile', 'openPRCommentModal',
    'closePRCommentModal', 'submitPRCommentModal', 'addPRComment', 'submitPRReview',
    'openRequestChangesModal', 'closeRequestChangesModal', 'submitRequestChanges']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds PR state on the shared state object at load', () => {
  const { win } = loadModule();
  assert.deepEqual(win.state.prsData, []);
  assert.equal(win.state.prsCurrentNumber, null);
  assert.equal(win.state.prsCurrentRepo, '');
});

test('populatePRsRepoSelect defaults to the active repo and lists all repos', () => {
  const { win, sel } = loadModule({ repos: { Alpha: {}, Beta: {} }, activeRepo: 'Beta' });
  win.populatePRsRepoSelect();
  assert.equal(win.state.prsCurrentRepo, 'Beta');     // defaulted to active repo
  assert.match(sel.innerHTML, /Alpha/);
  assert.match(sel.innerHTML, /Beta/);
  assert.match(sel.innerHTML, /selected/);             // active repo marked selected
});

test('populatePRsRepoSelect shows a placeholder when no repos are configured', () => {
  const { win, sel } = loadModule({ repos: {} });
  win.populatePRsRepoSelect();
  assert.match(sel.innerHTML, /No repos configured/);
});
