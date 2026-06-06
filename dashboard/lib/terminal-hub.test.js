'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createTerminalHub } = require('./terminal-hub');

function mkHub() {
  const srv = http.createServer();
  const hub = createTerminalHub({ httpServer: srv, repoRoot: process.cwd(), getConfig: () => ({ Repos: {} }) });
  return { srv, hub };
}

test('hub exposes the expected interface', () => {
  const { srv, hub } = mkHub();
  try {
    assert.equal(typeof hub.broadcast, 'function');
    assert.equal(typeof hub.createTerminal, 'function');
    assert.equal(typeof hub.killTerminal, 'function');
    assert.ok(hub.terminals instanceof Map);
    assert.ok(hub.termAiMeta instanceof Map);
    assert.ok(hub.wss);
    assert.doesNotThrow(() => hub.broadcast({ type: 'noop' })); // no clients -> safe
  } finally { hub.wss.close(); srv.close(); }
});

test('createTerminal spawns a PTY and killTerminal removes it', () => {
  const { srv, hub } = mkHub();
  try {
    const pty = hub.createTerminal('test-term', 80, 24);
    assert.ok(hub.terminals.has('test-term'), 'registered');
    assert.ok(pty && pty.pid, 'has a pid');
    hub.killTerminal('test-term');
    assert.ok(!hub.terminals.has('test-term'), 'removed after kill');
  } finally { hub.wss.close(); srv.close(); }
});
