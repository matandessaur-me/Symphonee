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
const learning = require('./apps-learning-loop');
const planner = require('./apps-goal-planner');
const { diffFrames } = require('./apps-frame-diff');

// "Live view" capture: when the model calls screenshot after a pixel-level
// input tool ran, poll until the frame actually differs from the one we last
// showed, or until the wait budget is exhausted. Returning immediately on the
// first delta makes the loop feel live without streaming video, and a
// 'changed: false' readout tells the model its action was a no-op.
const LIVE_POLL_INTERVAL_MS = 150;
const LIVE_POLL_MAX_WAIT_MS = 1500;

// Shared keep-alive agent. agent:false opens a fresh TCP+TLS handshake per
// request, which on Windows occasionally surfaces a spurious
// SSLV3_ALERT_BAD_RECORD_MAC when a handshake races a pending socket close.
// Reusing sockets removes that window and cuts per-step latency too.
const SHARED_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 4,
  maxFreeSockets: 2,
  timeout: 120000,
});

// Hard cap so a runaway loop can't burn unlimited tokens, but high enough
// that a multi-stage real task (search -> scroll -> pick -> confirm -> verify)
// never trips it. Stuck detection via the learning loop catches earlier
// repeats; this is just a safety net.
const MAX_ITERATIONS = 500;
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
    description: 'Scroll inside the current window using mouse-wheel ticks. Pick the axis carefully:\n' +
      '  - dy is VERTICAL: positive dy scrolls DOWN the page (reveals content below), negative dy scrolls UP.\n' +
      '  - dx is HORIZONTAL: positive dx scrolls RIGHT (reveals content to the right), negative dx scrolls LEFT.\n' +
      'NEVER set both dx and dy at once. Choose a single axis per call.\n' +
      'Typical magnitudes: 3 ticks = small nudge, 6 = one "page" on most apps, 15 = long jump. ' +
      'If a horizontal scrollbar is visible and you need to see content hidden on the right, use positive dx, NOT positive dy.',
    parameters: { type: 'object', properties: {
      dx: { type: 'number', description: 'Horizontal ticks. Positive = right, negative = left. Leave out for vertical scrolls.' },
      dy: { type: 'number', description: 'Vertical ticks. Positive = down, negative = up. Leave out for horizontal scrolls.' }
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
    description: 'END the session and hand off to the user. Call this exactly once, only after you have genuinely exhausted your options. Give a specific reason (what you tried, what is blocking you, and what the user should do next). After this call the session stops — you will NOT get another turn, so make the reason actionable.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  { name: 'ask_user',
    description: 'Ask the human user a question when you truly cannot decide what to do next — e.g. credentials, an ambiguous choice, or domain knowledge only they have. Use sparingly: only as a last resort after trying at least two different approaches. Returns their answer as the tool result.',
    parameters: { type: 'object', properties: {
      question: { type: 'string', description: 'The specific question the user needs to answer. Be concrete.' }
    }, required: ['question'] } },
  { name: 'web_research',
    description: 'Search the web for ground-truth information about the target application — keyboard shortcuts, menu paths, concrete setup steps, version-specific quirks. Use this BEFORE you get stuck, not only after. Good queries: "How to add a uniform to vertex shader in KodeLife", "Figma keyboard shortcut for frame". The result is a short summary you can act on.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Specific question. Include the app name and the exact feature you need.' }
    }, required: ['query'] } },
  { name: 'write_memory',
    description: 'Append a short, durable note (<= 2000 bytes) about the current app under a named section (e.g. "UI map", "Keybindings that work", "Known failure modes", "Successful workflows", "Calibration"). Use this to persist anything future sessions on this app would benefit from knowing. Do not dump the screen here; write in terse, decision-useful bullets.',
    parameters: { type: 'object', properties: {
      section: { type: 'string' },
      note: { type: 'string' }
    }, required: ['section', 'note'] } },
  { name: 'read_memory',
    description: 'Re-read the full memory file for the current app if the truncated system-prompt slice is not enough.',
    parameters: { type: 'object', properties: {} } },
  { name: 'set_subgoal',
    description: 'Add or update a subgoal on the plan. Use this to revise the plan when you discover the original decomposition was wrong. If you omit status, new subgoals start as pending. Only one subgoal can be active at a time.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Stable id to edit an existing subgoal. Omit to create a new one.' },
      title: { type: 'string' },
      completionCheck: { type: 'string', description: 'Describe what the screenshot should show when this subgoal is complete.' },
      parentId: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'skipped'] }
    }, required: ['title'] } },
  { name: 'complete_subgoal',
    description: 'Mark a subgoal done and promote the next pending subgoal to active. Call this only after the visual completionCheck is satisfied.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'The subgoal id to mark done. If omitted, the currently active subgoal is used.' },
      evidence: { type: 'string', description: 'One short sentence describing what you saw on screen that confirms completion.' }
    } } },
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
   If you see a "focus_stolen" error on an input tool, it means another window was on top when you tried to click/type. Call focus_window again with the target hwnd before retrying. If it keeps happening, ask_user to bring the app to the front themselves.
