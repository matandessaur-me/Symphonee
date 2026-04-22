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

const https = require('https');
const recipesStore = require('./apps-recipes');

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

// Call Anthropic vision with a compact prompt that asks the model to return
// JSON coordinates for a target description inside a screenshot. Keeps the
// locator out of the main agent loop so it's fast and bounded.
async function locateViaAnthropic({ apiKey, model, imageBase64, mimeType, description, rect }) {
  const prompt =
    `You are given a screenshot of a Windows application window (${rect.w}x${rect.h}). ` +
    `The user wants to interact with: "${description}". ` +
    `Return ONLY a compact JSON object with window-relative pixel coordinates of the CENTER of that element, like {"x":123,"y":456}. ` +
    `If you cannot identify the element, return {"x":null,"y":null,"reason":"short reason"}.`;
  const body = {
    model,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  };
  const payload = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 30000,
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) {
          return reject(new Error(`locator ${r.statusCode}: ${d.slice(0, 300)}`));
        }
        try {
          const parsed = JSON.parse(d);
          const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
          const m = text.match(/\{[\s\S]*\}/);
          if (!m) return reject(new Error('locator returned non-JSON: ' + text.slice(0, 160)));
          resolve(JSON.parse(m[0]));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('locator timed out')));
    req.write(payload); req.end();
  });
}

function pickLocatorProvider(registry, fallbackEntry) {
  // Anthropic vision is the cheapest + most reliable pixel locator today.
  // Fall back to whatever the session was started with if no Anthropic key.
  if (registry && registry.anthropic) return { kind: 'anthropic', entry: registry.anthropic };
  if (fallbackEntry && fallbackEntry.adapter && fallbackEntry.adapter.kind === 'anthropic') {
    return { kind: 'anthropic', entry: fallbackEntry };
  }
  return null;
}

async function locateTarget({ session, driver, description }) {
  const registry = session && session._providerRegistry;
  const locator = pickLocatorProvider(registry, session._providerEntry);
  if (!locator) throw new Error('no Anthropic key configured for visual locator (needed by CLICK/TYPE with a target, FIND, VERIFY). Set ANTHROPIC_API_KEY in Settings -> AI Keys, or rewrite the step to use explicit "x,y" coordinates.');
  const shot = await driver.screenshotWindow(session.hwnd, { format: 'jpeg', quality: 55 });
  if (!shot || !shot.base64) throw new Error('screenshot failed');
  const res = await locateViaAnthropic({
    apiKey: locator.entry.apiKey,
    model: locator.entry.adapter.defaultModel,
    imageBase64: shot.base64,
    mimeType: shot.mimeType || 'image/jpeg',
    description,
    rect: shot.rect || { w: shot.width, h: shot.height },
  });
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
      if (typeof driver.waitMs === 'function') await driver.waitMs(ms);
      else await new Promise(r => setTimeout(r, ms));
      return;
    }
    case 'PRESS': {
      if (!target) throw new Error('PRESS requires a key or combo (e.g. "Ctrl+S", "Enter").');
      await driver.key({ combo: target });
      return;
    }
    case 'TYPE': {
      if (target) {
        const coord = parseCoord(target) || await locateTarget({ session, driver, description: target });
        await driver.click({ x: coord.x, y: coord.y });
        await new Promise(r => setTimeout(r, 120));
      }
      await driver.type({ text: text || target });
      return;
    }
    case 'CLICK': {
      if (!target) throw new Error('CLICK requires a target (a description or "x,y" coordinates).');
      const coord = parseCoord(target) || await locateTarget({ session, driver, description: target });
      await driver.click({ x: coord.x, y: coord.y });
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
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const top = stack[stack.length - 1];
    switch (s.verb) {
      case 'IF':
        if (!s.target) throw new Error('IF requires a condition target');
        const ifNode = { kind: 'if', cond: s, thenBody: [], elseBody: [], branch: 'then', raw: s };
        top.children.push(ifNode);
        stack.push(ifNode);
        break;
      case 'ELSE':
        if (top.kind !== 'if') throw new Error('ELSE without matching IF');
        top.branch = 'else';
        break;
      case 'ENDIF':
        if (top.kind !== 'if') throw new Error('ENDIF without matching IF');
        stack.pop();
        break;
      case 'REPEAT':
        const times = Math.max(1, parseInt(s.target || s.text || '1', 10) || 1);
        const rptNode = { kind: 'repeat', times, body: [], raw: s };
        top.children.push(rptNode);
        stack.push(rptNode);
        break;
      case 'ENDREPEAT':
        if (top.kind !== 'repeat') throw new Error('ENDREPEAT without matching REPEAT');
        stack.pop();
        break;
      default:
        if (top.kind === 'if') (top.branch === 'else' ? top.elseBody : top.thenBody).push({ kind: 'leaf', step: s });
        else if (top.kind === 'repeat') top.body.push({ kind: 'leaf', step: s });
        else top.children.push({ kind: 'leaf', step: s });
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
    emit({ kind: 'step_failed', index: ctx.index, verb: step.verb, target: step.target, reason: lastErr.message, code: lastErr.code });
    const err = new Error(`Recipe step ${ctx.index + 1} (${step.verb}${step.target ? ' ' + step.target : ''}) failed: ${lastErr.message}`);
    err.code = lastErr.code || 'step_failed';
    throw err;
  }
  emit({ kind: 'step_done', index: ctx.index });
  try {
    const shot = await driver.screenshotWindow(session.hwnd, { format: 'jpeg', quality: 55 });
    if (shot && shot.base64) {
      emit({ kind: 'screenshot', base64: shot.base64, mimeType: shot.mimeType || 'image/jpeg', width: shot.width, height: shot.height, rect: shot.rect });
    }
  } catch (_) {}
}

