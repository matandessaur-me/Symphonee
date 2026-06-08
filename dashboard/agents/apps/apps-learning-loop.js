/**
 * Apps learning loop.
 *
 * Middleware the runSession loop consults at key points. No network
 * calls of its own; it only processes data already present in the
 * session and asks the provider for a short observer turn when due.
 *
 * Responsibilities:
 *   1. Retry-with-variation: refuse exact-duplicate tool calls with a
 *      crisp error so the model must propose a different approach.
 *   2. Stuck detector: watches screenshot pixel signatures and action
 *      cadence; decides when a session looks stuck.
 *   3. Observer pass: once every N actions, ask the provider a tiny
 *      question on the side ("did you learn anything new?") and record
 *      the answer to per-app memory if it volunteers one.
 *   4. Research sub-task: when genuinely stuck, spawn a secondary
 *      provider call with web search to pull in external knowledge.
 *      (Anthropic-only in v1; other providers fall back to a pep-talk
 *      user-message so the main loop still resumes.)
 */

const memory = require('./apps-memory');

const OBSERVER_EVERY_N = 5;
const STUCK_PIXEL_THRESHOLD = 0.98;     // >= this means "no pixels changed"
const STUCK_ACTION_STREAK = 4;          // actions without a completeSubgoal-ish signal (tightened)
const LOOP_SAME_TOOL_THRESHOLD = 3;     // same-tool-in-a-row count that counts as "looping"

// ---- Retry-with-variation ---------------------------------------------------

function _key(tool, args) {
  try { return tool + ':' + JSON.stringify(args || {}); }
  catch (_) { return tool + ':?'; }
}

function trackTry(session, tool, args) {
  if (!session._attempts) session._attempts = [];
  session._attempts.push({ key: _key(tool, args), at: Date.now() });
  // Keep the tail bounded; learning-loop only cares about recent history.
  if (session._attempts.length > 60) session._attempts = session._attempts.slice(-40);
}

function alreadyFailedIdentically(session, tool, args) {
  const k = _key(tool, args);
  const recent = (session._attempts || []).filter(a => a.key === k);
  if (!recent.length) return null;
  // Only flag a duplicate if a very recent identical call also landed as
  // an error. runSession stamps the error flag via recordOutcome below.
  const lastErr = (session._errorKeys || []).includes(k);
  if (lastErr) return { count: recent.length, key: k };
  return null;
}

function recordOutcome(session, tool, args, ok) {
  const k = _key(tool, args);
  if (!session._errorKeys) session._errorKeys = [];
  if (!ok) {
    if (!session._errorKeys.includes(k)) session._errorKeys.push(k);
  } else {
    session._errorKeys = session._errorKeys.filter(x => x !== k);
  }
  if (session._errorKeys.length > 40) session._errorKeys = session._errorKeys.slice(-25);
}

// ---- Stuck detection --------------------------------------------------------

// Cheap per-frame signature: 4x4 luminance grid from the base64 header.
// We never decode the full JPEG; instead we take a fast content hash that
// changes when the screen meaningfully changes.
function _signatureFromScreenshot(shot) {
  if (!shot || !shot.base64) return null;
  // Crude but good enough: hash bytes spread evenly across the payload.
  const s = shot.base64;
  const len = s.length;
  const samples = 32;
  const step = Math.max(1, Math.floor(len / samples));
  let h = 0;
  for (let i = 0; i < len; i += step) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return { hash: h, size: len, width: shot.width, height: shot.height };
}

function _pixelSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a.width !== b.width || a.height !== b.height) return 0;
  // Identical hash AND size = treat as "pixels unchanged".
  if (a.hash === b.hash && Math.abs(a.size - b.size) < 64) return 1;
  // Close sizes on JPEG usually mean very similar content; cap so we never
  // return > 0.98 unless hashes match.
  const sizeDelta = Math.abs(a.size - b.size);
  const sizeScale = Math.min(a.size, b.size) || 1;
  const sizeCloseness = Math.max(0, 1 - sizeDelta / sizeScale);
  return sizeCloseness * 0.7; // cap at < 0.98 even when sizes are near
}

function noteScreenshot(session, shot) {
  if (!session._shotSigs) session._shotSigs = [];
  const sig = _signatureFromScreenshot(shot);
  if (!sig) return;
  session._shotSigs.push(sig);
  if (session._shotSigs.length > 6) session._shotSigs = session._shotSigs.slice(-4);
}

