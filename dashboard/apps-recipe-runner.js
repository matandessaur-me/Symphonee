/**
 * Apps Recipe Runner - deterministic executor for saved Automations.
 *
 * Phase B upgrade: instead of injecting a recipe as the agent's goal and
 * letting the chat loop improvise, we execute each DSL step directly
 * against the driver. Only FIND / VERIFY / targeted CLICK / targeted TYPE
 * escalate to a vision call (one per locator, cached per step), because
 * those are the places where pixel coordinates aren't known ahead of time.
 *
 * Global rules enforced per step:
 *   Focus  -> ensureForeground + wait
 *   Locate -> (if target) vision locator returns {x, y}
 *   Act    -> driver.click / type / key / waitMs
 *   Verify -> post-action screenshot recorded on session for the stuck
 *             detector; no second AI call unless the verb is VERIFY.
 *   Retry  -> one re-attempt on failure with a fresh screenshot; if still
 *             failing, surface a step_failed event and stop.
 *
 * Variables: recipe.variables is a flat map { name: description }. Any
 * step.target or step.text containing {{name}} is substituted before
 * execution. This lets a user define "regression = the Regression tab in
 * the top bar" once and reference {{regression}} across every step.
 */

const recipesStore = require('./apps-recipes');
const { httpJson } = require('./apps-agent-chat');

function emitter(broadcast, sessionId) {
  return (step) => {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'apps-agent-step', sessionId, ...step, at: Date.now() });
  };
}

function expandVars(str, variables) {
  if (!str || !variables) return str || '';
  return String(str).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, name) => {
    const v = variables[name];
    return (v == null) ? `{{${name}}}` : String(v);
  });
}

function parseCoord(s) {
  if (!s) return null;
  const m = String(s).match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
  if (!m) return null;
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}

// Scale a raw (x, y) from its recording-time window rect to the window's
// current rect. Reads session._currentRect (populated once at runRecipe start
// and refreshed after a window-pin resize) so we don't spawn a PowerShell
// subprocess on every coord-based step.
//
// Known limitations: scales against the OUTER window rect (GetWindowRect),
// not the client area. Non-client furniture (title bar, borders) stays a
// roughly fixed pixel height while content scales, so very large resizes
// drift a few pixels in y. Cross-DPI monitor moves can also skew, since
// coords are recorded in physical pixels. For typical in-monitor resizes
// on a single-DPI setup this is well within locator-target tolerance.
function scaleCoord(session, coord) {
  const capture = session && session._recipeCaptureRect;
  const current = session && session._currentRect;
  if (!coord || !capture || !capture.w || !capture.h) return coord;
  if (!current || !current.w || !current.h) return coord;
  if (current.w === capture.w && current.h === capture.h) return coord;
  return {
    x: Math.round(coord.x * (current.w / capture.w)),
    y: Math.round(coord.y * (current.h / capture.h)),
  };
}

async function refreshRunRect(session, driver) {
  try { session._currentRect = await driver.getWindowRect(session.hwnd); }
  catch (_) { session._currentRect = null; }
}

// JSON-shaped target. Supports:
//   { "uia": {...} }                         - UIA selector only
//   { "uia": {...}, "xy": "500,400" }        - recorder variant with fallback coords
// Returns null when the target is a plain string (x,y or description).
function parseJsonTarget(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  // Compact "uia:" string form emitted by the auto-recipe pipeline:
  //   uia:name=Foo|type=Button|id=btnFoo|class=Win32
  // Same fields as the JSON form so resolveUia handles it identically.
  if (trimmed.toLowerCase().startsWith('uia:')) {
    const parts = trimmed.slice(4).split('|').filter(Boolean);
    const sel = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const k = p.slice(0, eq).trim().toLowerCase();
      const v = p.slice(eq + 1);
      if (k === 'name')  sel.name = v;
      else if (k === 'type')  sel.type = v;
      else if (k === 'id')    sel.id = v;
      else if (k === 'class') sel.class = v;
    }
    if (Object.keys(sel).length) return { uia: sel };
    return null;
  }
  if (trimmed[0] !== '{') return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object') {
      const out = {};
      if (obj.uia && typeof obj.uia === 'object') out.uia = obj.uia;
      if (typeof obj.xy === 'string') out.xy = obj.xy;
      if (Object.keys(out).length) return out;
    }
  } catch (_) {}
  return null;
}

