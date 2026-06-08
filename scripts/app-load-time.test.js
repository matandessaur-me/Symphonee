'use strict';
// Guard against the load-order class that broke startup twice: app.js parts
// load BEFORE the extracted ES-module bundles, so any code that runs at app.js
// load time (top-level statements / IIFEs) must NOT call a function that only
// exists once a module has loaded (loadConfig, refreshPluginActivation, ...).
// The startup boot IIFE did exactly that -> "loadConfig is not defined" ->
// empty config (no repos in the PR tab, empty backlog).
//
// This test loads the BUILT app.js in a sandbox where every module-exposed
// function throws if *called* during load. A deferred call (inside a function,
// a DOMContentLoaded handler, a setTimeout) never fires here, so it's fine; an
// at-load call throws and fails this test with the offending function name.
//
// Run: node --test scripts/app-load-time.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'dashboard', 'public');

// Every function a module bundle attaches to window (available only AFTER app.js).
function moduleExposedFns() {
  const fns = new Set();
  for (const d of fs.readdirSync(PUB)) {
    const f = path.join(PUB, d, 'src', 'index.js');
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/window\.([a-zA-Z_$][\w$]*)\s*=/g)) fns.add(m[1]);
  }
  return fns;
}

test('no app.js code calls a post-app.js-module function at load time', () => {
  const modFns = moduleExposedFns();
  // A permissive stub: callable, constructible, indexable, returns itself for
  // anything -- so legit browser API chains at load (document.x().y = z) never throw.
  const makeStub = () => new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub, construct: () => stub, has: () => true, set: () => true,
  });
  const stub = makeStub();
  const state = {};
  const offenders = [];
  // The sandbox global: real state, a self-referential window, and a catch-all
  // that hands out the permissive stub for any unknown identifier -- EXCEPT the
  // module functions, which throw when CALLED.
  const real = { state, console, Math, JSON, Object, Array, String, Number, Boolean, Date, RegExp,
    Map, Set, WeakMap, WeakSet, Promise, Symbol, Proxy, Reflect, parseInt, parseFloat, isNaN, isFinite,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    encodeURIComponent: s => s, decodeURIComponent: s => s, structuredClone: x => x };
  const handler = {
    has: () => true,
    get(_t, key) {
      if (typeof key !== 'string') return undefined;
      if (key in real) return real[key];
      if (modFns.has(key)) {
        // referenced -> return a fn that records + throws if actually CALLED at load
        return new Proxy(function () {}, { apply() { offenders.push(key); throw new Error('called-at-load:' + key); } });
      }
      return stub;
    },
    set(_t, key, val) { real[key] = val; return true; },
  };
  const sandbox = new Proxy(real, handler);
  real.window = sandbox;
  real.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const app = fs.readFileSync(path.join(PUB, 'js', 'app.js'), 'utf8');
  try {
    vm.runInContext(app, ctx);
  } catch (e) {
    if (String(e.message).startsWith('called-at-load:')) {
      assert.fail('app.js calls module function "' + e.message.split(':')[1] +
        '" at LOAD time -- it must be deferred (DOMContentLoaded) or guarded, since modules load after app.js');
    }
    // Any other throw means the sandbox is missing a stub, not a real failure of
    // this guard. Surface it so we can widen the stub, but don't mask it.
    throw new Error('app.js threw during load-time sandbox (likely a missing stub, not a module-fn call): ' + e.message);
  }
  assert.deepEqual(offenders, [], 'module functions called at load: ' + offenders.join(', '));
});