function noteAction(session, tool) {
  if (!session._actionStreak) session._actionStreak = 0;
  if (!session._sameToolStreak) session._sameToolStreak = { tool: null, n: 0 };
  // Reset on terminal-ish calls (finish, declare_stuck, write_memory).
  if (tool === 'finish' || tool === 'declare_stuck') {
    session._actionStreak = 0;
    session._sameToolStreak = { tool: null, n: 0 };
    return;
  }
  session._actionStreak++;
  // Track consecutive identical tool calls (any args) — a classic loop is
  // "click, click, click" against the same thing without progress.
  if (session._sameToolStreak.tool === tool) session._sameToolStreak.n++;
  else session._sameToolStreak = { tool, n: 1 };
}

function isStuck(session) {
  // Strict definition: the AGENT IS ACTING but the SCREEN is not changing.
  // Requires FOUR consecutive near-identical frames so a subtle UI change
  // (dropdown opening, toast, sidebar field update, spinner) does not flip
  // us into stuck. The previous 3-frame threshold + action-count + same-tool
  // heuristics were yanking the model out of workflows that were actually
  // progressing, which then made it loop on "try something different" prompts
  // and produce the "stuck at step 9 even though things were happening"
  // behaviour.
  const sigs = session._shotSigs || [];
  if (sigs.length >= 4) {
    const d = sigs[sigs.length - 4];
    const c = sigs[sigs.length - 3];
    const b = sigs[sigs.length - 2];
    const a = sigs[sigs.length - 1];
    const s1 = _pixelSimilarity(d, c);
    const s2 = _pixelSimilarity(c, b);
    const s3 = _pixelSimilarity(b, a);
    if (s1 >= STUCK_PIXEL_THRESHOLD && s2 >= STUCK_PIXEL_THRESHOLD && s3 >= STUCK_PIXEL_THRESHOLD) {
      return { stuck: true, reason: 'screen unchanged across last 4 screenshots despite actions' };
    }
  }
  return { stuck: false };
}

// ---- Observer pass ----------------------------------------------------------

function shouldObserve(session) {
  if (!session.app) return false;
  const count = session._actionCount = (session._actionCount || 0) + 1;
  return count > 0 && (count % OBSERVER_EVERY_N) === 0;
}

// Run a tiny secondary provider call asking whether the agent noticed
// anything memory-worthy. Extracts the first bullet answer (if any) and
// writes it to memory. Designed to be fire-and-forget; failures swallow.
async function runObserver({ session, providerEntry, model, lastActions }) {
  if (!session.app) return { wrote: false, skipped: 'no app' };
  const adapter = providerEntry.adapter;
  const summary = (lastActions || []).map(a => {
    return `- ${a.summary || a.tool}${a.ok === false ? ' (error: ' + (a.error || 'failed') + ')' : ''}`;
  }).join('\n') || '(no recent actions)';

  const prompt = [
    `You are a side-observer watching an AI agent drive a Windows application called "${session.app}".`,
    `The agent has just performed these recent actions:`,
    summary,
    ``,
    `Look for anything a FUTURE session would benefit from. Canonical categories:`,
    `- "Keybindings": a shortcut that actually worked on the first try`,
    `- "Nice to know": where a named element lives / app quirk`,
    `- "DOs": the minimal sequence of steps that produced a result`,
    `- "DON'T DOs": an approach that failed predictably — future sessions should skip it`,
    ``,
    `Do NOT write session narration (things like "reached N attempts", "unable to", "after N tries"). Only reusable facts.`,
    `If you spot one, answer with ONE line (bullet <= 160 chars):`,
    `SECTION: <one of the categories above> :: <short bullet>`,
    `If there is nothing new or notable, answer exactly:`,
    `NOTHING`,
  ].join('\n');

  try {
    const resp = await adapter.call({
      messages: adapter.initMessages(prompt),
      apiKey: providerEntry.apiKey,
      model,
      systemPrompt: 'You are a concise side-observer for an AI desktop-control agent. Respond in one line.',
    });
    const text = (resp && resp.text ? resp.text.trim() : '').split('\n')[0] || '';
    if (!text || /^NOTHING\b/i.test(text)) return { wrote: false };
    const m = /^SECTION\s*:\s*([^:]+?)\s*::\s*(.+)$/i.exec(text);
    if (!m) return { wrote: false, raw: text };
    const section = m[1].trim();
    const note = m[2].trim();
    try {
      memory.appendSection(session.app, section, note);
      return { wrote: true, section, note };
    } catch (e) {
      return { wrote: false, error: e.message };
    }
  } catch (e) {
    return { wrote: false, error: e.message };
  }
}

