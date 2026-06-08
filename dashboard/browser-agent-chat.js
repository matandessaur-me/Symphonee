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

const { isAbortError } = require('./browser-chat-http');
const siteRecipes = require('./site-recipes');
const { buildProviderRegistry, pickProvider } = require('./browser-chat-providers');
const { shortenContent } = require('./browser-chat-util');

const MAX_ITERATIONS = 30;

const { BASE_SYSTEM_PROMPT } = require('./browser-chat-prompts');

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


// Detect provider exhaustion across all the major API responses. Same shape
// as apps-agent.js so the failover behavior is consistent across automation
// surfaces.
function isBrowserProviderExhaustionError(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  if (/insufficient_quota|quota exceeded|quota has been exceeded|credit balance is too low|out of credits|out of credit|rate limit|rate-limit|429|resource exhausted|billing|purchase credits/.test(text)) return true;
  // Transient upstream failures — fail over rather than abort.
  if (/\b50[234]\b|upstream connect error|connection timeout|connection reset|econnreset|enotfound|service unavailable|bad gateway|gateway timeout|overloaded|temporarily unavailable/.test(text)) return true;
  return false;
}

// Ranked provider attempts, mirroring apps-agent. Preferred provider goes
// first; everything else available follows in canonical priority order.
function rankProviderAttempts(registry, preferred) {
  const order = ['anthropic', 'openai', 'gemini', 'grok', 'qwen'];
  const seen = new Set();
  const out = [];
  if (preferred && registry[preferred]) {
    out.push({ key: preferred, entry: registry[preferred] });
    seen.add(preferred);
  }
  for (const k of order) {
    if (registry[k] && !seen.has(k)) {
      out.push({ key: k, entry: registry[k] });
      seen.add(k);
    }
  }
  return out;
}

