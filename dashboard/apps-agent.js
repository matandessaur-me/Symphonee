/**
 * Apps Agent - REST surface for the Apps tab.
 *
 * Mirrors dashboard/browser-agent.js in shape: a thin module that mounts
 * HTTP routes and wires them to the DesktopDriver (apps-driver.js) and
 * the chat loop (apps-agent-chat.js).
 *
 * Phase 2 scope: one active session at a time, low-level tool schemas
 * only, no permission gate yet (that lands in Phase 4).
 */

const driver = require('./apps-driver');
const chat = require('./apps-agent-chat');
const memory = require('./apps-memory');
const recipes = require('./apps-recipes');
const recipeRunner = require('./apps-recipe-runner');
const recorder = require('./apps-recorder');
const sandbox = require('./apps-sandbox');
const com = require('./apps-com');

const PROVIDER_ORDER = ['anthropic', 'openai', 'gemini', 'grok', 'qwen'];
const CLI_PROVIDER_MAP = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'gemini',
  grok: 'grok',
  qwen: 'qwen',
  copilot: 'openai',
};

async function runSessionForEntry({ entry, session, task, driver, model, broadcast, recipe, inputs, stepThrough }) {
  session._providerEntry = entry;
  session._model = model || (entry && entry.adapter && entry.adapter.defaultModel);
  if (recipe) {
    // Deterministic path: execute recipe steps directly against the driver.
    const res = await recipeRunner.runRecipe({ session, driver, recipe, broadcast, providerEntry: entry, model, inputs, stepThrough });
    // When the user explicitly stopped the run, we respect that and DON'T
    // start a handoff chat - otherwise we'd burn tokens on a session the
    // user deliberately ended. (Also: session.stopped is still true, so the
    // chat loop would exit on iteration one anyway.)
    if (res.aborted) return res;
    // Hand off to the chat loop so the user can ask "why did you stop?" or
    // "try a different way". Clear the stopped flag so the new chat loop
    // doesn't inherit a terminal state from the runner.
    session.stopped = false;
    driver.resetStopped();
    session._handoff = true;
    const chatEntry = entry;
    const chatModel = model || (chatEntry && chatEntry.adapter && chatEntry.adapter.defaultModel);
    const lines = (res.trail || []).map(t => {
      const prefix = t.ok ? '[ok]' : '[FAIL]';
      const target = t.target ? ' ' + t.target : '';
      const textPart = t.text ? ' -> "' + t.text + '"' : '';
      return `${prefix} ${t.verb}${target}${textPart}${t.reason ? ' - ' + t.reason : ''}`;
    }).join('\n');
    const outcome = res.ok
      ? `completed successfully in ${res.iterations} steps`
      : `FAILED at step ${(res.failedAt || 0) + 1}: ${res.error}`;
    const handoff = [
      `The automation "${recipe.name}" ${outcome}.`,
      '',
      'Step trail:',
      lines || '(no steps recorded)',
      '',
      res.ok
        ? 'The user can ask you follow-up questions about what you did. Reply from memory of the trail above; only call tools if they explicitly ask you to do something new.'
        : 'Explain in plain English why the run ended. The user may ask for a fix, a retry, or something different. Diagnose from the trail before acting. Take a fresh screenshot before any new tool call.',
    ].join('\n');
    return chat.runSession({ session, task: handoff, driver, providerEntry: chatEntry, model: chatModel, broadcast });
  }
  return chat.runSession({ session, task, driver, providerEntry: entry, model, broadcast });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function normalizeProviderKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  if (key === 'google') return 'gemini';
  if (key === 'xai') return 'grok';
  return key;
}

function mapCliToProvider(cli) {
  const key = String(cli || '').trim().toLowerCase();
  return key ? (CLI_PROVIDER_MAP[key] || null) : null;
}

// Extract input values for a verified recipe from the user's goal text.
// One non-tool LLM round-trip; falls back to defaults on any error so the
// recipe still runs. Returns a map { inputName: value } or null.
//
// We bias the prompt toward returning the default when the user's goal
// doesn't mention a different value, so "play music on Spotify" with a
// recipe whose default query is "Rock Music" resolves to "Rock Music"
// instead of inventing something.
async function extractRecipeInputs({ goal, recipeInputs, providerEntry, model }) {
  if (!Array.isArray(recipeInputs) || !recipeInputs.length) return null;
  if (!providerEntry || !providerEntry.adapter) return null;
  const schema = recipeInputs.map(i => `- ${i.name}${i.default !== undefined ? ` (default: ${JSON.stringify(i.default)})` : ''}: ${i.description || i.type || 'string'}`).join('\n');
  const prompt = [
    'You map a user goal to recipe input values. Return ONLY a JSON object with one key per input, values as strings.',
    '',
    `User goal: ${goal}`,
    '',
    'Inputs to fill:',
    schema,
    '',
    'Rules:',
    '- If the goal explicitly names a value for an input, use it (e.g. "search for jazz" -> query="jazz").',
    '- If the goal does not specify, return the default (NEVER invent a value).',
    '- Return ONLY valid JSON, no prose, no code fences.',
  ].join('\n');

  const adapter = providerEntry.adapter;
  const adapterKind = adapter.kind;
  const messages = adapterKind === 'gemini'
    ? [{ role: 'user', parts: [{ text: prompt }] }]
    : [{ role: 'user', content: prompt }];
  let resp;
  try {
    resp = await adapter.call({
      messages,
      apiKey: providerEntry.apiKey,
      model: model || adapter.defaultModel,
      tools: [],
      maxTokens: 200,
    });
  } catch (_) { return null; }
  if (!resp || resp.text == null) return null;
  const text = String(resp.text || '').trim();
  // Strip code fences if a model added them despite the instruction.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const out = {};
  for (const inp of recipeInputs) {
    if (parsed[inp.name] != null) out[inp.name] = String(parsed[inp.name]);
  }
  return Object.keys(out).length ? out : null;
}

function isProviderExhaustionError(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  // Quota / credit exhaustion (the original cases).
  if (/insufficient_quota|quota exceeded|quota has been exceeded|credit balance is too low|out of credits|out of credit|rate limit|rate-limit|429|resource exhausted|billing|purchase credits/.test(text)) return true;
  // Transient upstream / gateway failures. We treat these as fail-over
  // signals too: if Anthropic's edge returned 503 we'd rather hand off
  // to OpenAI / Gemini and resume than abort the user's automation. The
  // continuation prompt makes the handoff seamless.
  if (/\b50[234]\b|upstream connect error|connection timeout|connection reset|econnreset|enotfound|service unavailable|bad gateway|gateway timeout|overloaded|temporarily unavailable/.test(text)) return true;
  return false;
}

// Build a continuation prompt for the next provider so the new agent
// doesn't start cold after a credit/quota handoff. Includes:
//   - Original goal
//   - Concise summary of recorded actions (UIA + pixel) so the agent
//     knows what was already attempted
//   - Last failure note (so the new agent doesn't repeat the same step)
//   - Directive to resume from current screen, not restart
// Hard-capped to ~4 KB so we don't shovel a megabyte of action log into
// the next provider's first turn.
function buildContinuationPrompt({ originalGoal, session, fromProvider, toProvider, exhaustReason }) {
  const lines = [];
  lines.push(`Goal: ${originalGoal || ''}`);
  lines.push('');
  lines.push(`## Provider handoff: ${fromProvider} -> ${toProvider}`);
  lines.push(`The previous AI provider was unable to continue (${exhaustReason || 'quota/credit exhausted'}).`);
  lines.push('You are picking up an in-progress automation. Do NOT restart from scratch.');
  lines.push('');
  if (Array.isArray(session && session._recordedActions) && session._recordedActions.length) {
    lines.push('## What was already done');
    const recent = session._recordedActions.slice(-30);
    for (const a of recent) {
      const args = a.args || {};
      let summary = a.name;
      if (a.name === 'click_element' && args.selector) summary = `click_element ${JSON.stringify(args.selector).slice(0, 100)}`;
      else if (a.name === 'type_into_element' && args.selector) summary = `type_into_element ${JSON.stringify(args.selector).slice(0, 80)} <- "${String(args.text || '').slice(0, 60)}"`;
      else if (a.name === 'click') summary = `click x=${args.x} y=${args.y}`;
      else if (a.name === 'type_text') summary = `type_text "${String(args.text || '').slice(0, 60)}"`;
      else if (a.name === 'key') summary = `key ${args.combo || ''}`;
      else if (a.name === 'navigate') summary = `navigate ${args.url || ''}`;
      else summary = `${a.name} ${JSON.stringify(args).slice(0, 80)}`;
      lines.push(`- ${summary}`);
    }
    lines.push('');
  }
  if (session && session.app)   lines.push(`Target app: ${session.app}`);
  if (session && session.title) lines.push(`Target window title: "${session.title}"`);
  if (session && session.hwnd != null) lines.push(`Window hwnd: ${session.hwnd} (already focused)`);
  lines.push('');
  lines.push('## What to do next');
  lines.push('1. Call describe_window (preferred) or screenshot to see the CURRENT state.');
  lines.push('2. Compare against the goal and the action history above.');
  lines.push('3. Continue from where the previous provider left off — do NOT click "Search" again if it was already clicked, do NOT type the query again if it was already typed, etc.');
  lines.push('4. When the goal is met, call finish.');
  const text = lines.join('\n');
  return text.length > 4096 ? text.slice(0, 4096) + '\n... (truncated)' : text;
}