6. Scrolling: use ONE axis per call. If you need to reveal content BELOW, use scroll({ dy: 5 }). If you need content to the RIGHT, use scroll({ dx: 5 }). Never set dx and dy in the same call. If vertical scrolling doesn't change the page but a horizontal scrollbar is visible, you need dx, not dy.

## Being honest about limits

- You drive a desktop by clicking pixels and typing keys. You CANNOT reason about arbitrary code, shader math, spreadsheet formulas, or domain content just by looking at a screenshot. If the task is "write a shader / essay / SQL query / formula", you cannot invent the content — the user has to supply it, or you type what they dictated. Do not try to generate it yourself by flailing at the keyboard.
- You cannot play fast-twitch games. If the user asks you to, try gently and call finish with an honest assessment.
- If nothing changes after 3 attempts at the same action, stop and try something different. Repeating the same failing action is worse than calling declare_stuck.
- If a dialog appears that requires the user (payment confirmation, unsaved work prompt, credentials), call declare_stuck with a clear reason.
- declare_stuck ENDS the session. Don't use it as a breadcrumb or status update — use it only when you're done trying.

## Grounding: use web_research proactively

You are NOT expected to know every app by heart. Before you start flailing:
- Call web_research at the start of an unfamiliar task with a concrete query ("How to <thing> in <app>").
- Call web_research whenever a screenshot shows a UI element whose label / purpose you don't recognize.
- Call web_research BEFORE attempting shader / formula / SQL / DSL content — the research tool will surface the exact syntax and bindings the app expects.
- Results are short actionable summaries with source URLs. Trust them over your own guesses about keyboard shortcuts and menu paths.
- web_research is cheap. Spending one research call to avoid 20 failed clicks is always the right trade.

## Escalation ladder when you can't make progress

1. First, try a completely different approach (different tool, keyboard shortcut, menu path). The system will reject exact-duplicate tool calls that just failed — that's a signal to change tactic.
2. Call web_research with a focused query about the specific blocker.
3. If you need information only the user has (credentials, a preference, which of two buttons to click, what the target should look like), call ask_user with a SPECIFIC question. Do not call ask_user for things you could verify yourself with a screenshot or research.
4. Only call declare_stuck as a last resort, after at least one web_research and one ask_user attempt.

## Deliverables

- When the goal is achieved, call finish with a one-paragraph summary of what you did.
- If you cannot achieve the goal, call finish anyway and explain what blocked you.
- Keep intermediate reasoning brief; every message you produce is shown to the user live.

## Writing to memory — ACTIVELY DURING AND AFTER THE SESSION

