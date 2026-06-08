'use strict';
// Executes the BUILT local-model-prompt module in isolation (Node vm + stubs)
// to prove the extraction is self-contained and its public API behaves.
//
// Run: node --test dashboard/public/local-model-prompt/local-model-prompt.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'local-model-prompt.js');

function loadModule({ fetchImpl } = {}) {
  const win = { addEventListener() {}, removeEventListener() {} };
  const ctx = {
    window: win,
    document: { getElementById: () => null, body: { appendChild() {} }, createElement: () => ({ style: {} }) },
    fetch: fetchImpl || (() => Promise.reject(new Error('no fetch'))),
    setTimeout: () => 0,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return { win };
}

test('loads in isolation and exposes symphEnsureLocalModel on window', () => {
  const { win } = loadModule();
  assert.equal(typeof win.symphEnsureLocalModel, 'function');
});

test('resolves true immediately when the reasoning model is already installed (no modal)', async () => {
  const { win } = loadModule({
    fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ reasoningModelInstalled: true }) }),
  });
  const ok = await win.symphEnsureLocalModel({ reason: 'test' });
  assert.equal(ok, true);
});
