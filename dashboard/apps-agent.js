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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function mountAppsRoutes(addRoute, json, { getConfig, broadcast } = {}) {
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

  addRoute('POST', '/api/apps/session/start', async (req, res) => {
    if (isIncognito()) return json(res, { error: 'Blocked by Incognito Mode.' }, 403);
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { error: 'Bad JSON: ' + e.message }, 400); }

    const goal = String(body.goal || '').trim();
    if (!goal) return json(res, { error: 'goal required' }, 400);
    const hwnd = Number(body.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return json(res, { error: 'hwnd required (see /api/apps/windows)' }, 400);

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

    json(res, { ok: true, sessionId, provider: entry.adapter.kind, label: entry.adapter.label, model, title: session.title });

    // Build the initial task the model sees: the user's goal plus the
    // window identity so the agent knows what it is driving without us
    // having to pre-list every app.
    const task = [
      `Goal: ${goal}`,
      '',
      `Target window: "${session.title}" (hwnd=${hwnd}${session.app ? `, app=${session.app}` : ''})`,
      'The window is already focused. Start with a screenshot and work toward the goal.',
    ].join('\n');

    chat.runSession({ session, task, driver, providerEntry: entry, model, broadcast })
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
    driver.stop();
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId, kind: 'stopped', at: Date.now() });
    }
    json(res, { ok: true });
  });

  addRoute('POST', '/api/apps/panic', async (req, res) => {
    for (const s of chat.sessions.values()) {
      s.stopped = true;
      if (s.abortController) { try { s.abortController.abort(); } catch (_) {} }
    }
    driver.stop();
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId: '*', kind: 'panic', at: Date.now() });
    }
    json(res, { ok: true });
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