// Threshold: when a UIA match covers more than this fraction of the target
// window it is almost certainly a container (viewport wrapper, scroll pane,
// root pane), not the element the user clicked. Clicking its center sends
// the cursor to dead space. Callers that have a stashed xy use it instead.
const UIA_GENERIC_CONTAINER_RATIO = 0.4;

function isHitTooGeneric(hit, session) {
  const rect = session && session._currentRect;
  if (!hit || !hit.meta || !rect || !rect.w || !rect.h) return false;
  const area = (hit.meta.w || 0) * (hit.meta.h || 0);
  const windowArea = rect.w * rect.h;
  if (!area || !windowArea) return false;
  return (area / windowArea) > UIA_GENERIC_CONTAINER_RATIO;
}

async function resolveUia(session, driver, selector, invoke = false) {
  if (typeof driver.findUIAElement !== 'function') {
    const e = new Error('UIA not available'); e.code = 'uia_unavailable'; throw e;
  }
  // Prefer the pattern-invoke shortcut for CLICK steps - faster and doesn't
  // steal focus. Returns { invoked: true } so the caller skips driver.click.
  if (invoke && typeof driver.invokeUIAElement === 'function') {
    try {
      const r = await driver.invokeUIAElement(session.hwnd, selector);
      if (r && r.ok) {
        if (typeof session._emit === 'function') {
          session._emit({ kind: 'step_info', message: 'UIA ' + r.pattern + ' on "' + (r.name || '?') + '"' });
        }
        return { invoked: true, pattern: r.pattern };
      }
    } catch (_) {}
  }
  const hit = await driver.findUIAElement(session.hwnd, selector);
  if (!hit) { const e = new Error('UIA selector did not match any visible element'); e.code = 'locator_miss'; throw e; }
  if (hit.meta && hit.meta.degraded && typeof session._emit === 'function') {
    session._emit({ kind: 'step_info', message: 'UIA selector matched after dropping "' + hit.meta.degraded + '"; consider re-picking' });
  }
  return { x: hit.x, y: hit.y, meta: hit.meta };
}

// Resolve a step target to {x, y} or {invoked: true}. Fallback order:
//   1. UIA selector (with InvokePattern shortcut when invoke=true)
//   2. Stashed raw xy from the recorder (scaled via the cached window rect)
//   3. Plain "x,y" parse (also scaled)
//   4. Vision locator on the descriptive text
// Misses cascade down so a broken UIA selector still plays back if the
// recorder captured coords alongside it.
//
// `preferXy` flips the order so raw xy wins over UIA. Use it for DRAG
// endpoints: dragging is inherently a coordinate action, and UIA selectors
// on canvas positions almost always capture an enclosing container, which
// collapses both endpoints to the same center and turns the drag into a
// zero-distance click.
async function resolveCoord(session, driver, descOrXY, { invoke = false, preferXy = false } = {}) {
  const json = parseJsonTarget(descOrXY);
  if (preferXy && json && json.xy) {
    const raw = parseCoord(json.xy);
    if (raw) return scaleCoord(session, raw);
  }
  if (json && json.uia) {
    try {
      const hit = await resolveUia(session, driver, json.uia, invoke);
      if (hit && hit.invoked) return hit;
      // Guardrail: if UIA matched a container that covers most of the window
      // (viewport wrapper, scroll pane, root), clicking its center lands in
      // dead space. Prefer the recorded xy in that case.
      if (json.xy && isHitTooGeneric(hit, session)) {
        const raw = parseCoord(json.xy);
        if (raw) {
          if (typeof session._emit === 'function') session._emit({ kind: 'step_info', message: 'UIA match too generic (' + (hit.meta && hit.meta.w) + 'x' + (hit.meta && hit.meta.h) + '), using recorded coords ' + json.xy });
          return scaleCoord(session, raw);
        }
      }
      return hit;
    }
    catch (e) {
      if (e.code !== 'locator_miss' && e.code !== 'uia_unavailable') throw e;
      if (json.xy) {
        if (typeof session._emit === 'function') session._emit({ kind: 'step_info', message: 'UIA miss, falling back to recorded coords ' + json.xy });
        const raw = parseCoord(json.xy);
        if (raw) return scaleCoord(session, raw);
      }
      throw e;
    }
  }
  if (json && json.xy) {
    const raw = parseCoord(json.xy);
    if (raw) return scaleCoord(session, raw);
  }
  const raw = parseCoord(descOrXY);
  if (raw) return scaleCoord(session, raw);
  return locateTarget({ session, driver, description: descOrXY });
}

