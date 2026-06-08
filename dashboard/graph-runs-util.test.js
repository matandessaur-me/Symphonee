'use strict';
// Unit tests for the graph-run pure helpers extracted from graph-runs.js.
// The reachability + merge + template + sandbox-eval logic drives real run
// branching but was previously only reachable through the engine.
const test = require('node:test');
const assert = require('node:assert');
const u = require('./graph-runs-util');

test('deepMerge recurses objects, replaces arrays, overwrites scalars', () => {
  assert.deepEqual(u.deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 }, e: 5 }),
    { a: 1, b: { c: 9, d: 3 }, e: 5 });
  assert.deepEqual(u.deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] }); // arrays replaced, not merged
  assert.equal(u.deepMerge({ a: 1 }, 7), 7); // scalar b wins
});

test('readPath / renderTemplate resolve dotted paths and tolerate misses', () => {
  const vars = { user: { name: 'Ada' }, n: 2 };
  assert.equal(u.readPath(vars, 'user.name'), 'Ada');
  assert.equal(u.readPath(vars, 'user.missing.deep'), undefined);
  assert.equal(u.renderTemplate('hi {{ user.name }} x{{n}}', vars), 'hi Ada x2');
  assert.equal(u.renderTemplate('{{ nope.nope }}!', vars), '!'); // missing -> empty
});

test('evalSafe evaluates a sandboxed expression against state', () => {
  assert.equal(u.evalSafe('state.x > 3 && state.y === "go"', { x: 5, y: 'go' }), true);
  assert.equal(u.evalSafe('state.x > 3', { x: 1 }), false);
});

test('unreachableFrom propagates skips only when ALL deps are skipped', () => {
  const nodes = [
    { id: 'a' },                         // root
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },  // needs both b and c
  ];
  // skipping b alone: d still reachable via c, so only b is skipped
  assert.deepEqual(u.unreachableFrom(nodes, 'b').sort(), ['b']);
  // skipping b when c already skipped: d becomes unreachable (both deps gone)
  assert.deepEqual(u.unreachableFrom(nodes, 'b', ['c']).sort(), ['b', 'c', 'd']);
});

test('re-exported helpers are stable from graph-runs.js too', () => {
  const gr = require('./graph-runs');
  assert.equal(gr.deepMerge, u.deepMerge);
  assert.equal(gr.renderTemplate, u.renderTemplate);
});