function countLeaves(node) {
  if (node.kind === 'leaf') return 1;
  if (node.kind === 'root') return node.children.reduce((n, c) => n + countLeaves(c), 0);
  if (node.kind === 'if') return node.thenBody.reduce((n, c) => n + countLeaves(c), 0) + node.elseBody.reduce((n, c) => n + countLeaves(c), 0);
  if (node.kind === 'repeat') return node.times * node.body.reduce((n, c) => n + countLeaves(c), 0);
  return 0;
}

async function runRecipe({ session, driver, recipe, broadcast, providerEntry, model }) {
  const emit = emitter(broadcast, session.id);
  session.running = true;
  const variables = (recipe && recipe.variables) || {};
  const steps = (recipe && recipe.steps) || [];
  const startedAt = Date.now();

  emit({ kind: 'provider', provider: 'recipe-runner', label: 'Recipe Runner', streaming: false, recipe: { id: recipe.id, name: recipe.name } });
  emit({ kind: 'recipe_started', recipeId: recipe.id, name: recipe.name, stepCount: steps.length });

  session._liveStop = () => { session._runnerAborted = true; };

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

  const ctx = { index: -1, total: countLeaves(tree) };

  try {
    await runNode({ session, driver, node: tree, variables, emit, ctx });
    emit({ kind: 'done', summary: `Recipe "${recipe.name}" completed (${ctx.index + 1} actions).` });
    finalize('ok', { iterations: ctx.index + 1 });
    return { ok: true, iterations: ctx.index + 1 };
  } catch (e) {
    if (e.code === 'stopped') {
      emit({ kind: 'stopped' });
      finalize('aborted', { iterations: ctx.index + 1 });
      return { ok: false, aborted: true };
    }
    emit({ kind: 'stuck', reason: e.message });
    finalize('failed', { iterations: ctx.index + 1, error: e.message });
    return { ok: false, error: e.message };
  } finally {
    session.running = false;
    session._liveStop = null;
  }
}

module.exports = { runRecipe };