Use write_memory ONLY with these five canonical section names (they map to the memory file's headings). Anything else is remapped automatically:
- "Instructions"  — user-written guidance; you generally do NOT write here
- "DOs"           — a sequence of steps that actually produced a result
- "DON'T DOs"     — an approach that failed predictably; a future session should skip it
- "Nice to know"  — UI map, where things live, app-specific quirks
- "Keybindings"   — shortcuts you VERIFIED work

Call write_memory at these moments:
1. Right after a NEW shortcut or menu path works first try → section "Keybindings" (shortcut) or "Nice to know" (menu path / location).
2. Right after an approach fails AND you found a workaround → section "DON'T DOs" with the failed path, plus a line in "DOs" with the workaround.
3. Before finish on a successful goal → section "DOs" with the minimal sequence of steps.
4. NEVER write session narration like "Reached N stuck declarations", "I was unable to", "after N attempts". Those are session-local and actively poison future sessions. The system will drop them anyway.

Rules:
- Be TERSE. One decision-useful line per bullet.
- Only write things you verified on screen. No speculation.
- Do NOT repeat what's already in "Prior notes for this app" — only correct or extend it.
- Prefer keyboard shortcuts over click paths; they survive UI changes better.`;

function buildSystemPrompt({ targetApp, targetTitle, plan } = {}) {
  let p = BASE_SYSTEM_PROMPT;
  if (targetApp || targetTitle) {
    p += `\n\n## Current target\n`;
    if (targetApp) p += `App: ${targetApp}\n`;
    if (targetTitle) p += `Window title: ${targetTitle}\n`;
  }
  if (targetApp) p += memory.buildSystemPromptAddition(targetApp);
  if (plan) p += planner.summarizeForPrompt(plan);
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
      agent: SHARED_HTTPS_AGENT,
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

