'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bus = require('./bus');

function inst() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-bus-'));
  fs.mkdirSync(path.join(workspaceDir, 'inboxes'), { recursive: true });
  let n = 0;
  return Object.assign({ inboxes: new Map(), workspaceDir, _id: () => `m${++n}`, broadcast: () => {} }, bus);
}

test('sendMessage -> readInbox round-trip + persists', () => {
  const o = inst();
  const msg = o.sendMessage({ to: 'agent-1', from: 'main', content: 'hello' });
  assert.equal(msg.content, 'hello');
  const got = o.readInbox('agent-1');
  assert.equal(got.length, 1);
  assert.equal(got[0].content, 'hello');
  assert.equal(got[0].read, true, 'readInbox marks read');
  assert.ok(fs.existsSync(path.join(o.workspaceDir, 'inboxes', 'agent-1.json')), 'persisted to disk');
});

test('readUnread returns only unread then marks them read', () => {
  const o = inst();
  o.sendMessage({ to: 'a', from: 'x', content: '1' });
  o.sendMessage({ to: 'a', from: 'x', content: '2' });
  const unread = o.readUnread('a');
  assert.equal(unread.length, 2);
  assert.equal(o.readUnread('a').length, 0, 'all read now');
});

test('clearInbox empties the inbox', () => {
  const o = inst();
  o.sendMessage({ to: 'a', from: 'x', content: '1' });
  o.clearInbox('a');
  assert.equal(o.readInbox('a').length, 0);
});
