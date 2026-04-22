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

async function runSessionForEntry({ entry, session, task, driver, model, broadcast, recipe, inputs, stepThrough }) {
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
    const chatEntry = (session._providerRegistry && session._providerRegistry.anthropic) || entry;
    const chatModel = chatEntry && chatEntry.adapter && chatEntry.adapter.defaultModel;
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

function mountAppsRoutes(addRoute, json, { getConfig, broadcast, permGate } = {}) {
  const isIncognito = () => (getConfig && getConfig().IncognitoMode === true);
  const buildRegistry = () => {
    const aiKeys = Object.assign({}, (getConfig && getConfig().AiApiKeys) || {});
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'DASHSCOPE_API_KEY', 'GEMINI_API_KEY']) {
      if (!aiKeys[k] && process.env[k]) aiKeys[k] = process.env[k];
    }
    return chat.buildProviderRegistry(aiKeys);
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
    if (!id && !path) return json(res, { error: 'id or path required' }, 400);
    if (typeof permGate === 'function') {
      const label = 'Launch app: ' + (name || id || path);
      const ok = await permGate(res, 'api', 'POST /api/apps/launch', label);
      if (!ok) return;
    }
    try {
      const result = await driver.launchApp({ id, path, name });
      json(res, { ok: true, ...result });
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
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
      const focused = await driver.focusWindow(hwnd);
      session.hwnd = hwnd;
      session.title = focused.title;
      session.app = String(body.app || '').trim() || null;
      session.goal = goal;
      session.stopped = false;
      driver.resetStopped();
    } catch (e) {
      const code = e && e.code;
      if (code === 'deny_listed') return json(res, { error: e.message, code }, 403);
      return json(res, { error: 'Failed to focus target window: ' + e.message }, 400);
    }

    const registry = buildRegistry();
    const entry = chat.pickProvider(registry, body.provider);
    if (!entry) {
      return json(res, {
        error: 'No AI provider configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or DASHSCOPE_API_KEY in Settings -> AI Keys.',
        providers: Object.keys(registry),
      }, 400);
    }
    const model = body.model || entry.adapter.defaultModel;

    json(res, { ok: true, sessionId, provider: entry.adapter.kind, label: entry.adapter.label, model, title: session.title, recipe: recipe ? { id: recipe.id, name: recipe.name } : null });

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
    runSessionForEntry({ entry, session, task, driver, model, broadcast, recipe, inputs: runInputs, stepThrough })
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
    const entry = chat.pickProvider(registry, body.provider);
    if (!entry) return json(res, { error: 'No AI provider configured.' }, 400);
    const model = body.model || entry.adapter.defaultModel;

    json(res, { ok: true, sessionId, provider: entry.adapter.kind, label: entry.adapter.label, model, title: session.title });

    const followUp = [
      `Follow-up task: ${goal}`,
      '',
      'Continue in the same window you were already driving. You do NOT need to relist windows or refocus — the user is keeping you on the same app. Start with a screenshot to see the current state, then work toward this new goal.',
    ].join('\n');

    // Append the new goal as a user turn on the existing message history so
    // prior context (what worked, what didn't) carries over.
    const adapter = entry.adapter;
    if (adapter.kind === 'gemini') session.messages.push({ role: 'user', parts: [{ text: followUp }] });
    else session.messages.push({ role: 'user', content: followUp });

    session._providerRegistry = registry;
    runSessionForEntry({ entry, session, task: followUp, driver, model, broadcast })
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

  addRoute('GET', '/api/apps/recipes/history', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    if (!app) return json(res, { error: 'app required' }, 400);
    json(res, recipes.listHistory(app));
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
    const entry = chat.pickProvider(registry, 'anthropic');
    if (!entry) return json(res, { error: 'ANTHROPIC_API_KEY required to generate recipes. Set it in Settings -> AI Keys.' }, 400);

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

    const userContent = [{ type: 'text', text: description }];
    if (body.screenshotBase64) {
      userContent.unshift({ type: 'image', source: { type: 'base64', media_type: body.mimeType || 'image/jpeg', data: body.screenshotBase64 } });
    }

    const payload = JSON.stringify({
      model: entry.adapter.defaultModel,
      max_tokens: 2048,
      system,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: userContent }],
    });
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const r = https.request({
        method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-api-key': entry.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
        },
        timeout: 60000,
      }, (response) => {
        let d = '';
        response.on('data', c => d += c);
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('anthropic ' + response.statusCode + ': ' + d.slice(0, 300)));
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
      r.on('error', reject);
      r.on('timeout', () => r.destroy(new Error('generate timed out')));
      r.write(payload); r.end();
    }).catch(e => ({ _err: e }));
    if (result._err) return json(res, { error: result._err.message }, 500);

    const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
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
      });
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
