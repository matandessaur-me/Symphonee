'use strict';
// Runs the built themes module in isolation (window===global). themes does real
// work at load (fetch saved themes + restore the active theme), so this proves
// it loads without throwing against stubbed browser APIs and exposes its surface
// -- including the 3 shared constants other parts depend on.
//
// Run: node --test dashboard/public/themes/themes.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'themes.js');

function loadModule() {
  const store = {};
  const styleStub = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } };
  const elStub = { style: styleStub, setAttribute() {}, getAttribute() { return ''; }, classList: { add() {}, remove() {}, toggle() {} }, value: '', querySelectorAll: () => [] };
  const ctx = {
    state: {},
    document: { documentElement: elStub, getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    setTimeout: () => 0,
    // terminals.js exposes this on window; themes reads it when applying a theme.
    TERM_THEMES: new Proxy({}, { get: () => ({}) }),
    // Top-level app.js functions themes calls (on window in the real app).
    applyShellTheme: () => {},
    getActiveTermTheme: () => ({}),
    restartAllTerminalsForTheme: () => {},
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return ctx;
}

test('loads in isolation (incl. its load-time theme restore) and exposes its functions', () => {
  const win = loadModule();
  for (const fn of ['renderThemeList', 'applyBuiltinTheme', 'applyCustomTheme', 'editThemeInEditor',
    'deleteTheme', 'toggleThemeEditor', 'saveCustomThemeFromEditor', 'exportThemes', 'importThemes',
    'restoreCustomTheme', '_setThemeMode']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('re-exposes the 3 shared constants other parts read at runtime', () => {
  const win = loadModule();
  assert.ok(Array.isArray(win.BUILTIN_THEMES) && win.BUILTIN_THEMES.length > 0, 'BUILTIN_THEMES');
  assert.ok(Array.isArray(win.ALL_CSS_KEYS) && win.ALL_CSS_KEYS.includes('--accent'), 'ALL_CSS_KEYS');
  assert.equal(typeof win.ACTIVE_THEME_KEY, 'string');
  // every built-in theme has the shape onboarding/settings rely on
  for (const t of win.BUILTIN_THEMES) {
    assert.ok(t.id && t.name && t.accent, 'built-in theme missing id/name/accent');
  }
});

test('seeds the editor mode on the shared state object at load', () => {
  const win = loadModule();
  assert.equal(win.state._editorMode, 'dark');
});
