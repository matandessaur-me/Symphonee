'use strict';
// Executes the BUILT notes-search module in isolation (over the util module,
// window===global) to prove the extraction is self-contained and that the
// state + escapeHtml dependencies resolve.
//
// Run: node --test dashboard/public/notes-search/notes-search.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'notes-search.js');
const UTIL = path.resolve(__dirname, '..', 'js', 'util.js');

function loadModule(elements = {}) {
  const ctx = {
    state: {}, // app.js declares the global `var state`; provide it (module reads it at load)
    document: { getElementById: id => elements[id] || null },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  ctx.window = ctx; // window === global (browser semantics) so window.x exposes a bare global
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(UTIL, 'utf8'), ctx); // window.escapeHtml
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its 8 public handlers on window', () => {
  const win = loadModule();
  for (const fn of ['onNotesSearchInput', 'openNoteFind', 'closeNoteFind', 'updateNoteFindMatches',
    'noteFindStep', 'syncNoteHighlightScroll', 'updateNoteHighlightsLive', 'onNoteFindKeydown']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('initializes its find state on the shared state object at load', () => {
  const win = loadModule();
  assert.deepEqual(win.state._noteFindMatches, []);
  assert.equal(win.state._noteFindIndex, -1);
});

test('closeNoteFind resets find state, hides the bar, and repaints escaped text', () => {
  const bar = { style: { display: 'flex' } };
  const layer = { innerHTML: 'stale', scrollTop: 0, scrollLeft: 0 };
  const ta = { value: '<b>x</b>', scrollTop: 0, scrollLeft: 0 };
  const win = loadModule({ noteFindBar: bar, noteHighlightLayer: layer, noteTextarea: ta });
  win.state._noteFindMatches = [1, 2, 3];
  win.state._noteFindIndex = 2;

  win.closeNoteFind();

  assert.deepEqual(win.state._noteFindMatches, []);
  assert.equal(win.state._noteFindIndex, -1);
  assert.equal(bar.style.display, 'none');
  assert.equal(layer.innerHTML, '&lt;b&gt;x&lt;/b&gt;'); // escaped via the shared util
});
