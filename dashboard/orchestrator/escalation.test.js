'use strict';
const test = require('node:test');
const assert = require('node:assert');
const escalation = require('./escalation');
const taskStore = require('./task-store');
const { STATE } = require('./state');

function inst() {
  const o = Object.assign(
    {
      tasks: new Map(),
      heartbeats: new Map(),
      checkpoints: new Map(),
      orchestrating: false,
      broadcast: () => {},
      getConfig: () => ({}),
      inject: () => {},
      sendMessage: () => {},
      saveTaskToMind: null,
      _saveTasks: () => {},
      circuitBreaker: { isAvailable: () => true },
    },
    taskStore,
    escalation
  );
  return o;
}

test('_aggregateResults ranks completed results by quality score', () => {
  const o = inst();
  const a = o._createTask({ type: 'headless', cli: 'claude', prompt: 'x' });
  a.state = STATE.COMPLETED;
  a.result = 'short';
  const b = o._createTask({ type: 'headless', cli: 'gemini', prompt: 'x' });
  b.state = STATE.COMPLETED;
  b.result = '# Heading\n```js\ncode\n```\n' + 'detailed answer '.repeat(40);
  const agg = o._aggregateResults([a.id, b.id]);
  assert.equal(agg.results.length, 2);
  assert.equal(agg.bestCli, 'gemini', 'richer result ranks first');
  assert.ok(agg.totalScore > 0);
});

test('spawnWithLineage prepends parent + sibling context to the prompt', () => {
  const o = inst();
  let captured = null;
  o.spawnHeadless = (opts) => { captured = opts; return { id: 'x' }; };
  const parent = o._createTask({ type: 'headless', cli: 'claude', prompt: 'parent goal' });
  const sib = o._createTask({ type: 'headless', cli: 'gemini', prompt: 'sibling work' });
  o.spawnWithLineage({ cli: 'codex', prompt: 'my job', parentTaskId: parent.id, siblingTaskIds: [sib.id] });
  assert.match(captured.prompt, /Parent task/);
  assert.match(captured.prompt, /Sibling tasks/);
  assert.match(captured.prompt, /my job/);
});

test('spawnWithEscalation starts at the preferred CLI and stores the remaining chain', () => {
  const o = inst();
  let startedCli = null;
  o.spawnHeadless = ({ cli, prompt }) => {
    startedCli = cli;
    const t = o._createTask({ type: 'headless', cli, prompt });
    return t;
  };
  const task = o.spawnWithEscalation({ preferCli: 'gemini', prompt: 'do it' });
  assert.equal(startedCli, 'gemini');
  assert.ok(Array.isArray(task._escalationChain), 'remaining chain stored on task');
  assert.equal(task._escalationPrompt, 'do it');
});