const LOCATOR_PROMPT = (description, rect) =>
  `You are given a screenshot of a Windows application window (${rect.w}x${rect.h}). ` +
  `The user wants to interact with: "${description}". ` +
  `Return ONLY a compact JSON object with window-relative pixel coordinates of the CENTER of that element, like {"x":123,"y":456}. ` +
  `If you cannot identify the element, return {"x":null,"y":null,"reason":"short reason"}.`;

function extractJsonObject(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('locator returned non-JSON: ' + String(text || '').slice(0, 160));
  return JSON.parse(m[0]);
}

async function locateViaAnthropic({ apiKey, model, imageBase64, mimeType, description, rect }) {
  const parsed = await httpJson({
    hostname: 'api.anthropic.com', path: '/v1/messages', timeoutMs: 30000,
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: {
      model,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: LOCATOR_PROMPT(description, rect) },
        ],
      }],
    },
  });
  const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return extractJsonObject(text);
}

async function locateViaOpenAICompat({ apiKey, model, hostname, path, authHeader, authPrefix, imageBase64, mimeType, description, rect }) {
  const parsed = await httpJson({
    hostname, path, timeoutMs: 30000,
    headers: { [authHeader || 'Authorization']: (authPrefix || 'Bearer ') + apiKey },
    body: {
      model,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } },
          { type: 'text', text: LOCATOR_PROMPT(description, rect) },
        ],
      }],
    },
  });
  const text = ((parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '').trim();
  return extractJsonObject(text);
}

async function locateViaGemini({ apiKey, model, imageBase64, mimeType, description, rect }) {
  const parsed = await httpJson({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    timeoutMs: 30000,
    headers: {},
    body: {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
          { text: LOCATOR_PROMPT(description, rect) },
        ],
      }],
      generationConfig: { maxOutputTokens: 256 },
    },
  });
  const parts = (parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('').trim();
  return extractJsonObject(text);
}

// Fallback chain: Anthropic first (cheapest + most reliable today), then any
// other vision-capable provider the user has configured.
function pickLocatorProvider(registry, fallbackEntry) {
  const kindOf = (e) => e && e.adapter && e.adapter.kind;
  const sel = fallbackEntry;
  const selKind = kindOf(sel);
  if (sel && (selKind === 'anthropic' || selKind === 'openai-compat' || selKind === 'gemini')) {
    return { kind: selKind, entry: sel };
  }
  if (registry && registry.anthropic) return { kind: 'anthropic', entry: registry.anthropic };
  if (registry && registry.openai) return { kind: 'openai-compat', entry: registry.openai };
  if (registry && registry.gemini) return { kind: 'gemini', entry: registry.gemini };
  return null;
}

