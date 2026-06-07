'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const taskStore = require('./task-store');
const lifecycle = require('./lifecycle');
const { STATE } = require('./state');

// Build a minimal fake Orchestrator with the task-store + lifecycle mixins and
// just enough instance state / stubs for the methods under test.
function inst() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-tasks-'));
  fs.mkdirSync(path.join(workspaceDir, 'results'), { recursive: true });
  const o = Object.assign(
    {
      tasks: new Map(),
      heartbeats: new Map(),
      workspaceDir,
      _tasksFile: path.join(workspaceDir, 'tasks.json'),
      orchestrating: false,
      getConfig: () => ({}),
      broadcast: () => {},
      inject: () => {},
      sendMessage: () => {},
      saveTaskToMind: null,
    },
    taskStore,
    lifecycle
  );
  return o;
}

test('_id returns unique hex ids', () => {
  const o = inst();
  const a = o._id();
  const b = o._id();
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('_createTask registers a PENDING task in the map', () => {
  const o = inst();
  const t = o._createTask({ type: 'headless', cli: 'claude', prompt: 'hi' });
  assert.equal(t.state, STATE.PENDING);
  assert.equal(o.tasks.get(t.id), t);
  assert.equal(o.getTask(t.id).cli, 'claude');
});

test('_serializeTask strips internal references', () => {
  const o = inst();
  const t = o._createTask({ type: 'headless', cli: 'claude', prompt: 'x' });
  t._proc = {}; t._timer = 1; t._pollInterval = 2; t._spawnOpts = {}; t._retryAttempt = 3;
  const safe = o._serializeTask(t);
  for (const k of ['_proc', '_timer', '_pollInterval', '_spawnOpts', '_retryAttempt']) {
    assert.ok(!(k in safe), `${k} should be stripped`);
  }
  assert.equal(safe.cli, 'claude');
});

test('listTasks filters by state and sorts newest first', () => {
  const o = inst();
  const a = o._createTask({ type: 'headless', cli: 'claude', prompt: '1' });
  a.createdAt = 100; a.state = STATE.COMPLETED;
  const b = o._createTask({ type: 'headless', cli: 'gemini', prompt: '2' });
  b.createdAt = 200; b.state = STATE.RUNNING;
  const completed = o.listTasks({ state: STATE.COMPLETED });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].cli, 'claude');
  const all = o.listTasks();
  assert.equal(all[0].prompt, '2', 'newest first');
});

test('cancelTask cancels a running task', () => {
  const o = inst();
  const t = o._createTask({ type: 'headless', cli: 'claude', prompt: 'x' });
  t.state = STATE.RUNNING;
  const r = o.cancelTask(t.id);
  assert.equal(r.ok, true);
  assert.equal(o.tasks.get(t.id).state, STATE.CANCELLED);
  assert.equal(o.cancelTask(t.id).ok, false, 'cannot cancel a finished task');
});

test('cleanup removes finished tasks but keeps running ones', () => {
  const o = inst();
  const done = o._createTask({ type: 'headless', cli: 'claude', prompt: 'd' });
  done.state = STATE.COMPLETED; done.completedAt = Date.now();
  const running = o._createTask({ type: 'headless', cli: 'claude', prompt: 'r' });
  running.state = STATE.RUNNING;
  const removed = o.cleanup();
  assert.equal(removed, 1);
  assert.ok(!o.tasks.has(done.id));
  assert.ok(o.tasks.has(running.id));
});

test('deleteTask refuses running tasks, deletes finished ones', () => {
  const o = inst();
  const running = o._createTask({ type: 'headless', cli: 'claude', prompt: 'r' });
  running.state = STATE.RUNNING;
  assert.equal(o.deleteTask(running.id).ok, false);
  running.state = STATE.FAILED;
  assert.equal(o.deleteTask(running.id).ok, true);
  assert.ok(!o.tasks.has(running.id));
});

test('_saveTasks + _loadTasks round-trip; running tasks become failed on reload', () => {
  const o = inst();
  const t = o._createTask({ type: 'headless', cli: 'claude', prompt: 'persist me' });
  t.state = STATE.RUNNING;
  o._saveTasks();
  // Fresh instance pointed at the same file
  const o2 = inst();
  o2._tasksFile = o._tasksFile;
  o2._loadTasks();
  const reloaded = o2.tasks.get(t.id);
  assert.ok(reloaded, 'task reloaded');
  assert.equal(reloaded.state, STATE.FAILED, 'in-flight task marked failed after restart');
});
