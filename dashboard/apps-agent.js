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

function runSessionForEntry({ entry, session, task, driver, model, broadcast, recipe }) {
  if (recipe) {
    // Deterministic path: execute recipe steps directly against the driver.
    return recipeRunner.runRecipe({ session, driver, recipe, broadcast, providerEntry: entry, model });
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
    runSessionForEntry({ entry, session, task, driver, model, broadcast, recipe })
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
    try {
      json(res, recipes.saveRecipe(app, body.recipe || body));
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });

  addRoute('DELETE', '/api/apps/recipes', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const app = url.searchParams.get('app');
    const id = url.searchParams.get('id');
    if (!app || !id) return json(res, { error: 'app and id required' }, 400);
    json(res, recipes.deleteRecipe(app, id));
  });

  addRoute('POST', '/api/apps/recipes/import', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }
    const app = String(body.app || '').trim();
    if (!app) return json(res, { error: 'app required' }, 400);
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