async function locateTarget({ session, driver, description }) {
  // UIA selectors short-circuit the vision path. Makes FIND/VERIFY/
  // WAIT_UNTIL with a JSON target use the UI tree directly. Invoke is NOT
  // used here - these verbs want a bounding rect, not a side-effect.
  const json = parseJsonTarget(description);
  if (json && json.uia) return resolveUia(session, driver, json.uia, false);
  const registry = session && session._providerRegistry;
  const locator = pickLocatorProvider(registry, session._providerEntry);
  if (!locator) throw new Error('no vision-capable provider configured for visual locator (needed by CLICK/TYPE with a target, FIND, VERIFY). Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY in Settings -> AI Keys, or rewrite the step to use explicit "x,y" coordinates.');
  const shot = await driver.screenshotWindow(session.hwnd, { format: 'jpeg', quality: 55 });
  if (!shot || !shot.base64) throw new Error('screenshot failed');
  const rect = shot.rect || { w: shot.width, h: shot.height };
  const entry = locator.entry;
  const model = (session._model && locator.entry === session._providerEntry)
    ? session._model
    : entry.adapter.defaultModel;
  const common = { imageBase64: shot.base64, mimeType: shot.mimeType || 'image/jpeg', description, rect, apiKey: entry.apiKey, model };
  let res;
  if (locator.kind === 'anthropic') {
    res = await locateViaAnthropic(common);
  } else if (locator.kind === 'gemini') {
    res = await locateViaGemini(common);
  } else {
    // openai-compat covers OpenAI, Grok (x.ai), Qwen (dashscope).
    const a = entry.adapter;
    res = await locateViaOpenAICompat({
      ...common,
      hostname: a.baseHost || 'api.openai.com',
      path: a.basePath || '/v1/chat/completions',
      authHeader: a.authHeader || 'Authorization',
      authPrefix: a.authPrefix || 'Bearer ',
    });
  }
  if (res.x == null || res.y == null) {
    const e = new Error('locator: ' + (res.reason || 'element not found'));
    e.code = 'locator_miss';
    throw e;
  }
  return { x: res.x, y: res.y };
}

async function focusAndSettle(driver, session) {
  if (typeof driver.ensureForeground === 'function') {
    await driver.ensureForeground(session.hwnd);
  }
  await new Promise(r => setTimeout(r, 60));
}