// Build a continuation prompt for the next browser provider so the new
// agent picks up where the previous one stopped — same idea as the apps
// path. Includes original goal, action log, current host/url, and a
// directive to inspect the live DOM before doing anything.
function buildBrowserContinuationPrompt({ originalGoal, thread, fromProvider, toProvider, exhaustReason }) {
  const lines = [];
  lines.push(`Goal: ${originalGoal || ''}`);
  lines.push('');
  lines.push(`## Provider handoff: ${fromProvider} -> ${toProvider}`);
  lines.push(`The previous AI provider was unable to continue (${exhaustReason || 'quota/credit exhausted'}).`);
  lines.push('You are picking up an in-progress browser automation. Do NOT restart from scratch.');
  lines.push('');
  if (Array.isArray(thread && thread._recordedActions) && thread._recordedActions.length) {
    lines.push('## What was already done');
    const recent = thread._recordedActions.slice(-30);
    for (const a of recent) {
      const args = a.args || {};
      let summary = a.name;
      if (a.name === 'navigate' && args.url) summary = `navigate ${args.url}`;
      else if (a.name === 'click' && args.selector) summary = `click ${args.selector}`;
      else if (a.name === 'click_text' && args.text) summary = `click_text "${String(args.text).slice(0, 60)}"`;
      else if (a.name === 'fill' && args.selector) summary = `fill ${args.selector} <- "${String(args.value || '').slice(0, 60)}"`;
      else if (a.name === 'fill_by_label' && args.label) summary = `fill_by_label "${args.label}" <- "${String(args.value || '').slice(0, 60)}"`;
      else if (a.name === 'press_key' && args.key) summary = `press_key ${args.key}`;
      else summary = `${a.name} ${JSON.stringify(args).slice(0, 80)}`;
      lines.push(`- ${summary}`);
    }
    lines.push('');
  }
  if (thread && thread.host) lines.push(`Current site: ${thread.host}`);
  if (thread && thread.lastUrl) lines.push(`Last URL: ${thread.lastUrl}`);
  lines.push('');
  lines.push('## What to do next');
  lines.push('1. Call inspect_dom to see the CURRENT page.');
  lines.push('2. Compare against the goal and the action history above.');
  lines.push('3. Continue from where the previous provider left off — do NOT re-navigate or re-fill fields that already happened.');
  lines.push('4. When the goal is met, call finish.');
  const text = lines.join('\n');
  return text.length > 4096 ? text.slice(0, 4096) + '\n... (truncated)' : text;
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
async function runThread(args) {
  const { thread, broadcast } = args;
  thread.running = true;
  // Outer guard so ANY throw between here and the main loop's own try/catch
  // still lands in thread.lastResult instead of silently rejecting up to the
  // /chat handler's `.catch(() => {})`. The router polls lastResult to know
  // when the run is over, so leaving it null = it never sees the result.
  try {
    return await _runThreadInner(args);
  } catch (e) {
    if (typeof broadcast === 'function') {
      try { broadcast({ type: 'browser-agent-step', threadId: thread.id, kind: 'error', message: e && e.message || String(e), at: Date.now() }); } catch (_) {}
    }
    thread.lastResult = { ok: false, kind: 'error', error: e && e.message || String(e), finishedAt: Date.now() };
    return thread.lastResult;
  } finally {
    thread.running = false;
    pruneThreads();
  }
}

async function _runThreadInner({ thread, task, agent, providerEntry, model, broadcast, credentials }) {
  // Stash the goal on the thread so the auto-promote pass at the end of the
  // run can reach it. Truncated to keep recipe names sane.
  thread.goal = String(task || '').slice(0, 400);
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
    thread.lastResult = { ok: false, kind: 'error', error: 'Failed to open browser: ' + e.message, finishedAt: Date.now() };
    return thread.lastResult;
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
          thread.lastResult = { ok: true, kind: 'stopped', stopped: true, finishedAt: Date.now() };
          return thread.lastResult;
        }
        if (msg.includes('429')) {
          saveBrowserLearning('Rate limit hit mid-task. Reduce steps: prefer direct URL navigation over multi-step UI clicks. Use Haiku model for browser tasks.');
        }
        emit({ kind: 'error', message: providerEntry.adapter.label + ' API error: ' + msg });
        thread.lastResult = { ok: false, kind: 'error', error: providerEntry.adapter.label + ' API error: ' + msg, finishedAt: Date.now() };
        return thread.lastResult;
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
          // Track host context: every navigate updates thread.host so any
          // subsequent click / fill action gets attributed to the right
          // site when we auto-promote the session into a recipe.
          if (tc.name === 'navigate' && result && result.url) {
            thread.host = siteRecipes.normalizeHost(result.url);
            thread.lastUrl = result.url;
          }
          // Record successful DOM-level actions so the session can be
          // promoted to a site recipe on clean finish. Mirrors the apps
          // recordedActions feed so the same Mind/Recipe pipeline applies.
          const RECORDABLE = new Set([
            'navigate', 'click', 'click_text', 'click_handle',
            'fill', 'fill_by_label', 'fill_handle',
            'press_key', 'wait_for', 'scroll_to', 'fill_saved_credentials',
          ]);
          if (RECORDABLE.has(tc.name)) {
            if (!Array.isArray(thread._recordedActions)) thread._recordedActions = [];
            thread._recordedActions.push({ name: tc.name, args: tc.args || {}, at: Date.now() });
          }
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

    // Auto-promote a successful browser session into a draft site recipe
    // so the next "do X on Y" hits the cache instead of paying tokens.
    // Same shape as the apps auto-promote: requires a clean finish and
    // 3+ recorded DOM/nav actions, plus a known host.
    try {
      const looksClean = finalSummary && !/\b(stuck|unable|cannot|could not|failed|stopped|loop detected)\b/i.test(finalSummary);
      if (looksClean && Array.isArray(thread._recordedActions) && thread._recordedActions.length >= 3 && thread.host) {
        const steps = siteRecipes.actionsToSteps(thread._recordedActions);
        if (steps.length >= 3) {
          // Minimization: collapse consecutive WAITs (none today, but the
          // shape is here for future verbs) and trim trailing noise.
          const minimized = [];
          for (const s of steps) {
            const last = minimized[minimized.length - 1];
            if (s.verb === 'WAIT' && last && last.verb === 'WAIT') continue;
            minimized.push(s);
          }
          // Concept tagging from goal text + step contents so cross-site
          // queries like "how do I search" surface recipes whose goals
          // didn't say "search" but whose steps clearly did.
          const haystack = [
            String(thread.goal || ''),
            String(finalSummary || ''),
            ...minimized.map(s => `${s.target || ''} ${s.text || ''} ${s.notes || ''}`),
          ].join(' ').toLowerCase();
          const conceptMap = {
            login: ['log in', 'login', 'sign in', 'signin', 'authenticate', 'password', 'username', 'email'],
            search: ['search', 'find ', 'lookup', 'query for'],
            browse: ['top of', 'subreddit', '/r/', 'browse', 'feed'],
            read: ['read article', 'read post', 'open article'],
            post: ['post ', 'submit', 'publish', 'comment'],
            extract: ['extract', 'scrape', 'collect', 'gather'],
            buy: ['buy', 'add to cart', 'checkout'],
            navigate: ['go to', 'navigate to', 'visit '],
          };
          const conceptTags = [];
          for (const [tag, keys] of Object.entries(conceptMap)) {
            if (keys.some(k => haystack.includes(k))) conceptTags.push(tag);
          }

          const baseName = String(thread.goal || 'auto-recorded').slice(0, 60).replace(/[\\/:*?"<>|]/g, ' ').trim();
          const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
          const recipeName = `${baseName} (auto ${stamp})`;
          const saved = siteRecipes.saveRecipe(thread.host, {
            name: recipeName,
            description: `Auto-recorded from browser session ${thread.id}. Goal: ${thread.goal || ''}`,
            steps: minimized,
            status: 'draft',
            conceptTags,
            sourceSessionId: thread.id,
          });
          emit({ kind: 'auto_recipe', host: thread.host, name: recipeName, steps: minimized.length, conceptTags });

          // Live Mind sync so any other CLI sees the new automation
          // immediately, not on the next /api/mind/build.
          if (saved && saved.path) {
            try {
              const http = require('http');
              const payload = JSON.stringify({
                path: saved.path,
                label: `${thread.host}: ${recipeName}`,
                kind: 'recipe',
                createdBy: 'browser-agent',
                tags: ['site-automation', thread.host, ...conceptTags],
              });
              const mreq = http.request({
                host: '127.0.0.1', port: 3800, path: '/api/mind/add', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
              }, (mres) => { mres.resume(); });
              mreq.on('error', () => {});
              mreq.write(payload); mreq.end();
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      emit({ kind: 'auto_recipe_error', error: e.message });
    }

    const finalReport = buildFinalBrowserReport(finalSummary, actionReports);
    emit({ kind: 'done', summary: finalSummary, markdown: finalReport, reports: actionReports });
    thread.lastResult = { ok: true, kind: 'done', summary: finalSummary, iterations: iter, report: finalReport, actionReports, finishedAt: Date.now() };
    return thread.lastResult;
  } catch (e) {
    emit({ kind: 'error', message: e.message });
    thread.lastResult = { ok: false, kind: 'error', error: e.message, finishedAt: Date.now() };
    return thread.lastResult;
  }
  // running=false + pruneThreads moved to outer runThread wrapper.
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

  const buildRegistry = () => {
    const aiKeys = Object.assign({}, getConfig().AiApiKeys || {});
    // Environment variables are a fallback source.
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'DASHSCOPE_API_KEY', 'GEMINI_API_KEY']) {
      if (!aiKeys[k] && process.env[k]) aiKeys[k] = process.env[k];
    }
    return buildProviderRegistry(aiKeys);
  };

  addRoute('POST', '/api/browser/agent/chat', async (req, res) => {
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
    // Build the full provider attempt list so an exhausted first provider
    // hands off to the next one mid-run with full context, rather than
    // failing the user's task on a 429.
    const attempts = rankProviderAttempts(registry, body.provider);
    json(res, { ok: true, threadId, provider: entry.adapter.kind, label: entry.adapter.label, model, attempts: attempts.map(a => a.key) });
    (async () => {
      let currentTask = task;
      const originalGoal = task;
      for (let i = 0; i < attempts.length; i++) {
        const a = attempts[i];
        if (i > 0) {
          // Force fresh thread state on provider switch so the new
          // adapter's tool-call shape isn't conflated with the previous
          // adapter's message history.
          thread.providerKind = null;
          thread.messages = [];
        }
        if (typeof broadcast === 'function') {
          try { broadcast({ type: 'browser-agent-step', threadId: thread.id, kind: 'provider_attempt', provider: a.key, label: a.entry.adapter.label, attempt: i + 1, total: attempts.length, at: Date.now() }); } catch (_) {}
        }
        const m = (i === 0 ? model : a.entry.adapter.defaultModel);
        const result = await runThread({ thread, task: currentTask, agent, providerEntry: a.entry, model: m, broadcast, credentials }).catch(e => ({ ok: false, error: e && e.message || String(e) }));
        if (result && result.ok) return;
        const reason = (result && (result.error || result.message)) || 'unknown';
        if (!isBrowserProviderExhaustionError(reason) || i + 1 >= attempts.length) return;
        const next = attempts[i + 1];
        currentTask = buildBrowserContinuationPrompt({
          originalGoal, thread,
          fromProvider: a.entry.adapter.label,
          toProvider: next.entry.adapter.label,
          exhaustReason: reason,
        });
        if (typeof broadcast === 'function') {
          try { broadcast({ type: 'browser-agent-step', threadId: thread.id, kind: 'provider_fallback', from: a.key, to: next.key, message: reason, continuationBytes: Buffer.byteLength(currentTask, 'utf8'), at: Date.now() }); } catch (_) {}
        }
        thread.stopped = false;
      }
    })().catch(() => {});
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
