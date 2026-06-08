// browser-chat-providers -- per-provider LLM adapters (Anthropic / OpenAI-compat
// / Gemini) plus the registry+selection that wires API keys to adapters. Each
// adapter translates the canonical BROWSER_TOOLS schema + message history into
// the provider's wire format and parses tool-calls back out. Split from
// browser-agent-chat.js; the orchestration loop imports buildProviderRegistry +
// pickProvider from here.
const { httpJson, httpStream, httpJsonWithRetry } = require('./browser-chat-http');
const { BASE_SYSTEM_PROMPT, REFINE_SYSTEM_PROMPT } = require('./browser-chat-prompts');
const BROWSER_TOOLS = require('./browser-chat-tools');
const { shortenContent } = require('./browser-chat-util');

const DEFAULT_MAX_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 14;

// ── Provider adapters ──────────────────────────────────────────────────────
// Each adapter exposes:
//   - initMessages(task): seed message log in provider format
//   - appendAssistant(messages, assistantContent): record assistant turn
//   - appendToolResults(messages, pairs): record [{toolUseId, name, resultBlocks}]
//   - call({messages, apiKey, model}) -> Promise<{ text, toolCalls: [{id, name, args}] }>
//   - buildToolResultBlocks(name, result): provider-shaped tool result content

function trimHistory(messages, seedCount) {
  // Keep the first `seedCount` seed messages (initial task) and the most recent MAX_HISTORY_MESSAGES.
  if (messages.length <= seedCount + MAX_HISTORY_MESSAGES) return messages;
  return [...messages.slice(0, seedCount), ...messages.slice(-(MAX_HISTORY_MESSAGES))];
}


function makeAnthropicAdapter() {
  return {
    kind: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    initMessages(task) { return [{ role: 'user', content: task }]; },
    buildToolResultBlocks(name, result) {
      if (name === 'screenshot' && result && result.base64) {
        return [
          { type: 'image', source: { type: 'base64', media_type: result.mimeType || 'image/png', data: result.base64 } },
          { type: 'text', text: 'Screenshot captured.' },
        ];
      }
      if (name === 'read_page' && result) {
        return [{ type: 'text', text: `URL: ${result.url || ''}\nTitle: ${result.title || ''}\n---\n${shortenContent(result.content || '', 2000)}` }];
      }
      if (name === 'get_page_source' && result) {
        return [{ type: 'text', text: `URL: ${result.url || ''}\nTitle: ${result.title || ''}\n--- HTML ---\n${shortenContent(result.html || '', 8000)}` }];
      }
      if (name === 'inspect_dom' && result) {
        return [{ type: 'text', text: shortenContent(JSON.stringify(result, null, 2), 8000) }];
      }
      if (name === 'get_forms' && result) {
        return [{ type: 'text', text: shortenContent(JSON.stringify(result, null, 2), 8000) }];
      }
      if (name === 'query_elements' && result && Array.isArray(result.elements)) {
        return [{ type: 'text', text: formatElements(result.elements) }];
      }
      if (name === 'get_network_log' && result && Array.isArray(result.events)) {
        return [{ type: 'text', text: shortenContent(JSON.stringify(result.events, null, 2), 8000) }];
      }
      if (name === 'get_network_body' && result) {
        return [{ type: 'text', text: shortenContent(JSON.stringify(result, null, 2), 8000) }];
      }
      if (name === 'get_console_log' && result && Array.isArray(result.events)) {
        return [{ type: 'text', text: shortenContent(JSON.stringify(result.events, null, 2), 8000) }];
      }
      const text = result == null ? 'ok' : (typeof result === 'string' ? result : JSON.stringify(result).slice(0, 800));
      return [{ type: 'text', text }];
    },
    appendAssistant(messages, assistantContent) { messages.push({ role: 'assistant', content: assistantContent }); },
    appendToolResults(messages, pairs) {
      messages.push({
        role: 'user',
        content: pairs.map(p => ({ type: 'tool_result', tool_use_id: p.toolUseId, is_error: p.isError || undefined, content: p.blocks })),
      });
    },
    async call({ messages, apiKey, model, systemPrompt, signal }) {
      const tools = BROWSER_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
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
      const tools = BROWSER_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
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
    async refine({ draft, selection, apiKey, model, signal }) {
      const resp = await httpJsonWithRetry({
        hostname: 'api.anthropic.com', path: '/v1/messages',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model: model || this.defaultModel, max_tokens: 512, system: REFINE_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildRefineUserText(draft, selection) }] },
        signal,
      });
      return ((resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '').trim();
    },
  };
}

