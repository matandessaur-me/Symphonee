'use strict';
// Runs the built browser-credentials module in isolation (window===global) to
// prove self-containment and a real credential add/render/remove cycle.
//
// Run: node --test dashboard/public/browser-credentials/browser-credentials.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BUILT = path.resolve(__dirname, '..', 'js', 'browser-credentials.js');

// Stub just the DOM the creds path touches: the input fields and the two list
// containers renderBrowserCreds writes into.
function loadModule() {
  const fields = {};
  const lists = { browserCredList: { innerHTML: '' }, browserCredListBrowser: { innerHTML: '' } };
  const el = id => fields[id] || lists[id] || null;
  const ctx = {
    state: { configData: {} },
    document: { getElementById: el },
    esc: s => String(s == null ? '' : s),
    toast: () => {},
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUILT, 'utf8'), ctx);
  return { win: ctx, fields, lists };
}

test('loads in isolation and exposes its 6 public functions on window', () => {
  const { win } = loadModule();
  for (const fn of ['renderBrowserCreds', 'addBrowserCredential', 'addBrowserCredentialBrowserTab',
    'removeBrowserCredential', 'refreshBrowserSettings', 'saveBrowserSettings']) {
    assert.equal(typeof win[fn], 'function', `window.${fn} missing`);
  }
});

test('add -> render -> remove cycle round-trips through state.configData', () => {
  const { win, fields, lists } = loadModule();
  fields.browserCredName = { value: 'acme' };
  fields.browserCredEmail = { value: 'a@b.co' };
  fields.browserCredPass = { value: 'pw' };

  win.addBrowserCredential();
  assert.deepEqual(win.state.configData.BrowserCredentials.acme, { email: 'a@b.co', password: 'pw' });
  assert.match(lists.browserCredList.innerHTML, /acme/);   // rendered into the list
  assert.equal(fields.browserCredName.value, '');           // inputs cleared

  win.removeBrowserCredential('acme');
  assert.equal(win.state.configData.BrowserCredentials.acme, undefined);
  assert.match(lists.browserCredList.innerHTML, /No credentials saved/);
});
