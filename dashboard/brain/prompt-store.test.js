'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./prompt-store');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-prompt-'));
}

test('loadRules returns the default when no override exists', () => {
  const root = tmpRoot();
  try {
    const r = store.loadRules(root);
    assert.equal(r.source, 'default');
    assert.equal(r.version, store.DEFAULT_VERSION);
    assert.equal(r.rules, store.DEFAULT_RULES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRules writes the file and loadRules reads it back', () => {
  const root = tmpRoot();
  try {
    const r = store.saveRules(root, 'CLI selection rules:\n  - test\n');
    assert.equal(r.ok, true);
    const loaded = store.loadRules(root);
    assert.equal(loaded.source, 'override');
    assert.match(loaded.rules, /test/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRules rejects empty strings', () => {
  const root = tmpRoot();
  try {
    assert.equal(store.saveRules(root, '').ok, false);
    assert.equal(store.saveRules(root, '   ').ok, false);
    assert.equal(store.saveRules(root, null).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRules records previous state in history', () => {
  const root = tmpRoot();
  try {
    store.saveRules(root, 'first version');
    store.saveRules(root, 'second version');
    const hist = store.readHistory(root);
    assert.equal(hist.length, 2);
    // newest first
    assert.match(hist[0].previousRules, /first version/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revertRules with no history removes the override and returns default', () => {
  const root = tmpRoot();
  try {
    const r = store.revertRules(root);
    assert.equal(r.source, 'default');
    assert.equal(r.revertedTo, store.DEFAULT_RULES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revertRules walks one step back through history', () => {
  const root = tmpRoot();
  try {
    store.saveRules(root, 'first version');
    store.saveRules(root, 'second version');
    // current is "second"; history says "first" was the previous override
    const r = store.revertRules(root);
    assert.equal(r.source, 'override');
    assert.match(r.revertedTo, /first version/);
    // current should now be "first"
    assert.match(store.loadRules(root).rules, /first version/);
    // history should have one entry left
    assert.equal(store.readHistory(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revertRules walks all the way back to default', () => {
  const root = tmpRoot();
  try {
    store.saveRules(root, 'edit 1');
    // revert: previous was default, so override file goes away
    const r = store.revertRules(root);
    assert.equal(r.source, 'default');
    assert.equal(store.loadRules(root).source, 'default');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readHistory respects limit', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 10; i++) store.saveRules(root, 'version ' + i);
    const hist = store.readHistory(root, { limit: 3 });
    assert.equal(hist.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source tag on saveRules flows into history', () => {
  const root = tmpRoot();
  try {
    store.saveRules(root, 'self iter version', { source: 'self-iterate', note: 'auto' });
    // The new entry was just written; the history records what was THERE
    // before (default). Let's save again to verify the tag on the most
    // recent history entry.
    store.saveRules(root, 'next version', { source: 'manual' });
    const hist = store.readHistory(root);
    assert.equal(hist[0].nextSource, 'manual');
    assert.equal(hist[1].nextSource, 'self-iterate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