function httpStreamOnce(opts, onStreamStarted) {
  const { hostname, path, method = 'POST', headers = {}, body, onChunk, timeoutMs = 180000, signal } = opts;
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
      agent: SHARED_HTTPS_AGENT,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => reject(new Error(`${hostname} ${res.statusCode}: ${err.slice(0, 600)}`)));
        return;
      }
      let buf = '';
      res.on('data', chunk => {
        if (onStreamStarted) { try { onStreamStarted(); } catch (_) {} }
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

// Retry transient failures (SSL BAD_RECORD_MAC, ECONNRESET, 429) that happen
// before any stream data arrives. Once the server has started emitting
// tokens, restarting would double-emit, so we give up and surface the error.
async function httpStream(opts, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    let started = false;
    try {
      return await httpStreamOnce(opts, () => { started = true; });
    } catch (e) {
      lastErr = e;
      if (!started && isTransientError(e) && i < maxRetries) {
        const wait = e.message && e.message.includes('429') ? (i + 1) * 15000 : (i + 1) * 1500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
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

// Input tools that send mouse / keyboard events to the OS. Before each of
// these runs, we re-assert that the target window is the foreground one
// so a stray click that landed outside (or a notification that stole focus)
// can't redirect subsequent input into an unrelated window.
const INPUT_TOOLS = new Set(['click', 'mouse_move', 'drag', 'scroll', 'type_text', 'key']);

async function executeTool(driver, session, name, args) {
  args = args || {};
  const hwnd = session.hwnd;
  if (INPUT_TOOLS.has(name) && hwnd != null && typeof driver.ensureForeground === 'function') {
    try {
      await driver.ensureForeground(hwnd);
    } catch (e) {
      // Refusing to send input into the wrong window is critical: the agent
      // would otherwise report "nothing changed" and loop forever. Surface
      // the focus-stolen code so the model can react (retry via focus_window
      // tool, call ask_user, or declare_stuck cleanly).
      const err = new Error(e.message || 'focus enforcement failed');
      err.code = e.code || 'focus_failed';
      throw err;
    }
    session._pendingChange = true;
  }
  switch (name) {
    case 'screenshot':
      if (hwnd == null) throw new Error('no target window focused');
      {
        const started = Date.now();
        let shot = await driver.screenshotWindow(hwnd, { format: 'jpeg', quality: 60 });
        // Only poll for a real delta when the model just issued an input tool.
        // Back-to-back screenshots (no action between) return immediately.
        if (session._pendingChange && session.lastShotBase64 && shot && shot.base64) {
          let diff = await diffFrames(session.lastShotBase64, shot.base64);
          while (!diff.changed && !session.stopped && (Date.now() - started) < LIVE_POLL_MAX_WAIT_MS) {
            await new Promise(r => setTimeout(r, LIVE_POLL_INTERVAL_MS));
            const next = await driver.screenshotWindow(hwnd, { format: 'jpeg', quality: 60 });
            if (!next || !next.base64) break;
            shot = next;
            diff = await diffFrames(session.lastShotBase64, shot.base64);
          }
          shot.changed = diff.changed;
          shot.diffScore = diff.score;
          shot.waitedMs = Date.now() - started;
        }
        if (shot && shot.rect) session.lastShotRect = shot.rect;
        if (shot && shot.base64) session.lastShotBase64 = shot.base64;
        session._pendingChange = false;
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
    case 'declare_stuck': {
      // DO NOT write the stuck reason to memory. Stuck reasons are almost
      // always self-narrative noise ("Reached N stuck declarations", "UI did
      // not respond to clicks") that poisons future sessions by making the
      // agent preemptively give up. Real don't-do learnings come from the
      // write_memory tool when the agent explicitly decides something is
      // worth recording. Keep the file clean.
      return { ok: true, stuck: true, reason: args.reason || '' };
    }
    case 'web_research': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('web_research requires a query');
      // Delegate to the same research helper used by the stuck-handler, but
      // scope the question to whatever the agent is asking right now. Live
      // providers (Gemini Live, OpenAI Realtime) use a stub adapter that
      // can't run a classic text turn, so live runners stash a batch-mode
      // counterpart on the session for research to use.
      const providerEntry = session._researchProviderEntry || session._providerEntry;
      const model = session._researchModel || session._model;
      if (!providerEntry) return { ok: false, error: 'No provider bound to session for research.' };
      const research = await require('./apps-learning-loop').runResearch({
        session, providerEntry, model,
        goal: query,
        reason: 'proactive web research',
      });
      if (typeof session._emit === 'function') {
        session._emit({ kind: 'research', provider: research.provider, summary: research.summary });
      }
      return { ok: true, summary: research.summary, provider: research.provider };
    }
    case 'ask_user': {
      const question = String(args.question || '').trim();
      if (!question) throw new Error('ask_user requires a question');
      // Parked promise — resolved when the user POSTs /api/apps/session/answer.
      // Times out after 5 minutes so a forgotten prompt doesn't hang forever.
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          session._pendingAsk = null;
          resolve({ ok: false, timedOut: true, message: 'No answer in 5 minutes. Continue without user input or call declare_stuck.' });
        }, 5 * 60 * 1000);
        session._pendingAsk = {
          question,
          resolve: (answer) => {
            clearTimeout(timer);
            session._pendingAsk = null;
            resolve({ ok: true, answer: String(answer || '').trim() });
          },
        };
        // Emit so the UI can render an inline input.
        if (typeof session._emit === 'function') {
          session._emit({ kind: 'ask', question });
        }
      });
    }
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
    case 'set_subgoal': {
      if (!session.plan) session.plan = planner.createEmptyPlan(session.goal);
      const sg = planner.addSubgoal(session.plan, {
        id: args.id, title: args.title, completionCheck: args.completionCheck,
        parentId: args.parentId, status: args.status,
      });
      return { ok: true, subgoal: sg, activeId: session.plan.activeId };
    }
    case 'complete_subgoal': {
      if (!session.plan) throw new Error('no plan on this session; call set_subgoal first');
      const id = args.id || session.plan.activeId;
      if (!id) throw new Error('no active subgoal to complete');
      return planner.completeSubgoal(session.plan, id, args.evidence);
    }
    case 'finish': {
      // Only record the final summary to memory when it looks like an
      // ACTUAL success. Reject summaries that read as failure narration so
      // the memory file keeps its signal-to-noise ratio.
      const summary = String(args.summary || '').trim();
      const looksLikeFailure = !summary || /\b(stuck|unable|cannot|could not|didn't work|did not work|gave up|handed off|reached \d+|failed|blocked|no progress|not respond)\b/i.test(summary);
      if (session.app && summary && !looksLikeFailure) {
        try {
          memory.appendSection(session.app, 'Successful workflows',
            `"${(session.goal || '').slice(0, 80)}": ${summary.slice(0, 320)}`);
        } catch (_) {}
      }
      return { ok: true, finished: true, summary };
    }
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
    case 'set_subgoal': return `Subgoal: ${String(args.title || '').slice(0, 60)}${args.status ? ' (' + args.status + ')' : ''}`;
    case 'complete_subgoal': return `Complete subgoal${args.id ? ' ' + args.id : ''}${args.evidence ? ': ' + String(args.evidence).slice(0, 40) : ''}`;
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
  session._emit = emit; // so executeTool (ask_user) can push UI events too.
  session._providerEntry = providerEntry;
  session._model = model;
  emit({ kind: 'provider', provider: providerEntry.adapter.kind, label: providerEntry.adapter.label });

  if (session.app) {
    try { memory.bumpSession(session.app); } catch (_) {}
    try {
      const body = memory.loadMemory(session.app) || '';
      const bytes = Buffer.byteLength(body, 'utf8');
      emit({ kind: 'memory_loaded', app: memory.normalizeApp(session.app), bytes, hasInstructions: /##\s*Instructions[\s\S]*?\S/i.test(body) });
    } catch (_) {}
  } else {
    emit({ kind: 'memory_loaded', app: null, bytes: 0, hasInstructions: false, reason: 'no app key on session' });
  }

  // Decompose the goal into subgoals. Best-effort; if decomposition fails
  // we still run the session as a single flat goal.
  if (!session.plan) session.plan = planner.createEmptyPlan(session.goal || task);
  if (session.plan.subgoals.length === 0 && session.goal) {
    try {
      const subs = await planner.decompose({ goal: session.goal, app: session.app, providerEntry, model });
      if (Array.isArray(subs) && subs.length) {
        for (const s of subs) planner.addSubgoal(session.plan, { title: s.title, completionCheck: s.completionCheck });
        emit({ kind: 'plan', subgoals: session.plan.subgoals.map(s => ({ id: s.id, title: s.title, completionCheck: s.completionCheck, status: s.status })), activeId: session.plan.activeId });
      }
    } catch (_) {}
  }

  const systemPrompt = buildSystemPrompt({ targetApp: session.app, targetTitle: session.title, plan: session.plan });

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
      let stuckSignal = null;
      const lastActionsForObserver = [];
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
        // Retry-with-variation guard: if this exact call recently failed,
        // reject it before executing so the model must try something new.
        const dup = learning.alreadyFailedIdentically(session, tc.name, tc.args);
        if (dup) {
          const msg = `Already tried ${tc.name} with these exact args and it failed. Try a different approach (different coordinates, a different tool, or declare_stuck).`;
          const errBlock = providerEntry.adapter.kind === 'anthropic' ? [{ type: 'text', text: msg }] : msg;
          pairs.push({ toolUseId: tc.id, name: tc.name, blocks: errBlock, isError: true });
          emit({ kind: 'observation', tool: tc.name, ok: false, error: msg, code: 'already_tried' });
          learning.trackTry(session, tc.name, tc.args);
          lastActionsForObserver.push({ tool: tc.name, summary: describeAction(tc.name, tc.args), ok: false, error: 'already_tried' });
          // Persist the failing call so future sessions skip it without
          // rediscovering the dead end every time. Only once per unique key.
          if (session.app && !(session._dontRetryNoted || (session._dontRetryNoted = new Set())).has(dup.key)) {
            session._dontRetryNoted.add(dup.key);
            try {
              memory.appendSection(session.app, "DON'T DOs",
                `${describeAction(tc.name, tc.args)} — failed identically twice, use a different tool or coordinates.`);
            } catch (_) {}
          }
          continue;
        }
        try {
          learning.trackTry(session, tc.name, tc.args);
          const result = await executeTool(driver, session, tc.name, tc.args);
          learning.recordOutcome(session, tc.name, tc.args, true);
          // Successful action: progress, not an attempt. Attempt counts
          // only increment for failures (see catch branch below).
          // Broadcast plan updates after set_subgoal / complete_subgoal.
          if ((tc.name === 'set_subgoal' || tc.name === 'complete_subgoal') && session.plan) {
            emit({ kind: 'plan', subgoals: session.plan.subgoals.map(s => ({ id: s.id, title: s.title, completionCheck: s.completionCheck, status: s.status, evidence: s.evidence, attempts: s.attempts })), activeId: session.plan.activeId });
            // Reset the auto-stuck latch when a subgoal completes so the
            // next subgoal gets its own budget.
            if (tc.name === 'complete_subgoal') session._autoStuckFired = false;
          }
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
            emit({
              kind: 'screenshot',
              base64: result.base64,
              mimeType: result.mimeType || 'image/jpeg',
              width: result.width,
              height: result.height,
              rect: result.rect,
              changed: result.changed,
              diffScore: result.diffScore,
              waitedMs: result.waitedMs,
            });
            learning.noteScreenshot(session, result);
          }
          learning.noteAction(session, tc.name);
          // Record successful input-level actions so the user can later
          // export the session as a reusable recipe.
          if (['click', 'type_text', 'key', 'scroll', 'drag', 'wait_ms'].includes(tc.name)) {
            if (!Array.isArray(session._recordedActions)) session._recordedActions = [];
            session._recordedActions.push({ name: tc.name, args: tc.args || {}, at: Date.now() });
          }
          lastActionsForObserver.push({ tool: tc.name, summary: describeAction(tc.name, tc.args), ok: true });
          emit({ kind: 'observation', tool: tc.name, ok: true, preview: summarizeResultForUi(tc.name, result) });
          if (tc.name === 'finish') { finished = true; finalSummary = (tc.args && tc.args.summary) || 'Done.'; break; }
          if (tc.name === 'declare_stuck') {
            // declare_stuck is terminal. Ending here is what lets the user
            // actually take over instead of the agent looping on "I am stuck"
            // while burning tokens. The reason goes into the done summary.
            const reason = (tc.args && tc.args.reason) || 'declared stuck';
            stuckSignal = reason;
            finished = true;
            finalSummary = `Stopped for user takeover. ${reason}`;
            emit({ kind: 'stuck', reason });
            break;
          }
        } catch (e) {
          learning.recordOutcome(session, tc.name, tc.args, false);
          const errText = 'Error: ' + (e.message || String(e)) + (e.code ? ` (${e.code})` : '');
          const errBlock = providerEntry.adapter.kind === 'anthropic' ? [{ type: 'text', text: errText }] : errText;
          pairs.push({ toolUseId: tc.id, name: tc.name, blocks: errBlock, isError: true });
          emit({ kind: 'observation', tool: tc.name, ok: false, error: e.message, code: e.code || null });
          lastActionsForObserver.push({ tool: tc.name, summary: describeAction(tc.name, tc.args), ok: false, error: e.message });
          // Failed tool against the current subgoal counts toward its
          // attempt budget; trip auto-stuck when exceeded.
          if (session.plan) {
            const bump = planner.bumpAttempt(session.plan, { failed: true });
            if (bump.overBudget && !session._autoStuckFired) {
              session._autoStuckFired = true;
              stuckSignal = `${bump.attempts} failed attempts on "${bump.subgoal.title}"`;
              emit({ kind: 'stuck', reason: stuckSignal });
            }
          }
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

      // Stuck detection: either explicit declare_stuck or heuristic.
      // When declare_stuck fired, we already emitted the 'stuck' frame
      // inside the tool loop, so don't re-emit here (that was the source of
      // the duplicate "Stuck: ..." rows in the activity panel).
      let emittedStuckAlready = !!stuckSignal;
      if (!stuckSignal) {
        const probe = learning.isStuck(session);
        if (probe.stuck) stuckSignal = probe.reason;
      }
      if (stuckSignal) {
        session._stuckCount = (session._stuckCount || 0) + 1;
        // Cap research calls at 2 per session so we don't spend unbounded
        // tokens hitting web_search when the agent genuinely can't recover.
        const researchBudget = 2;
        session._researchCount = session._researchCount || 0;

        if (!emittedStuckAlready) emit({ kind: 'stuck', reason: stuckSignal });

        // First stuck -> research + strategy reminder.
        // Second stuck -> fresh research + HARDER switch directive.
        // Third+ stuck -> skip research (already tried), force declare_stuck.
        if (session._researchCount < researchBudget) {
          session._researchCount++;
          const research = await learning.runResearch({
            session, providerEntry, model,
            goal: session.goal || task.slice(0, 200),
            reason: stuckSignal,
          });
          emit({ kind: 'research', provider: research.provider, summary: research.summary });
          const escalator = session._stuckCount >= 2
            ? `You are stuck for the ${session._stuckCount}${session._stuckCount === 2 ? 'nd' : 'rd+'} time. Stop repeating what you were doing. Do ALL of the following before your next action:\n` +
              `1) List the 2-3 approaches you've already tried.\n` +
              `2) Pick exactly ONE new approach you have NOT tried — prefer keyboard shortcuts, menus, or right-click context menus over more clicking.\n` +
              `3) If nothing new remains, call declare_stuck with a clear reason and stop.`
            : `You are stuck. Use the research below to try a DIFFERENT approach (different tool, different coordinates, a keyboard shortcut, or a menu path). Do NOT repeat what you just tried.`;
          const inject = `${escalator}\n\nResearch notes:\n\n${research.summary}`;
          if (providerEntry.adapter.kind === 'gemini') session.messages.push({ role: 'user', parts: [{ text: inject }] });
          else session.messages.push({ role: 'user', content: inject });
        } else {
          // Already researched twice and still stuck — hand off rather than loop.
          const handoff = `You've been stuck ${session._stuckCount} times and research didn't unblock you. Call declare_stuck with a one-sentence reason and stop. The user will take over.`;
          if (providerEntry.adapter.kind === 'gemini') session.messages.push({ role: 'user', parts: [{ text: handoff }] });
          else session.messages.push({ role: 'user', content: handoff });
        }
        // Reset the same-tool streak so the next stuck-detection pass isn't
        // triggered by the exact same signal instantly.
        if (session._sameToolStreak) session._sameToolStreak = { tool: null, n: 0 };
      }

      // Observer pass: every N actions, fire-and-forget a side call to
      // capture anything memory-worthy.
      if (learning.shouldObserve(session)) {
        // Don't block the main loop on this; fire concurrently.
        learning.runObserver({
          session, providerEntry, model,
          lastActions: lastActionsForObserver,
        }).then(r => {
          if (r && r.wrote) {
            emit({ kind: 'memory', section: r.section, note: r.note, source: 'observer' });
          }
        }).catch(() => {});
      }
    }
    if (!finalSummary) finalSummary = iter >= MAX_ITERATIONS ? `Stopped after ${MAX_ITERATIONS} steps.` : 'Done.';
    emit({ kind: 'done', summary: finalSummary });
    return { ok: true, summary: finalSummary, iterations: iter };
  } catch (e) {
    emit({ kind: 'error', message: e.message });
    return { ok: false, error: e.message };
  } finally {
    session.running = false;
    // Drop the topmost pin we installed at focus/launch time so the window
    // behaves normally when the agent is no longer driving it.
    if (session.hwnd != null && driver && typeof driver.unpinTopmost === 'function') {
      driver.unpinTopmost(session.hwnd).catch(() => {});
    }
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
