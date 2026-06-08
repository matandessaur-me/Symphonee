'use strict';
// Renderer build-integrity guards.
//
// app.js is a GENERATED file (flat concatenation of parts/ per manifest.json).
// Nothing enforced that the committed app.js actually matched its source, so a
// hand-edit or a forgotten rebuild could silently ship stale renderer code --
// exactly the failure mode that makes "edit a part, nothing changes" bugs.
// These tests make the generated/source relationship a hard invariant, and lock
// in the pinned-tabs module extraction (first slice off the flat app.js).
//
// Run: node --test scripts/build-renderer.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'dashboard', 'public');
const PARTS = path.join(PUB, 'app', 'src', 'parts');
const APP_JS = path.join(PUB, 'js', 'app.js');

const manifest = () => JSON.parse(fs.readFileSync(path.join(PARTS, 'manifest.json'), 'utf8'));

test('app.js is the byte-exact concatenation of the manifest parts (no drift)', () => {
  const out = manifest().map(p => fs.readFileSync(path.join(PARTS, p), 'utf8')).join('');
  const committed = fs.readFileSync(APP_JS, 'utf8');
  assert.equal(out, committed,
    'dashboard/public/js/app.js is out of sync with parts/. Run `node scripts/build-renderer.js`.');
});

test('every manifest entry exists as a part file', () => {
  for (const p of manifest()) {
    assert.ok(fs.existsSync(path.join(PARTS, p)), `manifest references missing part: ${p}`);
  }
});

test('no part is orphaned: every parts/*.js is listed in the manifest', () => {
  const inManifest = new Set(manifest());
  for (const f of fs.readdirSync(PARTS).filter(f => f.endsWith('.js'))) {
    assert.ok(inManifest.has(f),
      `parts/${f} exists but is not in manifest.json -- it would not be built into app.js`);
  }
});

// ── Extraction contract: pinned-tabs is a real ES module, not a concat part ──
test('pinned-tabs is extracted (not a part, sourced as a module, wired in index.html)', () => {
  assert.ok(!fs.existsSync(path.join(PARTS, 'pinned-tabs.js')),
    'parts/pinned-tabs.js should be deleted (moved to pinned-tabs/src/)');
  assert.ok(!manifest().includes('pinned-tabs.js'),
    'pinned-tabs.js must not be in the concat manifest');
  assert.ok(fs.existsSync(path.join(PUB, 'pinned-tabs', 'src', 'index.js')),
    'pinned-tabs module source missing at pinned-tabs/src/index.js');
  const indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(indexHtml, /<script src="\/js\/pinned-tabs\.js"><\/script>/,
    'index.html must load /js/pinned-tabs.js');
});

test('app.js no longer defines the extracted pinned-tabs functions', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  assert.doesNotMatch(app, /function _placeTabAtEnd\b/, 'app.js still defines _placeTabAtEnd');
  assert.doesNotMatch(app, /function _initTabDrag\b/, 'app.js still defines _initTabDrag');
});

test('built pinned-tabs.js re-exposes its public surface on window', () => {
  const built = path.join(PUB, 'js', 'pinned-tabs.js');
  assert.ok(fs.existsSync(built), 'js/pinned-tabs.js not built -- run `node scripts/build-renderer.js`');
  const mod = fs.readFileSync(built, 'utf8');
  assert.match(mod, /window\.getSavedTabOrderOverrides\s*=/, 'missing window.getSavedTabOrderOverrides');
  assert.match(mod, /window\._placeTabAtEnd\s*=/, 'missing window._placeTabAtEnd');
});
