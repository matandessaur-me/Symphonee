'use strict';
// Unit tests for the browser action-telemetry/report cluster extracted from
// browser-agent-chat.js. These are the pure formatters -- now that they live in
// their own module they can be tested directly instead of only via a live run.
const test = require('node:test');
const assert = require('node:assert');
const t = require('./browser-chat-telemetry');

test('describeAction produces a human label for known + unknown actions', () => {
  assert.equal(typeof t.describeAction('navigate', { url: 'https://example.com' }), 'string');
  assert.ok(t.describeAction('navigate', { url: 'https://example.com' }).length > 0);
  // unknown action must still return a non-empty string, not throw
  assert.ok(t.describeAction('totally_unknown', {}).length > 0);
});

test('isMutatingTool / MUTATING_TOOLS agree', () => {
  for (const name of t.MUTATING_TOOLS) assert.equal(t.isMutatingTool(name), true);
  assert.equal(t.isMutatingTool('read_page'), false);
});

test('summarizeUrl keeps host, drops the long tail, tolerates junk', () => {
  const long = 'https://example.com/' + 'a'.repeat(300);
  const out = t.summarizeUrl(long, 96);
  assert.ok(out.startsWith('example.com/'));  // host preserved
  assert.ok(out.includes('truncated'));       // long path elided
  assert.equal(typeof t.summarizeUrl('', 96), 'string');
  assert.equal(typeof t.summarizeUrl(null, 96), 'string');
});

test('buildActionReport assembles a report from a tool result + telemetry without throwing', () => {
  const report = t.buildActionReport({
    name: 'navigate',
    args: { url: 'https://example.com' },
    result: { url: 'https://example.com', title: 'Example' },
    telemetry: {
      payloads: [{ requestId: 'r1' }],
      network: { responses: [{ requestId: 'r1', url: 'https://example.com/api', status: 200 }], failures: [] },
      console: [{ type: 'log', text: 'hi' }],
    },
  });
  assert.equal(report.name, 'navigate');
  assert.equal(typeof report.title, 'string');
  assert.ok(Array.isArray(report.summaryLines));
  assert.equal(typeof report.markdown, 'string');
});

test('buildFinalBrowserReport tolerates an empty action list', () => {
  assert.equal(typeof t.buildFinalBrowserReport('done', []), 'string');
});
