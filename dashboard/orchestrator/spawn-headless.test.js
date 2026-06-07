'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const spawnHeadless = require('./spawn-headless');
const taskStore = require('./task-store');
const { STATE } = require('./state');

function inst() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-spawn-'));
  fs.mkdirSync(path.join(workspaceDir, 'results'), { recursive: true });
  const o = Object.assign(
    {
      tasks: new Map(),
      heartbeats: new Map(),
      checkpoints: new Map(),
      termOutput: new Map(),
      terminals: new Map(),
      orchestrating: false,
      workspaceDir,
      _tasksFile: path.join(workspaceDir, 'tasks.json'),
      getConfig: () => ({}),
      broadcast: () => {},
      sendMessage: () => {},
      saveTaskToMind: null,
      circuitBreaker: { isAvailable: () => true, recordSuccess: () => {}, recordFailure: () => false },
    },
    taskStore,
    spawnHeadless
  );
  return o;
}

test('inject writes clean text to the target PTY and broadcasts', () => {
  const o = inst();
  let written = '';
  o.terminals.set('t1', { pty: { write: (s) => { written += s; } } });
  let event = null;
  o.broadcast = (m) => { event = m; };
  const r = o.inject('t1', 'hello\n', { autoSubmit: false });
  assert.equal(r.ok, true);
  assert.equal(written, 'hello', 'trailing newline stripped, no auto-submit');
  assert.equal(event.event, 'inject');
});

test('inject errors on a missing terminal', () => {
  const o = inst();
  const r = o.inject('nope', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('dispatch creates a RUNNING task and injects the wrapped prompt', () => {
  const o = inst();
  let injected = '';
  o.terminals.set('t1', { pty: { write: (s) => { injected += s; } } });
  const task = o.dispatch({ targetTermId: 't1', prompt: 'do the thing' });
  try {
    assert.equal(task.state, STATE.RUNNING);
    assert.match(injected, /ORCHESTRATOR TASK/);
    assert.match(injected, /do the thing/);
    assert.ok(task.resultFile, 'result file path set for the file-mailbox');
  } finally {
    if (task._pollInterval) clearInterval(task._pollInterval);
    if (task._timer) clearTimeout(task._timer);
  }
});

test('spawnHeadless rejects an unknown CLI', () => {
  const o = inst();
  assert.throws(() => o.spawnHeadless({ cli: 'bogus', prompt: 'x' }), /Unknown CLI/);
});
