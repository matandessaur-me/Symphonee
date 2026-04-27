/**
 * Browser Agent Chat - natural-language driver over the in-app webview.
 *
 * Runs a tool-use loop: user types a task, an LLM decides which browser
 * primitive to call, we execute it against the in-app webview, and each step
 * is broadcast over the main WebSocket for the UI to render live.
 *
 * Provider-agnostic. Works with whichever CLI/API key the user has:
 *   - Anthropic (ANTHROPIC_API_KEY)
 *   - OpenAI-compatible: OpenAI, xAI Grok, Qwen/DashScope (OPENAI_API_KEY / XAI_API_KEY / DASHSCOPE_API_KEY)
 *   - Google Gemini (GEMINI_API_KEY)
 *
 * All providers speak the same internal tool schema; per-provider adapters
 * translate on the way out and parse tool-calls on the way in.
 */

const https = require('https');

const MAX_ITERATIONS = 30;
const DEFAULT_MAX_TOKENS = 1024;
// Keep the seed message + this many recent messages in context to control token usage.
// Each "turn" is 2 messages (assistant + tool_result), so 12 = 6 turns.
const MAX_HISTORY_MESSAGES = 14;

// Canonical tool set. Each provider adapter translates to its own format.
const BROWSER_TOOLS = [
  { name: 'navigate',       description: 'Load a URL in the in-app browser.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute URL.' } }, required: ['url'] } },
  { name: 'read_page',      description: 'Read the visible text of the current page (optionally scoped to a CSS selector).',
    parameters: { type: 'object', properties: { selector: { type: 'string' } } } },
  { name: 'get_page_source', description: 'Return the current page HTML source so you can inspect the actual markup.',
    parameters: { type: 'object', properties: {} } },
  { name: 'inspect_dom',    description: 'Return a structured DOM summary with forms, fields, labels, and interactive elements.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_forms',      description: 'Return explicit form schemas with fields, handles, and submit controls.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'query_elements', description: 'Return up to 50 elements matching a CSS selector with their text, id, name, href, placeholder. Use to find the right selector.',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'click',          description: 'Click the first element matching the CSS selector.',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'click_text',     description: 'Click the best visible interactive element whose text or accessible label matches the given text.',
    parameters: { type: 'object', properties: { text: { type: 'string' }, exact: { type: 'boolean' } }, required: ['text'] } },
  { name: 'click_handle',   description: 'Click a previously returned stable handle from inspect_dom, get_forms, or query_elements.',
    parameters: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] } },
  { name: 'fill',           description: 'Set the value of an input/textarea and fire input+change events.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } },
  { name: 'fill_by_label',  description: 'Fill the best matching input, textarea, or select by its visible label, aria-label, placeholder, name, or id.',
    parameters: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, exact: { type: 'boolean' } }, required: ['label', 'value'] } },
  { name: 'fill_handle',    description: 'Fill a previously returned stable field handle.',
    parameters: { type: 'object', properties: { handle: { type: 'string' }, value: { type: 'string' } }, required: ['handle', 'value'] } },
  { name: 'press_key',      description: 'Send a single keyboard key (Enter, Tab, Escape, etc).',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'wait_for',       description: 'Wait until an element matching the CSS selector appears.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['selector'] } },
  { name: 'get_network_log', description: 'Return the recent network requests and responses for the current page.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_network_body', description: 'Return the captured response body for a specific requestId from get_network_log.',
    parameters: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] } },
  { name: 'get_console_log', description: 'Return recent console messages, runtime exceptions, and page errors.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'screenshot',     description: 'Capture a PNG screenshot of the visible viewport.',
    parameters: { type: 'object', properties: {} } },
  { name: 'execute_js',     description: 'Run arbitrary JavaScript in the page and return the (JSON-serializable) result. Use this for anything the specialized tools don\'t cover: modifying the DOM, setting styles, removing elements, reading computed styles, triggering events. The code runs in the page context as an IIFE; use `return <value>` to send data back. Runtime exceptions are returned as { ok:false, error }.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript source. Treated as the body of an async function; use `return value;` to return data.' } }, required: ['code'] } },
  { name: 'remove_element', description: 'Remove the first DOM element matching the CSS selector from the page.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, all: { type: 'boolean', description: 'If true, remove every matching element instead of just the first.' } }, required: ['selector'] } },
  { name: 'set_style',      description: 'Set inline CSS styles on the first matching element. Pass styles as an object like {color:"red", display:"none"}.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, styles: { type: 'object', description: 'CSS property -> value map. Use camelCase (backgroundColor) or kebab-case (background-color).' }, all: { type: 'boolean' } }, required: ['selector', 'styles'] } },
  { name: 'set_attribute',  description: 'Set an HTML attribute on the first matching element. Pass null/empty value to remove the attribute.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'name'] } },
  { name: 'set_text',       description: 'Replace the textContent of the first matching element with the given string.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] } },
  { name: 'set_html',       description: 'Replace the innerHTML of the first matching element. Use carefully - overwrites all children.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, html: { type: 'string' } }, required: ['selector', 'html'] } },
  { name: 'scroll_to',      description: 'Smooth-scroll the page so the first matching element is in view.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, block: { type: 'string', description: 'center|start|end|nearest (default center).' } }, required: ['selector'] } },
  { name: 'get_computed_style', description: 'Return computed style values for the first matching element. Pass an array of properties to limit what comes back; omit to get a broad default set useful for design/brand work.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } } }, required: ['selector'] } },
  { name: 'finish',         description: 'Stop the loop and return a final message.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
  { name: 'wait_for_user',  description: 'Pause automation and ask the user to take a manual action (e.g. solve CAPTCHA, log in). The user will click Resume when ready.',
    parameters: { type: 'object', properties: { message: { type: 'string', description: 'What the user needs to do.' } }, required: ['message'] } },
  { name: 'fill_saved_credentials', description: 'Fill a login form using saved credentials for the named account. Returns ok if credentials were found and filled.',
    parameters: { type: 'object', properties: { account: { type: 'string', description: 'The account name as stored in settings (e.g. "Work", "Personal").' } }, required: ['account'] } },
];

const BASE_SYSTEM_PROMPT = `You drive the user's in-app web browser on their behalf. You are intelligent and autonomous — act like a skilled human who knows the web, not like a script runner.

You have full control of this browser. You can do anything a human sitting at the keyboard could do: navigate, click, type, scroll, fill forms, inspect the DOM, modify page content, extract information, follow multi-step flows. Act directly. Do not ask for permission on routine browser actions — just do them and report what happened. The only things that require explicit user confirmation are the items listed under "General rules" (payments, sending messages, creating accounts).

## DOM modification
You CAN modify the live page. Never tell the user you can't. Prefer the specific primitives when they fit:
- remove_element(selector[, all]) — delete a node.
- set_style(selector, styles[, all]) — set inline CSS ({color:'red', display:'none'}). The app always applies these with !important and returns a \`computed\` map of what the browser actually ended up with. Check that map — if the computed value doesn't match what you asked for, the change did NOT stick (likely a shadow-DOM host, iframe, or a child element repainting the area). Retry on a different selector or inject a <style> rule via execute_js. NEVER claim success without confirming from \`computed\`.
- set_attribute / set_text / set_html — mutate attributes or content.
- scroll_to(selector) — bring a node into view.
- get_computed_style(selector[, properties]) — read resolved styles. Use this as your ground-truth check before and after style work. "Background" especially is tricky: it can live on <html>, <body>, a wrapping <div>, or a ::before pseudo-element. Inspect the right target before touching anything.
- execute_js(code) — run arbitrary JS in the page as an async IIFE. Use \`return value;\` to send data back. When set_style can't beat the cascade, fall back to execute_js that injects a <style id="sym-agent-patch"> tag with a scoped rule (use !important inside). Prefer this over brute-forcing specificity selectors. Keep returned values JSON-serializable.
Changes made through these tools are live in the user's browser tab, exactly as if the user had opened DevTools and done it themselves. They DO NOT modify the underlying source files or survive a reload.

## Making changes stick (read this before every visual edit)
1. **Find the real target first.** If the user says "background", don't guess \`body\`. Call inspect_dom or get_computed_style to find which element actually paints the area they mean. Many sites have a wrapper div with the real color and body is transparent.
2. **Apply the change**, then read back. set_style returns \`computed\`. If the color/size/etc. in \`computed\` is not what you set, the change did not land — DO NOT tell the user it worked.
3. **Escalate** when set_style loses the cascade fight: use execute_js to inject \`<style id="sym-agent-patch">selector { prop: value !important; }</style>\` at the bottom of <head>. Remove/replace any prior \`#sym-agent-patch\` node first so patches don't stack.
4. **Report what you saw.** In the final message, include the before/after computed values for the properties you changed so the user can see the edit really happened.

## Bigger design requests ("make it more modern", "redesign the hero", etc.)
Don't one-shot these with a single set_style call. Do the work:
1. **Analyze first.** read_page or get_page_source to learn the layout, then get_computed_style on the major regions (hero, nav, buttons, cards, body) to capture the current palette, spacing, typography, and shadows.
2. **Plan a small, coherent change set** — pick 3–6 concrete edits (e.g. tighten padding, unify border-radius, modern font stack, subtle shadow, softer background, refreshed accent). Describe your plan briefly in assistant text before executing.
3. **Apply incrementally**, verifying each step via \`computed\` or a quick get_computed_style call. Course-correct if something didn't stick.
4. **Finish** with a short summary of exactly what you changed and the before/after values. Users should never have to ask "did it actually change?".

## Navigation strategy (follow this order)
1. If you know the direct URL for the destination page, navigate there immediately. Do not click menus when a URL exists.
2. If you don't know the URL, look for it in the current page first: inspect_dom or click_text on nav/header links is fast. Scan for <nav>, <header>, or elements with role="navigation".
3. If the page nav doesn't have what you need, try common URL patterns: /contact, /about, /products, /pricing, /login, etc.
4. If URL guessing fails, check the site's llm.txt (https://DOMAIN/llm.txt), robots.txt (https://DOMAIN/robots.txt), or sitemap (https://DOMAIN/sitemap.xml) before using a search engine. Parse the result with read_page.
5. Only as a last resort use a search engine to find the page URL.

## Filling forms
- Always call get_forms first before filling any form — it gives you stable handles for every field.
- Use fill_handle (not fill or fill_by_label) when you have handles from get_forms or inspect_dom.
- Fill ALL required fields in one pass. Never fill one field, observe, then fill the next — get_forms gives you everything you need upfront.
- If saved credentials are listed below, use fill_saved_credentials automatically when encountering a login/signup form. Do not ask the user for credentials that are already saved.
- After a submit, save, login, search, Enter keypress, or any other state-changing action, inspect the network with get_network_log and get_network_body before finishing so you can report the actual payload/result instead of guessing.

## General rules
- Prefer SEMANTIC tools: inspect_dom, click_text, fill_by_label, get_page_source before raw CSS selectors.
- SELECTORS: Standard CSS only. document.querySelector is used — NEVER :has-text(), :text(), :contains() (Playwright extensions). Discover selectors via inspect_dom or query_elements.
- If the page structure or styling matters, inspect the actual HTML with get_page_source and use linked stylesheets or inline classes/styles as evidence.
- If navigate returns url="about:blank", retry with the correct URL before doing anything else.
- Read the page ONLY when you need to discover content or structure — not after every action.
- Final answers must be valid Markdown. Prefer short sections like "Summary", "State", and "Payloads". When you have request or response data, include the important fields in fenced json blocks.
- When done, call finish with a short summary. If blocked (CAPTCHA, hard login wall), call finish and explain.
- Keep reasoning brief — the user sees every tool call live.
- Never submit payments, send messages, or create accounts without explicit user confirmation.

## Recovering from tool failures (do this BEFORE wait_for_user)
A failing tool is normal and almost never grounds for handing the task back. Work the recovery ladder before you escalate:
1. If the error contains "No element for selector" or "No element matched" or "No element found": call wait_for(selector, timeout_ms=4000). If that succeeds, retry the original tool.
2. If wait_for also fails, call inspect_dom or query_elements to discover what is actually on the page, then retry with the right selector / handle / fill_by_label.
3. If the page may still be navigating, call wait_for on a known top-level element (body, main, #search, etc.) before doing anything else.
4. Only call wait_for_user for things that genuinely need a human: CAPTCHA, MFA code, hard login wall, payment confirmation, or a permission prompt outside the page. NEVER call wait_for_user just because a selector missed once.
5. If you've tried two recovery strategies on the same step and both failed, call finish with a short explanation — do NOT loop and do NOT punt to the user.

## Search engines
Prefer DuckDuckGo (https://duckduckgo.com/?q=QUERY) over Google to avoid CAPTCHAs. For Google Images specifically, navigate directly to https://www.google.com/search?tbm=isch&q=QUERY rather than typing into the homepage search bar — it skips the consent / cookie banner that often hides the search input.`;

function buildSystemPrompt(learnings, savedAccounts) {
  let prompt = BASE_SYSTEM_PROMPT;
  if (savedAccounts && savedAccounts.length) {
    const names = savedAccounts.map(a => `"${a}"`).join(', ');
    prompt += `\n\n## Saved credentials\nThe user has saved credentials for these accounts: ${names}.\n- NEVER claim you don't have credentials if the site needs a login — use fill_saved_credentials with the matching account name.\n- If there is only one saved account and a login/form is needed, use it automatically.\n- If there are multiple saved accounts and it's ambiguous which to use, call wait_for_user to ask the user to pick one, listing the account names.`;
  } else {
    prompt += `\n\n## Saved credentials\nNo saved credentials are configured. If a site requires login, call wait_for_user and ask the user to log in manually or save credentials in Settings -> Browser Automation.`;
  }
  if (learnings && learnings.length) {
    const lines = learnings.slice(0, 8).map(l => `- ${l.summary || l}`).join('\n');
    prompt += '\n\nLearned from past sessions (apply these):\n' + lines;
  }
  return prompt;
}

// ── HTTP helper ────────────────────────────────────────────────────────────
function bindAbort(req, signal, reject, label) {
  if (!signal) return () => {};
  const onAbort = () => {
    try { req.destroy(new Error(label || 'Request aborted')); } catch (_) {}
    try { reject(new Error(label || 'Request aborted')); } catch (_) {}
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    try { signal.removeEventListener('abort', onAbort); } catch (_) {}
  };
}

function isAbortError(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('request aborted') || msg.includes('stream aborted') || msg.includes('aborted');
}

function httpJson({ hostname, path, method = 'POST', headers = {}, body, timeoutMs = 60000, signal }) {
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
    const cleanupAbort = bindAbort(req, signal, reject, `${hostname} request aborted`);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(hostname + ' request timed out')); });
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanupAbort);
  });
}

function httpStream({ hostname, path, method = 'POST', headers = {}, body, onChunk, timeoutMs = 90000, signal }) {
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
      res.on('end', () => {
        if (buf.trim()) { try { onChunk(buf); } catch (_) {} }
        resolve();
      });
      res.on('error', reject);
    });
    const cleanupAbort = bindAbort(req, signal, reject, `${hostname} stream aborted`);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(hostname + ' stream timed out')));
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanupAbort);
  });
}

