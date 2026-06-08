// browser-chat-telemetry -- action description, per-action telemetry capture
// (network/console/payload snapshots around each tool call), and the structured
// action/final report builders the browser agent emits to the UI. Split from
// browser-agent-chat.js; the run loop imports describeAction, isMutatingTool,
// snapshotAgentState, captureActionTelemetry, buildActionReport, buildFinalBrowserReport.
const { shortenContent } = require('./browser-chat-util');

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

module.exports = {
  describeAction, isMutatingTool, MUTATING_TOOLS, snapshotAgentState, captureActionTelemetry,
  buildActionReport, buildFinalBrowserReport, buildActionSummaryLines, summarizeUrl, summarizePayload,
  normalizeActionResult, isRelevantNetworkResponse,
};
