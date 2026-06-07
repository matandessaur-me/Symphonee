'use strict';
// UI-context + focus + application-state store - the shared "where is the user"
// state that every dispatched CLI can read. Extracted from server.js as a
// factory so server.js keeps a getUiContext binding for its 13 call sites.
//
// createUiContextStore({ repoRoot, getConfig, broadcast, onActiveRepoChange })
//   -> { getUiContext, getFocusState, mountRoutes(addRoute, json) }
// onActiveRepoChange() fires when the active repo changes (server.js wires it to
// writePluginHints) - kept as a callback to avoid a circular module dependency.

const fs = require('fs');
const path = require('path');
const { namespaceFromName } = require('./notes-ns');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function createUiContextStore({ repoRoot, getConfig, broadcast, onActiveRepoChange }) {
  const noop = () => {};
  const fireActiveRepoChange = typeof onActiveRepoChange === 'function' ? onActiveRepoChange : noop;

  // ── UI selection state (persisted so it survives a restart) ──────────────
  const _uiStatePath = path.join(repoRoot, '.symphonee', 'ui-state.json');
  function _loadUiState() {
    try {
      if (!fs.existsSync(_uiStatePath)) return null;
      return JSON.parse(fs.readFileSync(_uiStatePath, 'utf8'));
    } catch (_) { return null; }
  }
  function _saveUiState(state) {
    try {
      fs.mkdirSync(path.dirname(_uiStatePath), { recursive: true });
      fs.writeFileSync(_uiStatePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) { /* best effort */ }
  }
  const _uiContext = (() => {
    const saved = _loadUiState() || {};
    return {
      selectedIteration: saved.selectedIteration ?? null,
      selectedIterationName: saved.selectedIterationName || 'All Iterations',
      selectedArea: saved.selectedArea ?? null,
      selectedAreaName: saved.selectedAreaName || 'Team Default',
      activeSpace: saved.activeSpace ?? null,
      activeRepo: saved.activeRepo ?? null,
      activeRepoPath: null, // re-derived from config on read
    };
  })();

  function getUiContext() {
    const ctx = { ..._uiContext };
    if (ctx.activeRepo) {
      const cfg = getConfig();
      ctx.activeRepoPath = (cfg.Repos || {})[ctx.activeRepo] || null;
    }
    ctx.notesNamespace = ctx.activeSpace ? namespaceFromName(ctx.activeSpace) : '_global';
    return ctx;
  }

  async function handleUiContextUpdate(req, res) {
    const data = await readBody(req);
    const prevRepo = _uiContext.activeRepo;
    Object.assign(_uiContext, data);
    if (data.activeRepo !== undefined && data.activeRepo !== prevRepo) {
      try { fireActiveRepoChange(); } catch (_) {}
    }
    _saveUiState({
      selectedIteration: _uiContext.selectedIteration,
      selectedIterationName: _uiContext.selectedIterationName,
      selectedArea: _uiContext.selectedArea,
      selectedAreaName: _uiContext.selectedAreaName,
      activeSpace: _uiContext.activeSpace,
      activeRepo: _uiContext.activeRepo,
    });
    res._json({ ok: true, context: getUiContext() });
  }

  async function handleUiAction(req, res, action) {
    const data = await readBody(req);
    // Normalize: accept "commit" as alias for "hash" in view-commit-diff
    if (action === 'view-commit-diff' && data.commit && !data.hash) {
      data.hash = data.commit;
      delete data.commit;
    }
    broadcast({ type: 'ui-action', action, ...data });
    res._json({ ok: true, action });
  }

  async function handleUiMutate(req, res) {
    const data = await readBody(req);
    const ops = Array.isArray(data.ops) ? data.ops : (data.op ? [data] : []);
    if (!ops.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No ops supplied. Pass { op, ... } or { ops: [...] }.' }));
    }
    broadcast({ type: 'ui-mutate', ops });
    res._json({ ok: true, count: ops.length });
  }

  // ── Focus / context-awareness state ──────────────────────────────────────
  let _focusState = { activeTab: null, activeRepo: null, currentNote: null, selection: '', updatedAt: 0 };
  function getFocusState() {
    const ctx = getUiContext();
    return {
      ..._focusState,
      activeRepo: _focusState.activeRepo || ctx.activeRepo || null,
      activeRepoPath: ctx.activeRepoPath || null,
    };
  }
  async function handleFocusUpdate(req, res) {
    const data = await readBody(req);
    _focusState = {
      activeTab: data.activeTab ?? _focusState.activeTab,
      activeRepo: data.activeRepo ?? _focusState.activeRepo,
      currentNote: data.currentNote ?? _focusState.currentNote,
      selection: typeof data.selection === 'string' ? data.selection.slice(0, 2000) : _focusState.selection,
      updatedAt: Date.now(),
    };
    res._json({ ok: true });
  }

  // ── Application state key/value store (agent-native pattern) ──────────────
  const APP_STATE_MAX_KEYS = 128;
  const APP_STATE_EPHEMERAL = new Set(['navigate']);
  const _appStatePath = path.join(repoRoot, 'config', 'application-state.json');
  let _appStateStore = {};
  try {
    if (fs.existsSync(_appStatePath)) _appStateStore = JSON.parse(fs.readFileSync(_appStatePath, 'utf8')) || {};
  } catch (_) { _appStateStore = {}; }
  let _appStateSaveTimer = null;
  function _saveAppState() {
    clearTimeout(_appStateSaveTimer);
    _appStateSaveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(_appStatePath), { recursive: true });
        const serializable = {};
        for (const [k, v] of Object.entries(_appStateStore)) {
          if (!APP_STATE_EPHEMERAL.has(k)) serializable[k] = v;
        }
        fs.writeFileSync(_appStatePath, JSON.stringify(serializable, null, 2));
      } catch (_) {}
    }, 200);
  }
  async function handleAppStateWrite(req, res, key) {
    const data = await readBody(req);
    if (Object.keys(_appStateStore).length >= APP_STATE_MAX_KEYS && !(key in _appStateStore)) {
      return res._json({ error: 'too many keys' }, 400);
    }
    _appStateStore[key] = data && Object.prototype.hasOwnProperty.call(data, 'value') ? data.value : data;
    _saveAppState();
    broadcast({ type: 'app-state-set', key, value: _appStateStore[key] });
    res._json({ ok: true, key });
  }

  // ── Routes ───────────────────────────────────────────────────────────────
  const UI_ACTIONS = {
    'tab': 'switch-tab',
    'view-workitem': 'view-workitem',
    'view-note': 'view-note',
    'refresh-workitems': 'refresh-workitems',
    'view-file': 'view-file',
    'view-diff': 'view-diff',
    'view-commit-diff': 'view-commit-diff',
    'view-activity': 'view-activity',
    'view-pr': 'view-pr',
    'view-plugin': 'view-plugin',
  };

  function mountRoutes(addRoute, json) {
    // Bridge: handlers use res._json so they don't need json threaded everywhere.
    const wrap = (fn) => (req, res, ...rest) => { res._json = (d, s) => json(res, d, s); return fn(req, res, ...rest); };

    addRoute('GET',  '/api/ui/context', wrap((req, res) => json(res, getUiContext())));
    addRoute('POST', '/api/ui/context', wrap(handleUiContextUpdate));
    addRoute('POST', '/api/ui/mutate',  wrap(handleUiMutate));
    for (const [pathSeg, action] of Object.entries(UI_ACTIONS)) {
      addRoute('POST', '/api/ui/' + pathSeg, wrap((req, res) => handleUiAction(req, res, action)));
    }
    addRoute('GET',  '/api/application-state/focus', wrap((req, res) => json(res, getFocusState())));
    addRoute('POST', '/api/application-state/focus', wrap(handleFocusUpdate));
    addRoute('GET',  '/api/application-state', wrap((req, res) => json(res, _appStateStore)));
    // Generic key-value store: /api/application-state/<key> GET/PUT/DELETE.
    addRoute('__PREFIX__', '/api/application-state', (req, res, url, subpath) => {
      res._json = (d, s) => json(res, d, s);
      if (subpath === '/' || subpath === '') return false; // exact GET handled above
      const key = decodeURIComponent(subpath.replace(/^\//, ''));
      if (!key || key === 'focus') return false;
      if (req.method === 'GET') { json(res, { key, value: _appStateStore[key] !== undefined ? _appStateStore[key] : null }); return; }
      if (req.method === 'PUT') { return handleAppStateWrite(req, res, key); }
      if (req.method === 'DELETE') { delete _appStateStore[key]; broadcast({ type: 'app-state-set', key, value: null }); json(res, { ok: true, key }); return; }
      return false;
    });
  }

  return { getUiContext, getFocusState, mountRoutes };
}

module.exports = { createUiContextStore };
