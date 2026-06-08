'use strict';
// Unit tests for the apps (desktop) provider adapters extracted from
// apps-agent-chat.js. Exercise the NON-network methods so the adapter closures
// are actually verified -- require-smoke only proves the module loads, not that
// the factory functions resolve every free variable (shortenContent,
// formatChangeNote, trimHistory, DESKTOP_TOOLS, BASE_SYSTEM_PROMPT) they close over.
const test = require('node:test');
const assert = require('node:assert');
const p = require('./apps-chat-providers');

test('buildProviderRegistry wires keys to adapters and pickProvider honours priority', () => {
  const reg = p.buildProviderRegistry({
    ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x',
    DASHSCOPE_API_KEY: 'd', GEMINI_API_KEY: 'g',
  });
  assert.ok(reg.anthropic && reg.openai && reg.gemini);
  assert.equal(p.pickProvider(reg, 'gemini').keyEnv, 'GEMINI_API_KEY');
  assert.equal(p.pickProvider(reg, null).keyEnv, 'ANTHROPIC_API_KEY'); // canonical first
  assert.equal(p.pickProvider({}, null), null);
});

test('every adapter constructs and its non-network methods run without throwing', () => {
  const adapters = [
    p.makeAnthropicAdapter(),
    p.makeOpenAIAdapter({ baseHost: 'api.openai.com', label: 'OpenAI', defaultModel: 'gpt-4o' }),
    p.makeGeminiAdapter(),
  ];
  const shot = { base64: 'AAAA', mimeType: 'image/jpeg', width: 800, height: 600, rect: { x: 0, y: 0, w: 800, h: 600 }, changed: true };
  for (const a of adapters) {
    assert.equal(typeof a.defaultModel, 'string');
    const msgs = a.initMessages('open notepad and type hi');
    assert.ok(Array.isArray(msgs) && msgs.length >= 1);
    // screenshot branch exercises formatChangeNote; list_windows exercises shortenContent
    assert.ok(a.buildToolResultBlocks('screenshot', shot) != null);
    assert.ok(a.buildToolResultBlocks('list_windows', [{ hwnd: 1, title: 'x'.repeat(5000) }]) != null);
    assert.ok(a.buildToolResultBlocks('some_unknown_tool', { ok: true }) != null);
    assert.doesNotThrow(() => a.appendAssistant(msgs, 'assistant turn'));
  }
});

test('exposed helpers behave', () => {
  assert.equal(typeof p.formatChangeNote, 'function');
  // trimHistory keeps seed + recent
  const many = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: String(i) }));
  const trimmed = p.trimHistory(many, 1);
  assert.ok(trimmed.length < many.length);
  assert.equal(trimmed[0].content, '0');
  // shortenContent truncates past the limit
  assert.ok(p.shortenContent('x'.repeat(100), 10).length < 100);
});