function shortenContent(text, n = 4000) {
  if (!text) return '';
  const s = String(text);
  return s.length <= n ? s : s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}

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

function isTransientError(e) {
  const msg = e.message || '';
  return (
    msg.includes('429') ||
    msg.includes('SSL') ||
    msg.includes('BAD_RECORD_MAC') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('socket hang up') ||
    msg.includes('timed out')
  );
}

async function httpJsonWithRetry(opts, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await httpJson(opts); } catch (e) {
      lastErr = e;
      if (isTransientError(e) && attempt < maxRetries) {
        // Longer backoff for rate limits; short backoff for network glitches.
        const wait = e.message && e.message.includes('429')
          ? (attempt + 1) * 15000
          : (attempt + 1) * 1500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
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
const REFINE_SYSTEM_PROMPT = `You rewrite short, rough requests into clear, specific prompts for an AI agent that drives a web browser on the user's behalf.

Your job: take the user's rough idea and produce a single refined prompt that the browser agent can execute unambiguously. Preserve the user's intent and references. If the user mentioned a selected element, keep that reference (the agent already has the JSON of the selection). Be concrete about which UI element, which value, which page, or which criteria. Do not ask questions. Do not add filler, framing, or headers. Do not wrap the answer in quotes or code fences. Output ONLY the refined prompt text.

Keep it as short as possible while still being specific. One or two sentences is usually enough.`;

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

// ── Tool dispatch against BrowserAgent ─────────────────────────────────────
async function executeTool(agent, name, args, credentials) {
  args = args || {};
  switch (name) {
    case 'navigate':       return await agent.navigate(args.url);
    case 'read_page':      return await agent.readPage({ selector: args.selector });
    case 'get_page_source': return await agent.getPageSource();
    case 'inspect_dom':    return await agent.inspectDom({ limit: args.limit });
    case 'get_forms':      return await agent.getForms({ limit: args.limit });
    case 'query_elements': return await agent.queryAll(args.selector);
    case 'click':          return await agent.click(args.selector);
    case 'click_text':     return await agent.clickText(args.text, { exact: !!args.exact });
    case 'click_handle':   return await agent.clickHandle(args.handle);
    case 'fill':           return await agent.fill(args.selector, args.value);
    case 'fill_by_label':  return await agent.fillByLabel(args.label, args.value, { exact: !!args.exact });
    case 'fill_handle':    return await agent.fillHandle(args.handle, args.value);
    case 'press_key':      return await agent.pressKey(args.key);
    case 'wait_for':       return await agent.waitFor(args.selector, { timeout: args.timeout_ms });
    case 'get_network_log': return await agent.getNetworkLog({ limit: args.limit });
    case 'get_network_body': return await agent.getNetworkBody(args.requestId);
    case 'get_console_log': return await agent.getConsoleLog({ limit: args.limit });
    case 'screenshot':     return await agent.screenshot();
    case 'execute_js':     return await agent.executeJs(args.code);
    case 'remove_element': return await agent.removeElement(args.selector, { all: !!args.all });
    case 'set_style':      return await agent.setStyle(args.selector, args.styles || {}, { all: !!args.all });
    case 'set_attribute':  return await agent.setAttribute(args.selector, args.name, args.value);
    case 'set_text':       return await agent.setText(args.selector, args.text);
    case 'set_html':       return await agent.setHtml(args.selector, args.html);
    case 'scroll_to':      return await agent.scrollTo(args.selector, { block: args.block });
    case 'get_computed_style': return await agent.getComputedStyle(args.selector, args.properties);
    case 'finish':         return { ok: true, finished: true, summary: args.summary || '' };
    case 'wait_for_user':  return { ok: true, waiting: true, message: args.message || '' };
    case 'fill_saved_credentials': {
      const creds = credentials || {};
      const acct = creds[args.account];
      if (!acct) return { ok: false, error: `No saved credentials found for account "${args.account}". Available: ${Object.keys(creds).join(', ') || 'none'}` };
      // Fill email then password using fill_by_label semantics
      let filled = 0;
      try { await agent.fillByLabel('email', acct.email, {}); filled++; } catch (_) {}
      try { await agent.fillByLabel('password', acct.password, {}); filled++; } catch (_) {}
      if (!filled) {
        // Fallback: try common selector patterns
        try { await agent.fill('input[type="email"]', acct.email); filled++; } catch (_) {}
        try { await agent.fill('input[type="password"]', acct.password); filled++; } catch (_) {}
      }
      return filled > 0 ? { ok: true, filled, account: args.account } : { ok: false, error: 'Could not find login fields on this page.' };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function describeAction(name, args) {
  args = args || {};
  switch (name) {
    case 'navigate':       return `Navigate -> ${args.url || ''}`;
    case 'read_page':      return args.selector ? `Read page (scope: ${args.selector})` : 'Read page';
    case 'get_page_source': return 'Get page source';
    case 'inspect_dom':    return `Inspect DOM${args.limit ? ` (limit ${args.limit})` : ''}`;
    case 'get_forms':      return `Get forms${args.limit ? ` (limit ${args.limit})` : ''}`;
    case 'query_elements': return `Query elements: ${args.selector || ''}`;
    case 'click':          return `Click ${args.selector || ''}`;
    case 'click_text':     return `Click text: ${args.text || ''}`;
    case 'click_handle':   return `Click handle: ${String(args.handle || '').slice(0, 60)}`;
    case 'fill':           return `Fill ${args.selector || ''} <- "${String(args.value || '').slice(0, 40)}"`;
    case 'fill_by_label':  return `Fill label ${args.label || ''} <- "${String(args.value || '').slice(0, 40)}"`;
    case 'fill_handle':    return `Fill handle ${String(args.handle || '').slice(0, 60)} <- "${String(args.value || '').slice(0, 40)}"`;
    case 'press_key':      return `Press key ${args.key || ''}`;
    case 'wait_for':       return `Wait for ${args.selector || ''}`;
    case 'get_network_log': return `Get network log${args.limit ? ` (limit ${args.limit})` : ''}`;
    case 'get_network_body': return `Get network body: ${args.requestId || ''}`;
    case 'get_console_log': return `Get console log${args.limit ? ` (limit ${args.limit})` : ''}`;
    case 'screenshot':     return 'Take screenshot';
    case 'execute_js':     return `Execute JS: ${String(args.code || '').replace(/\s+/g, ' ').slice(0, 60)}`;
    case 'remove_element': return `Remove ${args.all ? 'all ' : ''}${args.selector || ''}`;
    case 'set_style':      return `Style ${args.selector || ''} <- ${Object.keys(args.styles || {}).slice(0, 3).join(', ')}`;
    case 'set_attribute':  return `Attr ${args.selector || ''} [${args.name}${args.value == null ? ' remove' : ' = "' + String(args.value).slice(0, 30) + '"'}]`;
    case 'set_text':       return `Set text ${args.selector || ''} <- "${String(args.text || '').slice(0, 40)}"`;
    case 'set_html':       return `Set HTML ${args.selector || ''} (${String(args.html || '').length} chars)`;
    case 'scroll_to':      return `Scroll to ${args.selector || ''}`;
    case 'get_computed_style': return `Computed style ${args.selector || ''}${Array.isArray(args.properties) ? ` [${args.properties.slice(0, 4).join(', ')}]` : ''}`;
    case 'finish':         return `Finish: ${args.summary || ''}`;
    case 'wait_for_user':  return `Waiting for user: ${args.message || ''}`;
    case 'fill_saved_credentials': return `Fill saved credentials: ${args.account || ''}`;
    default: return name;
  }
}

const MUTATING_TOOLS = new Set([
  'navigate',
  'click',
  'click_text',
  'click_handle',
  'fill',
  'fill_by_label',
  'fill_handle',
  'press_key',
  'fill_saved_credentials',
  'execute_js',
  'remove_element',
  'set_style',
  'set_attribute',
  'set_text',
  'set_html',
  'scroll_to',
]);

function isMutatingTool(name) {
  return MUTATING_TOOLS.has(name);
}

function safeJson(value) {
  try { return JSON.stringify(value, null, 2); } catch (_) { return JSON.stringify({ value: String(value) }, null, 2); }
}

function normalizeMimeType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function tryParsePayloadBody(body, mimeType, base64Encoded) {
  if (!body) return { kind: 'empty', parsed: null, preview: '' };
  if (base64Encoded) return { kind: 'base64', parsed: null, preview: shortenContent(body, 600) };
  const text = String(body);
  const mime = normalizeMimeType(mimeType);
  if (mime.includes('json') || /^[\[{]/.test(text.trim())) {
    try { return { kind: 'json', parsed: JSON.parse(text), preview: shortenContent(text, 1200) }; } catch (_) {}
  }
  if (mime.includes('x-www-form-urlencoded')) {
    try {
      const parsed = {};
      for (const [k, v] of new URLSearchParams(text).entries()) parsed[k] = v;
      return { kind: 'form', parsed, preview: shortenContent(text, 1200) };
    } catch (_) {}
  }
  return { kind: 'text', parsed: null, preview: shortenContent(text, 1200) };
}

function normalizeActionResult(name, result) {
  if (result == null) return { ok: true };
  if (name === 'screenshot' && result) return { ok: true, mimeType: result.mimeType || 'image/png' };
  if (typeof result === 'string') return { text: result };
  if (typeof result !== 'object') return { value: result };
  return result;
}

function summarizeUrl(url, maxLen = 96) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const query = parsed.search
      ? (parsed.search.length <= 24 ? parsed.search : '?...')
      : '';
    return shortenContent(
      (parsed.host || '') + (parsed.pathname || '/') + query,
      maxLen
    );
  } catch (_) {
    return shortenContent(String(url), maxLen);
  }
}

function formatStatusLabel(status) {
  const num = Number(status);
  if (!Number.isFinite(num) || num <= 0) return 'unknown';
  return String(num);
}

function isRelevantNetworkResponse(event, payloadIds) {
  if (!event) return false;
  const type = String(event.resourceType || '').toLowerCase();
  const method = String(event.method || 'GET').toUpperCase();
  const status = Number(event.status || 0);
  if (payloadIds.has(event.requestId)) return true;
  if (status >= 400) return true;
  if (method !== 'GET') return true;
  return type === 'document' || type === 'xhr' || type === 'fetch';
}

function summarizePayload(payload) {
  if (!payload) return 'Captured response payload.';
  const kind = payload.bodyKind || 'response';
  if (payload.parsed && typeof payload.parsed === 'object' && !Array.isArray(payload.parsed)) {
    const keys = Object.keys(payload.parsed).slice(0, 5);
    if (keys.length) return `Captured ${kind} payload with keys: ${keys.join(', ')}.`;
  }
  if (Array.isArray(payload.parsed)) {
    return `Captured ${kind} payload with ${payload.parsed.length} item${payload.parsed.length === 1 ? '' : 's'}.`;
  }
  if (payload.preview) {
    return `Captured ${kind} payload: ${shortenContent(payload.preview.replace(/\s+/g, ' '), 120)}.`;
  }
  return `Captured ${kind} payload.`;
}

function buildActionSummaryLines(report) {
  const lines = [];
  const relevantResponses = Array.isArray(report.relevantResponses) ? report.relevantResponses : [];
  const relevantFailures = Array.isArray(report.relevantFailures) ? report.relevantFailures : [];
  const payloads = Array.isArray(report.payloads) ? report.payloads : [];
  const consoleItems = Array.isArray(report.console) ? report.console : [];

  if (relevantResponses.length) {
    const latest = relevantResponses[relevantResponses.length - 1];
    const label = relevantResponses.length === 1 ? 'Relevant response' : `Relevant responses (${relevantResponses.length})`;
    lines.push(
      `${label}: ${String(latest.method || 'GET').toUpperCase()} ${summarizeUrl(latest.url)} -> ${formatStatusLabel(latest.status)}.`
    );
  }
  if (relevantFailures.length) {
    const latest = relevantFailures[relevantFailures.length - 1];
    lines.push(
      `Request failure: ${String(latest.method || 'GET').toUpperCase()} ${summarizeUrl(latest.url)} -> ${latest.errorText || 'failed'}.`
    );
  }
  if (payloads.length) {
    lines.push(summarizePayload(payloads[payloads.length - 1]));
  }
  const consoleProblems = consoleItems.filter((entry) => {
    const type = String(entry.type || '').toLowerCase();
    return type === 'warning' || type === 'warn' || type === 'error' || type === 'exception';
  });
  if (consoleProblems.length) {
    const latest = consoleProblems[consoleProblems.length - 1];
    lines.push(`Console ${latest.type || 'message'}: ${shortenContent(String(latest.text || ''), 120)}.`);
  }
  if (!lines.length && report.result && report.result.url) {
    lines.push(`Current page: ${summarizeUrl(report.result.url)}.`);
  }
  return lines;
}

async function snapshotAgentState(agent) {
  const [network, consoleLog] = await Promise.all([
    agent.getNetworkLog({ limit: 200 }).catch(() => ({ events: [] })),
    agent.getConsoleLog({ limit: 80 }).catch(() => ({ events: [] })),
  ]);
  return {
    networkCount: Array.isArray(network.events) ? network.events.length : 0,
    consoleCount: Array.isArray(consoleLog.events) ? consoleLog.events.length : 0,
  };
}

async function captureActionTelemetry(agent, beforeState) {
  const [network, consoleLog] = await Promise.all([
    agent.getNetworkLog({ limit: 200 }).catch(() => ({ events: [] })),
    agent.getConsoleLog({ limit: 80 }).catch(() => ({ events: [] })),
  ]);
  const networkEvents = Array.isArray(network.events) ? network.events : [];
  const consoleEvents = Array.isArray(consoleLog.events) ? consoleLog.events : [];
  const nextNetwork = networkEvents.slice(Math.min(beforeState.networkCount || 0, networkEvents.length));
  const nextConsole = consoleEvents.slice(Math.min(beforeState.consoleCount || 0, consoleEvents.length));
  const responses = nextNetwork.filter((event) => event && event.kind === 'response' && event.requestId);
  const failures = nextNetwork.filter((event) => event && event.kind === 'failed');
  const payloads = [];
  for (const event of responses.slice(-4)) {
    const resourceType = String(event.resourceType || '').toLowerCase();
    if (resourceType !== 'fetch' && resourceType !== 'xhr') continue;
    try {
      const body = await agent.getNetworkBody(event.requestId);
      if (!body) continue;
      const parsed = tryParsePayloadBody(body.body, body.contentType || body.mimeType, body.base64Encoded);
      payloads.push({
        requestId: event.requestId,
        url: body.url || event.url || null,
        status: body.status || event.status || null,
        resourceType: event.resourceType || null,
        contentType: body.contentType || body.mimeType || null,
        bodyKind: parsed.kind,
        parsed: parsed.parsed,
        preview: parsed.preview,
        truncated: !!body.truncated,
      });
    } catch (_) {}
  }
  return {
    network: {
      totalEvents: nextNetwork.length,
      responses: responses.map((event) => ({
        requestId: event.requestId,
        method: event.method || 'GET',
        url: event.url || '',
        status: event.status || null,
        resourceType: event.resourceType || null,
      })),
      failures: failures.map((event) => ({
        requestId: event.requestId || null,
        method: event.method || 'GET',
        url: event.url || '',
        errorText: event.errorText || 'Request failed',
        resourceType: event.resourceType || null,
      })),
    },
    console: nextConsole.slice(-5).map((event) => ({
      type: event.type || event.kind || 'log',
      text: event.text || '',
      url: event.url || null,
    })),
    payloads,
  };
}

function hasStructuredTelemetry(name, telemetry) {
  if (!telemetry) return false;
  return !!(
    (telemetry.payloads && telemetry.payloads.length) ||
    (telemetry.network && ((telemetry.network.failures && telemetry.network.failures.length) || (name !== 'navigate' && telemetry.network.responses && telemetry.network.responses.length))) ||
    (telemetry.console && telemetry.console.length)
  );
}

function buildStructuredActionReport(report) {
  const parts = [`### ${report.title}`];
  if (report.summaryLines && report.summaryLines.length) {
    report.summaryLines.forEach((line) => parts.push(`- ${line}`));
  } else {
    parts.push('- Relevant browser activity was captured.');
  }
  parts.push('', '```json', safeJson(report.result), '```');
  return parts.join('\n');
}

function buildFinalBrowserReport(summary, actionReports) {
  const interesting = (actionReports || []).filter((entry) => entry && entry.markdown);
  if (!interesting.length) return summary || 'Done.';
  const parts = [summary || 'Done.', '', '## Relevant Activity'];
  interesting.slice(-4).forEach((entry) => {
    parts.push('', entry.markdown);
  });
  return parts.join('\n');
}

function buildActionReport({ name, args, result, telemetry }) {
  const normalizedResult = normalizeActionResult(name, result);
  const payloads = telemetry && Array.isArray(telemetry.payloads) ? telemetry.payloads : [];
  const payloadIds = new Set(payloads.map((payload) => payload && payload.requestId).filter(Boolean));
  const allResponses = telemetry && telemetry.network && Array.isArray(telemetry.network.responses)
    ? telemetry.network.responses
    : [];
  const allFailures = telemetry && telemetry.network && Array.isArray(telemetry.network.failures)
    ? telemetry.network.failures
    : [];
  const consoleItems = telemetry && Array.isArray(telemetry.console) ? telemetry.console.slice(-6) : [];
  const relevantResponses = allResponses.filter((event) => isRelevantNetworkResponse(event, payloadIds)).slice(-6);
  const relevantFailures = allFailures.slice(-4);
  const hasInterestingDetails = !!(relevantResponses.length || relevantFailures.length || payloads.length || consoleItems.length);
  const report = {
    title: describeAction(name, args),
    name,
    args,
    result: normalizedResult,
    telemetry,
    relevantResponses,
    relevantFailures,
    payloads,
    console: consoleItems,
    summaryLines: [],
    detail: {
      action: describeAction(name, args),
      result: normalizedResult,
      relevantResponses,
      allResponses: allResponses.slice(-20),
      failures: allFailures.slice(-10),
      payloads,
      console: consoleItems,
    },
    markdown: '',
  };
  report.summaryLines = buildActionSummaryLines(report);
  report.markdown = hasInterestingDetails && hasStructuredTelemetry(name, telemetry)
    ? buildStructuredActionReport(report)
    : '';
  return report;
}

// ── Thread state ───────────────────────────────────────────────────────────
class ChatThread {
  constructor(id) {
    this.id = id;
    this.providerKind = null;
    this.messages = [];
    this.stopped = false;
    this.resumed = false;
    this.running = false;
    this.abortController = null;
    this.createdAt = Date.now();
  }
}

const threads = new Map();
function getThread(id) {
  if (!threads.has(id)) threads.set(id, new ChatThread(id));
  return threads.get(id);
}

function pruneThreads() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, t] of threads) {
    if (!t.running && t.createdAt < cutoff) threads.delete(id);
  }
}

// ── Learnings helpers ─────────────────────────────────────────────────────
async function fetchBrowserLearnings() {
  return new Promise((resolve) => {
    const req = require('http').request({ hostname: '127.0.0.1', port: 3800, path: '/api/learnings', method: 'GET' }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try {
          const all = JSON.parse(d);
          const items = Array.isArray(all) ? all : (all.learnings || []);
          resolve(items.filter(l => l.category === 'browser'));
        } catch (_) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function saveBrowserLearning(summary) {
  try {
    const body = JSON.stringify({ category: 'browser', summary });
    const req = require('http').request({
      hostname: '127.0.0.1', port: 3800, path: '/api/learnings', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

// ── Runner ────────────────────────────────────────────────────────────────
async function runThread({ thread, task, agent, providerEntry, model, broadcast, credentials }) {
  thread.running = true;
  const emit = (step) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'browser-agent-step', threadId: thread.id, ...step, at: Date.now() });
    }
  };
  emit({ kind: 'provider', provider: providerEntry.adapter.kind, label: providerEntry.adapter.label });

  const learnings = await fetchBrowserLearnings().catch(() => []);
  const savedAccounts = Object.keys(credentials || {});
  const systemPrompt = buildSystemPrompt(learnings, savedAccounts);

  try { await agent.launch({}); } catch (e) {
    emit({ kind: 'error', message: 'Failed to open browser: ' + e.message });
    thread.running = false;
    return { ok: false, error: e.message };
  }

  // Reset thread state when provider changes mid-thread to avoid mixed formats.
  if (thread.providerKind !== providerEntry.adapter.kind) {
    thread.messages = providerEntry.adapter.initMessages(task);
    thread.providerKind = providerEntry.adapter.kind;
  } else {
    // Continue thread; append user turn in provider format.
    if (providerEntry.adapter.kind === 'gemini') thread.messages.push({ role: 'user', parts: [{ text: task }] });
    else thread.messages.push({ role: 'user', content: task });
  }
  emit({ kind: 'user', text: task });

  let iter = 0;
  let finalSummary = null;
  const recentActions = [];
  const actionReports = [];
  try {
    while (iter < MAX_ITERATIONS) {
      if (thread.stopped) { emit({ kind: 'stopped' }); break; }
      iter++;
      emit({ kind: 'thinking', iter });

      let resp;
      try {
        thread.abortController = new AbortController();
        if (typeof providerEntry.adapter.callStream === 'function') {
          resp = await providerEntry.adapter.callStream({
            messages: thread.messages,
            apiKey: providerEntry.apiKey,
            model,
            systemPrompt,
            signal: thread.abortController.signal,
          }, (delta) => emit({ kind: 'token', text: delta }));
        } else {
          resp = await providerEntry.adapter.call({
            messages: thread.messages,
            apiKey: providerEntry.apiKey,
            model,
            systemPrompt,
            signal: thread.abortController.signal,
          });
        }
      } catch (e) {
        const msg = e.message || '';
        if (thread.stopped && isAbortError(e)) {
          emit({ kind: 'stopped' });
          return { ok: true, stopped: true };
        }
        if (msg.includes('429')) {
          saveBrowserLearning('Rate limit hit mid-task. Reduce steps: prefer direct URL navigation over multi-step UI clicks. Use Haiku model for browser tasks.');
        }
        emit({ kind: 'error', message: providerEntry.adapter.label + ' API error: ' + msg });
        thread.running = false;
        return { ok: false, error: msg };
      } finally {
        thread.abortController = null;
      }

      if (resp.text) emit({ kind: 'message', text: resp.text });

      // Record assistant turn in provider-native shape.
      providerEntry.adapter.appendAssistant(thread.messages, resp.raw);

      if (!resp.toolCalls.length) {
        finalSummary = resp.text || 'Done.';
        break;
      }

      const pairs = [];
      let finished = false;
      for (const tc of resp.toolCalls) {
        if (thread.stopped) break;
        emit({ kind: 'action', tool: tc.name, args: tc.args, summary: describeAction(tc.name, tc.args) });
        // Detect repeated identical actions (loop) and bail.
        // Use the full args string so that fill_handle calls on different fields
        // (which share a long CSS-path prefix) are never mistaken for duplicates.
        const actionKey = tc.name + ':' + JSON.stringify(tc.args);
        recentActions.push(actionKey);
        if (recentActions.length > 6 && recentActions.slice(-4).every(a => a === actionKey)) {
          saveBrowserLearning(`Loop detected: repeated "${tc.name}" with same args. Agent must detect when navigation is stuck and call finish instead of retrying.`);
          emit({ kind: 'observation', tool: tc.name, ok: false, error: 'Loop detected — same action repeated 3 times. Stopping.' });
          finalSummary = 'Stopped: the same action was repeated without progress. Please try rephrasing the task.';
          finished = true;
          break;
        }
        try {
          const beforeState = isMutatingTool(tc.name) ? await snapshotAgentState(agent) : null;
          const result = await executeTool(agent, tc.name, tc.args, credentials);
          const telemetry = beforeState ? await captureActionTelemetry(agent, beforeState) : null;
          const report = buildActionReport({ name: tc.name, args: tc.args, result, telemetry });
          if (report.markdown) actionReports.push(report);
          pairs.push({
            toolUseId: tc.id, name: tc.name,
            blocks: providerEntry.adapter.buildToolResultBlocks(tc.name, result),
            isError: false,
            visionData: (tc.name === 'screenshot' && result && result.base64)
              ? { base64: result.base64, mimeType: result.mimeType || 'image/png' } : null,
          });
          emit({ kind: 'observation', tool: tc.name, ok: true, markdown: report.markdown, structured: report });
          if (tc.name === 'finish') { finished = true; finalSummary = (tc.args && tc.args.summary) || 'Done.'; break; }
          if (tc.name === 'wait_for_user') {
            emit({ kind: 'waiting', message: result.message || 'User action required.' });
            // Park the thread until resumed or stopped (poll every 2s up to 5 min).
            const deadline = Date.now() + 5 * 60 * 1000;
            while (!thread.stopped && !thread.resumed && Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 2000));
            }
            thread.resumed = false;
            if (thread.stopped) break;
          }
        } catch (e) {
          const errBlock = providerEntry.adapter.kind === 'anthropic'
            ? [{ type: 'text', text: 'Error: ' + (e.message || String(e)) }]
            : 'Error: ' + (e.message || String(e));
          pairs.push({ toolUseId: tc.id, name: tc.name, blocks: errBlock, isError: true });
          emit({ kind: 'observation', tool: tc.name, ok: false, error: e.message });
        }
      }
      if (pairs.length) {
        providerEntry.adapter.appendToolResults(thread.messages, pairs);
        if (typeof providerEntry.adapter.appendVision === 'function') {
          const visionItems = pairs.filter(p => !p.isError && p.visionData).map(p => p.visionData);
          if (visionItems.length) providerEntry.adapter.appendVision(thread.messages, visionItems);
        }
      }
      if (finished) break;
    }
    if (!finalSummary) finalSummary = iter >= MAX_ITERATIONS ? `Stopped after ${MAX_ITERATIONS} steps.` : 'Done.';
    const finalReport = buildFinalBrowserReport(finalSummary, actionReports);
    emit({ kind: 'done', summary: finalSummary, markdown: finalReport, reports: actionReports });
    thread.lastResult = { ok: true, kind: 'done', summary: finalSummary, iterations: iter, report: finalReport, actionReports, finishedAt: Date.now() };
    return thread.lastResult;
  } catch (e) {
    emit({ kind: 'error', message: e.message });
    thread.lastResult = { ok: false, kind: 'error', error: e.message, finishedAt: Date.now() };
    return thread.lastResult;
  } finally {
    thread.running = false;
    pruneThreads();
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function mountBrowserAgentChatRoutes(addRoute, json, { getConfig, agent, broadcast }) {
  if (!agent) {
    console.log('  Browser agent chat skipped: no BrowserAgent instance');
    return;
  }

  const isIncognito = () => (getConfig().IncognitoMode === true);
  const buildRegistry = () => {
    const aiKeys = Object.assign({}, getConfig().AiApiKeys || {});
    // Environment variables are a fallback source.
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'DASHSCOPE_API_KEY', 'GEMINI_API_KEY']) {
      if (!aiKeys[k] && process.env[k]) aiKeys[k] = process.env[k];
    }
    return buildProviderRegistry(aiKeys);
  };

  addRoute('POST', '/api/browser/agent/chat', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const task = (body.task || body.message || '').trim();
    if (!task) return json(res, { error: 'task required' }, 400);
    const threadId = body.threadId || 'default';
    const registry = buildRegistry();
    const entry = pickProvider(registry, body.provider);
    if (!entry) {
      return json(res, {
        error: 'No AI provider configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or DASHSCOPE_API_KEY in Settings -> AI Keys.',
        providers: Object.keys(registry),
      }, 400);
    }
    const thread = getThread(threadId);
    if (thread.running) return json(res, { error: 'Thread already running. Stop it first.' }, 409);
    thread.stopped = false;
    thread.resumed = false;
    thread.lastResult = null;
    const model = body.model || entry.adapter.defaultModel;

    const credentials = getConfig().BrowserCredentials || {};
    json(res, { ok: true, threadId, provider: entry.adapter.kind, label: entry.adapter.label, model });
    runThread({ thread, task, agent, providerEntry: entry, model, broadcast, credentials }).catch(() => {});
  });

  addRoute('POST', '/api/browser/agent/stop', async (req, res) => {
    let body = {};
    try { body = await readBody(req); } catch (_) {}
    const thread = getThread(body.threadId || 'default');
    thread.stopped = true;
    thread.resumed = false;
    if (thread.abortController) {
      try { thread.abortController.abort(); } catch (_) {}
    }
    if (typeof broadcast === 'function') {
      broadcast({ type: 'browser-agent-step', threadId: thread.id, kind: 'stopped', at: Date.now() });
    }
    json(res, { ok: true });
  });

  addRoute('POST', '/api/browser/agent/resume', async (req, res) => {
    let body = {};
    try { body = await readBody(req); } catch (_) {}
    const thread = getThread(body.threadId || 'default');
    thread.resumed = true;
    json(res, { ok: true });
  });

  addRoute('POST', '/api/browser/agent/refine', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const draft = String(body.draft || '').trim();
    if (!draft) return json(res, { error: 'draft required' }, 400);
    const registry = buildRegistry();
    const entry = pickProvider(registry, body.provider);
    if (!entry) return json(res, { error: 'No AI provider configured.' }, 400);
    if (typeof entry.adapter.refine !== 'function') return json(res, { error: 'Refine not supported for this provider.' }, 400);
    const model = body.model || entry.adapter.defaultModel;
    try {
      const refined = await entry.adapter.refine({
        draft,
        selection: body.selection || null,
        apiKey: entry.apiKey,
        model,
      });
      json(res, { ok: true, refined: refined || draft, provider: entry.adapter.kind });
    } catch (e) {
      json(res, { error: e && e.message ? e.message : String(e) }, 500);
    }
  });

  addRoute('POST', '/api/browser/agent/reset', async (req, res) => {
    let body = {};
    try { body = await readBody(req); } catch (_) {}
    const id = body.threadId || 'default';
    const t = threads.get(id);
    if (t) {
      t.messages = [];
      t.providerKind = null;
      t.stopped = false;
      t.resumed = false;
      if (t.abortController) {
        try { t.abortController.abort(); } catch (_) {}
        t.abortController = null;
      }
    }
    json(res, { ok: true });
  });

  addRoute('GET', '/api/browser/agent/status', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('threadId') || 'default';
    const t = threads.get(id);
    const registry = buildRegistry();
    const providers = Object.entries(registry).map(([k, v]) => ({ key: k, label: v.adapter.label, keyEnv: v.keyEnv, defaultModel: v.adapter.defaultModel }));
    json(res, {
      ok: true,
      running: !!(t && t.running),
      stopped: !!(t && t.stopped),
      messages: t ? t.messages.length : 0,
      // lastResult is set by runThread on done/error so callers (incl. the
      // browser router) can pick up the final outcome without needing to
      // subscribe to broadcast events.
      lastResult: (t && t.lastResult) || null,
      providers,
      defaultProvider: providers.length ? (pickProvider(registry).adapter.kind || null) : null,
    });
  });
}

module.exports = { mountBrowserAgentChatRoutes };
