'use strict';
// Loads the BUILT apps bundle (former apps.js + apps-step-builder.js) in a
// permissive sandbox to prove it loads without throwing and exposes its surface.
//
// Run: node --test dashboard/public/apps/apps.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'apps.js');

function loadModule() {
  const stub = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub, construct: () => stub, has: () => true, set: () => true,
  });
  const real = {
    state: {}, console, Math, JSON, Object, Array, String, Number, Boolean, Date, RegExp,
    Map, Set, WeakMap, Promise, Symbol, Proxy, Reflect, parseInt, parseFloat, isNaN, isFinite,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    encodeURIComponent: s => s, decodeURIComponent: s => s,
    esc: s => String(s == null ? '' : s), toast: () => {},
  };
  const sandbox = new Proxy(real, {
    has: () => true,
    get: (_t, key) => (typeof key === 'string' && key in real ? real[key] : stub),
    set: (_t, key, val) => { real[key] = val; return true; },
  });
  real.window = sandbox; real.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), sandbox);
  return real;
}

test('the bundled apps subsystem loads in isolation and exposes its surface', () => {
  const win = loadModule();
  for (const fn of ['appsOpenLauncher', 'appsOpenAutomations', 'appsRefreshAll', 'appsRefreshWindows',
    'appsChatSend', 'appsAutomationsNew', 'appsAutomationsSave', 'appsAutomationsRunNow',
    'appsAutomationsGenerate', 'appsPanic', 'handleAppsAgentStep', 'appsSubmitAdd',
    '_appsBuilderDragStart', '_appsComSubmit']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});
