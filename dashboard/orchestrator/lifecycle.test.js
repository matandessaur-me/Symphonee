'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lifecycle = require('./lifecycle');
const taskStore = require('./task-store');
const { STATE } = require('./state');

function inst() {
  const o = Object.assign(
    {
      tasks: new Map(),
      heartbeats: new Map(),
      terminals: new Map(),
      orchestrating: false,
      _paused: false,
      broadcast: () => {},
      getConfig: () => ({}),
      inject: () => {},
      sendMessage: () => {},
      saveTaskToMind: null,
      _tasksFile: null,
      _saveTasks: () => {},
    },
    taskStore,
    lifecycle
  );
  return o;
}

test('getAgents lists live terminals', () => {
  const o = inst();
  o.terminals.set('term-1', { cols: 80, rows: 24 });
  const agents = o.getAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].termId, 'term-1');
  assert.equal(agents[0].alive, true);
});

test('pauseAll / resumeAll / isPaused toggle state', () => {
  const o = inst();
  assert.equal(o.isPaused(), false);
  o.pauseAll();
  assert.equal(o.isPaused(), true);
  o.resumeAll();
  assert.equal(o.isPaused(), false);
});

test('spawnWithDependencies queues until deps complete, then releases', () => {
  const o = inst();
  // Stub the spawn so _checkAndRelease can "run" the task once deps are met.
  let spawned = null;
  o.spawnHeadless = (opts) => {
    spawned = opts;
    const t = o._createTask({ type: 'headless', cli: opts.cli, prompt: opts.prompt });
    t.state = STATE.RUNNING;
    return t;
  };

  const dep = o._createTask({ type: 'headless', cli: 'claude', prompt: 'dep' });
  dep.state = STATE.RUNNING;

  const queued = o.spawnWithDependencies({ cli: 'gemini', prompt: 'child', dependsOn: [dep.id] });
  assert.equal(o.tasks.get(queued.id).state, STATE.QUEUED, 'stays queued while dep runs');

  // Complete the dependency, then release queued tasks.
  dep.state = STATE.COMPLETED;
  dep.result = 'dep done';
  o._releaseQueuedTasks();
  assert.ok(spawned, 'queued task spawned after dep completed');
  assert.match(spawned.prompt, /dep done/, 'dependency result injected as context');
});

test('getHeartbeats classifies running tasks by idle time', () => {
  const o = inst();
  const t = o._createTask({ type: 'headless', cli: 'claude', prompt: 'x' });
  t.state = STATE.RUNNING;
  t.startedAt = Date.now();
  o.heartbeats.set(t.id, Date.now());
  const hb = o.getHeartbeats();
  assert.equal(hb.length, 1);
  assert.equal(hb[0].status, 'active');
});

test('waitFor resolves when a task reaches a terminal state', async () => {
  const o = inst();
  const t = o._createTask({ type: 'headless', cli: 'claude', prompt: 'x' });
  t.state = STATE.RUNNING;
  setTimeout(() => { t.state = STATE.COMPLETED; t.result = 'ok'; }, 50);
  const done = await o.waitFor(t.id, 5000);
  assert.equal(done.state, STATE.COMPLETED);
});
