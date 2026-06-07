'use strict';
// In-app browser automation driver. Discovers the <webview> webContents inside
// the Browser tab and drives navigate/click/fill/etc via executeJavaScript + the
// CDP debugger. A factory so it can read the late-created, reassigned main window
// through getWin(). Extracted from electron-main.js (behavior-preserving).

const { webContents: webContentsNS } = require('electron');
const BROWSER_DOM_HELPERS = require('./browser-dom-helpers');

function createWebviewDriver({ getWin }) {
// ── In-app browser automation driver ───────────────────────────────────────
// Tracks the <webview> webContents inside panel-browser and exposes
// navigate/click/fill/etc. ops that browser-agent.js can dispatch. Replaces
// the external-playwright fallback so automation never opens a system browser.
let _webviewContents = null;

function _findWebviewContents() {
  if (_webviewContents && !_webviewContents.isDestroyed()) return _webviewContents;
  try {
    const all = (webContentsNS && typeof webContentsNS.getAllWebContents === 'function')
      ? webContentsNS.getAllWebContents()
      : [];
    for (const c of all) {
      try {
        if (c && !c.isDestroyed() && typeof c.getType === 'function' && c.getType() === 'webview') {
          _webviewContents = c;
          return c;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function _broadcastToRenderer(msg) {
  try { const win = getWin(); if (win && !win.isDestroyed()) win.webContents.send('browser-agent', msg); } catch (_) {}
}

async function _ensureBrowserTab() {
  const win = getWin();
  if (!win || win.isDestroyed()) throw new Error('Main window not available');
  // Open the Browser tab and ensure the webview exists. Do NOT pass a URL here
  // to avoid a race where openBrowserTab's 50ms timeout fires after the driver's
  // loadURL(url) and navigates back to about:blank.
  await win.webContents.executeJavaScript(
    `(function(){ try { if (typeof _ensureInappBrowser === 'function') { _ensureInappBrowser(); } if (typeof switchTab === 'function') { switchTab('browser'); } } catch(_){} })();`
  );
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const wc = _findWebviewContents();
    if (wc) return wc;
    await new Promise(r => setTimeout(r, 100));
  }
  const wc = _findWebviewContents();
  if (!wc) throw new Error('In-app webview not ready');
  return wc;
}

function _waitForLoad(wc, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const onStop = () => finish();
    const onFinish = () => finish();
    try { wc.once('did-stop-loading', onStop); } catch (_) {}
    try { wc.once('did-finish-load', onFinish); } catch (_) {}
    setTimeout(finish, timeoutMs);
  });
}

// Wrap every script in try/catch so we get the REAL error string back, not
// Electron's generic "Script failed to execute, this normally means an error
// was thrown" rejection. The wrapper returns { __syOk:true, value } on success
// and { __syOk:false, error, stack } on a thrown error; we unwrap on this side
// and re-throw with the real message so the agent loop sees something useful.
//
// Every existing caller passes an EXPRESSION (an IIFE, `new Promise(...)`, or
// a plain identifier), optionally with a trailing semicolon. We strip the
// trailing semicolon and `await` the expression so sync values, thenables,
// and async IIFEs all flow through the same path.
async function _exec(wc, code) {
  const expr = String(code).trim().replace(/;+\s*$/, '');
  const wrapped =
    `(async function(){
      try {
        var __sy_v = await (${expr});
        return { __syOk: true, value: __sy_v };
      } catch (e) {
        return { __syOk: false, error: (e && e.message) ? e.message : String(e), stack: e && e.stack ? String(e.stack) : null };
      }
    })()`;
  const result = await wc.executeJavaScript(wrapped, true);
  if (result && typeof result === 'object' && '__syOk' in result) {
    if (result.__syOk) return result.value;
    const err = new Error(result.error || 'script error');
    if (result.stack) err.stack = result.stack;
    throw err;
  }
  return result;
}

const _debugState = new WeakMap();
const MAX_BROWSER_NETWORK_EVENTS = 200;

function _getDebugState(wc) {
  let state = _debugState.get(wc);
  if (!state) {
    state = {
      listening: false,
      networkEnabled: false,
      runtimeEnabled: false,
      logEnabled: false,
      pageEnabled: false,
      events: [],
      consoleEvents: [],
      requests: new Map(),
      responseBodies: new Map(),
      // Watchdog buffers, parity with the Playwright driver's
      // dashboard/lib/browser-watchdogs.js attachAll() output shape.
      popups: [],
      aboutBlank: [],
      downloads: [],
      // Per-type popup policy. Conservative default: dismiss everything.
      popupPolicy: { alert: 'dismiss', confirm: 'dismiss', prompt: 'dismiss', beforeunload: 'dismiss' },
    };
    _debugState.set(wc, state);
  }
  return state;
}

function _trimValue(value, maxLen = 240) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= maxLen ? text : (text.slice(0, maxLen) + '...');
}

function _pushNetworkEvent(state, event) {
  state.events.push(event);
  if (state.events.length > MAX_BROWSER_NETWORK_EVENTS) state.events.splice(0, state.events.length - MAX_BROWSER_NETWORK_EVENTS);
}

function _pushConsoleEvent(state, event) {
  state.consoleEvents.push(event);
  if (state.consoleEvents.length > MAX_BROWSER_NETWORK_EVENTS) state.consoleEvents.splice(0, state.consoleEvents.length - MAX_BROWSER_NETWORK_EVENTS);
}

async function _ensureDebugger(wc) {
  const state = _getDebugState(wc);
  if (!wc || !wc.debugger) return state;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  if (!state.listening) {
    wc.debugger.on('message', (_event, method, params) => {
      try {
        if (method === 'Network.requestWillBeSent') {
          const req = params && params.request ? params.request : {};
          state.requests.set(params.requestId, {
            requestId: params.requestId,
            url: req.url || '',
            method: req.method || 'GET',
            resourceType: params.type || null,
            initiator: params.initiator && params.initiator.type ? params.initiator.type : null,
            startedAt: Date.now(),
          });
          _pushNetworkEvent(state, {
            kind: 'request',
            requestId: params.requestId,
            method: req.method || 'GET',
            url: req.url || '',
            resourceType: params.type || null,
            initiator: params.initiator && params.initiator.type ? params.initiator.type : null,
            startedAt: Date.now(),
          });
          return;
        }
        if (method === 'Network.responseReceived') {
          const prev = state.requests.get(params.requestId) || {};
          const res = params && params.response ? params.response : {};
          const event = {
            kind: 'response',
            requestId: params.requestId,
            method: prev.method || 'GET',
            url: res.url || prev.url || '',
            status: res.status,
            statusText: res.statusText || null,
            mimeType: res.mimeType || null,
            resourceType: params.type || prev.resourceType || null,
            fromDiskCache: !!res.fromDiskCache,
            fromServiceWorker: !!res.fromServiceWorker,
            hasBodyPreview: false,
            receivedAt: Date.now(),
          };
          state.requests.set(params.requestId, { ...prev, ...event });
          _pushNetworkEvent(state, event);
          return;
        }
        if (method === 'Network.loadingFailed') {
          const prev = state.requests.get(params.requestId) || {};
          const event = {
            kind: 'failed',
            requestId: params.requestId,
            method: prev.method || 'GET',
            url: prev.url || '',
            errorText: params.errorText || 'Request failed',
            canceled: !!params.canceled,
            resourceType: params.type || prev.resourceType || null,
            failedAt: Date.now(),
          };
          state.requests.delete(params.requestId);
          _pushNetworkEvent(state, event);
          return;
        }
        if (method === 'Network.loadingFinished') {
          const prev = state.requests.get(params.requestId) || {};
          const event = {
            kind: 'finished',
            requestId: params.requestId,
            method: prev.method || 'GET',
            url: prev.url || '',
            status: prev.status || null,
            resourceType: prev.resourceType || null,
            encodedDataLength: params.encodedDataLength || 0,
            finishedAt: Date.now(),
          };
          _pushNetworkEvent(state, event);
          return;
        }
        if (method === 'Runtime.consoleAPICalled') {
          _pushConsoleEvent(state, {
            kind: 'console',
            type: params.type || 'log',
            text: (params.args || []).map((arg) => _trimValue(arg.value != null ? arg.value : arg.description || arg.type || '')).filter(Boolean).join(' '),
            at: Date.now(),
          });
          return;
        }
        if (method === 'Runtime.exceptionThrown') {
          const details = params && params.exceptionDetails ? params.exceptionDetails : {};
          _pushConsoleEvent(state, {
            kind: 'exception',
            type: 'exception',
            text: _trimValue((details.exception && (details.exception.description || details.exception.value)) || details.text || 'Exception thrown', 2000),
            url: details.url || null,
            lineNumber: details.lineNumber,
            columnNumber: details.columnNumber,
            at: Date.now(),
          });
          return;
        }
        if (method === 'Log.entryAdded') {
          const entry = params && params.entry ? params.entry : {};
          _pushConsoleEvent(state, {
            kind: 'log',
            type: entry.level || 'info',
            source: entry.source || null,
            text: _trimValue(entry.text || '', 2000),
            url: entry.url || null,
            at: Date.now(),
          });
          return;
        }
        if (method === 'Page.javascriptDialogOpening') {
          const type = params && params.type ? params.type : 'alert'; // alert | confirm | prompt | beforeunload
          const action = (state.popupPolicy && state.popupPolicy[type]) || 'dismiss';
          const message = params.message || '';
          const url = params.url || null;
          // CDP fires this event on both the page and any embedded webview's
          // hosting context. Dedupe by (type, message, url) within a 500ms
          // window so the snapshot has one row per actual dialog.
          const last = state.popups.length ? state.popups[state.popups.length - 1] : null;
          const isDup = last && last.type === type && last.message === message && last.url === url && (Date.now() - last.at) < 500;
          if (!isDup) {
            state.popups.push({ at: Date.now(), type, message, defaultValue: params.defaultPrompt != null ? params.defaultPrompt : null, url, action });
            if (state.popups.length > MAX_BROWSER_NETWORK_EVENTS) state.popups.splice(0, state.popups.length - MAX_BROWSER_NETWORK_EVENTS);
          }
          // Always answer - without this Chromium hangs forever, even on dups.
          const accept = action === 'accept';
          wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept, promptText: '' }).catch(() => {});
          return;
        }
        if (method === 'Page.frameNavigated') {
          const f = params && params.frame ? params.frame : {};
          if (!f.parentId) {
            const url = f.url || '';
            if (url === 'about:blank' || url === '' || url.startsWith('about:')) {
              const last = state.aboutBlank.length ? state.aboutBlank[state.aboutBlank.length - 1] : null;
              const isDup = last && last.url === url && (Date.now() - last.at) < 500;
              if (!isDup) {
                state.aboutBlank.push({ at: Date.now(), url, kind: 'mainframe-blank' });
                if (state.aboutBlank.length > MAX_BROWSER_NETWORK_EVENTS) state.aboutBlank.splice(0, state.aboutBlank.length - MAX_BROWSER_NETWORK_EVENTS);
              }
            }
          }
          return;
        }
        if (method === 'Page.downloadWillBegin') {
          const url = params.url || null;
          const suggestedFilename = params.suggestedFilename || null;
          // Dedupe by (url, filename) within 500ms - same CDP duplication
          // pattern as dialogs.
          const last = state.downloads.length ? state.downloads[state.downloads.length - 1] : null;
          const isDup = last && last.url === url && last.suggestedFilename === suggestedFilename && (Date.now() - last.at) < 500;
          if (!isDup) {
            state.downloads.push({ at: Date.now(), url, suggestedFilename, guid: params.guid || null, savedPath: null });
            if (state.downloads.length > MAX_BROWSER_NETWORK_EVENTS) state.downloads.splice(0, state.downloads.length - MAX_BROWSER_NETWORK_EVENTS);
          }
        }
      } catch (_) {}
    });
    wc.on('destroyed', () => { _debugState.delete(wc); });
    state.listening = true;
  }
  if (!state.networkEnabled) {
    await wc.debugger.sendCommand('Network.enable');
    state.networkEnabled = true;
  }
  if (!state.runtimeEnabled) {
    await wc.debugger.sendCommand('Runtime.enable');
    state.runtimeEnabled = true;
  }
  if (!state.logEnabled) {
    await wc.debugger.sendCommand('Log.enable');
    state.logEnabled = true;
  }
  if (!state.pageEnabled) {
    // Page.enable surfaces javascriptDialogOpening, frameNavigated, and
    // downloadWillBegin so the watchdogs can capture them. Best-effort -
    // older Electron / certain webContents may reject this.
    try { await wc.debugger.sendCommand('Page.enable'); } catch (_) {}
    try { await wc.debugger.sendCommand('Page.setDownloadBehavior', { behavior: 'default' }); } catch (_) {}
    state.pageEnabled = true;
  }
  return state;
}