function headerValue(req, name) {
  if (!req || !req.headers) return null;
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] || null;
  return raw || null;
}

function resolveCallerContext({ req, body, resolveTermCli }) {
  const explicitProvider = normalizeProviderKey(body && body.provider);
  const explicitCli = String((body && body.cli) || headerValue(req, 'x-symphonee-cli') || '').trim().toLowerCase() || null;
  const termId = String((body && body.termId) || headerValue(req, 'x-symphonee-term-id') || '').trim() || null;
  const termCli = !explicitCli && termId && typeof resolveTermCli === 'function'
    ? String(resolveTermCli(termId) || '').trim().toLowerCase() || null
    : null;
  const cli = explicitCli || termCli || null;
  return { cli, termId, preferredProvider: explicitProvider || mapCliToProvider(cli) || null };
}

function buildProviderAttempts({ registry, preferredProvider, model }) {
  const ordered = PROVIDER_ORDER.filter(k => registry && registry[k]);
  if (preferredProvider && registry && registry[preferredProvider]) {
    const idx = ordered.indexOf(preferredProvider);
    if (idx > 0) {
      ordered.splice(idx, 1);
      ordered.unshift(preferredProvider);
    } else if (idx === -1) {
      ordered.unshift(preferredProvider);
    }
  }
  return ordered
    .filter((key, index) => ordered.indexOf(key) === index && registry[key])
    .map((key, index) => ({
      key,
      entry: registry[key],
      model: index === 0 && model ? model : registry[key].adapter.defaultModel,
    }));
}

async function runSessionWithFallback({
  attempts,
  session,
  task,
  driver,
  broadcast,
  recipe,
  inputs,
  stepThrough,
  notify,
}) {
  let last = null;
  const originalGoal = task;
  let currentTask = task;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (typeof broadcast === 'function') {
      broadcast({
        type: 'apps-agent-step',
        sessionId: session.id,
        kind: 'provider_attempt',
        provider: attempt.key,
        label: attempt.entry.adapter.label,
        model: attempt.model,
        attempt: i + 1,
        total: attempts.length,
        at: Date.now(),
      });
    }
    // Force a fresh message thread on every provider switch so the new
    // adapter sees the continuation prompt, not stale messages built for
    // the previous provider's tool-use shape.
    if (i > 0) session.providerKind = null;
    const result = await runSessionForEntry({
      entry: attempt.entry,
      session,
      task: currentTask,
      driver,
      model: attempt.model,
      broadcast,
      recipe,
      inputs,
      stepThrough,
    });
    last = { result, entry: attempt.entry, model: attempt.model, key: attempt.key };
    if (result && result.ok) return last;

    const message = (result && (result.error || result.message)) || 'Unknown provider error';
    const shouldRetry = isProviderExhaustionError(message) && i + 1 < attempts.length;
    if (!shouldRetry) break;

    const next = attempts[i + 1];
    // Build a continuation prompt so the next provider picks up where the
    // previous one left off, with full context of what was already done.
    // Without this, the new agent restarts from scratch and re-clicks /
    // re-types things that already happened on screen.
    currentTask = buildContinuationPrompt({
      originalGoal,
      session,
      fromProvider: attempt.entry.adapter.label,
      toProvider: next.entry.adapter.label,
      exhaustReason: message,
    });
    if (typeof broadcast === 'function') {
      broadcast({
        type: 'apps-agent-step',
        sessionId: session.id,
        kind: 'provider_fallback',
        from: attempt.key,
        to: next.key,
        message,
        continuationBytes: Buffer.byteLength(currentTask, 'utf8'),
        at: Date.now(),
      });
    }
    if (typeof notify === 'function') {
      notify(
        'Apps provider exhausted',
        `${attempt.entry.adapter.label} ran out of credits/quota or was rate-limited. Continuing with ${next.entry.adapter.label} from where we left off.`
      );
    }
    session.stopped = false;
    driver.resetStopped();
  }
  if (last && typeof notify === 'function') {
    const reason = last.result && (last.result.error || last.result.message);
    notify('Apps automation failed', reason ? `No provider could complete this run: ${reason}` : 'No provider could complete this run.');
  }
  return last || { result: { ok: false, error: 'No provider attempts were available.' }, entry: null, model: null, key: null };
}

