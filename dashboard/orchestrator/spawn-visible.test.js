'use strict';
const test = require('node:test');
const assert = require('node:assert');
const spawnVisible = require('./spawn-visible');
const taskStore = require('./task-store');

// spawnVisible drives a real PTY + interactive watcher, so unit coverage here is
// limited to its guard clauses; end-to-end behavior is covered by a live restart
// smoke (a real worker dispatch) per the refactor workflow.
function inst(extra = {}) {
  return Object.assign(
    {
      tasks: new Map(),
      terminals: new Map(),
      termOutput: new Map(),
      workspaceDir: require('os').tmpdir(),
      broadcast: () => {},
      getConfig: () => ({}),
    },
    taskStore,
    spawnVisible,
    extra
  );
}

test('spawnVisible rejects an unknown CLI', () => {
  const o = inst();
  assert.throws(() => o.spawnVisible({ cli: 'bogus', prompt: 'x' }), /Unknown CLI/);
});

test('spawnVisible requires createTerminal', () => {
  const o = inst(); // no createTerminal provided
  assert.throws(() => o.spawnVisible({ cli: 'claude', prompt: 'x' }), /createTerminal not available/);
});
