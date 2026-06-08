'use strict';
// Unit tests for the pure plugin-manifest layer extracted from plugin-loader.js.
// These rules decide which plugin contributions are honoured, how legacy tab
// shapes are migrated, and when a plugin activates -- previously only exercised
// implicitly during a real plugin scan at startup.
const test = require('node:test');
const assert = require('node:assert');
const m = require('./plugin-manifest');

test('validateContributions flags unknown keys and v2-on-v1 misuse', () => {
  const warnings = m.validateContributions({
    sdkVersion: 1,
    contributions: { settingsHtml: '<div>', prProvider: {}, bogusKey: 1 },
  });
  assert.ok(warnings.some(w => w.includes("unknown contribution 'bogusKey'")));
  assert.ok(warnings.some(w => w.includes("'prProvider' requires sdkVersion >= 2")));
  // a clean v1-only manifest yields no warnings
  assert.deepEqual(m.validateContributions({ sdkVersion: 1, contributions: { settingsHtml: 'x' } }), []);
});

test('validateContributions enforces pinned/popup tab rules', () => {
  const w1 = m.validateContributions({
    sdkVersion: 2,
    contributions: { centerTabs: [{ id: 't', pinned: true, popup: true, claims: {} }] },
  });
  assert.ok(w1.some(w => w.includes('mutually exclusive')));
  const w2 = m.validateContributions({
    sdkVersion: 2,
    contributions: { rightTabs: [{ id: 'r', pinned: true }] }, // no claims, no html
  });
  assert.ok(w2.some(w => w.includes("neither 'claims' nor 'html'")));
});

test('normalizeLegacyShapes migrates legacyNativeTabs to centerTabs in place', () => {
  const manifest = {
    contributions: {
      legacyNativeTabs: [
        { tabBtnId: 'fooTabBtn', label: 'Foo', panelId: 'fooPanel' },          // visible -> pinned
        { tabBtnId: 'workItemTabBtn', label: 'WI', openable: false },          // openable:false -> popup
      ],
    },
  };
  m.normalizeLegacyShapes(manifest);
  const c = manifest.contributions;
  assert.equal(c.legacyNativeTabs, undefined);            // legacy key removed
  assert.equal(c.centerTabs.length, 2);
  const foo = c.centerTabs.find(t => t.id === 'foo');
  assert.ok(foo.pinned && !foo.popup);
  assert.equal(foo.claims.tabBtnId, 'fooTabBtn');
  const wi = c.centerTabs.find(t => t.label === 'WI');
  assert.ok(wi.popup && !wi.pinned);
});

test('checkActivation honours always / configKeys conditions', () => {
  assert.equal(m.checkActivation({ activationConditions: { always: true } }, () => ({})), true);
  assert.equal(m.checkActivation({}, () => ({})), true); // no conditions -> active
  const manifest = { activationConditions: { configKeys: ['AZURE_PAT'] } };
  assert.equal(m.checkActivation(manifest, () => ({ AZURE_PAT: 'x' })), true);
  assert.equal(m.checkActivation(manifest, () => ({})), false); // missing key -> inactive
});
