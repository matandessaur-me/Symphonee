/**
 * Apps Agent Chat - natural-language driver over any running Windows
 * application via DesktopDriver (nut.js + PowerShell).
 *
 * Mirrors dashboard/browser-agent-chat.js: provider-agnostic tool-use
 * loop with Anthropic / OpenAI-compatible / Gemini adapters, vision
 * injection for screenshots, streaming where supported.
 *
 * Phase 2 scope: low-level pixel + keyboard tools only. Memory,
 * research sub-tasks, and goal decomposition land in later phases.
 */

const https = require('https');
const memory = require('./apps-memory');

const MAX_ITERATIONS = 40;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 14;

// Canonical tool set for desktop control. Each provider adapter
// translates to its own shape.
const DESKTOP_TOOLS = [
  { name: 'screenshot',
    description: 'Capture a JPEG screenshot of the currently targeted application window. Always call this first and after any action that might have changed the screen.',
    parameters: { type: 'object', properties: {} } },
  { name: 'list_windows',
    description: 'Return the list of currently visible top-level windows on the desktop with process name, title, HWND, and bounding rect.',
    parameters: { type: 'object', properties: {} } },
  { name: 'focus_window',
    description: 'Bring a window to the foreground and make it the active target for subsequent actions. Use the hwnd from list_windows.',
    parameters: { type: 'object', properties: { hwnd: { type: 'number', description: 'The window handle (integer) returned by list_windows.' } }, required: ['hwnd'] } },
  { name: 'click',
    description: 'Click at a window-relative pixel coordinate inside the current target window. Coordinates are relative to the top-left of the window.',
    parameters: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default: left.' },
      double: { type: 'boolean', description: 'Double-click when true.' }
    }, required: ['x', 'y'] } },
  { name: 'mouse_move',
    description: 'Move the mouse to a window-relative coordinate without clicking. Useful for hover states and calibration.',
    parameters: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
      smooth: { type: 'boolean', description: 'If true, move gradually along a path rather than teleporting.' }
    }, required: ['x', 'y'] } },
  { name: 'drag',
    description: 'Press, move, and release the left mouse button from one window-relative coordinate to another.',
    parameters: { type: 'object', properties: {
      fromX: { type: 'number' }, fromY: { type: 'number' },
      toX: { type: 'number' }, toY: { type: 'number' }
    }, required: ['fromX', 'fromY', 'toX', 'toY'] } },
  { name: 'scroll',
    description: 'Scroll inside the current window. Positive dy scrolls down, positive dx scrolls right. Units are mouse-wheel ticks.',
    parameters: { type: 'object', properties: {
      dx: { type: 'number' }, dy: { type: 'number' }
    } } },
  { name: 'type_text',
    description: 'Type a literal string of characters into the focused window. Does NOT interpret special keys like Enter or Tab; use key for those.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'key',
    description: 'Send a single keyboard combo like "Enter", "Ctrl+S", "Alt+F4", "F11", "Escape".',
    parameters: { type: 'object', properties: { combo: { type: 'string' } }, required: ['combo'] } },
  { name: 'wait_ms',
    description: 'Pause for N milliseconds to let the UI settle after an action. Capped at 60000.',
    parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
  { name: 'calibrate_mouse_look',
    description: 'For 3D / FPS games: move the mouse by a known pixel delta and screenshot before and after, so you can figure out how many pixels per camera degree this game uses.',
    parameters: { type: 'object', properties: { testDeltaPx: { type: 'number', description: 'How far to move the mouse in x. Default 200.' } } } },
  { name: 'declare_stuck',
    description: 'Call this if you have tried several approaches without progress and need to pause for research or user input. Include a short reason.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  { name: 'write_memory',
    description: 'Append a short, durable note (<= 2000 bytes) about the current app under a named section (e.g. "UI map", "Keybindings that work", "Known failure modes", "Successful workflows", "Calibration"). Use this to persist anything future sessions on this app would benefit from knowing. Do not dump the screen here; write in terse, decision-useful bullets.',
    parameters: { type: 'object', properties: {
      section: { type: 'string' },
      note: { type: 'string' }
    }, required: ['section', 'note'] } },
  { name: 'read_memory',
    description: 'Re-read the full memory file for the current app if the truncated system-prompt slice is not enough.',
    parameters: { type: 'object', properties: {} } },
  { name: 'finish',
    description: 'Stop the loop and return a final summary.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];

const BASE_SYSTEM_PROMPT = `You drive a Windows desktop application on the user's behalf by taking screenshots and issuing pixel-level mouse and keyboard actions. You are watching the target window over a cloud connection: expect 1-4 seconds of latency per tool call.

## How to work

1. Start by calling screenshot to see what the window currently looks like. The image is in the tool result above; you MUST look at it before planning the next action.
2. All coordinates are WINDOW-RELATIVE: (0,0) is the top-left of the target window, not the screen. You never see absolute screen positions and you never need to think about them.
3. After any action that could change the screen (click, type_text, key, scroll, drag), call screenshot again before deciding the next step. Do not issue multiple clicks without screenshotting between them.
4. Use key for named keys (Enter, Tab, Escape, Ctrl+S, Alt+F4). Use type_text only for literal characters. Passing "\\n" to type_text will NOT press Enter; use key("Enter").
5. If the window closes, minimizes, or moves, the driver will tell you in the error. Re-list windows and refocus before continuing.

## Being honest about limits

- You cannot play fast-twitch games. If the user asks you to, try gently and call finish with an honest assessment.
- If nothing changes after 3 attempts at the same action, stop and try something different. Repeating the same failing action is worse than calling declare_stuck.
- If a dialog appears that requires the user (payment confirmation, unsaved work prompt, credentials), call declare_stuck with a clear reason.

## Deliverables

- When the goal is achieved, call finish with a one-paragraph summary of what you did.
- If you cannot achieve the goal, call finish anyway and explain what blocked you.
- Keep intermediate reasoning brief; every message you produce is shown to the user live.`;

function buildSystemPrompt({ targetApp, targetTitle } = {}) {
  let p = BASE_SYSTEM_PROMPT;
  if (targetApp || targetTitle) {
    p += `\n\n## Current target\n`;
    if (targetApp) p += `App: ${targetApp}\n`;
    if (targetTitle) p += `Window title: ${targetTitle}\n`;
  }
  if (targetApp) p += memory.buildSystemPromptAddition(targetApp);
  return p;
}

// ---- HTTP helpers (same shape as browser-agent-chat) ----

function bindAbort(req, signal, reject, label) {
  if (!signal) return () => {};
  const onAbort = () => {
    try { req.destroy(new Error(label || 'Request aborted')); } catch (_) {}
    try { reject(new Error(label || 'Request aborted')); } catch (_) {}
  };
  if (signal.aborted) { onAbort(); return () => {}; }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { try { signal.removeEventListener('abort', onAbort); } catch (_) {} };
}

function isAbortError(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('request aborted') || msg.includes('stream aborted') || msg.includes('aborted');
}

function httpJson({ hostname, path, method = 'POST', headers = {}, body, timeoutMs = 90000, signal }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`${hostname} ${res.statusCode}: ${data.slice(0, 600)}`));
        }
      });
    });
    const cleanup = bindAbort(req, signal, reject, `${hostname} request aborted`);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(hostname + ' request timed out')));
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanup);
  });
}

