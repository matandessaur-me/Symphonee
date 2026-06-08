/**
 * apps-agent-session -- provider/session/fallback helpers for the Apps agent,
 * split out of apps-agent.js (which is now just mountAppsRoutes + this require).
 * Self-contained: uses only the apps-* subsystem requires below + its params.
 */
const driver = require('./apps-driver');
const chat = require('./apps-agent-chat');
const recipeRunner = require('./apps-recipe-runner');

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

module.exports = { PROVIDER_ORDER, CLI_PROVIDER_MAP, runSessionForEntry, readBody, normalizeProviderKey, mapCliToProvider, extractRecipeInputs, isProviderExhaustionError, buildContinuationPrompt, headerValue, resolveCallerContext, buildProviderAttempts, runSessionWithFallback };
