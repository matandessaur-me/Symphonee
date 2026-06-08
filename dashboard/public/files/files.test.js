'use strict';
// Runs the built files module in isolation (window===global) to prove self-
// containment, load-time state init, and that the SHARED renderInlineDiff (used
// by the pull-requests module) renders a unified diff.
//
// Run: node --test dashboard/public/files/files.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'files.js');

function loadModule() {
  const ctx = {
    state: {},
    document: { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, appendChild() {} }) },
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    toast: () => {},
    hljs: { highlightAuto: s => ({ value: s }), highlight: (a, b) => ({ value: b || a }), getLanguage: () => true },
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its key public functions on window', () => {
  const win = loadModule();
  for (const fn of ['populateFilesRepoSelect', 'loadFileTree', 'viewFile', 'toggleFilesEdit', 'loadMonaco',
    'viewCommitDiff', 'selectDiffFile', 'renderInlineDiff', 'closeDiffView', 'viewChangedFile',
    'saveFilesEdit', 'loadGitLogPanel', 'closeModal', 'openSpaceModal', 'openRepoModal',
    'doGitCheckoutFromModal']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds Files-tab state on the shared state object at load', () => {
  const win = loadModule();
  assert.equal(win.state.filesCurrentRepo, '');
  assert.equal(win.state.filesMode, 'view');
  assert.equal(win.state.monacoEditor, null);
});

test('the shared renderInlineDiff renders a unified diff into the container', () => {
  const win = loadModule();
  const container = { innerHTML: '' };
  const diff = [
    'diff --git a/x.txt b/x.txt',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,2 +1,2 @@',
    ' context',
    '-removedline',
    '+addedline',
  ].join('\n');
  win.renderInlineDiff(container, diff);
  assert.ok(container.innerHTML.length > 0, 'renderInlineDiff produced no output');
  assert.match(container.innerHTML, /addedline/);
  assert.match(container.innerHTML, /removedline/);
});
