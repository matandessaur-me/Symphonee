'use strict';
// Unit tests for the browser provider adapters extracted from browser-agent-chat.js.
// These exercise the NON-network methods (initMessages / buildToolResultBlocks /
// appendAssistant / appendToolResults) so the adapter closures are actually
// verified -- require-smoke only proves the module loads, not that the factory
// functions resolve every free variable they close over.
const test = require('node:test');
const assert = require('node:assert');
const p = require('./browser-chat-providers');

test('buildProviderRegistry wires keys to adapters and pickProvider honours priority', () => {
  const reg = p.buildProviderRegistry({
    ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x',
    DASHSCOPE_API_KEY: 'd', GEMINI_API_KEY: 'g',
  });
  assert.deepEqual(Object.keys(reg).sort(), ['anthropic', 'gemini', 'grok', 'openai', 'qwen']);
  // preferred wins when present; otherwise canonical order (anthropic first)
  assert.equal(p.pickProvider(reg, 'gemini').keyEnv, 'GEMINI_API_KEY');
  assert.equal(p.pickProvider(reg, null).keyEnv, 'ANTHROPIC_API_KEY');
  // empty registry -> null
  assert.equal(p.pickProvider({}, null), null);
});

test('every adapter constructs and its non-network methods run without throwing', () => {
  const adapters = [
    p.makeAnthropicAdapter(),
    p.makeOpenAIAdapter({ baseHost: 'api.openai.com', label: 'OpenAI', defaultModel: 'gpt-4o' }),
    p.makeGeminiAdapter(),
  ];
  for (const a of adapters) {
    assert.equal(typeof a.defaultModel, 'string');
    // initMessages seeds a message log
    const msgs = a.initMessages('do a thing');
    assert.ok(Array.isArray(msgs) && msgs.length >= 1);
    // buildToolResultBlocks must handle a known tool + the fallback path
    // (exercises shortenContent/formatElements closures inside the adapter)
    assert.ok(a.buildToolResultBlocks('read_page', { url: 'u', title: 't', content: 'x'.repeat(5000) }) != null);
    assert.ok(a.buildToolResultBlocks('query_elements', { elements: [{ tag: 'a', text: 'hi' }] }) != null);
    assert.ok(a.buildToolResultBlocks('some_unknown_tool', { ok: true }) != null);
    // appendAssistant / appendToolResults mutate the log without throwing
    assert.doesNotThrow(() => a.appendAssistant(msgs, 'assistant turn'));
    assert.doesNotThrow(() => a.appendToolResults(msgs, [{ toolUseId: 'id1', name: 'read_page', blocks: a.buildToolResultBlocks('read_page', { content: 'c' }) }]));
  }
});

test('exposed helpers are present', () => {
  assert.equal(typeof p.trimHistory, 'function');
  assert.equal(typeof p.formatElements, 'function');
  assert.equal(typeof p.buildRefineUserText, 'function');
  // trimHistory keeps seed + recent
  const many = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: String(i) }));
  const trimmed = p.trimHistory(many, 1);
  assert.ok(trimmed.length < many.length);
  assert.equal(trimmed[0].content, '0'); // seed preserved
});
