'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createUiContextStore } = require('./ui-context');

function harness() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-uictx-'));
  fs.mkdirSync(path.join(repoRoot, '.symphonee'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  const events = [];
  let repoChanges = 0;
  const store = createUiContextStore({
    repoRoot,
    getConfig: () => ({ Repos: { MyRepo: 'C:/x' } }),
    broadcast: (m) => events.push(m),
    onActiveRepoChange: () => { repoChanges++; },
  });
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  store.mountRoutes(addRoute, json);
  return { store, routes, events, repoRoot, repoChanges: () => repoChanges };
}
const req = (b) => Readable.from([JSON.stringify(b)]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('getUiContext default shape', () => {
  const { store } = harness();
  const c = store.getUiContext();
  assert.equal(c.activeRepo, null);
  assert.equal(c.notesNamespace, '_global');
});

test('routes registered (context, mutate, ui-actions, app-state, focus)', () => {
  const { routes } = harness();
  for (const k of ['GET /api/ui/context', 'POST /api/ui/context', 'POST /api/ui/mutate',
    'POST /api/ui/view-file', 'POST /api/ui/tab', 'GET /api/application-state',
    'GET /api/application-state/focus', 'POST /api/application-state/focus',
    '__PREFIX__ /api/application-state']) assert.ok(routes[k], `missing ${k}`);
});

test('context update mutates, persists, derives path+ns, fires onActiveRepoChange', async () => {
  const { store, routes, repoRoot, repoChanges } = harness();
  const res = {};
  await routes['POST /api/ui/context'](req({ activeRepo: 'MyRepo', activeSpace: 'Space One' }), res);
  assert.ok(res._data.ok);
  const c = store.getUiContext();
  assert.equal(c.activeRepo, 'MyRepo');
  assert.equal(c.activeRepoPath, 'C:/x');
  assert.equal(c.notesNamespace, 'Space_One');
  assert.equal(repoChanges(), 1, 'onActiveRepoChange fired');
  assert.ok(fs.existsSync(path.join(repoRoot, '.symphonee', 'ui-state.json')), 'persisted');
});

test('app-state PUT/GET/DELETE round-trip + focus reserved', async () => {
  const { routes } = harness();
  const pfx = routes['__PREFIX__ /api/application-state'];
  const reqM = (method, body) => { const r = Readable.from([JSON.stringify(body || {})]); r.method = method; return r; };
  let res = {};
  await pfx(reqM('PUT', { value: { x: 1 } }), res, new URL('http://h/api/application-state/nav'), '/nav');
  assert.ok(res._data.ok);
  res = {};
  pfx({ method: 'GET' }, res, new URL('http://h/api/application-state/nav'), '/nav');
  assert.deepEqual(res._data.value, { x: 1 });
  res = {};
  pfx({ method: 'DELETE' }, res, new URL('http://h/api/application-state/nav'), '/nav');
  assert.ok(res._data.ok);
  res = {};
  pfx({ method: 'GET' }, res, new URL('http://h/api/application-state/nav'), '/nav');
  assert.equal(res._data.value, null);
  // focus key is reserved -> prefix handler declines
  assert.equal(pfx({ method: 'GET' }, {}, new URL('http://h/api/application-state/focus'), '/focus'), false);
});

test('focus update + read', async () => {
  const { routes, store } = harness();
  let res = {};
  await routes['POST /api/application-state/focus'](req({ activeTab: 'notes', currentNote: 'N' }), res);
  assert.ok(res._data.ok);
  res = {};
  routes['GET /api/application-state/focus']({}, res);
  assert.equal(res._data.activeTab, 'notes');
  assert.equal(res._data.currentNote, 'N');
});

test('ui-action + mutate broadcast', async () => {
  const { routes, events } = harness();
  await routes['POST /api/ui/view-file'](req({ path: 'a.js' }), {});
  assert.ok(events.some(e => e.type === 'ui-action' && e.action === 'view-file' && e.path === 'a.js'));
  await routes['POST /api/ui/mutate'](req({ ops: [{ op: 'addTab', id: 't' }] }), {});
  assert.ok(events.some(e => e.type === 'ui-mutate'));
});