function httpStream({ hostname, path, method = 'POST', headers = {}, body, onChunk, timeoutMs = 180000, signal }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => reject(new Error(`${hostname} ${res.statusCode}: ${err.slice(0, 600)}`)));
        return;
      }
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) { try { onChunk(line); } catch (_) {} }
      });
      res.on('end', () => { if (buf.trim()) { try { onChunk(buf); } catch (_) {} } resolve(); });
      res.on('error', reject);
    });
    const cleanup = bindAbort(req, signal, reject, `${hostname} stream aborted`);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(hostname + ' stream timed out')));
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanup);
  });
}

function isTransientError(e) {
  const msg = e.message || '';
  return msg.includes('429') || msg.includes('SSL') || msg.includes('BAD_RECORD_MAC') ||
    msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
    msg.includes('socket hang up') || msg.includes('timed out');
}

async function httpJsonWithRetry(opts, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await httpJson(opts); } catch (e) {
      lastErr = e;
      if (isTransientError(e) && i < maxRetries) {
        const wait = e.message && e.message.includes('429') ? (i + 1) * 15000 : (i + 1) * 1500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function trimHistory(messages, seedCount) {
  if (messages.length <= seedCount + MAX_HISTORY_MESSAGES) return messages;
  return [...messages.slice(0, seedCount), ...messages.slice(-MAX_HISTORY_MESSAGES)];
}

function shortenContent(text, n = 4000) {
  if (!text) return '';
  const s = String(text);
  return s.length <= n ? s : s.slice(0, n) + `\n[truncated ${s.length - n} chars]`;
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
        return [
          { type: 'image', source: { type: 'base64', media_type: result.mimeType || 'image/jpeg', data: result.base64 } },
          { type: 'text', text: `Screenshot ${result.width}x${result.height}. ${rectNote}` },
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
      if (name === 'screenshot' && result && result.base64) {
        // String tool-result; actual image is attached as a separate user
        // message via appendVision below.
        return `Screenshot ${result.width}x${result.height} captured. Rect x=${result.rect && result.rect.x} y=${result.rect && result.rect.y} w=${result.rect && result.rect.w} h=${result.rect && result.rect.h}.`;
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
      const tools = DESKTOP_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
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
        return { ok: true, width: result.width, height: result.height, rect: result.rect };
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
  return registry;
}

function pickProvider(registry, preferred) {
  if (preferred && registry[preferred]) return registry[preferred];
  for (const k of ['anthropic', 'openai', 'gemini', 'grok', 'qwen']) {
    if (registry[k]) return registry[k];
  }
  return null;
}

// ---- Tool dispatch (calls into apps-driver) ----

async function executeTool(driver, session, name, args) {
  args = args || {};
  const hwnd = session.hwnd;
  switch (name) {
    case 'screenshot':
      if (hwnd == null) throw new Error('no target window focused');
      {
        const shot = await driver.screenshotWindow(hwnd, { format: 'jpeg', quality: 60 });
        if (shot && shot.rect) session.lastShotRect = shot.rect;
        return shot;
      }
    case 'list_windows':
      return await driver.listWindows({ force: true });
    case 'focus_window': {
      const r = await driver.focusWindow(args.hwnd);
      session.hwnd = args.hwnd;
      session.title = r.title;
      return r;
    }
    case 'click': {
      if (hwnd == null) throw new Error('no target window focused');
      // If the window has moved more than a tolerance since the last
      // screenshot, refuse the click so the agent takes a fresh screenshot
      // instead of clicking where the window USED to be.
      if (session.lastShotRect) {
        await driver.verifyStableRect(hwnd, session.lastShotRect);
      }
      return await driver.click(args.x, args.y, { hwnd, button: args.button, double: !!args.double });
    }
    case 'mouse_move':
      if (hwnd == null) throw new Error('no target window focused');
      return await driver.mouseMove(args.x, args.y, { hwnd, smooth: !!args.smooth });
    case 'drag':
      if (hwnd == null) throw new Error('no target window focused');
      return await driver.drag(args.fromX, args.fromY, args.toX, args.toY, { hwnd });
    case 'scroll':
      if (hwnd == null) throw new Error('no target window focused');
      return await driver.scroll(args.dx || 0, args.dy || 0, { hwnd });
    case 'type_text':
      if (hwnd == null) throw new Error('no target window focused');
      return await driver.type(args.text, { hwnd });
    case 'key':
      if (hwnd == null) throw new Error('no target window focused');
      return await driver.key(args.combo, { hwnd });
    case 'wait_ms':
      return await driver.waitMs(args.ms);
    case 'calibrate_mouse_look':
      if (hwnd == null) throw new Error('no target window focused');
      return await driver.calibrateMouseLook({ hwnd, testDeltaPx: args.testDeltaPx });
    case 'declare_stuck':
      return { ok: true, stuck: true, reason: args.reason || '' };
    case 'write_memory': {
      const app = session.app;
      if (!app) throw new Error('no app identified for this session; writeMemory needs an app');
      return memory.appendSection(app, String(args.section || '').trim(), String(args.note || '').trim());
    }
    case 'read_memory': {
      const app = session.app;
      if (!app) throw new Error('no app identified for this session; readMemory needs an app');
      return { app: memory.normalizeApp(app), body: memory.loadMemory(app) };
    }
    case 'finish':
      return { ok: true, finished: true, summary: args.summary || '' };
    default:
      throw new Error('unknown tool: ' + name);
  }
}

function describeAction(name, args) {
  args = args || {};
  switch (name) {
    case 'screenshot': return 'Screenshot';
    case 'list_windows': return 'List windows';
    case 'focus_window': return `Focus hwnd=${args.hwnd}`;
    case 'click': return `Click (${args.x}, ${args.y})${args.double ? ' x2' : ''}${args.button && args.button !== 'left' ? ` ${args.button}` : ''}`;
    case 'mouse_move': return `Move to (${args.x}, ${args.y})${args.smooth ? ' smooth' : ''}`;
    case 'drag': return `Drag (${args.fromX}, ${args.fromY}) -> (${args.toX}, ${args.toY})`;
    case 'scroll': return `Scroll dx=${args.dx || 0} dy=${args.dy || 0}`;
    case 'type_text': return `Type "${String(args.text || '').slice(0, 40)}"`;
    case 'key': return `Key ${args.combo}`;
    case 'wait_ms': return `Wait ${args.ms}ms`;
    case 'calibrate_mouse_look': return `Calibrate mouse look (${args.testDeltaPx || 200}px)`;
    case 'declare_stuck': return `Declare stuck: ${args.reason || ''}`;
    case 'write_memory': return `Memory <- [${args.section || '?'}] ${String(args.note || '').slice(0, 60)}`;
    case 'read_memory': return 'Read memory';
    case 'finish': return `Finish: ${String(args.summary || '').slice(0, 80)}`;
    default: return name;
  }
}

// ---- Session + runner ----

class AppsSession {
  constructor(id) {
    this.id = id;
    this.providerKind = null;
    this.messages = [];
    this.hwnd = null;
    this.app = null;
    this.title = null;
    this.goal = null;
    this.stopped = false;
    this.running = false;
    this.abortController = null;
    this.createdAt = Date.now();
  }
}

const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, new AppsSession(id));
  return sessions.get(id);
}

function pruneSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (!s.running && s.createdAt < cutoff) sessions.delete(id);
  }
}

