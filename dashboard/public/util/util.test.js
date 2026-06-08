'use strict';
// Executes the BUILT shared util module in isolation and asserts escapeHtml's
// behavior (the helper 6 flat parts depend on via window).
//
// Run: node --test dashboard/public/util/util.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'util.js');

function loadModule() {
  const win = {};
  const ctx = { window: win, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return win;
}

test('loads in isolation and exposes escapeHtml on window', () => {
  const win = loadModule();
  assert.equal(typeof win.escapeHtml, 'function');
});

test('escapeHtml escapes all five HTML-significant characters', () => {
  const { escapeHtml } = loadModule();
  assert.equal(escapeHtml(`<a href="x" class='y'>&</a>`),
    '&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('escapeHtml coerces null/undefined to an empty string', () => {
  const { escapeHtml } = loadModule();
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});