async function _preferLightColorScheme(wc) {
  if (!wc || wc.isDestroyed()) return;
  try {
    await _ensureDebugger(wc);
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
  } catch (_) {}
}

const internalWebviewDriver = {
  kind: 'internal-webview',

  async launch({ headless = false } = {}) {
    // headless has no meaning here; we always drive the visible in-app tab.
    const wc = await _ensureBrowserTab();
    // Arm the debugger up front so Page.* events are captured before the
    // very first navigate. Otherwise a dialog fired by the landing page
    // slips through before we attach.
    try { await _ensureDebugger(wc); } catch (_) {}
    return { launchedVia: 'in-app webview' };
  },

  async navigate(url) {
    const wc = await _ensureBrowserTab();
    try {
      const state = await _ensureDebugger(wc);
      state.events = [];
      state.consoleEvents = [];
      state.requests.clear();
      state.responseBodies.clear();
    } catch (_) {}
    try { await wc.loadURL(url); } catch (_) { /* allow waitForLoad to settle */ }
    await _waitForLoad(wc);
    const title = await _exec(wc, 'document.title').catch(() => '');
    _broadcastToRenderer({ type: 'navigated', url: wc.getURL() });
    return { url: wc.getURL(), title };
  },

  async fill(selector, value) {
    const wc = await _ensureBrowserTab();
    // Poll for up to 2s so a still-rendering input (e.g. SPA / Google Images)
    // doesn't fail the call outright. The agent already has wait_for, but
    // 9 times out of 10 the field is one paint away and a tiny wait is enough.
    const js = `(async function(){
      var sel = ${JSON.stringify(selector)};
      var el = null;
      var deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try { el = document.querySelector(sel); } catch (e) {
          throw new Error('Invalid CSS selector: ' + sel);
        }
        if (el) break;
        await new Promise(function(r){ setTimeout(r, 50); });
      }
      if (!el) throw new Error('No element for selector: ' + sel);
      try { el.scrollIntoView({ block: 'center' }); } catch(_){}
      try { el.focus(); } catch(_){}
      var v = ${JSON.stringify(String(value))};
      var proto = Object.getPrototypeOf(el);
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      var setter = desc && desc.set;
      if (setter) setter.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    await _exec(wc, js);
  },

  async click(selector) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var sel = ${JSON.stringify(selector)};
      var el;
      try { el = document.querySelector(sel); } catch(e) {
        throw new Error('Invalid CSS selector: ' + sel + ' — use standard CSS only (no Playwright/jQuery extensions like :has-text)');
      }
      if (!el) throw new Error('No element found for: ' + sel);
      el.scrollIntoView({ block: 'center' });
      try { el.click(); } catch(_) {}
      return true;
    })();`;
    await _exec(wc, js);
    // Give the page up to 5s to settle if the click navigates
    await Promise.race([_waitForLoad(wc, 5000), new Promise(r => setTimeout(r, 250))]);
    return { url: wc.getURL() };
  },

  async clickText(text, { exact = false } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var wanted = normalizeText(${JSON.stringify(String(text || ''))});
      var exactOnly = ${exact ? 'true' : 'false'};
      if (!wanted) throw new Error('clickText requires non-empty text');
      var selectors = 'button, a[href], input[type="button"], input[type="submit"], input[type="reset"], summary, [role="button"], [role="link"], [aria-label]';
      var ranked = walkDocuments(4).filter(function(entry) { return entry.accessible; }).flatMap(function(entry) {
        return Array.from(entry.doc.querySelectorAll(selectors))
        .filter(isVisible)
        .map(function(el) {
          var best = { score: 0, text: '' };
          candidateTexts(el).forEach(function(candidate) {
            var normalized = normalizeText(candidate);
            var score = scoreText(wanted, normalized, exactOnly);
            if (score > best.score) best = { score: score, text: candidate };
          });
          if (best.score > 0) {
            if (el.matches('button, input[type="submit"], input[type="button"]')) best.score += 25;
            if (el.matches('[role="button"]')) best.score += 10;
            if (el.matches('a[href]')) best.score += 5;
          }
          return { el: el, framePath: entry.framePath, score: best.score, text: best.text };
        });
      })
        .filter(function(item) { return item.score > 0; })
        .sort(function(a, b) { return b.score - a.score; });
      if (!ranked.length) {
        var sample = walkDocuments(4).filter(function(entry) { return entry.accessible; }).flatMap(function(entry) {
          return Array.from(entry.doc.querySelectorAll(selectors))
            .filter(isVisible)
            .slice(0, 12)
            .map(function(el) { return candidateTexts(el)[0] || selectorHint(el) || el.tagName.toLowerCase(); });
        })
          .filter(Boolean);
        throw new Error('No clickable element matched text "' + ${JSON.stringify(String(text || ''))} + '". Visible candidates: ' + sample.join(' | '));
      }
      var chosen = ranked[0];
      var result = clickElement(chosen.el, chosen.framePath);
      result.matchedText = chosen.text || result.clickedText || '';
      result.score = chosen.score;
      return result;
    })();`;
    const result = await _exec(wc, js);
    await Promise.race([_waitForLoad(wc, 5000), new Promise(r => setTimeout(r, 250))]);
    return { url: wc.getURL(), ...(result || {}) };
  },

  async clickHandle(handle) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var el = getElementByHandle(${JSON.stringify(handle || '')});
      if (!el) throw new Error('No element found for handle');
      var parsed = parseHandle(${JSON.stringify(handle || '')}) || {};
      return clickElement(el, parsed.framePath || []);
    })();`;
    const result = await _exec(wc, js);
    await Promise.race([_waitForLoad(wc, 5000), new Promise(r => setTimeout(r, 250))]);
    return { url: wc.getURL(), ...(result || {}) };
  },

  async type(selector, text) {
    const wc = await _ensureBrowserTab();
    await _exec(wc, `(function(){var el = document.querySelector(${JSON.stringify(selector)}); if (el) el.focus();})();`);
    const str = String(text || '');
    for (const ch of str) {
      try { wc.sendInputEvent({ type: 'char', keyCode: ch }); } catch (_) {}
      await new Promise(r => setTimeout(r, 10));
    }
  },

  async pressKey(key) {
    const wc = await _ensureBrowserTab();
    try {
      wc.sendInputEvent({ type: 'keyDown', keyCode: key });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key });
    } catch (_) {}
  },

  async waitFor(selector, { timeout = 10000 } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `new Promise(function(resolve, reject){
      var sel = ${JSON.stringify(selector)};
      var start = Date.now();
      function tick(){
        var el = document.querySelector(sel);
        if (el) return resolve(true);
        if (Date.now() - start > ${Number(timeout) || 10000}) return reject(new Error('waitFor timeout: ' + sel));
        setTimeout(tick, 100);
      }
      tick();
    })`;
    await _exec(wc, js);
  },

  async screenshot() {
    const wc = await _ensureBrowserTab();
    const img = await wc.capturePage();
    const buf = img.toPNG();
    return { base64: buf.toString('base64'), mimeType: 'image/png' };
  },

  async evaluate(code) {
    const wc = await _ensureBrowserTab();
    const js = `(async function(){ try { var __r = await (async function(){ ${code} })(); return { ok: true, value: __r }; } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; } })();`;
    const r = await _exec(wc, js);
    if (r && r.ok === false) throw new Error(r.error || 'script error');
    return r && 'value' in r ? r.value : r;
  },

  async removeElement(selector, { all = false } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var sel = ${JSON.stringify(selector)};
      var nodes = ${all ? 'Array.from(document.querySelectorAll(sel))' : '[document.querySelector(sel)].filter(Boolean)'};
      var removed = 0;
      nodes.forEach(function(n){ if (n && n.parentNode) { n.parentNode.removeChild(n); removed++; } });
      return { removed: removed, matched: nodes.length };
    })();`;
    return await _exec(wc, js);
  },

  async setStyle(selector, styles, { all = false } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var sel = ${JSON.stringify(selector)};
      var styles = ${JSON.stringify(styles || {})};
      var nodes = ${all ? 'Array.from(document.querySelectorAll(sel))' : '[document.querySelector(sel)].filter(Boolean)'};
      if (!nodes.length) throw new Error('No element matched ' + sel);
      function toCamel(k){ return k.replace(/-([a-z])/g, function(_, c){ return c.toUpperCase(); }); }
      Object.keys(styles).forEach(function(key){
        var val = styles[key];
        nodes.forEach(function(n){ try { n.style[toCamel(key)] = val == null ? '' : String(val); } catch(_){} });
      });
      return { applied: Object.keys(styles).length, matched: nodes.length };
    })();`;
    return await _exec(wc, js);
  },

  async setAttribute(selector, name, value) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('No element matched ' + ${JSON.stringify(selector)});
      var v = ${JSON.stringify(value == null ? null : String(value))};
      if (v == null || v === '') el.removeAttribute(${JSON.stringify(name)});
      else el.setAttribute(${JSON.stringify(name)}, v);
      return { matched: 1 };
    })();`;
    return await _exec(wc, js);
  },

  async setText(selector, text) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('No element matched ' + ${JSON.stringify(selector)});
      el.textContent = ${JSON.stringify(String(text == null ? '' : text))};
      return { matched: 1 };
    })();`;
    return await _exec(wc, js);
  },

  async setHtml(selector, html) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('No element matched ' + ${JSON.stringify(selector)});
      el.innerHTML = ${JSON.stringify(String(html == null ? '' : html))};
      return { matched: 1 };
    })();`;
    return await _exec(wc, js);
  },

  async scrollTo(selector, { block = 'center' } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('No element matched ' + ${JSON.stringify(selector)});
      el.scrollIntoView({ behavior: 'smooth', block: ${JSON.stringify(block)} });
      return { matched: 1 };
    })();`;
    return await _exec(wc, js);
  },

  async getComputedStyle(selector, properties) {
    const wc = await _ensureBrowserTab();
    const defaults = [
      'color', 'background-color', 'background-image', 'font-family', 'font-size',
      'font-weight', 'line-height', 'letter-spacing', 'text-transform',
      'border-color', 'border-radius', 'box-shadow', 'opacity',
      'padding', 'margin', 'width', 'height', 'display', 'position',
    ];
    const props = (Array.isArray(properties) && properties.length) ? properties : defaults;
    const js = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('No element matched ' + ${JSON.stringify(selector)});
      var cs = getComputedStyle(el);
      var keys = ${JSON.stringify(props)};
      var out = {};
      keys.forEach(function(k){ try { out[k] = cs.getPropertyValue(k); } catch(_){} });
      return { properties: out };
    })();`;
    return await _exec(wc, js);
  },

  async readPage({ selector } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      var sel = ${JSON.stringify(selector || null)};
      var el = sel ? document.querySelector(sel) : document.body;
      if (!el) return { url: location.href, title: document.title, content: '' };
      var clone = el.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, svg').forEach(function(n){ n.remove(); });
      return { url: location.href, title: document.title, content: clone.innerText || clone.textContent || '' };
    })();`;
    return await _exec(wc, js);
  },

  async getPageSource() {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      return {
        url: location.href,
        title: document.title,
        html: document.documentElement ? document.documentElement.outerHTML : ''
      };
    })();`;
    return await _exec(wc, js);
  },

  async inspectDom({ limit = 120 } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var maxItems = Math.max(10, Math.min(Number(${Number(limit) || 120}) || 120, 400));
      var fieldSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select';
      var docs = walkDocuments(4);
      var frames = [];
      var fields = [];
      var forms = [];
      var interactives = [];
      docs.forEach(function(entry) {
        if (!entry.accessible) {
          frames.push({ framePath: entry.framePath, frameName: entry.frameName || null, frameSrc: entry.frameSrc || null, accessible: false });
          return;
        }
        var meta = getFrameMeta(entry.doc, entry.framePath);
        frames.push({ framePath: meta.framePath, frameName: meta.frameName, frameSrc: meta.frameSrc, accessible: true });
        fields = fields.concat(Array.from(entry.doc.querySelectorAll(fieldSelector)).slice(0, maxItems).map(function(el) { return describeField(el, entry.framePath); }));
        forms = forms.concat(Array.from(entry.doc.forms || []).slice(0, 20).map(function(form) { return describeForm(form, entry.framePath); }));
        interactives = interactives.concat(Array.from(entry.doc.querySelectorAll('button, a[href], input, textarea, select, summary, [role="button"], [role="link"]'))
          .filter(isVisible)
          .slice(0, maxItems)
          .map(function(el) { return describeInteractive(el, entry.framePath); }));
      });
      return {
        url: location.href,
        title: document.title,
        frames: frames,
        forms: forms.slice(0, maxItems),
        fields: fields.slice(0, maxItems),
        interactives: interactives.slice(0, maxItems)
      };
    })();`;
    return await _exec(wc, js);
  },

  async getForms({ limit = 50 } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var maxItems = Math.max(1, Math.min(Number(${Number(limit) || 50}) || 50, 100));
      var docs = walkDocuments(4);
      var forms = [];
      docs.forEach(function(entry) {
        if (!entry.accessible) return;
        forms = forms.concat(Array.from(entry.doc.forms || []).slice(0, maxItems).map(function(form) { return describeForm(form, entry.framePath); }));
      });
      return { url: location.href, title: document.title, forms: forms.slice(0, maxItems) };
    })();`;
    return await _exec(wc, js);
  },

  async listInteractive({ limit = 200, includeHidden = false, maxFrameDepth = 4, maxIframes = 100 } = {}) {
    const wc = await _ensureBrowserTab();
    const opts = {
      limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
      includeHidden: !!includeHidden,
      maxFrameDepth: Math.max(0, Math.min(Number(maxFrameDepth) || 4, 8)),
      maxIframes: Math.max(1, Math.min(Number(maxIframes) || 100, 500))
    };
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var opts = ${JSON.stringify(opts)};
      return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        elements: enumerateInteractive(opts)
      };
    })();`;
    return await _exec(wc, js);
  },

  async queryAll(selector) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var sel = ${JSON.stringify(selector)};
      var out = [];
      walkDocuments(4).forEach(function(entry) {
        if (!entry.accessible) return;
        var list; try { list = entry.doc.querySelectorAll(sel); } catch(e) { throw new Error('Invalid CSS selector: ' + sel); }
        Array.from(list).slice(0, 50).forEach(function(el){
          var desc = describeInteractive(el, entry.framePath);
          desc.placeholder = el.placeholder || null;
          out.push(desc);
        });
      });
      return out.slice(0, 50);
    })();`;
    const elements = await _exec(wc, js);
    return { elements };
  },

  async fillByLabel(label, value, { exact = false } = {}) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var wanted = normalizeText(${JSON.stringify(String(label || ''))});
      var nextValue = ${JSON.stringify(String(value == null ? '' : value))};
      var exactOnly = ${exact ? 'true' : 'false'};
      if (!wanted) throw new Error('fillByLabel requires a non-empty label');
      var selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select';
      var ranked = walkDocuments(4).filter(function(entry) { return entry.accessible; }).flatMap(function(entry) {
        return Array.from(entry.doc.querySelectorAll(selector))
        .filter(function(el) { return !el.disabled; })
        .map(function(el) {
          var best = { score: 0, text: '' };
          candidateTexts(el).forEach(function(candidate) {
            var normalized = normalizeText(candidate);
            var score = scoreText(wanted, normalized, exactOnly);
            if (score > best.score) best = { score: score, text: candidate };
          });
          if (best.score > 0 && isVisible(el)) best.score += 15;
          return { el: el, framePath: entry.framePath, score: best.score, text: best.text };
        });
      })
        .filter(function(item) { return item.score > 0; })
        .sort(function(a, b) { return b.score - a.score; });
      if (!ranked.length) {
        var sample = walkDocuments(4).filter(function(entry) { return entry.accessible; }).flatMap(function(entry) {
          return Array.from(entry.doc.querySelectorAll(selector))
            .slice(0, 15)
            .map(function(el) { return candidateTexts(el)[0] || selectorHint(el) || el.tagName.toLowerCase(); });
        })
          .filter(Boolean);
        throw new Error('No form field matched label "' + ${JSON.stringify(String(label || ''))} + '". Available fields: ' + sample.join(' | '));
      }
      var chosen = ranked[0];
      var result = assignElementValue(chosen.el, nextValue, chosen.framePath);
      result.matchedLabel = chosen.text || result.filledLabel || '';
      result.score = chosen.score;
      return result;
    })();`;
    return await _exec(wc, js);
  },

  async fillHandle(handle, value) {
    const wc = await _ensureBrowserTab();
    const js = `(function(){
      ${BROWSER_DOM_HELPERS}
      var el = getElementByHandle(${JSON.stringify(handle || '')});
      if (!el) throw new Error('No field found for handle');
      var parsed = parseHandle(${JSON.stringify(handle || '')}) || {};
      return assignElementValue(el, ${JSON.stringify(String(value == null ? '' : value))}, parsed.framePath || []);
    })();`;
    return await _exec(wc, js);
  },

  async getNetworkLog({ limit = 50 } = {}) {
    const wc = await _ensureBrowserTab();
    const state = await _ensureDebugger(wc).catch(() => _getDebugState(wc));
    const maxItems = Math.max(1, Math.min(Number(limit) || 50, MAX_BROWSER_NETWORK_EVENTS));
    return { events: state.events.slice(-maxItems) };
  },

  async getNetworkBody(requestId) {
    const wc = await _ensureBrowserTab();
    if (!requestId) throw new Error('requestId is required');
    const state = await _ensureDebugger(wc).catch(() => _getDebugState(wc));
    if (state.responseBodies.has(requestId)) return state.responseBodies.get(requestId);
    try {
      const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId });
      const meta = state.requests.get(requestId) || {};
      const text = body && body.body ? String(body.body) : '';
      const result = {
        requestId,
        url: meta.url || null,
        status: meta.status || null,
        mimeType: meta.mimeType || null,
        base64Encoded: !!(body && body.base64Encoded),
        body: text.slice(0, 20000),
        truncated: text.length > 20000,
      };
      state.responseBodies.set(requestId, result);
      return result;
    } catch (err) {
      throw new Error('No captured body for requestId: ' + requestId + ' (' + (err.message || err) + ')');
    }
  },

  async getConsoleLog({ limit = 50 } = {}) {
    const wc = await _ensureBrowserTab();
    const state = await _ensureDebugger(wc).catch(() => _getDebugState(wc));
    const maxItems = Math.max(1, Math.min(Number(limit) || 50, MAX_BROWSER_NETWORK_EVENTS));
    return { events: state.consoleEvents.slice(-maxItems) };
  },

  async getCookies() {
    const wc = _findWebviewContents();
    if (!wc) return { cookies: [] };
    try {
      const url = wc.getURL();
      const cookies = await wc.session.cookies.get(url && url !== 'about:blank' ? { url } : {});
      return { cookies };
    } catch (_) {
      return { cookies: [] };
    }
  },

  async setCookies(cookies) {
    const wc = await _ensureBrowserTab();
    for (const c of (cookies || [])) {
      try {
        // Electron's cookies.set wants a url field. Reconstruct from domain.
        const url = c.url || ((c.secure ? 'https://' : 'http://') + (c.domain || '').replace(/^\./, '') + (c.path || '/'));
        await wc.session.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expires || c.expirationDate,
          sameSite: c.sameSite ? String(c.sameSite).toLowerCase() : undefined,
        });
      } catch (_) { /* best effort */ }
    }
  },

  async getWatchdogEvents() {
    const wc = _findWebviewContents();
    if (!wc) return { popups: [], aboutBlank: [], downloads: [] };
    const state = _getDebugState(wc);
    return {
      popups: (state.popups || []).slice(),
      aboutBlank: (state.aboutBlank || []).slice(),
      downloads: (state.downloads || []).slice(),
    };
  },

  async close() {
    const wc = _findWebviewContents();
    if (wc) { try { await wc.loadURL('about:blank'); } catch (_) {} }
    _broadcastToRenderer({ type: 'closed' });
  },
};

  return {
    driver: internalWebviewDriver,
    ensureBrowserTab: _ensureBrowserTab,
    ensureDebugger: _ensureDebugger,
    preferLightColorScheme: _preferLightColorScheme,
    setWebviewContents(c) { _webviewContents = c; },
    clearWebviewContents(c) { if (_webviewContents === c) _webviewContents = null; },
  };
}

module.exports = { createWebviewDriver };