function mountAppsRoutes(addRoute, json, { getConfig, broadcast, permGate, resolveTermCli } = {}) {
  const isIncognito = () => (getConfig && getConfig().IncognitoMode === true);
  const buildRegistry = () => {
    const aiKeys = Object.assign({}, (getConfig && getConfig().AiApiKeys) || {});
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'DASHSCOPE_API_KEY', 'GEMINI_API_KEY']) {
      if (!aiKeys[k] && process.env[k]) aiKeys[k] = process.env[k];
    }
    return chat.buildProviderRegistry(aiKeys);
  };
  const notify = (title, body) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'notification', title, body, icon: 'monitor', source: 'apps-agent' });
    }
  };

  addRoute('POST', '/api/apps/windows', async (req, res) => {
    try {
      const list = await driver.listWindows({ force: true });
      json(res, { ok: true, windows: list });
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  });

  addRoute('POST', '/api/apps/installed', async (req, res) => {
    try {
      const apps = await driver.listInstalledApps();
      json(res, { ok: true, apps });
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  });

  addRoute('POST', '/api/apps/launch', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const id = body.id ? String(body.id) : null;
    const path = body.path ? String(body.path) : null;
    const name = body.name ? String(body.name) : null;
    const stealth = body.sandbox === true || body.stealth === true;
    if (!id && !path) return json(res, { error: 'id or path required' }, 400);
    if (typeof permGate === 'function') {
      const label = (stealth ? 'Stealth-launch app: ' : 'Launch app: ') + (name || id || path);
      const ok = await permGate(res, 'api', 'POST /api/apps/launch', label);
      if (!ok) return;
    }
    try {
      const result = stealth
        ? await sandbox.stealthLaunch({ id, path, name })
        : await driver.launchApp({ id, path, name });
      json(res, { ok: true, ...result });
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  });

  // Sandbox control surface. The hwnd from a stealth launch (or one passed
  // to /sandbox/adopt) becomes a "sandboxed" target — the agent treats it
  // like any other window, but launch/focus are no-ops on the host desktop.
  addRoute('POST', '/api/apps/sandbox/adopt', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = Number(body.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required' }, 400);
    if (typeof permGate === 'function') {
      const ok = await permGate(res, 'api', 'POST /api/apps/sandbox/adopt', 'Stash window ' + hwnd + ' off-screen for stealth automation');
      if (!ok) return;
    }
    try { json(res, { ok: true, ...(await sandbox.adoptIntoSandbox(hwnd, { app: body.app })) }); }
    catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  addRoute('POST', '/api/apps/sandbox/peek', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = Number(body.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required' }, 400);
    try { json(res, await sandbox.peek(hwnd)); }
    catch (e) { json(res, { ok: false, error: e.message }, 400); }
  });

  addRoute('POST', '/api/apps/sandbox/unpeek', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = Number(body.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required' }, 400);
    try { json(res, await sandbox.unpeek(hwnd)); }
    catch (e) { json(res, { ok: false, error: e.message }, 400); }
  });

  addRoute('POST', '/api/apps/sandbox/release', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = Number(body.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required' }, 400);
    const restore = body.restore !== false;
    try { json(res, await sandbox.release(hwnd, { restore })); }
    catch (e) { json(res, { ok: false, error: e.message }, 400); }
  });

  addRoute('GET', '/api/apps/sandbox/list', async (req, res) => {
    json(res, { ok: true, sandboxed: sandbox.list() });
  });

  // COM-based Office automation. Headless (no window painted at all) — even
  // more invisible than off-screen positioning. Bypasses UIA which can't
  // drive Office's custom-canvas editing surfaces.
  addRoute('POST', '/api/apps/com/word/write', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const filePath = body.filePath ? String(body.filePath) : null;
    if (!filePath) return json(res, { error: 'filePath required' }, 400);
    if (typeof permGate === 'function') {
      const ok = await permGate(res, 'api', 'POST /api/apps/com/word/write', 'Write Word doc to ' + filePath);
      if (!ok) return;
    }
    try { json(res, await com.wordWrite({ filePath, content: String(body.content || '') })); }
    catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  addRoute('POST', '/api/apps/com/word/read', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const filePath = body.filePath ? String(body.filePath) : null;
    if (!filePath) return json(res, { error: 'filePath required' }, 400);
    try { json(res, await com.wordRead({ filePath })); }
    catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  addRoute('POST', '/api/apps/com/excel/write', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const filePath = body.filePath ? String(body.filePath) : null;
    if (!filePath) return json(res, { error: 'filePath required' }, 400);
    if (!Array.isArray(body.values)) return json(res, { error: 'values required (2D array)' }, 400);
    if (typeof permGate === 'function') {
      const ok = await permGate(res, 'api', 'POST /api/apps/com/excel/write', 'Write Excel sheet to ' + filePath + ' (' + body.values.length + ' rows)');
      if (!ok) return;
    }
    try { json(res, await com.excelWrite({ filePath, values: body.values, sheetName: body.sheetName, autoFit: body.autoFit !== false })); }
    catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  addRoute('POST', '/api/apps/com/excel/read', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const filePath = body.filePath ? String(body.filePath) : null;
    if (!filePath) return json(res, { error: 'filePath required' }, 400);
    try { json(res, await com.excelRead({ filePath, sheetName: body.sheetName || null, maxRows: body.maxRows, maxCols: body.maxCols })); }
    catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  // One-off screenshot for a window. Used by the AI recipe generator so it
  // can ground DSL steps in the actual UI currently on screen.
  addRoute('GET', '/api/apps/screenshot', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hwnd = Number(url.searchParams.get('hwnd'));
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required' }, 400);
    try {
      const shot = await driver.screenshotWindow(hwnd, { format: 'jpeg', quality: 55 });
      if (!shot || !shot.base64) return json(res, { error: 'screenshot failed' }, 500);
      json(res, { ok: true, base64: shot.base64, mimeType: shot.mimeType || 'image/jpeg', width: shot.width, height: shot.height });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });

  addRoute('GET', '/api/apps/icon', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const idOrPath = url.searchParams.get('id') || url.searchParams.get('path');
    if (!idOrPath) return json(res, { error: 'id or path required' }, 400);
    try {
      const icon = await driver.extractAppIcon(idOrPath);
      json(res, { ok: true, ...icon });
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  });

  // Orchestrated chain: installed -> launch -> windows -> session/start, all
  // in one call. Designed for terminal AIs (Claude Code, Codex, etc.) so a
  // request like "open Spotify and play rock music" doesn't stall after the
  // launch step. The agent gets back { ok, sessionId, hwnd, app } once the
  // session is running, then either streams to completion (default, blocks
  // up to waitMs) or returns immediately (waitMs=0) so the caller can
  // observe via the apps-agent-step WS.
  addRoute('POST', '/api/apps/do', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }

    const appName = String(body.app || body.appName || '').trim();
    const goal = String(body.goal || '').trim();
    const model = body.model || null;
    const waitMs = body.waitMs === 0 ? 0 : Math.max(1000, Math.min(Number(body.waitMs) || 600000, 1800000));
    if (!appName) return json(res, { error: 'app required (name to match against /api/apps/installed)' }, 400);
    if (!goal) return json(res, { error: 'goal required (what should the agent do once the app is open?)' }, 400);

    // Single permission gate for the whole chain. Naming both the app and
    // the goal so the user sees the full intent in the modal.
    if (typeof permGate === 'function') {
      const label = `Drive ${appName}: ${goal.slice(0, 100)}`;
      const ok = await permGate(res, 'api', 'POST /api/apps/do', label);
      if (!ok) return;
    }

    const stealth = body.sandbox === true || body.stealth === true;
    let installed;
    try { installed = await driver.listInstalledApps(); }
    catch (e) { return json(res, { error: 'listInstalledApps failed: ' + e.message }, 500); }

    const needle = appName.toLowerCase();
    let match = installed.find(a => (a.name || '').toLowerCase() === needle)
      || installed.find(a => (a.name || '').toLowerCase().startsWith(needle))
      || installed.find(a => (a.name || '').toLowerCase().includes(needle));

    let hwnd = null;
    let title = null;
    let adoptedSandbox = false;
    if (!match) {
      // Fallback: maybe the app is already running. Look for a window whose
      // title or processName matches the needle, skip the launch step.
      const running = await driver.listWindows({ force: true });
      const win = running.find(w => (w.title || '').toLowerCase().includes(needle))
        || running.find(w => (w.processName || '').toLowerCase().includes(needle));
      if (!win) {
        return json(res, {
          error: `App not found in /api/apps/installed and no running window matched "${appName}". Try /api/apps/installed and pass an exact name.`,
          suggestions: installed.filter(a => (a.name || '').toLowerCase().includes(needle.split(' ')[0])).slice(0, 5).map(a => a.name),
        }, 404);
      }
      hwnd = win.hwnd; title = win.title;
      // If the caller asked for stealth and we picked up an already-running
      // window, stash it off-screen now so the run doesn't disturb the user.
      if (stealth && !sandbox.isSandboxed(hwnd)) {
        try { await sandbox.adoptIntoSandbox(hwnd, { app: appName }); adoptedSandbox = true; } catch (_) {}
      }
    } else {
      try {
        const launched = stealth
          ? await sandbox.stealthLaunch({ id: match.id, path: match.path, name: match.name })
          : await driver.launchApp({ id: match.id, path: match.path, name: match.name });
        hwnd = launched.hwnd; title = launched.title;
      } catch (e) {
        return json(res, { error: 'launchApp failed: ' + e.message, app: match.name }, 500);
      }
    }
    if (!Number.isFinite(hwnd) || hwnd <= 0) {
      return json(res, { error: 'Resolved app but no window hwnd available' }, 500);
    }

    // Hand off to the existing session/start machinery directly (no HTTP
    // self-call) so we keep the gate, recipe handling, and provider picking
    // consistent.
    const sessionId = body.sessionId || ('apps-do-' + Date.now().toString(36));
    const session = chat.getSession(sessionId);
    if (session.running) return json(res, { error: 'Session already running. Stop it first or pass a different sessionId.' }, 409);

    try {
      // Sandboxed windows live off-screen; calling focusWindow on them would
      // (a) drag them back onto the visible desktop and (b) steal foreground
      // from whatever the user is doing. Skip the focus dance — UIA-based
      // input doesn't need it.
      const isSandboxed = sandbox.isSandboxed(hwnd);
      if (isSandboxed) {
        session.hwnd = hwnd;
        session.title = title || (sandbox.getEntry(hwnd) || {}).app || 'sandboxed window';
      } else {
        const focused = await driver.focusWindow(hwnd);
        session.hwnd = hwnd;
        session.title = focused.title || title;
      }
      session.app = match ? match.name : appName;
      session.goal = goal;
      session.stopped = false;
      session.sandboxed = isSandboxed;
      driver.resetStopped();
    } catch (e) {
      const code = e && e.code;
      if (code === 'deny_listed') return json(res, { error: e.message, code }, 403);
      return json(res, { error: 'Failed to focus target window: ' + e.message }, 400);
    }

    const registry = buildRegistry();
    const caller = resolveCallerContext({ req, body, resolveTermCli });
    const attempts = buildProviderAttempts({ registry, preferredProvider: caller.preferredProvider, model });
    if (!attempts.length) {
      return json(res, {
        error: 'No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or DASHSCOPE_API_KEY.',
        providers: Object.keys(registry),
      }, 400);
    }

    // Pre-session lookup: check the per-app recipe file directly for a
    // verified recipe whose name/description matches the goal. This is
    // the fast path — it bypasses Mind index staleness entirely (a
    // recipe edited to verified on disk works immediately, without
    // waiting for an extractor pass). Mind is still consulted below
    // for memory context and cross-app concept hints.
    let priorRecipes = [];
    let priorMemory = null;
    let directVerifiedRecipe = null;
    try {
      const recipesMod = require('./apps-recipes');
      const rawList = recipesMod.listRecipes(session.app);
      const list = Array.isArray(rawList && rawList.recipes) ? rawList.recipes : [];
      const goalLc = String(goal || '').toLowerCase();
      // Score each verified recipe by token overlap with the goal so
      // "Search for Rock Music" matches a recipe named "Search for Rock
      // Music in the search bar..." but not an unrelated "Open Settings"
      // recipe stored in the same file.
      function score(r) {
        const hay = ((r.name || '') + ' ' + (r.description || '')).toLowerCase();
        const tokens = goalLc.split(/\s+/).filter(t => t.length >= 3);
        if (!tokens.length) return 0;
        let hits = 0;
        for (const t of tokens) if (hay.includes(t)) hits++;
        return hits / tokens.length;
      }
      const ranked = list.filter(r => r.status === 'verified').map(r => ({ r, s: score(r) })).sort((a, b) => b.s - a.s);
      if (ranked.length && ranked[0].s >= 0.5) directVerifiedRecipe = ranked[0].r;
    } catch (_) { /* file missing / parse fail — fall through to Mind */ }

    try {
      const mindStore = require('./mind/store');
      const mindQuery = require('./mind/query');
      // No direct space accessor here; default to '_global' which is the
      // Symphonee notesNamespace fallback that mind/index.js uses too.
      const space = '_global';
      const repoRoot = require('path').resolve(__dirname, '..');
      const graph = mindStore.loadGraph(repoRoot, space);
      if (graph && Array.isArray(graph.nodes) && graph.nodes.length) {
        const r = mindQuery.runQuery(graph, { question: `${session.app}: ${goal}`, budget: 1200 });
        const candidates = (r.nodes || []).filter(n => n.kind === 'recipe' && (n.tags || []).includes('app-automation') && (n.tags || []).includes(session.app));
        priorRecipes = candidates.slice(0, 3).map(n => ({
          id: n.id, label: n.label, status: (n.tags || []).includes('verified') ? 'verified' : 'draft',
          steps: n.steps, description: n.description, file: n.source && n.source.file,
        }));
        const memNode = (r.nodes || []).find(n => n.kind === 'doc' && (n.tags || []).includes('app-memory') && (n.tags || []).includes(session.app));
        if (memNode && memNode.description) priorMemory = memNode.description;
      }
    } catch (_) { /* Mind unavailable — proceed without hints */ }

    // Verified recipe hit? Direct disk lookup (above) wins over Mind
    // because it survives index staleness. Either way, dispatch through
    // the deterministic recipe runner — no LLM tokens spent on planning.
    let resolvedRecipe = null;
    if (body.skipMindMatch !== true) {
      if (directVerifiedRecipe) {
        resolvedRecipe = directVerifiedRecipe;
      } else {
        const verifiedHit = priorRecipes.find(p => p.status === 'verified');
        if (verifiedHit) {
          try {
            const fs = require('fs');
            if (verifiedHit.file && fs.existsSync(verifiedHit.file)) {
              const data = JSON.parse(fs.readFileSync(verifiedHit.file, 'utf8'));
              const nameFromLabel = String(verifiedHit.label || '').split(':').slice(1).join(':').trim();
              resolvedRecipe = (Array.isArray(data.recipes) ? data.recipes : [])
                .find(r => r.name === nameFromLabel || r.id === verifiedHit.id || r.status === 'verified')
                || null;
            }
          } catch (_) { /* leave resolvedRecipe null and fall back to agent */ }
        }
      }
      if (resolvedRecipe && typeof broadcast === 'function') {
        try { broadcast({
          type: 'apps-agent-step', sessionId: session.id, kind: 'mind_match',
          recipe: { id: resolvedRecipe.id, name: resolvedRecipe.name, willRun: true, source: directVerifiedRecipe ? 'disk' : 'mind' },
          message: `Replaying verified recipe "${resolvedRecipe.name}" — no LLM tokens.`,
          at: Date.now(),
        }); } catch (_) {}
      }
    }

    const taskLines = [
      `Goal: ${goal}`,
      '',
      `Target window: "${session.title}" (hwnd=${hwnd}, app=${session.app})`,
      'The window is already focused. Start with describe_window to see UI elements; only fall back to screenshot when UIA returns nothing useful.',
    ];
    if (priorRecipes.length) {
      taskLines.push('');
      taskLines.push('## Prior automations for this app (from Mind)');
      for (const p of priorRecipes) {
        taskLines.push(`- ${p.label} [${p.status}] — ${p.steps || 0} steps. ${p.description || ''}`);
      }
      taskLines.push('You may follow one of these step-by-step if it matches the goal, or improvise if none fits.');
    }
    if (priorMemory) {
      taskLines.push('');
      taskLines.push('## Prior memory for this app (from Mind)');
      taskLines.push(priorMemory.slice(0, 800));
    }
    const task = taskLines.join('\n');

    session._providerRegistry = registry;

    // If we resolved a verified recipe with declared inputs, extract input
    // values from the user's goal text. Defaults already populate via the
    // runner's input-merge, so this only matters when the user wants
    // something different than the default ("play classical" instead of
    // the default "Rock Music"). One small LLM call, ~200 tokens.
    let recipeInputs = undefined;
    if (resolvedRecipe && Array.isArray(resolvedRecipe.inputs) && resolvedRecipe.inputs.length) {
      try {
        recipeInputs = await extractRecipeInputs({
          goal, recipeInputs: resolvedRecipe.inputs,
          providerEntry: attempts[0].entry, model: attempts[0].model,
        });
        if (typeof broadcast === 'function' && recipeInputs) {
          try { broadcast({ type: 'apps-agent-step', sessionId: session.id, kind: 'recipe_inputs_extracted', inputs: recipeInputs, at: Date.now() }); } catch (_) {}
        }
      } catch (e) { /* fall back to defaults */ }
    }

    const runPromise = runSessionWithFallback({
      attempts, session, task, driver, broadcast, notify,
      // When a verified recipe was resolved, hand it to runSessionForEntry
      // which routes through recipeRunner.runRecipe — deterministic playback
      // with vision-locator fallback only on UIA misses.
      recipe: resolvedRecipe || undefined,
      inputs: recipeInputs,
    });

    if (waitMs === 0) {
      json(res, {
        ok: true,
        sessionId,
        hwnd,
        app: session.app,
        title: session.title,
        provider: attempts[0].entry.adapter.kind,
        model: attempts[0].model,
        mode: 'fire-and-forget'
      });
      runPromise.catch(e => {
        if (typeof broadcast === 'function') broadcast({ type: 'apps-agent-step', sessionId: session.id, kind: 'error', message: e.message, at: Date.now() });
      });
      return;
    }

    const terminal = await Promise.race([
      runPromise.then((outcome) => {
        const result = outcome && outcome.result ? outcome.result : null;
        const entry = outcome && outcome.entry ? outcome.entry : attempts[0].entry;
        const usedModel = outcome && outcome.model ? outcome.model : attempts[0].model;
        if (!result) return { kind: 'error', message: 'Unknown apps automation failure', provider: entry.adapter.kind, model: usedModel };
        if (result.ok) return { kind: 'done', summary: result.summary || null, provider: entry.adapter.kind, model: usedModel };
        return { kind: 'error', message: result.error || result.message || 'Unknown apps automation failure', provider: entry.adapter.kind, model: usedModel };
      }).catch(e => ({ kind: 'error', message: e.message })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), waitMs)),
    ]);

    json(res, {
      ok: terminal.kind === 'done',
      sessionId,
      hwnd,
      app: session.app,
      title: session.title,
      provider: terminal.provider || attempts[0].entry.adapter.kind,
      model: terminal.model || attempts[0].model,
      terminal: terminal.kind,
      summary: terminal.summary || null,
      error: terminal.message || null,
    });
  });

  addRoute('POST', '/api/apps/session/start', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }

    // Either `goal` (free-form chat) or `recipeId` (saved automation) is
    // required. When recipeId is supplied we resolve the recipe against the
    // app's recipes file and render it into a goal that seeds the agent.
    let goal = String(body.goal || '').trim();
    let recipe = null;
    const appForLookup = String(body.app || '').trim();
    if (body.recipeId) {
      if (!appForLookup) return json(res, { error: 'app required when using recipeId' }, 400);
      recipe = recipes.getRecipe(appForLookup, String(body.recipeId));
      if (!recipe) return json(res, { error: 'recipe not found' }, 404);
      goal = recipes.renderRecipeAsGoal(recipe);
    }
    if (!goal) return json(res, { error: 'goal or recipeId required' }, 400);
    const hwnd = Number(body.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required (see /api/apps/windows)' }, 400);

    // Gate: starting a session gives the AI pixel-level control of another
    // app. Ask in edit/trusted modes, deny in review. `bypass` auto-allows.
    if (typeof permGate === 'function') {
      const label = 'Control "' + (body.app || 'a window') + '": ' + goal.slice(0, 80);
      const ok = await permGate(res, 'api', 'POST /api/apps/session/start', label);
      if (!ok) return;
    }

    const sessionId = body.sessionId || ('apps-' + Date.now().toString(36));
    const session = chat.getSession(sessionId);
    if (session.running) return json(res, { error: 'Session already running. Stop it first.' }, 409);

    try {
      const isSandboxed = sandbox.isSandboxed(hwnd);
      if (isSandboxed) {
        session.hwnd = hwnd;
        session.title = (sandbox.getEntry(hwnd) || {}).app || 'sandboxed window';
      } else {
        const focused = await driver.focusWindow(hwnd);
        session.hwnd = hwnd;
        session.title = focused.title;
      }
      session.app = String(body.app || '').trim() || null;
      session.goal = goal;
      session.stopped = false;
      session.sandboxed = isSandboxed;
      driver.resetStopped();
    } catch (e) {
      const code = e && e.code;
      if (code === 'deny_listed') return json(res, { error: e.message, code }, 403);
      return json(res, { error: 'Failed to focus target window: ' + e.message }, 400);
    }

    const registry = buildRegistry();
    const caller = resolveCallerContext({ req, body, resolveTermCli });
    const attempts = buildProviderAttempts({ registry, preferredProvider: caller.preferredProvider, model: body.model || null });
    if (!attempts.length) {
      return json(res, {
        error: 'No AI provider configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or DASHSCOPE_API_KEY in Settings -> AI Keys.',
        providers: Object.keys(registry),
      }, 400);
    }
    const firstAttempt = attempts[0];

    json(res, {
      ok: true,
      sessionId,
      provider: firstAttempt.entry.adapter.kind,
      label: firstAttempt.entry.adapter.label,
      model: firstAttempt.model,
      title: session.title,
      recipe: recipe ? { id: recipe.id, name: recipe.name } : null
    });

    if (recipe && typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId, kind: 'recipe_started', recipeId: recipe.id, name: recipe.name, stepCount: recipe.steps.length, at: Date.now() });
    }

    // Build the initial task the model sees: the user's goal plus the
    // window identity so the agent knows what it is driving without us
    // having to pre-list every app.
    const task = [
      `Goal: ${goal}`,
      '',
      `Target window: "${session.title}" (hwnd=${hwnd}${session.app ? `, app=${session.app}` : ''})`,
      'The window is already focused. Start with a screenshot and work toward the goal.',
    ].join('\n');

    session._providerRegistry = registry;
    const runInputs = (body.inputs && typeof body.inputs === 'object') ? body.inputs : null;
    const stepThrough = !!body.stepThrough;
    runSessionWithFallback({ attempts, session, task, driver, broadcast, recipe, inputs: runInputs, stepThrough, notify })
      .catch(e => {
        if (typeof broadcast === 'function') {
          broadcast({ type: 'apps-agent-step', sessionId: session.id, kind: 'error', message: e.message, at: Date.now() });
        }
      });
  });

  addRoute('POST', '/api/apps/session/stop', async (req, res) => {
    let body = {};
    try { body = await readBody(req); } catch (_) {}
    const sessionId = body.sessionId;
    if (!sessionId) return json(res, { error: 'sessionId required' }, 400);
    const session = chat.sessions.get(sessionId);
    if (!session) return json(res, { error: 'unknown session' }, 404);
    session.stopped = true;
    if (session.abortController) {
      try { session.abortController.abort(); } catch (_) {}
    }
    if (typeof session._liveStop === 'function') {
      try { session._liveStop(); } catch (_) {}
    }
    driver.stop();
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId, kind: 'stopped', at: Date.now() });
    }
    json(res, { ok: true });
  });

  // Queue a mid-run user message as a fresh user turn on the session, so
  // the next model iteration sees it. Does NOT consume a pending ask_user;
  // dedicated /api/apps/session/answer is the way to do that.
  addRoute('POST', '/api/apps/session/inject', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const sessionId = String(body.sessionId || '');
    let message = String(body.message || '').trim();
    if (!sessionId || !message) return json(res, { error: 'sessionId and message required' }, 400);
    // Size cap: no one types 8k mid-run; anything bigger is almost certainly
    // a script / paste that would blow the next model request.
    if (message.length > 4000) message = message.slice(0, 4000) + '\n[truncated by /inject]';
    const session = chat.sessions.get(sessionId);
    if (!session) return json(res, { error: 'unknown session' }, 404);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'POST /api/apps/session/inject', 'Send note to running agent: ' + message.slice(0, 80))) return;
    }
    // Append as a user turn in whichever provider shape the session uses.
    const adapterKind = (session._providerEntry && session._providerEntry.adapter && session._providerEntry.adapter.kind) || null;
    if (!Array.isArray(session.messages)) session.messages = [];
    // Cap total queued injections so a loop can't grow messages unbounded.
    const injectedCount = (session._injectedCount = (session._injectedCount || 0) + 1);
    if (injectedCount > 50) return json(res, { error: 'too many mid-run injections; stop the session and start a new one' }, 429);
    if (adapterKind === 'gemini') session.messages.push({ role: 'user', parts: [{ text: message }] });
    else session.messages.push({ role: 'user', content: message });
    if (typeof broadcast === 'function') broadcast({ type: 'apps-agent-step', sessionId, kind: 'user_injected', message, at: Date.now() });
    json(res, { ok: true, mode: 'queued' });
  });

  // Resume a paused ask_user tool-call with the user's answer.
  addRoute('POST', '/api/apps/session/answer', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const sessionId = String(body.sessionId || '');
    const answer = String(body.answer || '').trim();
    if (!sessionId) return json(res, { error: 'sessionId required' }, 400);
    if (!answer) return json(res, { error: 'answer required' }, 400);
    const session = chat.sessions.get(sessionId);
    if (!session) return json(res, { error: 'unknown session' }, 404);
    if (!session._pendingAsk) return json(res, { error: 'session is not waiting for an answer' }, 409);
    session._pendingAsk.resolve(answer);
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId, kind: 'answer', answer, at: Date.now() });
    }
    json(res, { ok: true });
  });

  // Continue an existing session with a follow-up goal. Keeps the full
  // message history so the agent retains context from the prior task(s)
  // instead of re-discovering the app from scratch.
  addRoute('POST', '/api/apps/session/continue', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const sessionId = String(body.sessionId || '');
    const goal = String(body.goal || '').trim();
    if (!sessionId) return json(res, { error: 'sessionId required' }, 400);
    if (!goal) return json(res, { error: 'goal required' }, 400);
    const session = chat.sessions.get(sessionId);
    if (!session) return json(res, { error: 'unknown session' }, 404);
    if (session.running) return json(res, { error: 'Session already running.' }, 409);
    if (typeof permGate === 'function') {
      const ok = await permGate(res, 'api', 'POST /api/apps/session/continue', 'Follow-up: ' + goal.slice(0, 80));
      if (!ok) return;
    }
    // Refocus in case the user alt-tabbed away since the last task ended.
    try { await driver.focusWindow(session.hwnd); } catch (_) {}
    driver.resetStopped();
    session.stopped = false;
    session.goal = goal;
    // Reset stuck / research budgets so the new task gets a fresh chance.
    session._stuckCount = 0;
    session._researchCount = 0;
    session._autoStuckFired = false;
    session._dontRetryNoted = null;

    const registry = buildRegistry();
    const caller = resolveCallerContext({ req, body, resolveTermCli });
    const attempts = buildProviderAttempts({ registry, preferredProvider: caller.preferredProvider, model: body.model || null });
    if (!attempts.length) return json(res, { error: 'No AI provider configured.' }, 400);
    const firstAttempt = attempts[0];

    json(res, {
      ok: true,
      sessionId,
      provider: firstAttempt.entry.adapter.kind,
      label: firstAttempt.entry.adapter.label,
      model: firstAttempt.model,
      title: session.title
    });

    const followUp = [
      `Follow-up task: ${goal}`,
      '',
      'Continue in the same window you were already driving. You do NOT need to relist windows or refocus — the user is keeping you on the same app. Start with a screenshot to see the current state, then work toward this new goal.',
    ].join('\n');

    // Append the new goal as a user turn on the existing message history so
    // prior context (what worked, what didn't) carries over.
    const adapter = firstAttempt.entry.adapter;
    if (adapter.kind === 'gemini') session.messages.push({ role: 'user', parts: [{ text: followUp }] });
    else session.messages.push({ role: 'user', content: followUp });

    session._providerRegistry = registry;
    runSessionWithFallback({ attempts, session, task: followUp, driver, broadcast, notify })
      .catch(e => {
        if (typeof broadcast === 'function') {
          broadcast({ type: 'apps-agent-step', sessionId: session.id, kind: 'error', message: e.message, at: Date.now() });
        }
      });
  });

  addRoute('POST', '/api/apps/panic', async (req, res) => {
    for (const s of chat.sessions.values()) {
      s.stopped = true;
      if (s.abortController) { try { s.abortController.abort(); } catch (_) {} }
      if (typeof s._liveStop === 'function') { try { s._liveStop(); } catch (_) {} }
    }
    driver.stop();
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId: '*', kind: 'panic', at: Date.now() });
    }
    json(res, { ok: true });
  });

  addRoute('GET', '/api/apps/memory', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    if (!app) return json(res, { error: 'app query param required' }, 400);
    json(res, { ok: true, app: memory.normalizeApp(app), body: memory.loadMemory(app) });
  });

  addRoute('POST', '/api/apps/memory', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const app = String(body.app || '').trim();
    const mode = body.mode || 'append';
    if (!app) return json(res, { error: 'app required' }, 400);
    // mode: 'append' | 'replace' | 'replace-all' | 'clear'
    try {
      if (mode === 'replace-all') {
        return json(res, memory.replaceMemory(app, String(body.body || '')));
      }
      if (mode === 'clear') {
        return json(res, memory.clearMemory(app));
      }
      const section = String(body.section || '').trim();
      const bodyText = String(body.body || '').trim();
      if (!section || !bodyText) return json(res, { error: 'section and body required for append/replace' }, 400);
      const r = mode === 'replace'
        ? memory.replaceSection(app, section, bodyText)
        : memory.appendSection(app, section, bodyText);
      json(res, r);
    } catch (e) {
      json(res, { error: e.message, code: e.code || null }, 400);
    }
  });

  addRoute('GET', '/api/apps/recipes', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    if (!app) return json(res, { error: 'app query param required' }, 400);
    json(res, { ok: true, ...recipes.listRecipes(app) });
  });

  addRoute('POST', '/api/apps/recipes', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const app = String(body.app || '').trim();
    if (!app) return json(res, { error: 'app required' }, 400);
    const rec = body.recipe || body;
    if (typeof permGate === 'function') {
      const label = (rec && rec.id ? 'Update' : 'Save') + ' automation "' + (rec && rec.name || '?').toString().slice(0, 60) + '" for ' + app;
      if (!await permGate(res, 'api', 'POST /api/apps/recipes', label)) return;
    }
    try {
      json(res, recipes.saveRecipe(app, rec));
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  addRoute('DELETE', '/api/apps/recipes', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    const id = url.searchParams.get('id');
    if (!app || !id) return json(res, { error: 'app and id required' }, 400);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'DELETE /api/apps/recipes', 'Delete automation ' + id + ' for ' + app)) return;
    }
    json(res, recipes.deleteRecipe(app, id));
  });

  addRoute('POST', '/api/apps/recipes/import', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const app = String(body.app || '').trim();
    if (!app) return json(res, { error: 'app required' }, 400);
    if (typeof permGate === 'function') {
      const count = Array.isArray(body.payload) ? body.payload.length : Array.isArray(body.payload && body.payload.recipes) ? body.payload.recipes.length : 1;
      if (!await permGate(res, 'api', 'POST /api/apps/recipes/import', 'Import ' + count + ' automation(s) into ' + app)) return;
    }
    try { json(res, recipes.importRecipes(app, body.payload)); }
    catch (e) { json(res, { error: e.message }, 400); }
  });

  addRoute('GET', '/api/apps/recipes/export', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    if (!app) return json(res, { error: 'app required' }, 400);
    const idsParam = url.searchParams.get('ids');
    const ids = idsParam ? idsParam.split(',').map(s => s.trim()).filter(Boolean) : null;
    json(res, recipes.exportRecipes(app, ids));
  });

  // Run a single step against a target window. Used by the editor's
  // "Test step" button so the user can iterate on one UIA selector or
  // coordinate without replaying the whole recipe.
  addRoute('POST', '/api/apps/recipes/run-step', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = body && body.hwnd;
    if (hwnd == null) return json(res, { error: 'hwnd required' }, 400);
    if (!body.step || typeof body.step !== 'object') return json(res, { error: 'step required' }, 400);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'POST /api/apps/recipes/run-step', 'Test step: ' + (body.step.verb || '?') + ' ' + String(body.step.target || '').slice(0, 60))) return;
    }
    // Build a minimal throw-away "session" shape that the recipe runner's
    // step executor understands. Reuses everything: provider registry for
    // vision fallback, cached window rect for coord scaling, driver for UIA.
    const registry = buildRegistry();
    const entry = chat.pickProvider(registry, body.provider);
    const session = {
      id: 'teststep_' + Date.now(),
      hwnd,
      app: body.app || null,
      _providerRegistry: registry,
      _providerEntry: entry || null,
      _recipeCaptureRect: (body.captureRect && body.captureRect.w && body.captureRect.h) ? body.captureRect : null,
      _emit: () => {},
    };
    try {
      try { session._currentRect = await driver.getWindowRect(hwnd); } catch (_) {}
      try { if (typeof driver.ensureForeground === 'function') await driver.ensureForeground(hwnd); } catch (_) {}
      const { runSingleStep } = require('./apps-recipe-runner');
      await runSingleStep({ session, driver, step: body.step, variables: body.inputs || {} });
      json(res, { ok: true });
    } catch (e) {
      json(res, { error: e.message, code: e.code || null }, 400);
    }
  });

  addRoute('GET', '/api/apps/recipes/history', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    if (!app) return json(res, { error: 'app required' }, 400);
    json(res, recipes.listHistory(app));
  });

  // --- Recorder: capture raw mouse/keyboard input against a specific window
  // and translate the captured stream into a recipe DSL draft. The draft is
  // returned by /stop so the UI can show it in the editor before the user
  // decides to save.
  addRoute('POST', '/api/apps/recording/start', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = body && body.hwnd;
    if (hwnd == null) return json(res, { error: 'hwnd required' }, 400);
    // Resolve the hwnd against the live window list so the permission prompt
    // names a real target (title + process) and the recorder can't be pointed
    // at a non-visible handle by a malicious caller.
    let targetInfo = null;
    try {
      const wins = await driver.listWindows({ force: true });
      targetInfo = (wins || []).find(w => String(w.hwnd) === String(hwnd));
    } catch (_) {}
    if (!targetInfo) return json(res, { error: 'hwnd not found in the visible window list' }, 400);
    if (typeof permGate === 'function') {
      const label = 'Record input on "' + String(targetInfo.title || '').slice(0, 80) + '" (' + (targetInfo.processName || 'unknown') + ') - stop with Ctrl+Shift+Q';
      if (!await permGate(res, 'api', 'POST /api/apps/recording/start', label)) return;
    }
    try {
      try { if (typeof driver.ensureForeground === 'function') await driver.ensureForeground(hwnd); } catch (_) {}
      // When the PS recorder closes on its own (Ctrl+Shift+Q hotkey, window
      // closed) the client can't see the end - broadcast a WS event so the
      // UI auto-stops instead of leaving a stale "Stop recording" button.
      const onAutoStop = (info) => {
        if (typeof broadcast !== 'function') return;
        broadcast({ type: 'apps-recording-ended', recordingId: info.recordingId, reason: info.reason, at: Date.now() });
      };
      const result = await recorder.startRecording({ hwnd, onAutoStop });
      json(res, { ok: true, ...result, target: { title: targetInfo.title, processName: targetInfo.processName } });
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  addRoute('POST', '/api/apps/recording/stop', async (req, res) => {
    let body = {};
    try { body = await readBody(req); } catch (_) {}
    try {
      const result = await recorder.stopRecording({ recordingId: body.recordingId });
      const app = body.app ? String(body.app).trim() : null;
      const draft = recorder.eventsToRecipe({
        events: result.events,
        captureRect: result.captureRect,
        name: body.name || null,
        description: body.description || null,
      });
      // Auto-save if the caller passed an app + save=true, so the recorded
      // recipe lands in the app's library without a second round trip.
      let saved = null;
      if (app && body.save) {
        if (typeof permGate === 'function') {
          if (!await permGate(res, 'api', 'POST /api/apps/recording/stop', 'Save recorded automation "' + draft.name + '" for ' + app)) return;
        }
        try { saved = recipes.saveRecipe(app, draft); } catch (e) { saved = { error: e.message }; }
      }
      json(res, { ok: true, draft, saved, meta: { durationMs: result.durationMs, reason: result.reason, eventCount: result.events.length, captureRect: result.captureRect, errors: result.errors || [] } });
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  // --- UI Automation (UIA) element picker + finder. Gives recipes PAD-style
  // selectors ("the Save button in the Toolbar") that survive resizes and
  // layout changes without eating vision-model tokens.
  // Maximize a target window. Used by the editor to put the target app
  // full-screen before Record / Pick / Run so coordinate-based steps replay
  // against the same layout they were captured against.
  addRoute('POST', '/api/apps/window/maximize', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = body && body.hwnd;
    if (hwnd == null) return json(res, { error: 'hwnd required' }, 400);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'POST /api/apps/window/maximize', 'Maximize target window ' + hwnd)) return;
    }
    try {
      if (typeof driver.ensureForeground === 'function') await driver.ensureForeground(Number(hwnd));
      const info = await driver.maximizeWindow(Number(hwnd));
      json(res, { ok: true, alreadyMaximized: !!(info && info.alreadyMaximized) });
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  addRoute('POST', '/api/apps/uia/tree', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = body && body.hwnd;
    if (hwnd == null) return json(res, { error: 'hwnd required' }, 400);
    try {
      const out = await driver.uiaTree(Number(hwnd), { maxNodes: Math.min(2000, Math.max(50, parseInt(body.maxNodes, 10) || 400)) });
      json(res, { ok: true, ...out });
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  addRoute('POST', '/api/apps/uia/find', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const hwnd = body && body.hwnd;
    if (hwnd == null) return json(res, { error: 'hwnd required' }, 400);
    if (!body.selector || typeof body.selector !== 'object') return json(res, { error: 'selector required' }, 400);
    try {
      const hit = await driver.findUIAElement(hwnd, body.selector);
      json(res, { ok: true, hit: !!hit, element: hit });
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  // Streaming picker: spawns uia-pick.ps1 and pipes its JSON-lines back as a
  // simple Server-Sent Events stream. Closes automatically on picked/cancelled.
  addRoute('GET', '/api/apps/uia/pick', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hwnd = url.searchParams.get('hwnd');
    if (!hwnd) return json(res, { error: 'hwnd required' }, 400);
    // Consent prompt - picker watches global mouse + keyboard state until
    // the user clicks or aborts, so the user should know the expectation.
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'GET /api/apps/uia/pick', 'Pick a UI element on window ' + hwnd + ' (Ctrl+Click to capture, Esc to cancel)')) return;
    }
    // Bring the target forward so the user can Ctrl+Click it immediately.
    try { if (typeof driver.ensureForeground === 'function') await driver.ensureForeground(Number(hwnd)); } catch (_) {}
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Heartbeat every 15s so the browser doesn't close the EventSource on its
    // own idle timeout; without this, a picker left open for a minute drops.
    const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (_) {} }, 15000);
    const proc = driver.spawnUIAPicker(Number(hwnd));
    let buf = '';
    let stderrBuf = '';
    let done = false;
    const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} };
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      try { res.end(); } catch (_) {}
      try { proc.kill(); } catch (_) {}
    };
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        res.write('data: ' + line + '\n\n');
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'picked' || ev.type === 'cancelled' || ev.type === 'error') {
            finish();
            return;
          }
        } catch (_) {}
      }
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });
    proc.on('error', (e) => { send({ type: 'error', message: 'spawn failed: ' + (e && e.message || e) }); finish(); });
    proc.on('close', (code) => {
      // If the script exited without emitting a terminal event, surface the
      // stderr / exit code to the UI instead of letting the browser interpret
      // the silent close as a dropped connection.
      if (!done) {
        const tail = stderrBuf.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 500);
        send({ type: 'error', message: 'picker exited (' + code + ')' + (tail ? ' - ' + tail : '') });
      }
      finish();
    });
    req.on('close', finish);
  });

  addRoute('GET', '/api/apps/recording/status', async (req, res) => {
    const active = recorder.getActive();
    if (!active) return json(res, { ok: true, active: false });
    json(res, {
      ok: true,
      active: true,
      recordingId: active.id,
      hwnd: active.hwnd,
      eventCount: active.events.length,
      captureRect: active.captureRect,
      startedAt: active.startedAt,
    });
  });

  // "Save current session as a recipe". Takes the actions the chat loop
  // recorded on the session and turns them into a DSL step list the user
  // can rerun deterministically.
  addRoute('GET', '/api/apps/tests', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    if (!app) return json(res, { error: 'app required' }, 400);
    json(res, { ok: true, ...recipes.listTests(app) });
  });

  addRoute('POST', '/api/apps/tests', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const app = String(body.app || '').trim();
    if (!app) return json(res, { error: 'app required' }, 400);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'POST /api/apps/tests', 'Save test for ' + app)) return;
    }
    try { json(res, recipes.saveTest(app, body.test || body)); }
    catch (e) { json(res, { error: e.message }, 400); }
  });

  addRoute('DELETE', '/api/apps/tests', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    const id = url.searchParams.get('id');
    if (!app || !id) return json(res, { error: 'app and id required' }, 400);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'DELETE /api/apps/tests', 'Delete test ' + id + ' for ' + app)) return;
    }
    json(res, recipes.deleteTest(app, id));
  });

  // Run a test: execute the referenced recipe with the test's inputs, then
  // verify post-run assertions via the vision locator. Returns pass/fail
  // with per-assertion detail.
  addRoute('POST', '/api/apps/tests/run', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const app = String(body.app || '').trim();
    const testId = String(body.testId || '').trim();
    const hwnd = Number(body.hwnd);
    if (!app || !testId) return json(res, { error: 'app and testId required' }, 400);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required (pick an app first)' }, 400);
    const test = recipes.getTest(app, testId);
    if (!test) return json(res, { error: 'test not found' }, 404);
    const recipe = recipes.getRecipe(app, test.macro);
    if (!recipe) return json(res, { error: 'test references missing recipe ' + test.macro }, 400);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'POST /api/apps/tests/run', 'Run test "' + test.name + '" on ' + app)) return;
    }

    const sessionId = body.sessionId || ('test-' + Date.now().toString(36));
    const session = chat.getSession(sessionId);
    if (session.running) return json(res, { error: 'Session already running. Stop it first.' }, 409);

    try { await driver.focusWindow(hwnd); }
    catch (e) { return json(res, { error: 'focus failed: ' + e.message }, 400); }
    session.hwnd = hwnd; session.app = app; session.goal = 'test:' + test.name;
    session.stopped = false; driver.resetStopped();

    // Tests rely on the Anthropic vision locator for VERIFY assertions; fail
    // fast with a clear error here rather than let runRecipe/locateTarget
    // discover the missing key mid-run and emit a confusing step failure.
    const registry = buildRegistry();
    const entry = registry && registry.anthropic;
    if (!entry) return json(res, { error: 'Tests require ANTHROPIC_API_KEY for the vision locator. Set it in Settings -> AI Keys, or remove the test.' }, 400);
    session._providerRegistry = registry;
    session._providerEntry = entry;
    session._model = entry.adapter.defaultModel;

    json(res, { ok: true, sessionId, testId, starting: true });

    // Run the recipe, then verify expectations.
    const startedAt = Date.now();
    const runRes = await require('./apps-recipe-runner').runRecipe({
      session, driver, recipe, broadcast,
      providerEntry: entry, model: entry.adapter.defaultModel,
      inputs: test.inputs,
    });
    const actualOutcome = runRes.ok ? 'ok' : (runRes.aborted ? 'aborted' : 'failed');
    const failures = [];
    const checks = [];
    if (test.expected.outcome && test.expected.outcome !== actualOutcome) {
      failures.push(`outcome expected "${test.expected.outcome}" but got "${actualOutcome}"`);
    }
    checks.push({ kind: 'outcome', expected: test.expected.outcome, actual: actualOutcome });

    const runner = require('./apps-recipe-runner');
    for (const target of test.expected.elementsPresent || []) {
      try { await runner.locateTarget({ session, driver, description: target }); checks.push({ kind: 'present', target, ok: true }); }
      catch (e) { failures.push(`missing element: "${target}"`); checks.push({ kind: 'present', target, ok: false, reason: e.message }); }
    }
    for (const target of test.expected.elementsAbsent || []) {
      try { await runner.locateTarget({ session, driver, description: target }); failures.push(`element should be absent but is visible: "${target}"`); checks.push({ kind: 'absent', target, ok: false }); }
      catch (e) { if (e.code === 'locator_miss') checks.push({ kind: 'absent', target, ok: true }); else checks.push({ kind: 'absent', target, ok: false, reason: e.message }); }
    }

    const passed = failures.length === 0;
    const durationMs = Date.now() - startedAt;
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId, kind: passed ? 'test_pass' : 'test_fail', testId, testName: test.name, failures, checks, durationMs, at: Date.now() });
    }
    // Record as a run too so the history view reflects test outcomes.
    try { recipes.recordRun(app, { recipeId: recipe.id, recipeName: `[test] ${test.name}`, outcome: passed ? 'ok' : 'failed', iterations: runRes.iterations || 0, durationMs, error: passed ? null : failures.join('; ') }); } catch (_) {}
  });

  // Pause / resume control for step-through debugging. Gated to keep it
  // aligned with the other session-mutating endpoints.
  addRoute('POST', '/api/apps/session/debug', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const sessionId = String(body.sessionId || '');
    const action = String(body.action || '').trim();
    if (!sessionId || !action) return json(res, { error: 'sessionId and action required' }, 400);
    const session = chat.sessions.get(sessionId);
    if (!session) return json(res, { error: 'unknown session' }, 404);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'POST /api/apps/session/debug', 'Control step-through: ' + action)) return;
    }
    if (action === 'resume') {
      if (typeof session._debugResolver === 'function') { session._debugResolver(); session._debugResolver = null; }
      return json(res, { ok: true });
    }
    if (action === 'disable-step-through') {
      session._stepThrough = false;
      if (typeof session._debugResolver === 'function') { session._debugResolver(); session._debugResolver = null; }
      return json(res, { ok: true });
    }
    return json(res, { error: 'unknown action' }, 400);
  });

  // Natural-language recipe generator. Sends a description (plus any
  // per-app instructions the user has written, plus an optional current
  // screenshot of the target window) to Anthropic and parses the returned
  // JSON into DSL steps. Blocked in Incognito because it can exfiltrate
  // window screenshots and per-app notes to Anthropic.
  addRoute('POST', '/api/apps/recipes/generate', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const description = String(body.description || '').trim();
    if (!description) return json(res, { error: 'description required' }, 400);
    const app = String(body.app || '').trim();
    const registry = buildRegistry();
    // The user can pick any provider they have a key for. Anthropic remains
    // the default since it's the only one that can use the server-side
    // web_search tool for grounding; other providers run ungrounded.
    const preferred = typeof body.provider === 'string' ? body.provider : 'anthropic';
    const entry = chat.pickProvider(registry, preferred);
    if (!entry) return json(res, { error: 'Requested provider "' + preferred + '" is not configured. Add an API key in Settings -> AI Keys.' }, 400);

    // Pull the app's instructions memory so the generator grounds in the
    // user's own notes about this app (UI map, DOs, DONTs, keybindings).
    let appNotes = '';
    if (app) { try { appNotes = memory.loadMemory(app) || ''; } catch (_) {} }

    const system = [
      'You convert a plain-English description of a Windows desktop task into a JSON recipe that Symphonee can replay.',
      'OUTPUT ONLY valid JSON, no prose or code fences. The shape is:',
      '{ "name": "string", "description": "string", "steps": [ {"verb":"CLICK","target":"..."} ] }',
      '',
      'Allowed verbs:',
      '- CLICK target   (target: element description or "x,y")',
      '- TYPE target -> text   (target optional; target is what to click first, text is what to type)',
      '- PRESS target   (target: key or combo, e.g. "Enter", "Ctrl+S")',
      '- WAIT target    (target: milliseconds, e.g. "500")',
      '- WAIT_UNTIL target -> timeoutMs  (poll until the target element appears)',
      '- FIND target    (locate without clicking)',
      '- VERIFY target  (assert visible; fails if missing)',
      '- SCROLL "dx,dy" (ticks, e.g. "0,5")',
      '- DRAG "fromX,fromY" -> "toX,toY"',
      '- IF target / ELSE / ENDIF    (conditional on element existence)',
      '- REPEAT target / ENDREPEAT   (loop N times)',
      '',
      'In JSON, step rows look like {"verb":"CLICK","target":"File menu"}. For TYPE use {"verb":"TYPE","target":"Filename input","text":"hello"}.',
      'Prefer keyboard shortcuts (PRESS) over menu traversal when both are possible.',
      'Do not output explanation. Do not wrap the JSON in markdown.',
      app ? `\nTarget app: ${app}. If the user\'s instructions below have specific notes, prefer those over anything else.` : '',
      appNotes ? `\n--- User-written instructions for ${app} ---\n${appNotes.slice(0, 8000)}\n--- end instructions ---` : '',
      '\nIf you are unsure of exact menu labels, keyboard shortcuts, or UI element names for this app, use the web_search tool to look them up before emitting steps. Do NOT invent menu paths.',
    ].filter(Boolean).join('\n');

    const chosenModel = (body && typeof body.model === 'string' && /^[\w.\-:]+$/.test(body.model.trim()))
      ? body.model.trim()
      : entry.adapter.defaultModel;

    const kind = entry.adapter.kind;
    const { httpJson } = chat;

    // Dispatch per-adapter. Anthropic gets the native messages API + web_search
    // for grounding; OpenAI-compat (OpenAI / Grok / Qwen) go through Chat
    // Completions with an image_url payload; Gemini uses generateContent. All
    // three return a single text block we parse for the JSON recipe.
    let text = '';
    try {
      if (kind === 'anthropic') {
        const userContent = [{ type: 'text', text: description }];
        if (body.screenshotBase64) {
          userContent.unshift({ type: 'image', source: { type: 'base64', media_type: body.mimeType || 'image/jpeg', data: body.screenshotBase64 } });
        }
        const parsed = await httpJson({
          hostname: 'api.anthropic.com', path: '/v1/messages',
          headers: { 'x-api-key': entry.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05' },
          body: {
            model: chosenModel, max_tokens: 2048, system,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
            messages: [{ role: 'user', content: userContent }],
          },
          timeoutMs: 60000,
        });
        text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      } else if (kind === 'openai-compat') {
        const content = [{ type: 'text', text: description }];
        if (body.screenshotBase64) {
          content.unshift({ type: 'image_url', image_url: { url: 'data:' + (body.mimeType || 'image/jpeg') + ';base64,' + body.screenshotBase64 } });
        }
        const parsed = await httpJson({
          hostname: entry.adapter.baseHost, path: entry.adapter.basePath,
          headers: { [entry.adapter.authHeader]: entry.adapter.authPrefix + entry.apiKey },
          body: {
            model: chosenModel, max_tokens: 2048,
            messages: [{ role: 'system', content: system }, { role: 'user', content }],
          },
          timeoutMs: 60000,
        });
        text = ((parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '').trim();
      } else if (kind === 'gemini') {
        const parts = [{ text: description }];
        if (body.screenshotBase64) {
          parts.unshift({ inlineData: { mimeType: body.mimeType || 'image/jpeg', data: body.screenshotBase64 } });
        }
        const parsed = await httpJson({
          hostname: 'generativelanguage.googleapis.com',
          path: '/v1beta/models/' + encodeURIComponent(chosenModel) + ':generateContent?key=' + encodeURIComponent(entry.apiKey),
          headers: {},
          body: {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { maxOutputTokens: 2048 },
          },
          timeoutMs: 60000,
        });
        const gp = (parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts) || [];
        text = gp.map(p => p.text || '').join('').trim();
      } else {
        return json(res, { error: 'provider "' + kind + '" not supported by generate yet' }, 400);
      }
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }

    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json(res, { error: 'AI returned non-JSON output', raw: text.slice(0, 400) }, 500);
    try {
      const draft = JSON.parse(m[0]);
      // Validate by round-tripping through saveRecipe's shape checks without persisting.
      if (!Array.isArray(draft.steps) || !draft.steps.length) throw new Error('AI returned no steps');
      json(res, { ok: true, draft });
    } catch (e) {
      json(res, { error: e.message, raw: text.slice(0, 400) }, 500);
    }
  });

  addRoute('POST', '/api/apps/recipes/from-session', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const sessionId = String(body.sessionId || '');
    const name = String(body.name || '').trim();
    if (!sessionId) return json(res, { error: 'sessionId required' }, 400);
    if (!name) return json(res, { error: 'name required' }, 400);
    const session = chat.sessions.get(sessionId);
    if (!session) return json(res, { error: 'unknown session' }, 404);
    const app = session.app;
    if (!app) return json(res, { error: 'session has no app key; cannot file the recipe' }, 400);
    const steps = recipes.actionsToSteps(session._recordedActions || []);
    if (!steps.length) return json(res, { error: 'no recorded actions yet - start a session, let the agent do work, then save.' }, 400);
    if (typeof permGate === 'function') {
      if (!await permGate(res, 'api', 'POST /api/apps/recipes/from-session', 'Save session as automation "' + name + '" for ' + app)) return;
    }
    try {
      const r = recipes.saveRecipe(app, {
        name,
        description: String(body.description || '').trim() || `Captured from session ${sessionId}`,
        steps,
        sourceSessionId: sessionId,
      });
      // Live Mind sync so other CLIs see the new automation immediately.
      if (r && r.path) {
        try {
          const http = require('http');
          const payload = JSON.stringify({
            path: r.path, label: `${app}: ${name}`, kind: 'recipe',
            createdBy: 'apps-agent-manual', tags: ['app-automation', app],
          });
          const mreq = http.request({
            host: '127.0.0.1', port: 3800, path: '/api/mind/add', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          }, (mres) => { mres.resume(); });
          mreq.on('error', () => {});
          mreq.write(payload); mreq.end();
        } catch (_) {}
      }
      json(res, { ...r, captured: steps.length });
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  addRoute('GET', '/api/apps/status', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    const registry = buildRegistry();
    const providers = Object.entries(registry).map(([k, v]) => ({ key: k, label: v.adapter.label, defaultModel: v.adapter.defaultModel }));
    if (sessionId) {
      const s = chat.sessions.get(sessionId);
      if (!s) return json(res, { providers, session: null });
      return json(res, {
        providers,
        session: {
          id: s.id, goal: s.goal, app: s.app, title: s.title, hwnd: s.hwnd,
          running: s.running, stopped: s.stopped, providerKind: s.providerKind,
          createdAt: s.createdAt,
        }
      });
    }
    json(res, { providers, sessions: [...chat.sessions.values()].map(s => ({
      id: s.id, goal: s.goal, app: s.app, title: s.title, running: s.running, createdAt: s.createdAt
    })) });
  });
}

module.exports = { mountAppsRoutes };
