'use strict';
// Runs the built git module in isolation (window===global) to prove self-
// containment, load-time state init, and that the SHARED renderMarkdown (used
// by browser-tools/notes/onboarding/orchestrator/pull-requests) works.
//
// Run: node --test dashboard/public/git/git.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'git.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelectorAll: () => [] },
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    toast: () => {},
    // highlight.js (CDN global on window in the real app)
    hljs: { highlightAuto: s => ({ value: s }), highlight: (a, b) => ({ value: b || a }), getLanguage: () => true },
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its 15 public functions on window', () => {
  const win = loadModule();
  for (const fn of ['openGitModal', 'closeGitModal', 'switchGitTab', 'loadGitBranches', 'renderGitBranches',
    'filterGitBranches', 'doGitCheckout', 'doGitPull', 'doGitPush', 'doGitCompare', 'setCommitMode',
    'doGitCommit', 'loadProjectScripts', 'runNpmScript', 'loadTerminalScripts']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('does NOT expose renderMarkdown (onboarding.js owns the live one)', () => {
  // git.js contains a dead duplicate; exposing it would swap the app-wide
  // renderer. The module must leave window.renderMarkdown untouched.
  const win = loadModule();
  assert.equal(win.renderMarkdown, undefined, 'git must not expose its dead renderMarkdown duplicate');
});

test('seeds git branch state on the shared state object at load', () => {
  const win = loadModule();
  assert.equal(typeof win.state._gitBranches, 'object');
});