async function runStep({ session, driver, step, variables, emit, providerEntry, model }) {
  const verb = step.verb;
  const target = expandVars(step.target, variables) || '';
  const text = expandVars(step.text, variables) || '';
  emit({ kind: 'step_start', verb, target: target || undefined, text: text || undefined });

  await focusAndSettle(driver, session);

  switch (verb) {
    case 'WAIT': {
      const ms = Math.min(60000, Math.max(0, parseInt(target || '0', 10) || 0));
      await new Promise(r => setTimeout(r, ms));
      return;
    }
    case 'WAIT_UNTIL': {
      // Poll the vision locator until the target appears or we hit the
      // timeout. Huge readability win over guessing fixed WAIT durations.
      const timeoutMs = Math.min(60000, Math.max(500, parseInt((step.text || '').trim(), 10) || 10000));
      const pollMs = 800;
      if (!target) throw new Error('WAIT_UNTIL requires a target (e.g. "WAIT_UNTIL Save button -> 5000")');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (session._runnerAborted || session.stopped) throw Object.assign(new Error('stopped'), { code: 'stopped' });
        try { await locateTarget({ session, driver, description: target }); return; }
        catch (e) { if (e.code !== 'locator_miss') throw e; }
        await new Promise(r => setTimeout(r, pollMs));
      }
      const err = new Error('WAIT_UNTIL timed out waiting for "' + target + '" (' + timeoutMs + 'ms)');
      err.code = 'wait_timeout';
      throw err;
    }
    case 'SCROLL': {
      const parts = String(target || '0,0').split(',').map(s => parseInt(s.trim(), 10) || 0);
      const dx = parts.length >= 2 ? parts[0] : 0;
      const dy = parts.length >= 2 ? parts[1] : parts[0];
      await driver.scroll(dx, dy);
      return;
    }
    case 'DRAG': {
      if (!target || !text) throw new Error('DRAG needs a source and destination (target and text). Accepts "x,y" coordinates or element descriptions.');
      // preferXy: drag endpoints are coordinate actions, not logical clicks.
      // UIA selectors on canvas drags almost always capture the whole viewport
      // wrapper and would collapse both endpoints to one point.
      const from = await resolveCoord(session, driver, target, { preferXy: true });
      const to   = await resolveCoord(session, driver, text,   { preferXy: true });
      await driver.drag(from.x, from.y, to.x, to.y, { hwnd: session.hwnd });
      return;
    }
    case 'PRESS': {
      if (!target) throw new Error('PRESS requires a key or combo (e.g. "Ctrl+S", "Enter").');
      await driver.key(target);
      return;
    }
    case 'TYPE': {
      if (target) {
        const coord = await resolveCoord(session, driver, target);
        await driver.click({ x: coord.x, y: coord.y, hwnd: session.hwnd });
        await new Promise(r => setTimeout(r, 120));
      }
      await driver.type(text || target || '');
      return;
    }
    case 'CLICK': {
      if (!target) throw new Error('CLICK requires a target (a description or "x,y" coordinates).');
      const coord = await resolveCoord(session, driver, target, { invoke: true });
      if (coord && coord.invoked) return;
      await driver.click({ x: coord.x, y: coord.y, hwnd: session.hwnd });
      return;
    }
    case 'DOUBLE_CLICK': {
      if (!target) throw new Error('DOUBLE_CLICK requires a target (a description or "x,y" coordinates).');
      // Skip the UIA Invoke shortcut — apps that need a double-click
      // (Spotify song rows, file explorer items) don't expose a single
      // Invoke pattern that maps to "open"; the actual double-click is
      // what triggers their action.
      const coord = await resolveCoord(session, driver, target, { invoke: false });
      await driver.click({ x: coord.x, y: coord.y, hwnd: session.hwnd, double: true });
      return;
    }
    case 'RIGHT_CLICK': {
      if (!target) throw new Error('RIGHT_CLICK requires a target (a description or "x,y" coordinates).');
      const coord = await resolveCoord(session, driver, target);
      await driver.click({ x: coord.x, y: coord.y, hwnd: session.hwnd, button: 'right' });
      return;
    }
    case 'FIND': {
      if (!target) throw new Error('FIND requires a target description.');
      const coord = await locateTarget({ session, driver, description: target });
      emit({ kind: 'step_info', message: `Found "${target}" at ${coord.x},${coord.y}` });
      return;
    }
    case 'VERIFY': {
      if (!target) throw new Error('VERIFY requires a target description.');
      await locateTarget({ session, driver, description: target });
      return;
    }
    case 'EXTRACT': {
      // EXTRACT reads a UIA value from the live window at runtime and binds
      // it to a recipe variable. This is what makes "play the first song"
      // genuinely dynamic — the recipe doesn't know the song name, it asks
      // UIA at replay time and substitutes into the next step's selector.
      //
      // Step shape:
      //   { verb: "EXTRACT", target: "uia:type=DataItem|minDepth=10",
      //     text: "first_song_name" }
      //
      // The target is parsed for type / class / minDepth / nameRegex
      // filters; the FIRST matching node's `name` is bound to variables[text].
      if (!target) throw new Error('EXTRACT requires a UIA selector target like "uia:type=DataItem|minDepth=10".');
      if (!text) throw new Error('EXTRACT requires a variable name in the text field (e.g. "first_song_name").');
      const filter = {};
      const lower = String(target).toLowerCase();
      if (lower.startsWith('uia:')) {
        for (const p of target.slice(4).split('|').filter(Boolean)) {
          const eq = p.indexOf('=');
          if (eq <= 0) continue;
          const k = p.slice(0, eq).trim().toLowerCase();
          const v = p.slice(eq + 1);
          if (k === 'type')      filter.type = v;
          else if (k === 'class') filter.class = v;
          else if (k === 'mindepth') filter.minDepth = parseInt(v, 10) || 0;
          else if (k === 'nameregex') filter.nameRegex = v;
        }
      }
      if (typeof driver.findFirstUIA !== 'function') throw new Error('driver.findFirstUIA is unavailable; cannot EXTRACT.');
      const hit = await driver.findFirstUIA(session.hwnd, filter);
      if (!hit) {
        const err = new Error('EXTRACT found no UIA element matching ' + JSON.stringify(filter));
        err.code = 'extract_miss';
        throw err;
      }
      // Mutate the variables bag in place so subsequent steps see the bind.
      // The runner already passes the same object through every runStep call.
      if (variables && typeof variables === 'object') {
        variables[text] = hit.name;
      }
      emit({ kind: 'step_info', message: `EXTRACT ${text} = "${hit.name}" (${hit.type || 'unknown type'} at depth ${hit.depth})` });
      return;
    }
    default:
      throw new Error('unknown verb: ' + verb);
  }
}