function makeOpenAIAdapter({ baseHost, basePath = '/v1/chat/completions', label, defaultModel, authHeader = 'Authorization', authPrefix = 'Bearer ' } = {}) {
  return {
    kind: 'openai-compat',
    label: label || 'OpenAI',
    defaultModel,
    initMessages(task) {
      return [
        { role: 'system', content: BASE_SYSTEM_PROMPT },
        { role: 'user', content: task },
      ];
    },
    buildToolResultBlocks(name, result) {
      // OpenAI returns tool results as plain strings in a `tool` message.
      if (name === 'screenshot') return 'Screenshot captured (image omitted; call read_page for a text description of the current state).';
      if (name === 'read_page' && result) return `URL: ${result.url || ''}\nTitle: ${result.title || ''}\n---\n${shortenContent(result.content || '')}`;
      if (name === 'get_page_source' && result) return `URL: ${result.url || ''}\nTitle: ${result.title || ''}\n--- HTML ---\n${shortenContent(result.html || '', 12000)}`;
      if (name === 'inspect_dom' && result) return shortenContent(JSON.stringify(result, null, 2), 12000);
      if (name === 'get_forms' && result) return shortenContent(JSON.stringify(result, null, 2), 12000);
      if (name === 'query_elements' && result && Array.isArray(result.elements)) return formatElements(result.elements);
      if (name === 'get_network_log' && result && Array.isArray(result.events)) return shortenContent(JSON.stringify(result.events, null, 2), 12000);
      if (name === 'get_network_body' && result) return shortenContent(JSON.stringify(result, null, 2), 12000);
      if (name === 'get_console_log' && result && Array.isArray(result.events)) return shortenContent(JSON.stringify(result.events, null, 2), 12000);
      return result == null ? 'ok' : (typeof result === 'string' ? result : JSON.stringify(result).slice(0, 1500));
    },
    appendAssistant(messages, assistantRaw) { messages.push(assistantRaw); },
    appendToolResults(messages, pairs) {
      for (const p of pairs) {
        messages.push({ role: 'tool', tool_call_id: p.toolUseId, content: typeof p.blocks === 'string' ? p.blocks : JSON.stringify(p.blocks) });
      }
    },
    async call({ messages, apiKey, model, systemPrompt, signal }) {
      const tools = BROWSER_TOOLS.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      const trimmed = trimHistory(messages, 2); // seed = system + user
      // Update system message with current systemPrompt if provided.
      if (systemPrompt && trimmed.length && trimmed[0].role === 'system') trimmed[0].content = systemPrompt;
      const resp = await httpJsonWithRetry({
        hostname: baseHost, path: basePath,
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
      const tools = BROWSER_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const trimmed = trimHistory(messages, 2);
      if (systemPrompt && trimmed.length && trimmed[0].role === 'system') trimmed[0].content = systemPrompt;
      let text = '';
      const tcMap = {};
      await httpStream({
        hostname: baseHost, path: basePath,
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
        { type: 'text', text: 'Screenshot from browser (tool result above).' },
      ]);
      messages.push({ role: 'user', content });
    },
    async refine({ draft, selection, apiKey, model, signal }) {
      const resp = await httpJsonWithRetry({
        hostname: baseHost, path: basePath,
        headers: { [authHeader]: authPrefix + apiKey },
        body: {
          model: model || defaultModel, max_tokens: 512,
          messages: [
            { role: 'system', content: REFINE_SYSTEM_PROMPT },
            { role: 'user', content: buildRefineUserText(draft, selection) },
          ],
        },
        signal,
      });
      return ((resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '').trim();
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
      if (name === 'screenshot') return { ok: true, note: 'screenshot captured (image omitted from tool result)' };
      if (name === 'read_page' && result) return { url: result.url, title: result.title, content: shortenContent(result.content || '', 3000) };
      if (name === 'get_page_source' && result) return { url: result.url, title: result.title, html: shortenContent(result.html || '', 12000) };
      if (name === 'inspect_dom' && result) return result;
      if (name === 'get_forms' && result) return result;
      if (name === 'query_elements' && result && Array.isArray(result.elements)) return { elements: result.elements.slice(0, 30) };
      if (name === 'get_network_log' && result && Array.isArray(result.events)) return { events: result.events.slice(-Math.min(result.events.length, 50)) };
      if (name === 'get_network_body' && result) return result;
      if (name === 'get_console_log' && result && Array.isArray(result.events)) return { events: result.events.slice(-Math.min(result.events.length, 50)) };
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
      const tools = [{ functionDeclarations: BROWSER_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      const mdl = model || this.defaultModel;
      const trimmed = trimHistory(messages, 1);
      const resp = await httpJsonWithRetry({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(apiKey)}`,
        body: {
          systemInstruction: { parts: [{ text: systemPrompt || BASE_SYSTEM_PROMPT }] },
          contents: trimmed,
          tools,
          generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
        },
        signal,
      });
      const cand = resp.candidates && resp.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const text = parts.filter(p => p.text).map(p => p.text).join('\n').trim();
      const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({
        id: 'g_' + Date.now() + '_' + i,
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      }));
      return { text, toolCalls, raw: parts };
    },
    async callStream({ messages, apiKey, model, systemPrompt, signal }, onToken) {
      const tools = [{ functionDeclarations: BROWSER_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      const mdl = model || this.defaultModel;
      const trimmed = trimHistory(messages, 1);
      let fullText = '';
      const allParts = [];
      await httpStream({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${mdl}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`,
        body: {
          systemInstruction: { parts: [{ text: systemPrompt || BASE_SYSTEM_PROMPT }] },
          contents: trimmed,
          tools,
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
      const text = fullText.trim();
      const toolCalls = allParts.filter(p => p.functionCall).map((p, i) => ({
        id: 'g_' + Date.now() + '_' + i,
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      }));
      return { text, toolCalls, raw: allParts };
    },
    appendVision(messages, visionItems) {
      if (!visionItems.length) return;
      const parts = visionItems.flatMap(v => [
        { inlineData: { mimeType: v.mimeType, data: v.base64 } },
        { text: 'Screenshot from browser (tool result above).' },
      ]);
      messages.push({ role: 'user', parts });
    },
    async refine({ draft, selection, apiKey, model, signal }) {
      const mdl = model || this.defaultModel;
      const resp = await httpJsonWithRetry({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(apiKey)}`,
        body: {
          systemInstruction: { parts: [{ text: REFINE_SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: buildRefineUserText(draft, selection) }] }],
          generationConfig: { maxOutputTokens: 512 },
        },
        signal,
      });
      const cand = resp.candidates && resp.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      return parts.filter(p => p.text).map(p => p.text).join('\n').trim();
    },
  };
}

function formatElements(elements) {
  const lines = elements.slice(0, 30).map((e, i) => {
    const attrs = [];
    if (e.handle) attrs.push(`handle=${String(e.handle).slice(0, 80)}`);
    if (e.id) attrs.push(`id=${e.id}`);
    if (e.name) attrs.push(`name=${e.name}`);
    if (e.type) attrs.push(`type=${e.type}`);
    if (e.framePath && e.framePath.length) attrs.push(`frame=${e.framePath.join('.')}`);
    if (e.placeholder) attrs.push(`ph="${String(e.placeholder).slice(0, 40)}"`);
    if (e.href) attrs.push(`href=${String(e.href).slice(0, 60)}`);
    const text = (e.text || '').replace(/\s+/g, ' ').slice(0, 80);
    return `${i + 1}. <${e.tag}> ${attrs.join(' ')}${text ? ` :: "${text}"` : ''}`;
  });
  return `Found ${elements.length} element(s):\n${lines.join('\n')}`;
}

// ── Refine helper (shared by all adapters) ─────────────────────────────────

function buildRefineUserText(draft, selection) {
  const parts = [];
  if (selection) {
    parts.push('A page element is currently selected (the agent will receive this JSON). Treat "this"/"it"/"selected" references as pointing to it.');
    parts.push('```json');
    parts.push(JSON.stringify(selection, null, 2));
    parts.push('```');
    parts.push('');
  }
  parts.push('Rough request to refine:');
  parts.push(String(draft || '').trim());
  return parts.join('\n');
}

// ── Provider registry & selection ──────────────────────────────────────────
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
  return registry;
}

function pickProvider(registry, preferred) {
  if (preferred && registry[preferred]) return registry[preferred];
  // Priority order: Anthropic > OpenAI > Gemini > Grok > Qwen.
  for (const k of ['anthropic', 'openai', 'gemini', 'grok', 'qwen']) {
    if (registry[k]) return registry[k];
  }
  return null;
}

module.exports = { makeAnthropicAdapter, makeOpenAIAdapter, makeGeminiAdapter, buildProviderRegistry, pickProvider, trimHistory, formatElements, buildRefineUserText };