async function runSession({ session, task, driver, providerEntry, model, broadcast }) {
  session.running = true;
  const emit = (step) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId: session.id, ...step, at: Date.now() });
    }
  };
  emit({ kind: 'provider', provider: providerEntry.adapter.kind, label: providerEntry.adapter.label });

  if (session.app) {
    try { memory.bumpSession(session.app); } catch (_) {}
  }
  const systemPrompt = buildSystemPrompt({ targetApp: session.app, targetTitle: session.title });

  // Reset thread state when provider changes.
  if (session.providerKind !== providerEntry.adapter.kind) {
    session.messages = providerEntry.adapter.initMessages(task);
    session.providerKind = providerEntry.adapter.kind;
  } else {
    if (providerEntry.adapter.kind === 'gemini') session.messages.push({ role: 'user', parts: [{ text: task }] });
    else session.messages.push({ role: 'user', content: task });
  }
  emit({ kind: 'user', text: task });

  let iter = 0;
  let finalSummary = null;
  const recentActions = [];
  try {
    while (iter < MAX_ITERATIONS) {
      if (session.stopped) { emit({ kind: 'stopped' }); break; }
      iter++;
      emit({ kind: 'thinking', iter });
      let resp;
      try {
        session.abortController = new AbortController();
        if (typeof providerEntry.adapter.callStream === 'function') {
          resp = await providerEntry.adapter.callStream({
            messages: session.messages, apiKey: providerEntry.apiKey, model,
            systemPrompt, signal: session.abortController.signal,
          }, (delta) => emit({ kind: 'token', text: delta }));
        } else {
          resp = await providerEntry.adapter.call({
            messages: session.messages, apiKey: providerEntry.apiKey, model,
            systemPrompt, signal: session.abortController.signal,
          });
        }
      } catch (e) {
        if (session.stopped && isAbortError(e)) { emit({ kind: 'stopped' }); return { ok: true, stopped: true }; }
        emit({ kind: 'error', message: providerEntry.adapter.label + ' API error: ' + e.message });
        session.running = false;
        return { ok: false, error: e.message };
      } finally {
        session.abortController = null;
      }

      if (resp.text) emit({ kind: 'message', text: resp.text });
      providerEntry.adapter.appendAssistant(session.messages, resp.raw);

      if (!resp.toolCalls.length) {
        finalSummary = resp.text || 'Done.';
        break;
      }

      const pairs = [];
      let finished = false;
      for (const tc of resp.toolCalls) {
        if (session.stopped) break;
        emit({ kind: 'action', tool: tc.name, args: tc.args, summary: describeAction(tc.name, tc.args) });
        const actionKey = tc.name + ':' + JSON.stringify(tc.args);
        recentActions.push(actionKey);
        if (recentActions.length > 6 && recentActions.slice(-4).every(a => a === actionKey)) {
          emit({ kind: 'observation', tool: tc.name, ok: false, error: 'Loop detected: same action repeated. Stopping.' });
          finalSummary = 'Stopped: the same action was repeated without progress.';
          finished = true; break;
        }
        try {
          const result = await executeTool(driver, session, tc.name, tc.args);
          pairs.push({
            toolUseId: tc.id, name: tc.name,
            blocks: providerEntry.adapter.buildToolResultBlocks(tc.name, result),
            isError: false,
            visionData: (tc.name === 'screenshot' && result && result.base64)
              ? { base64: result.base64, mimeType: result.mimeType || 'image/jpeg' } : null,
          });
          // Broadcast screenshots so the UI can show the live view even
          // when the tool result itself is consumed by the model.
          if (tc.name === 'screenshot' && result && result.base64) {
            emit({ kind: 'screenshot', base64: result.base64, mimeType: result.mimeType || 'image/jpeg', width: result.width, height: result.height, rect: result.rect });
          }
          emit({ kind: 'observation', tool: tc.name, ok: true, preview: summarizeResultForUi(tc.name, result) });
          if (tc.name === 'finish') { finished = true; finalSummary = (tc.args && tc.args.summary) || 'Done.'; break; }
          if (tc.name === 'declare_stuck') {
            emit({ kind: 'stuck', reason: (tc.args && tc.args.reason) || '' });
          }
        } catch (e) {
          const errText = 'Error: ' + (e.message || String(e)) + (e.code ? ` (${e.code})` : '');
          const errBlock = providerEntry.adapter.kind === 'anthropic' ? [{ type: 'text', text: errText }] : errText;
          pairs.push({ toolUseId: tc.id, name: tc.name, blocks: errBlock, isError: true });
          emit({ kind: 'observation', tool: tc.name, ok: false, error: e.message, code: e.code || null });
        }
      }
      if (pairs.length) {
        providerEntry.adapter.appendToolResults(session.messages, pairs);
        if (typeof providerEntry.adapter.appendVision === 'function') {
          const visionItems = pairs.filter(p => !p.isError && p.visionData).map(p => p.visionData);
          if (visionItems.length) providerEntry.adapter.appendVision(session.messages, visionItems);
        }
      }
      if (finished) break;
    }
    if (!finalSummary) finalSummary = iter >= MAX_ITERATIONS ? `Stopped after ${MAX_ITERATIONS} steps.` : 'Done.';
    emit({ kind: 'done', summary: finalSummary });
    return { ok: true, summary: finalSummary, iterations: iter };
  } catch (e) {
    emit({ kind: 'error', message: e.message });
    return { ok: false, error: e.message };
  } finally {
    session.running = false;
    pruneSessions();
  }
}

function summarizeResultForUi(name, result) {
  if (result == null) return 'ok';
  if (name === 'screenshot') return `screenshot ${result.width}x${result.height}`;
  if (name === 'list_windows') return `${Array.isArray(result) ? result.length : 0} windows`;
  if (typeof result === 'string') return result.slice(0, 120);
  try { return JSON.stringify(result).slice(0, 180); } catch (_) { return 'ok'; }
}

module.exports = {
  DESKTOP_TOOLS,
  BASE_SYSTEM_PROMPT,
  buildProviderRegistry,
  pickProvider,
  runSession,
  getSession,
  sessions,
  describeAction,
  executeTool,
};