// ---- Research sub-task ------------------------------------------------------

async function runResearch({ session, providerEntry, model, goal, reason, lastScreenshots }) {
  // Always prefer a provider with a real web-search tool. Priority:
  // 1. An Anthropic entry in the session registry (Anthropic web_search).
  // 2. A Gemini entry (google_search tool).
  // 3. An OpenAI entry (web_search_preview tool).
  // Fall back to the caller-supplied providerEntry only if none are present.
  // NOTE: the caller's `model` param is the live-session model and does NOT
  // match the research provider's API (e.g. passing gpt-realtime to
  // api.anthropic.com -> 404). Always use the research provider's own
  // defaultModel for the research call.
  const registry = session && session._providerRegistry;
  const chosen = pickResearchProvider(registry, providerEntry);
  const adapter = chosen.entry.adapter;
  const researchModel = adapter.defaultModel;
  const query = `How to "${goal}" in ${session.app || 'the target Windows application'}: the agent is stuck because "${reason}". Focus on keyboard shortcuts and menu paths that would move it past this point.`;
  const prompt = `Research question: ${query}\n\nReturn a <= 350-word markdown summary of what you find. Do NOT write long intros; bullet points with concrete steps/shortcuts only.`;
  try {
    if (chosen.kind === 'anthropic') return await researchAnthropic(chosen.entry, researchModel, prompt);
    if (chosen.kind === 'gemini')    return await researchGemini(chosen.entry, researchModel, prompt);
    if (chosen.kind === 'openai')    return await researchOpenAI(chosen.entry, researchModel, prompt);
    return {
      provider: adapter.kind,
      summary: 'No research-capable provider configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY in Settings -> AI Keys to enable web_research.',
    };
  } catch (e) {
    return { provider: chosen.kind, summary: `Research failed: ${e.message}. Consider calling declare_stuck so the user can help.` };
  }
}

function pickResearchProvider(registry, fallbackEntry) {
  if (registry && registry.anthropic) return { kind: 'anthropic', entry: registry.anthropic };
  if (registry && registry.gemini)    return { kind: 'gemini',    entry: registry.gemini };
  if (registry && registry.openai)    return { kind: 'openai',    entry: registry.openai };
  const kind = fallbackEntry && fallbackEntry.adapter && fallbackEntry.adapter.kind;
  return { kind, entry: fallbackEntry };
}

function postJsonHost({ hostname, path, headers, payload, timeoutMs = 60000 }) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({ method: 'POST', hostname, path, headers, timeout: timeoutMs }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`${hostname} ${r.statusCode}: ${d.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('web research timed out')));
    req.write(payload); req.end();
  });
}

async function researchAnthropic(entry, model, prompt) {
  const body = {
    model,
    max_tokens: 1024,
    system: 'You are a short, concrete web researcher. Cite sources with bare URLs inline.',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  const payload = JSON.stringify(body);
  const resp = await postJsonHost({
    hostname: 'api.anthropic.com', path: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-api-key': entry.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    payload,
  });
  const content = resp.content || [];
  const summary = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { provider: 'anthropic', summary: summary || 'No results.', raw: content };
}

async function researchGemini(entry, model, prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
  };
  const payload = JSON.stringify(body);
  const resp = await postJsonHost({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(entry.apiKey)}`,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    payload,
  });
  const parts = (resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts) || [];
  const summary = parts.filter(p => p && p.text).map(p => p.text).join('\n').trim();
  return { provider: 'gemini', summary: summary || 'No results.', raw: resp };
}

async function researchOpenAI(entry, model, prompt) {
  const body = {
    model,
    input: prompt,
    tools: [{ type: 'web_search_preview' }],
  };
  const payload = JSON.stringify(body);
  const resp = await postJsonHost({
    hostname: 'api.openai.com', path: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'authorization': `Bearer ${entry.apiKey}`,
    },
    payload,
  });
  const text = typeof resp.output_text === 'string' && resp.output_text
    || (Array.isArray(resp.output)
      ? resp.output.flatMap(o => (o && o.content) || []).filter(c => c && c.type === 'output_text').map(c => c.text).join('\n')
      : '');
  return { provider: 'openai', summary: (text || '').trim() || 'No results.', raw: resp };
}

module.exports = {
  OBSERVER_EVERY_N,
  trackTry,
  alreadyFailedIdentically,
  recordOutcome,
  noteScreenshot,
  noteAction,
  isStuck,
  shouldObserve,
  runObserver,
  runResearch,
};
