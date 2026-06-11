// apps-chat-providers -- per-provider LLM adapters (Anthropic / OpenAI-compat
// incl. local Ollama / Gemini) plus the registry+selection that wires API keys
// to adapters, for the desktop-app agent. Each adapter translates the canonical
// DESKTOP_TOOLS schema + screenshot-change notes + message history into the
// provider wire format and parses tool-calls back out. Split from
// apps-agent-chat.js; the run loop imports buildProviderRegistry + pickProvider.
const { httpJson, httpStream, httpJsonWithRetry } = require('./apps-chat-http');
const BASE_SYSTEM_PROMPT = require('./apps-chat-prompt');
const DESKTOP_TOOLS = require('./apps-chat-tools');

const DEFAULT_MAX_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 14;

function trimHistory(messages, seedCount) {
  if (messages.length <= seedCount + MAX_HISTORY_MESSAGES) return messages;
  let start = messages.length - MAX_HISTORY_MESSAGES;
  // Don't let the tail start with an orphan tool_result / tool turn whose
  // paired tool_use got trimmed off the front. Anthropic, OpenAI, and
  // Gemini all 400 on that. Shift the boundary forward until the first
  // tail message is a plain user turn or a fresh assistant turn.
  while (start < messages.length) {
    const m = messages[start];
    if (!m) break;
    const isTailResult =
      (m.role === 'tool') ||                                    // OpenAI
      (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result')) || // Anthropic
      (m.role === 'user' && Array.isArray(m.parts) && m.parts.some(p => p && p.functionResponse));            // Gemini
    if (!isTailResult) break;
    start++;
  }
  if (start >= messages.length) return messages.slice(0, seedCount);
  return [...messages.slice(0, seedCount), ...messages.slice(start)];
}

function shortenContent(text, n = 4000) {
  if (!text) return '';
  const s = String(text);
  return s.length <= n ? s : s.slice(0, n) + `\n[truncated ${s.length - n} chars]`;
}

function formatChangeNote(shot) {
  if (!shot || shot.changed === undefined) return '';
  if (shot.changed === false) {
    return ` No visible change since last screenshot (polled ${shot.waitedMs || 0}ms). Your last action may have had no effect.`;
  }
  if (shot.waitedMs) return ` Change detected after ${shot.waitedMs}ms.`;
  return '';
}

// ---- Provider adapters ----

function makeAnthropicAdapter() {
  return {
    kind: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    initMessages(task) { return [{ role: 'user', content: task }]; },
    buildToolResultBlocks(name, result) {
      if (name === 'screenshot' && result && result.base64) {
        const rectNote = result.rect ? `Window rect: x=${result.rect.x} y=${result.rect.y} w=${result.rect.w} h=${result.rect.h}` : '';
        const changeNote = formatChangeNote(result);
        return [
          { type: 'image', source: { type: 'base64', media_type: result.mimeType || 'image/jpeg', data: result.base64 } },
          { type: 'text', text: `Screenshot ${result.width}x${result.height}. ${rectNote}${changeNote}` },
        ];
      }
      if (name === 'list_windows' && Array.isArray(result)) {
        return [{ type: 'text', text: shortenContent(JSON.stringify(result, null, 2), 4000) }];
      }
      const text = result == null ? 'ok' : (typeof result === 'string' ? result : JSON.stringify(result).slice(0, 1000));
      return [{ type: 'text', text }];
    },
    appendAssistant(messages, raw) { messages.push({ role: 'assistant', content: raw }); },
    appendToolResults(messages, pairs) {
      messages.push({
        role: 'user',
        content: pairs.map(p => ({ type: 'tool_result', tool_use_id: p.toolUseId, is_error: p.isError || undefined, content: p.blocks })),
      });
    },
    async call({ messages, apiKey, model, systemPrompt, signal }) {
      const tools = DESKTOP_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const trimmed = trimHistory(messages, 1);
      const resp = await httpJsonWithRetry({
        hostname: 'api.anthropic.com', path: '/v1/messages',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model: model || this.defaultModel, max_tokens: DEFAULT_MAX_TOKENS, system: systemPrompt || BASE_SYSTEM_PROMPT, tools, messages: trimmed },
        signal,
      });
      const content = resp.content || [];
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const toolCalls = content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
      return { text, toolCalls, raw: content };
    },
    async callStream({ messages, apiKey, model, systemPrompt, signal }, onToken) {
      const tools = DESKTOP_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const trimmed = trimHistory(messages, 1);
      const blocks = {};
      let textContent = '';
      await httpStream({
        hostname: 'api.anthropic.com', path: '/v1/messages',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model: model || this.defaultModel, max_tokens: DEFAULT_MAX_TOKENS, system: systemPrompt || BASE_SYSTEM_PROMPT, tools, messages: trimmed, stream: true },
        signal,
        onChunk(line) {
          if (!line.startsWith('data: ')) return;
          let evt; try { evt = JSON.parse(line.slice(6)); } catch (_) { return; }
          if (evt.type === 'content_block_start') {
            blocks[evt.index] = { ...evt.content_block, _argsJson: '' };
          } else if (evt.type === 'content_block_delta') {
            const blk = blocks[evt.index];
            if (!blk) return;
            if (blk.type === 'text' && evt.delta.type === 'text_delta') {
              textContent += evt.delta.text; onToken(evt.delta.text);
            } else if (blk.type === 'tool_use' && evt.delta.type === 'input_json_delta') {
              blk._argsJson += evt.delta.partial_json;
            }
          }
        },
      });
      const raw = [];
      if (textContent) raw.push({ type: 'text', text: textContent });
      for (const blk of Object.values(blocks)) {
        if (blk.type === 'tool_use') {
          let input = {}; try { input = JSON.parse(blk._argsJson || '{}'); } catch (_) {}
          raw.push({ type: 'tool_use', id: blk.id, name: blk.name, input });
        }
      }
      const toolCalls = raw.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
      return { text: textContent.trim(), toolCalls, raw };
    },
  };
}