// Fold a flat step list into a tree so block verbs (IF/ELSE/ENDIF,
// REPEAT/ENDREPEAT) execute their bodies together. Each block node owns
// child step arrays.
function treeify(steps) {
  const root = { kind: 'root', children: [] };
  const stack = [root];
  // Return the array the parent's currently-open body points at, so nested
  // blocks append into that body rather than a non-existent `children`.
  const activeBody = (node) => {
    if (node.kind === 'root') return node.children;
    if (node.kind === 'if') return node.branch === 'else' ? node.elseBody : node.thenBody;
    if (node.kind === 'repeat') return node.body;
    return node.children || [];
  };
  const MAX_REPEAT = 1000;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const top = stack[stack.length - 1];
    const body = activeBody(top);
    switch (s.verb) {
      case 'IF': {
        if (!s.target) throw new Error('IF requires a condition target');
        const ifNode = { kind: 'if', cond: s, thenBody: [], elseBody: [], branch: 'then', raw: s };
        body.push(ifNode);
        stack.push(ifNode);
        break;
      }
      case 'ELSE':
        if (top.kind !== 'if') throw new Error('ELSE without matching IF');
        top.branch = 'else';
        break;
      case 'ENDIF':
        if (top.kind !== 'if') throw new Error('ENDIF without matching IF');
        stack.pop();
        break;
      case 'REPEAT': {
        let times = parseInt(s.target || s.text || '1', 10);
        if (!Number.isFinite(times) || times < 1) times = 1;
        if (times > MAX_REPEAT) times = MAX_REPEAT;
        const rptNode = { kind: 'repeat', times, body: [], raw: s };
        body.push(rptNode);
        stack.push(rptNode);
        break;
      }
      case 'ENDREPEAT':
        if (top.kind !== 'repeat') throw new Error('ENDREPEAT without matching REPEAT');
        stack.pop();
        break;
      default:
        body.push({ kind: 'leaf', step: s });
    }
  }
  if (stack.length !== 1) {
    const open = stack[stack.length - 1];
    throw new Error('unclosed ' + (open.kind === 'if' ? 'IF' : 'REPEAT') + ' block');
  }
  return root;
}

// Does the target exist on screen right now? Returns boolean. Uses the same
// locator as VERIFY/CLICK targeted actions, but converts locator_miss into
// a falsy answer instead of a thrown error.
async function conditionHolds(session, driver, target) {
  try {
    await locateTarget({ session, driver, description: target });
    return true;
  } catch (e) {
    if (e.code === 'locator_miss') return false;
    throw e;
  }
}

