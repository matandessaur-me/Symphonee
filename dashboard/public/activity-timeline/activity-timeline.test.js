'use strict';
// Runs the built activity-timeline module in isolation (window===global) to
// prove self-containment and load-time state init.
//
// Run: node --test dashboard/public/activity-timeline/activity-timeline.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'activity-timeline.js');

function loadModule() {
  const ctx = {
    state: {}, // app.js declares the global `var state`; module reads it at load
    document: { getElementById: () => null, querySelectorAll: () => [] },
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation and exposes its 4 public functions on window', () => {
  const win = loadModule();
  for (const fn of ['openActivityTimeline', 'closeActivityTimeline', 'setTimelineRange', 'renderTimeline']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('seeds the default timeline range on the shared state object at load', () => {
  const win = loadModule();
  assert.equal(win.state._tlRangeDays, 5);
});