function makeOpenAIAdapter({ baseHost, basePath = '/v1/chat/completions', label, defaultModel, authHeader = 'Authorization', authPrefix = 'Bearer ', port, protocol = 'https' } = {}) {
  return {
    kind: 'openai-compat',
    label: label || 'OpenAI',
    defaultModel,
    baseHost,
    basePath,
    authHeader,
    authPrefix,
    initMessages(task) {
      return [
        { role: 'system', content: BASE_SYSTEM_PROMPT },
        { role: 'user', content: task },
      ];
    },
    buildToolResultBlocks(name, result) {
      if (name === 'screenshot' && result && result.base64) {
        // String tool-result; actual image is attached as a separate user
        // message via appendVision below.
        return `Screenshot ${result.width}x${result.height} captured. Rect x=${result.rect && result.rect.x} y=${result.rect && result.rect.y} w=${result.rect && result.rect.w} h=${result.rect && result.rect.h}.${formatChangeNote(result)}`;
      }
      if (name === 'list_windows' && Array.isArray(result)) {
        return shortenContent(JSON.stringify(result, null, 2), 6000);
      }
      return result == null ? 'ok' : (typeof result === 'string' ? result : JSON.stringify(result).slice(0, 2000));
    },
    appendAssistant(messages, assistantRaw) { messages.push(assistantRaw); },
    appendToolResults(messages, pairs) {
      for (const p of pairs) {
        messages.push({ role: 'tool', tool_call_id: p.toolUseId, content: typeof p.blocks === 'string' ? p.blocks : JSON.stringify(p.blocks) });
      }
    },
    async call({ messages, apiKey, model, systemPrompt, signal }) {
      const tools = DESKTOP_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const trimmed = trimHistory(messages, 2);
      if (systemPrompt && trimmed.length && trimmed[0].role === 'system') trimmed[0].content = systemPrompt;
      const resp = await httpJsonWithRetry({
        hostname: baseHost, path: basePath, port, protocol,
        headers: { [authHeader]: authPrefix + apiKey },
        body: { model: model || defaultModel, messages: trimmed, tools, tool_choice: 'auto', max_tokens: DEFAULT_MAX_TOKENS },
        signal,
      });
      const msg = (resp.choices && resp.choices[0] && resp.choices[0].message) || {};
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map(tc => {
        let args = {};
        try { args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (_) {}
        return { id: tc.id, name: tc.function && tc.function.name, args };
      }) : [];
      return { text: msg.content || '', toolCalls, raw: msg };
    },
    async callStream({ messages, apiKey, model, systemPrompt, signal }, onToken) {
      const tools = DESKTOP_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const trimmed = trimHistory(messages, 2);
      if (systemPrompt && trimmed.length && trimmed[0].role === 'system') trimmed[0].content = systemPrompt;
      let text = '';
      const tcMap = {};
      await httpStream({
        hostname: baseHost, path: basePath, port, protocol,
        headers: { [authHeader]: authPrefix + apiKey },
        body: { model: model || defaultModel, messages: trimmed, tools, tool_choice: 'auto', max_tokens: DEFAULT_MAX_TOKENS, stream: true },
        signal,
        onChunk(line) {
          if (!line.startsWith('data: ')) return;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') return;
          let evt; try { evt = JSON.parse(raw); } catch (_) { return; }
          const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
          if (!delta) return;
          if (delta.content) { text += delta.content; onToken(delta.content); }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!tcMap[tc.index]) tcMap[tc.index] = { id: '', name: '', argsJson: '' };
              if (tc.id) tcMap[tc.index].id = tc.id;
              if (tc.function && tc.function.name) tcMap[tc.index].name = tc.function.name;
              if (tc.function && tc.function.arguments) tcMap[tc.index].argsJson += tc.function.arguments;
            }
          }
        },
      });
      const toolCalls = Object.values(tcMap).map(tc => {
        let args = {}; try { args = JSON.parse(tc.argsJson || '{}'); } catch (_) {}
        return { id: tc.id, name: tc.name, args };
      });
      const rawMsg = {
        role: 'assistant', content: text || null,
        tool_calls: toolCalls.length ? toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) : undefined,
      };
      return { text, toolCalls, raw: rawMsg };
    },
    appendVision(messages, visionItems) {
      if (!visionItems.length) return;
      const content = visionItems.flatMap(v => [
        { type: 'image_url', image_url: { url: `data:${v.mimeType};base64,${v.base64}` } },
        { type: 'text', text: 'Screenshot from target window (tool result above).' },
      ]);
      messages.push({ role: 'user', content });
    },
  };
}