async function runNode({ session, driver, node, variables, emit, ctx }) {
  if (session._runnerAborted || session.stopped) throw Object.assign(new Error('stopped'), { code: 'stopped' });
  if (node.kind === 'root') {
    for (const c of node.children) await runNode({ session, driver, node: c, variables, emit, ctx });
    return;
  }
  if (node.kind === 'if') {
    const cond = expandVars(node.cond.target, variables);
    const holds = await conditionHolds(session, driver, cond);
    emit({ kind: 'step_info', message: `IF "${cond}" -> ${holds ? 'taking THEN branch' : 'taking ELSE branch'}` });
    const body = holds ? node.thenBody : node.elseBody;
    for (const c of body) await runNode({ session, driver, node: c, variables, emit, ctx });
    return;
  }
  if (node.kind === 'repeat') {
    for (let i = 0; i < node.times; i++) {
      if (session._runnerAborted || session.stopped) throw Object.assign(new Error('stopped'), { code: 'stopped' });
      emit({ kind: 'step_info', message: `REPEAT iteration ${i + 1}/${node.times}` });
      for (const c of node.body) await runNode({ session, driver, node: c, variables, emit, ctx });
    }
    return;
  }
  // Leaf step
  ctx.index++;
  const step = node.step;
  emit({ kind: 'step_index', index: ctx.index, total: ctx.total });
  let attempt = 0;
  let lastErr = null;
  while (attempt < 2) {
    try {
      await runStep({ session, driver, step, variables, emit });
      lastErr = null; break;
    } catch (e) {
      lastErr = e;
      attempt++;
      if (attempt < 2) {
        emit({ kind: 'step_retry', index: ctx.index, reason: e.message });
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }
  if (lastErr) {
    ctx.trail.push({ index: ctx.index, verb: step.verb, target: step.target, text: step.text, ok: false, reason: lastErr.message });
    emit({ kind: 'step_failed', index: ctx.index, verb: step.verb, target: step.target, reason: lastErr.message, code: lastErr.code });
    const err = new Error(`Recipe step ${ctx.index + 1} (${step.verb}${step.target ? ' ' + step.target : ''}) failed: ${lastErr.message}`);
    err.code = lastErr.code || 'step_failed';
    throw err;
  }
  ctx.trail.push({ index: ctx.index, verb: step.verb, target: step.target, text: step.text, ok: true });
  emit({ kind: 'step_done', index: ctx.index });
  try {
    const shot = await driver.screenshotWindow(session.hwnd, { format: 'jpeg', quality: 55 });
    if (shot && shot.base64) {
      emit({ kind: 'screenshot', base64: shot.base64, mimeType: shot.mimeType || 'image/jpeg', width: shot.width, height: shot.height, rect: shot.rect });
    }
  } catch (_) {}
  // Step-through: if enabled, pause after each completed step until the UI
  // releases the gate via /api/apps/session/debug.
  if (session._stepThrough) {
    emit({ kind: 'step_paused', index: ctx.index });
    await new Promise((resolve) => { session._debugResolver = resolve; });
    session._debugResolver = null;
    emit({ kind: 'step_resumed', index: ctx.index });
  }
}

function countLeaves(node) {
  if (node.kind === 'leaf') return 1;
  if (node.kind === 'root') return node.children.reduce((n, c) => n + countLeaves(c), 0);
  if (node.kind === 'if') return node.thenBody.reduce((n, c) => n + countLeaves(c), 0) + node.elseBody.reduce((n, c) => n + countLeaves(c), 0);
  if (node.kind === 'repeat') return node.times * node.body.reduce((n, c) => n + countLeaves(c), 0);
  return 0;
}

async function applyWindowPin(session, driver, pin) {
  if (!pin || session.hwnd == null) return;
  if (pin.maximized && typeof driver.maximizeWindow === 'function') {
    await driver.maximizeWindow(session.hwnd);
  } else if (pin.w && pin.h && typeof driver.setWindowRect === 'function') {
    await driver.setWindowRect(session.hwnd, {
      x: typeof pin.x === 'number' ? pin.x : undefined,
      y: typeof pin.y === 'number' ? pin.y : undefined,
      w: pin.w,
      h: pin.h,
    });
  } else {
    return;
  }
  // Settle - window move dispatches async WM_SIZE; 180ms is enough on Win10/11.
  await new Promise(r => setTimeout(r, 180));
}

async function runRecipe({ session, driver, recipe, broadcast, providerEntry, model, inputs, stepThrough }) {
  const emit = emitter(broadcast, session.id);
  session.running = true;
  session._stepThrough = !!stepThrough;
  // Merge order: static recipe.variables first, then per-run user inputs
  // override. This lets the UI prompt for {{filename}} / {{count}} / ... at
  // Run time while still honoring library-style variables defined on the
  // recipe itself.
  const variables = Object.assign({}, (recipe && recipe.variables) || {}, inputs || {});
  const steps = (recipe && recipe.steps) || [];
  const startedAt = Date.now();

  session._recipeCaptureRect = (recipe && recipe.captureRect && recipe.captureRect.w && recipe.captureRect.h)
    ? { w: recipe.captureRect.w, h: recipe.captureRect.h }
    : null;
  try { await applyWindowPin(session, driver, recipe && recipe.window); }
  catch (e) { emit({ kind: 'step_info', message: 'Window pin skipped: ' + e.message }); }
  await refreshRunRect(session, driver);

  emit({ kind: 'provider', provider: 'recipe-runner', label: 'Recipe Runner', streaming: false, recipe: { id: recipe.id, name: recipe.name } });
  emit({ kind: 'recipe_started', recipeId: recipe.id, name: recipe.name, stepCount: steps.length });

  session._liveStop = () => {
    session._runnerAborted = true;
    // Release any pending step-through gate so the runner can unwind.
    if (typeof session._debugResolver === 'function') { session._debugResolver(); session._debugResolver = null; }
  };

  const finalize = (outcome, extra) => {
    const durationMs = Date.now() - startedAt;
    try {
      if (session.app) {
        recipesStore.recordRun(session.app, {
          recipeId: recipe.id,
          recipeName: recipe.name,
          outcome,
          iterations: (extra && extra.iterations) || 0,
          error: (extra && extra.error) || null,
          durationMs,
        });
      }
    } catch (_) {}
    emit({ kind: 'run_recorded', outcome, durationMs, iterations: (extra && extra.iterations) || 0 });
  };

  let tree;
  try { tree = treeify(steps); }
  catch (e) {
    emit({ kind: 'error', message: 'Recipe parse error: ' + e.message });
    session.running = false;
    session._liveStop = null;
    finalize('failed', { error: e.message });
    return { ok: false, error: e.message };
  }

  const ctx = { index: -1, total: countLeaves(tree), trail: [] };

  try {
    await runNode({ session, driver, node: tree, variables, emit, ctx });
    // Optional post-run verifications folded into the recipe itself. These
    // are best-effort: failures surface as a verify_fail event but don't
    // overwrite the recipe's happy-path completion.
    const verify = recipe && recipe.verify;
    if (verify && (Array.isArray(verify.elementsPresent) || Array.isArray(verify.elementsAbsent))) {
      const failures = [];
      for (const target of verify.elementsPresent || []) {
        try { await locateTarget({ session, driver, description: target }); emit({ kind: 'verify_check', target, ok: true }); }
        catch (e) { failures.push(`missing: "${target}"`); emit({ kind: 'verify_check', target, ok: false, reason: e.message }); }
      }
      for (const target of verify.elementsAbsent || []) {
        try { await locateTarget({ session, driver, description: target }); failures.push(`should be absent: "${target}"`); emit({ kind: 'verify_check', target, ok: false, expectedAbsent: true }); }
        catch (e) { if (e.code === 'locator_miss') emit({ kind: 'verify_check', target, ok: true, expectedAbsent: true }); else emit({ kind: 'verify_check', target, ok: false, expectedAbsent: true, reason: e.message }); }
      }
      if (failures.length) emit({ kind: 'verify_fail', failures });
      else emit({ kind: 'verify_pass' });
    }
    emit({ kind: 'done', summary: `Recipe "${recipe.name}" completed (${ctx.index + 1} actions).` });
    finalize('ok', { iterations: ctx.index + 1 });
    return { ok: true, iterations: ctx.index + 1, trail: ctx.trail, recipe, variables };
  } catch (e) {
    if (e.code === 'stopped') {
      emit({ kind: 'stopped' });
      finalize('aborted', { iterations: ctx.index + 1 });
      return { ok: false, aborted: true, trail: ctx.trail, recipe, variables };
    }
    emit({ kind: 'stuck', reason: e.message });
    finalize('failed', { iterations: ctx.index + 1, error: e.message });
    return { ok: false, error: e.message, trail: ctx.trail, recipe, variables, failedAt: ctx.index };
  } finally {
    session.running = false;
    session._liveStop = null;
  }
}

// Test-step runner: execute one leaf step against a target without the full
// tree-walk machinery. Used by /api/apps/recipes/run-step for the editor's
// "Test step" button.
async function runSingleStep({ session, driver, step, variables }) {
  const emit = () => {};
  return runStep({ session, driver, step, variables: variables || {}, emit });
}

module.exports = { runRecipe, locateTarget, runSingleStep };