function makeGeminiAdapter() {
  return {
    kind: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-2.5-flash',
    initMessages(task) { return [{ role: 'user', parts: [{ text: task }] }]; },
    buildToolResultBlocks(name, result) {
      if (name === 'screenshot' && result && result.base64) {
        return {
          ok: true,
          width: result.width,
          height: result.height,
          rect: result.rect,
          changed: result.changed,
          waitedMs: result.waitedMs,
        };
      }
      if (name === 'list_windows' && Array.isArray(result)) return { windows: result };
      if (typeof result === 'string') return { text: result };
      return result || { ok: true };
    },
    appendAssistant(messages, parts) { messages.push({ role: 'model', parts }); },
    appendToolResults(messages, pairs) {
      messages.push({
        role: 'user',
        parts: pairs.map(p => ({ functionResponse: { name: p.name, response: typeof p.blocks === 'object' ? p.blocks : { result: p.blocks } } })),
      });
    },
    async call({ messages, apiKey, model, systemPrompt, signal }) {
      const tools = [{ functionDeclarations: DESKTOP_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      const mdl = model || this.defaultModel;
      const trimmed = trimHistory(messages, 1);
      const resp = await httpJsonWithRetry({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(apiKey)}`,
        body: {
          systemInstruction: { parts: [{ text: systemPrompt || BASE_SYSTEM_PROMPT }] },
          contents: trimmed, tools,
          generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
        },
        signal,
      });
      const cand = resp.candidates && resp.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const text = parts.filter(p => p.text).map(p => p.text).join('\n').trim();
      const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({
        id: 'g_' + Date.now() + '_' + i, name: p.functionCall.name, args: p.functionCall.args || {},
      }));
      return { text, toolCalls, raw: parts };
    },
    async callStream({ messages, apiKey, model, systemPrompt, signal }, onToken) {
      const tools = [{ functionDeclarations: DESKTOP_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      const mdl = model || this.defaultModel;
      const trimmed = trimHistory(messages, 1);
      let fullText = '';
      const allParts = [];
      await httpStream({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${mdl}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`,
        body: {
          systemInstruction: { parts: [{ text: systemPrompt || BASE_SYSTEM_PROMPT }] },
          contents: trimmed, tools,
          generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
        },
        signal,
        onChunk(line) {
          if (!line.startsWith('data: ')) return;
          let evt; try { evt = JSON.parse(line.slice(6)); } catch (_) { return; }
          const cand = evt.candidates && evt.candidates[0];
          const parts = (cand && cand.content && cand.content.parts) || [];
          for (const part of parts) {
            allParts.push(part);
            if (part.text) { fullText += part.text; onToken(part.text); }
          }
        },
      });
      const toolCalls = allParts.filter(p => p.functionCall).map((p, i) => ({
        id: 'g_' + Date.now() + '_' + i, name: p.functionCall.name, args: p.functionCall.args || {},
      }));
      return { text: fullText.trim(), toolCalls, raw: allParts };
    },
    appendVision(messages, visionItems) {
      if (!visionItems.length) return;
      const parts = visionItems.flatMap(v => [
        { inlineData: { mimeType: v.mimeType, data: v.base64 } },
        { text: 'Screenshot from target window (tool result above).' },
      ]);
      messages.push({ role: 'user', parts });
    },
  };
}

function buildProviderRegistry(aiKeys) {
  const registry = {};
  if (aiKeys.ANTHROPIC_API_KEY) registry.anthropic = { adapter: makeAnthropicAdapter(), keyEnv: 'ANTHROPIC_API_KEY', apiKey: aiKeys.ANTHROPIC_API_KEY };
  if (aiKeys.OPENAI_API_KEY) {
    registry.openai = { adapter: makeOpenAIAdapter({ baseHost: 'api.openai.com', label: 'OpenAI', defaultModel: 'gpt-4o' }), keyEnv: 'OPENAI_API_KEY', apiKey: aiKeys.OPENAI_API_KEY };
  }
  if (aiKeys.XAI_API_KEY) {
    registry.grok = { adapter: makeOpenAIAdapter({ baseHost: 'api.x.ai', label: 'Grok', defaultModel: 'grok-2-latest' }), keyEnv: 'XAI_API_KEY', apiKey: aiKeys.XAI_API_KEY };
  }
  if (aiKeys.DASHSCOPE_API_KEY) {
    registry.qwen = { adapter: makeOpenAIAdapter({ baseHost: 'dashscope-intl.aliyuncs.com', basePath: '/compatible-mode/v1/chat/completions', label: 'Qwen', defaultModel: 'qwen-plus' }), keyEnv: 'DASHSCOPE_API_KEY', apiKey: aiKeys.DASHSCOPE_API_KEY };
  }
  if (aiKeys.GEMINI_API_KEY) registry.gemini = { adapter: makeGeminiAdapter(), keyEnv: 'GEMINI_API_KEY', apiKey: aiKeys.GEMINI_API_KEY };
  // Local Gemma via Ollama (OpenAI-compatible API on 127.0.0.1:11434). No API key
  // and no quota -- runs fully offline. Reliability depends on the local model
  // actually supporting tool-calling + vision; weaker/smaller models will struggle
  // with the multi-step desktop loop. The model id follows the brain's reasoning
  // model (SYMPHONEE_REASONING_MODEL, default gemma4:26b).
  // Only offer the local provider when Ollama is actually reachable (cached
  // status, refreshed on boot + periodically), so selecting it can't dead-end in
  // a cryptic ECONNREFUSED after the retry loop. When Ollama is down it simply
  // isn't listed.
  let _ollamaReachable = false;
  try { _ollamaReachable = !!require('../../lib/llm').getChatStatus().reachable; } catch (_) {}
  if (_ollamaReachable) {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
    let host = '127.0.0.1', ollPort = 11434;
    try { const u = new URL(ollamaUrl); host = u.hostname; ollPort = Number(u.port) || 11434; } catch (_) {}
    const gemmaModel = process.env.SYMPHONEE_APPS_MODEL || process.env.SYMPHONEE_REASONING_MODEL || 'gemma4:26b';
    registry.gemma = {
      adapter: makeOpenAIAdapter({
        baseHost: host, port: ollPort, protocol: 'http',
        basePath: '/v1/chat/completions', label: 'Gemma (local)', defaultModel: gemmaModel,
      }),
      keyEnv: null, apiKey: 'ollama', local: true,
    };
  }
  return registry;
}

function pickProvider(registry, preferred) {
  if (preferred && registry[preferred]) return registry[preferred];
  for (const k of ['anthropic', 'openai', 'gemini', 'grok', 'qwen']) {
    if (registry[k]) return registry[k];
  }
  return null;
}

module.exports = { makeAnthropicAdapter, makeOpenAIAdapter, makeGeminiAdapter, buildProviderRegistry, pickProvider, trimHistory, shortenContent, formatChangeNote };
