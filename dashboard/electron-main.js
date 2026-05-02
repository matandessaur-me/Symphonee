/**
 * Electron main process — wraps the HTTP+WS server in a desktop window.
 */
const { app, BrowserWindow, nativeImage, dialog, screen, shell, webContents: webContentsNS, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.ELECTRON = '1';

const PORT = 3800;
const HOST = '127.0.0.1';

let win = null;
let splashShownAt = 0;
const SPLASH_MIN_MS = 1500;

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
  try { if (win && !win.isDestroyed()) win.webContents.send('browser-agent', msg); } catch (_) {}
}

async function _ensureBrowserTab() {
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

const BROWSER_DOM_HELPERS = `
function normalizeText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
}
function cleanText(value, maxLen) {
  var text = String(value || '').replace(/\\s+/g, ' ').trim();
  if (!maxLen || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}
function safeCssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, function(ch) {
    return '\\\\' + ch;
  });
}
function isVisible(el) {
  if (!el) return false;
  var win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
  var style = win.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  var rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function getFrameElements(doc) {
  return Array.from(doc.querySelectorAll('iframe, frame'));
}
function getDocumentByFramePath(framePath) {
  var doc = document;
  for (var i = 0; i < (framePath || []).length; i++) {
    var idx = framePath[i];
    var frames = getFrameElements(doc);
    var frameEl = frames[idx];
    if (!frameEl) return null;
    try {
      doc = frameEl.contentDocument;
    } catch (_) {
      return null;
    }
    if (!doc) return null;
  }
  return doc;
}
function getFrameMeta(doc, framePath) {
  if (!framePath || !framePath.length) return { framePath: [], frameName: null, frameSrc: location.href, accessible: true };
  var parentDoc = document;
  var frameEl = null;
  for (var i = 0; i < framePath.length; i++) {
    var frames = getFrameElements(parentDoc);
    var candidate = frames[framePath[i]];
    if (!candidate) break;
    frameEl = candidate;
    try { parentDoc = candidate.contentDocument; } catch (_) { break; }
  }
  return {
    framePath: framePath.slice(),
    frameName: frameEl ? (frameEl.name || frameEl.id || null) : null,
    frameSrc: frameEl ? (frameEl.getAttribute('src') || null) : null,
    accessible: !!(frameEl && frameEl.contentDocument)
  };
}
function walkDocuments(maxDepth) {
  maxDepth = Math.max(0, Math.min(maxDepth || 4, 8));
  var out = [];
  function visit(doc, framePath, depth) {
    out.push({ doc: doc, framePath: framePath.slice(), accessible: true });
    if (depth >= maxDepth) return;
    getFrameElements(doc).forEach(function(frameEl, idx) {
      var nextPath = framePath.concat(idx);
      try {
        if (frameEl.contentDocument) visit(frameEl.contentDocument, nextPath, depth + 1);
        else out.push({ framePath: nextPath, accessible: false, frameName: frameEl.name || frameEl.id || null, frameSrc: frameEl.getAttribute('src') || null });
      } catch (_) {
        out.push({ framePath: nextPath, accessible: false, frameName: frameEl.name || frameEl.id || null, frameSrc: frameEl.getAttribute('src') || null });
      }
    });
  }
  visit(document, [], 0);
  return out;
}
function labelsFor(el) {
  var doc = el && el.ownerDocument ? el.ownerDocument : document;
  var labels = [];
  try {
    if (el.labels && el.labels.length) {
      labels = labels.concat(Array.from(el.labels).map(function(label) { return cleanText(label.innerText || label.textContent || '', 160); }));
    }
  } catch (_) {}
  if (el.id) {
    try {
      labels = labels.concat(Array.from(doc.querySelectorAll('label[for="' + safeCssEscape(el.id) + '"]')).map(function(label) {
        return cleanText(label.innerText || label.textContent || '', 160);
      }));
    } catch (_) {}
  }
  return Array.from(new Set(labels.filter(Boolean)));
}
function selectorHint(el) {
  if (!el || !el.tagName) return null;
  var tag = el.tagName.toLowerCase();
  if (el.id) return '#' + el.id;
  if (el.name) return tag + '[name="' + el.name + '"]';
  var type = el.getAttribute && el.getAttribute('type');
  if (type) return tag + '[type="' + type + '"]';
  return tag;
}
function cssPath(el) {
  if (!el || !el.tagName) return null;
  if (el.id) return '#' + safeCssEscape(el.id);
  var parts = [];
  var cur = el;
  while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
    var tag = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift('#' + safeCssEscape(cur.id));
      break;
    }
    var part = tag;
    var parent = cur.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(node) { return node.tagName === cur.tagName; });
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}
function makeHandle(framePath, element) {
  return JSON.stringify({ framePath: framePath || [], cssPath: cssPath(element) });
}
function parseHandle(handle) {
  if (!handle) return null;
  if (typeof handle === 'object') return handle;
  try { return JSON.parse(String(handle)); } catch (_) { return null; }
}
function getElementByHandle(handle) {
  var parsed = parseHandle(handle);
  if (!parsed || !parsed.cssPath) return null;
  var doc = getDocumentByFramePath(parsed.framePath || []);
  if (!doc) return null;
  try { return doc.querySelector(parsed.cssPath); } catch (_) { return null; }
}
function candidateTexts(el) {
  var texts = [];
  texts.push(cleanText(el.innerText || el.textContent || '', 200));
  texts.push(cleanText(el.value || '', 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('aria-label'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('placeholder'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('title'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('alt'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('name'), 200));
  texts.push(cleanText(el.id || '', 200));
  labelsFor(el).forEach(function(label) { texts.push(label); });
  return Array.from(new Set(texts.filter(Boolean)));
}
function scoreText(target, candidate, exact) {
  if (!candidate) return 0;
  if (candidate === target) return 500;
  if (exact) return 0;
  if (candidate.startsWith(target)) return 350;
  if (candidate.indexOf(target) >= 0) return 300;
  if (target.indexOf(candidate) >= 0) return 120;
  return 0;
}
function clickElement(el, framePath) {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  try { el.focus({ preventScroll: true }); } catch (_) {}
  var doc = el.ownerDocument || document;
  var win = doc.defaultView || window;
  var rect = el.getBoundingClientRect();
  var x = rect.left + Math.max(1, Math.min(rect.width / 2, rect.width - 1));
  var y = rect.top + Math.max(1, Math.min(rect.height / 2, rect.height - 1));
  var hit = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
  var target = hit && (hit === el || el.contains(hit)) ? hit : el;
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(type) {
    try {
      target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y, button: 0 }));
    } catch (_) {}
  });
  try { target.click(); } catch (_) {}
  return {
    clickedText: cleanText(target.innerText || target.textContent || target.value || target.getAttribute('aria-label') || '', 200),
    selectorHint: selectorHint(target),
    handle: makeHandle(framePath || [], target)
  };
}
function assignElementValue(el, value, framePath) {
  var nextValue = String(value == null ? '' : value);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  try { el.focus({ preventScroll: true }); } catch (_) {}
  if (el.tagName === 'SELECT') {
    var wanted = normalizeText(nextValue);
    var option = Array.from(el.options || []).find(function(opt) {
      return normalizeText(opt.text) === wanted || normalizeText(opt.value) === wanted;
    }) || Array.from(el.options || []).find(function(opt) {
      return normalizeText(opt.text).indexOf(wanted) >= 0 || normalizeText(opt.value).indexOf(wanted) >= 0;
    });
    el.value = option ? option.value : nextValue;
  } else {
    var proto = Object.getPrototypeOf(el);
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, nextValue);
    else el.value = nextValue;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    filledLabel: labelsFor(el)[0] || cleanText(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '', 160),
    selectorHint: selectorHint(el),
    handle: makeHandle(framePath || [], el)
  };
}
function describeField(el, framePath) {
  var meta = getFrameMeta(el.ownerDocument, framePath || []);
  return {
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    name: el.name || null,
    id: el.id || null,
    role: el.getAttribute && el.getAttribute('role') || null,
    placeholder: cleanText(el.getAttribute && el.getAttribute('placeholder'), 120),
    ariaLabel: cleanText(el.getAttribute && el.getAttribute('aria-label'), 120),
    labels: labelsFor(el),
    valueText: (el.tagName === 'SELECT')
      ? cleanText(((el.selectedOptions && el.selectedOptions[0]) ? el.selectedOptions[0].text : ''), 120)
      : cleanText((el.type === 'password' ? '' : (el.value || '')), 120),
    visible: isVisible(el),
    disabled: !!el.disabled,
    selectorHint: selectorHint(el),
    cssPath: cssPath(el),
    handle: makeHandle(framePath || [], el),
    framePath: meta.framePath,
    frameName: meta.frameName,
    frameSrc: meta.frameSrc
  };
}
function describeInteractive(el, framePath) {
  var desc = describeField(el, framePath || []);
  desc.text = cleanText(el.innerText || el.textContent || el.value || '', 160);
  desc.href = cleanText(el.getAttribute && el.getAttribute('href'), 240);
  return desc;
}
function describeForm(form, framePath) {
  var meta = getFrameMeta(form.ownerDocument, framePath || []);
  var fieldSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select';
  return {
    id: form.id || null,
    name: form.name || null,
    method: form.method || 'get',
    action: form.action || form.ownerDocument.location.href,
    cssPath: cssPath(form),
    handle: makeHandle(framePath || [], form),
    framePath: meta.framePath,
    frameName: meta.frameName,
    frameSrc: meta.frameSrc,
    fields: Array.from(form.querySelectorAll(fieldSelector)).slice(0, 40).map(function(el) { return describeField(el, framePath || []); }),
    submitControls: Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]')).slice(0, 10).map(function(el) { return describeInteractive(el, framePath || []); })
  };
}
function _hasFormControlDescendant(el, maxDepth) {
  if (!el || maxDepth <= 0) return false;
  var children = el.children ? Array.from(el.children) : [];
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c.nodeType !== 1) continue;
    var tag = (c.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
    if (_hasFormControlDescendant(c, maxDepth - 1)) return true;
  }
  return false;
}
function hasJsClickListener(el) {
  if (!el || el.nodeType !== 1) return false;
  if (typeof el.onclick === 'function') return true;
  if (!el.attributes) return false;
  for (var i = 0; i < el.attributes.length; i++) {
    var name = el.attributes[i].name;
    if (name === '@click' || name === 'v-on:click' || name === '(click)') return true;
    if (name === 'data-onclick' || name === 'data-action' || name === 'data-click') return true;
    if (name.indexOf('data-action-') === 0) return true;
  }
  return false;
}
function isInteractive(el) {
  if (!el || el.nodeType !== 1) return false;
  var tag = (el.tagName || '').toLowerCase();
  if (tag === 'html' || tag === 'body') return false;
  if (hasJsClickListener(el)) return true;
  if (tag === 'iframe' || tag === 'frame') {
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (rect && rect.width > 100 && rect.height > 100) return true;
    return false;
  }
  if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'input') {
    var t = (el.type || '').toLowerCase();
    if (t !== 'hidden') return true;
  }
  if (tag === 'summary' || tag === 'details') return true;
  if (tag === 'label') {
    if (el.attributes && el.getAttribute('for')) return false;
    if (_hasFormControlDescendant(el, 2)) return true;
  }
  if (tag === 'span' && _hasFormControlDescendant(el, 2)) return true;
  var role = el.getAttribute && el.getAttribute('role');
  if (role) {
    var ROLES = { button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, option: 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1 };
    if (ROLES[role]) return true;
  }
  if (el.isContentEditable) return true;
  if (el.attributes) {
    var classStr = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
    var idStr = (el.id || '').toLowerCase();
    var SEARCH_HINTS = ['search', 'magnify', 'glass', 'clickable', 'btn', 'button'];
    for (var j = 0; j < SEARCH_HINTS.length; j++) {
      if (classStr.indexOf(SEARCH_HINTS[j]) >= 0 || idStr.indexOf(SEARCH_HINTS[j]) >= 0) return true;
    }
  }
  try {
    var win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    var cs = win.getComputedStyle(el);
    if (cs && cs.cursor === 'pointer') return true;
  } catch (_) {}
  return false;
}
function isOccluded(el) {
  try {
    var doc = el.ownerDocument;
    if (!doc || !doc.elementFromPoint) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var hit = doc.elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === el) return false;
    if (el.contains(hit) || hit.contains(el)) return false;
    return true;
  } catch (_) { return false; }
}
function pagesAwayFromViewport(el) {
  try {
    var win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    var vh = win.innerHeight || 768;
    if (vh <= 0) return 0;
    var rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= vh) return 0;
    if (rect.bottom < 0) return Math.round((rect.bottom / vh) * 10) / 10;
    if (rect.top > vh) return Math.round(((rect.top - vh) / vh) * 10) / 10;
    return 0;
  } catch (_) { return 0; }
}
function enumerateInteractive(opts) {
  opts = opts || {};
  var maxDepth = opts.maxFrameDepth || 4;
  var maxIframes = opts.maxIframes || 100;
  var includeHidden = !!opts.includeHidden;
  var limit = opts.limit || 200;
  var iframesSeen = 0;
  var out = [];
  walkDocuments(maxDepth).forEach(function(entry) {
    if (!entry.accessible) return;
    if (iframesSeen++ > maxIframes) return;
    var nodes = Array.from(entry.doc.querySelectorAll('*'));
    for (var i = 0; i < nodes.length && out.length < limit; i++) {
      var el = nodes[i];
      if (!isInteractive(el)) continue;
      var visible = isVisible(el);
      if (!visible && !includeHidden) {
        var pagesDown = pagesAwayFromViewport(el);
        if (Math.abs(pagesDown) < 0.05) continue;
        out.push({
          handle: makeHandle(entry.framePath, el),
          tag: el.tagName.toLowerCase(),
          text: cleanText(el.innerText || el.textContent || el.value || el.getAttribute && el.getAttribute('aria-label') || '', 80),
          visible: false,
          hiddenReason: 'offscreen',
          pagesAway: pagesDown,
          framePath: entry.framePath
        });
        continue;
      }
      out.push({
        handle: makeHandle(entry.framePath, el),
        tag: el.tagName.toLowerCase(),
        text: cleanText(el.innerText || el.textContent || el.value || el.getAttribute && el.getAttribute('aria-label') || '', 80),
        href: el.getAttribute && el.getAttribute('href') || null,
        type: el.type || null,
        role: el.getAttribute && el.getAttribute('role') || null,
        visible: visible,
        hiddenReason: visible ? null : 'css',
        occluded: visible ? isOccluded(el) : false,
        framePath: entry.framePath
      });
    }
  });
  return out;
}
`;

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

// ── Display preference persistence ──────────────────────────────────────
const displayPrefPath = path.join(__dirname, '..', 'config', 'display-pref.json');

function loadDisplayPref() {
  try {
    if (fs.existsSync(displayPrefPath)) {
      return JSON.parse(fs.readFileSync(displayPrefPath, 'utf8'));
    }
  } catch (_) { /* ignore corrupt file */ }
  return null;
}

function saveDisplayPref(displayId) {
  try {
    fs.writeFileSync(displayPrefPath, JSON.stringify({ displayId }), 'utf8');
  } catch (_) { /* best effort */ }
}

/**
 * Kill anything holding port 3800 and/or any stale Electron instances.
 * Returns true if something was killed.
 */
function killStaleProcesses() {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  const myPid = process.pid;
  const pidsToKill = new Set();

  // Strategy 1: find PIDs holding port 3800 via netstat
  try {
    const out = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/\s(\d+)$/);
      if (m && Number(m[1]) !== myPid) pidsToKill.add(m[1]);
    }
  } catch (_) { /* no listeners on port -- fine */ }

  // Strategy 2: find other Electron instances by exe name
  try {
    const exeName = path.basename(process.execPath);
    const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/^"[^"]+","(\d+)"/);
      if (m && Number(m[1]) !== myPid) pidsToKill.add(m[1]);
    }
  } catch (_) {}

  if (pidsToKill.size) {
    try {
      execSync(`taskkill /F ${[...pidsToKill].map(p => '/PID ' + p).join(' ')}`, { encoding: 'utf8', timeout: 5000 });
      console.log('Killed stale process(es):', [...pidsToKill].join(', '));
      return true;
    } catch (_) {}
  }
  return false;
}

// ── GPU + window-survival switches (minimal, targeted) ──────────────────────
// Earlier versions of this file flipped on every GPU-acceleration knob in
// Chromium. On Intel UHD that over-subscribed the iGPU — the terminal's
// xterm-webgl renderer would die ('unavailable' card), Canvas2D paths
// were forced through a struggling iGPU instead of the CPU, and
// background apps competed with the foreground for the same compositor.
//
// Stripped back to ONLY what the Mind 2D / 3D graph actually needs (the
// WebGL it requests is GPU-accelerated by default in Electron — no flag
// needed for that), plus the focus-return survival flags that the user
// explicitly asked for.
//
// What we KEEP:
//   - ignore-gpu-blocklist         : without this, Chromium silently
//                                    drops to software rendering on some
//                                    Intel iGPU drivers, killing the 3D
//                                    graph's WebGL path. The Mind graph
//                                    is the one place GPU is essential.
//   - disable-renderer-backgrounding +
//     disable-backgrounding-occluded-windows
//                                  : keep Symphonee's compositor active
//                                    when the window is occluded/inactive
//                                    so alt-tab back doesn't show stale
//                                    or torn-down layers.
//
// What we DROPPED (and why):
//   - enable-gpu-rasterization     : forced ALL Canvas2D through the GPU;
//                                    Chromium's auto-decision is fine.
//   - enable-accelerated-2d-canvas : same reason.
//   - enable-zero-copy             : WebGL texture upload optimization
//                                    that's only useful when the iGPU is
//                                    NOT the bottleneck. On Intel UHD it
//                                    just adds memory pressure.
//   - use-angle=gl                 : forced the OpenGL backend on Windows;
//                                    D3D11 (the default) is actually faster
//                                    on Intel iGPUs.
//   - enable-features=WebGPU,SharedArrayBuffer : nothing in Symphonee
//                                    uses WebGPU.
//   - enable-accelerated-video-decode : irrelevant.
//   - disable-background-timer-throttling : was making background tabs
//                                    fight for CPU; the renderer-bg flag
//                                    above is sufficient.
//   - disable-features=CalculateNativeWinOcclusion : same.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance holds the lock. Check if it's actually alive.
  const http = require('http');
  const req = http.get(`http://${HOST}:${PORT}/api/ui/context`, { timeout: 2000 }, (res) => {
    // Server is alive -- the real instance is running, just focus it
    console.log('Another instance is running -- focusing it.');
    res.resume();
    res.on('end', () => { app.quit(); });
  });
  req.on('error', () => {
    // Server not responding -- zombie. Kill everything and relaunch.
    console.log('Stale instance detected -- killing and relaunching...');
    killStaleProcesses();
    setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('Stale instance detected (timeout) -- killing and relaunching...');
    killStaleProcesses();
    setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
  });
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.setAlwaysOnTop(true);
      win.focus();
      win.setAlwaysOnTop(false);
    }
  });

  // Track any <webview> webContents so the browser-agent driver can find them.
  // Browser appearance is handled by the Browser tab itself; do not inject a
  // global light/dark override here or remote sites will render incorrectly.
  app.on('web-contents-created', (_event, contents) => {
    try {
      if (!contents || typeof contents.getType !== 'function') return;
      if (contents.getType() === 'webview') {
        _webviewContents = contents;
        _preferLightColorScheme(contents);
        contents.on('did-start-navigation', () => { _preferLightColorScheme(contents); });
        contents.on('destroyed', () => { if (_webviewContents === contents) _webviewContents = null; });
      }
    } catch (_) {}
  });

  app.whenReady().then(async () => {
    // Create the main window FIRST and point it at splash.html on disk so
    // the user sees the brand mark immediately. We swap to the dashboard
    // URL once the HTTP server is listening (with a CSS fade in splash.html).
    {
      const displays = screen.getAllDisplays();
      const pref = loadDisplayPref();
      const preferredDisplay = pref
        ? displays.find(d => d.id === pref.displayId) || screen.getPrimaryDisplay()
        : screen.getPrimaryDisplay();
      const { x, y, width, height } = preferredDisplay.workArea;
      win = new BrowserWindow({
        x, y, width, height,
        autoHideMenuBar: true,
        title: 'Symphonee',
        backgroundColor: '#1a1a1a',
        show: false,
        icon: nativeImage.createFromPath(
          fs.existsSync(path.join(__dirname, 'public', 'icon.ico'))
            ? path.join(__dirname, 'public', 'icon.ico')
            : path.join(__dirname, 'public', 'icon.png')
        ),
        titleBarStyle: 'hidden',
        maximizable: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          // Explicit GPU paths for the 2D / 3D Mind graph views. webgl + offscreen
          // false make sure the renderer process draws to an on-screen surface
          // backed by the GPU compositor instead of a software canvas.
          webgl: true,
          offscreen: false,
          backgroundThrottling: false,
        },
      });
      win.maximize();
      win.once('ready-to-show', () => {
        try { win.show(); splashShownAt = Date.now(); } catch (_) {}
      });
      win.on('closed', () => { win = null; });
      try { win.loadFile(path.join(__dirname, 'public', 'splash.html')); } catch (_) {}
    }

    // Wipe the renderer's HTTP cache on every launch. Electron's session
    // cache survives across app restarts and was serving stale index.html /
    // mind-ui.js even after the server had updated them, which broke the
    // dashboard repeatedly during development. Localhost-only assets so
    // the cache buys us nothing.
    try {
      const { session } = require('electron');
      await session.defaultSession.clearCache();
    } catch (e) { console.log('  cache clear skipped:', e.message); }
    console.log('Electron ready, loading server...');
    let server, startServer, addRoute;
    try {
      ({ server, startServer, addRoute } = require('./server'));
    } catch (err) {
      dialog.showErrorBox('Symphonee - Startup Error',
        `Failed to load server modules.\n\n${err.message}\n\nTry running "npm install" in the dashboard folder.`);
      app.quit();
      return;
    }

    // Install the in-app webview driver so /api/browser/* routes drive the
    // Browser tab instead of launching a system Edge/Chrome window. Safe to
    // call even if browser-agent was skipped (setter is a no-op then).
    try {
      const { setActiveBrowserDriver } = require('./browser-agent');
      setActiveBrowserDriver(internalWebviewDriver);
      console.log('  Browser automation bound to in-app webview');
    } catch (err) {
      console.log('  Browser driver install skipped:', err.message);
    }

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} in use -- killing stale processes and relaunching...`);
        if (killStaleProcesses()) {
          setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
          return;
        }
        dialog.showErrorBox('Symphonee', `Port ${PORT} is already in use.\n\nClose any other Symphonee instances and try again.`);
      } else {
        dialog.showErrorBox('Server Error', err.message);
      }
      app.quit();
    });

    // ── Switch-screen API (Electron only) ──────────────────────────────
    addRoute('POST', '/api/switch-screen', (req, res) => {
      if (!win) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No window' }));
      }
      const displays = screen.getAllDisplays();
      if (displays.length < 2) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ switched: false, reason: 'Only one display' }));
      }
      const currentBounds = win.getBounds();
      const currentDisplay = screen.getDisplayMatching(currentBounds);
      const currentIdx = displays.findIndex(d => d.id === currentDisplay.id);
      const nextIdx = (currentIdx + 1) % displays.length;
      const next = displays[nextIdx];
      const { x, y } = next.workArea;
      // Move to the target display first, then maximize to fill it
      win.setBounds({ x, y, width: 800, height: 600 });
      win.maximize();
      saveDisplayPref(next.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ switched: true, display: nextIdx + 1, total: displays.length }));
    });

    addRoute('GET', '/api/screen-info', (req, res) => {
      const displays = screen.getAllDisplays();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: displays.length }));
    });

    // ── Check for updates (git fetch + compare) ───────────────────────
    addRoute('GET', '/api/check-updates', (req, res) => {
      const { execSync } = require('child_process');
      const repoRoot = path.resolve(__dirname, '..');
      try {
        // Fetch latest from origin (quiet, no output)
        execSync('git fetch origin', { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
        // Always compare against origin/master regardless of current branch
        const localHead = execSync('git rev-parse master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        const remoteHead = execSync('git rev-parse origin/master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        // Count commits master is behind origin/master
        const behind = execSync('git rev-list --count master..origin/master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        const behindCount = parseInt(behind, 10) || 0;
        // Get short summary of what's new
        let summary = '';
        if (behindCount > 0) {
          summary = execSync('git log --oneline master..origin/master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        }
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updateAvailable: behindCount > 0, behind: behindCount, branch, summary }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updateAvailable: false, error: err.message }));
      }
    });

    // ── Apply update (stash + fetch + pull + install + relaunch) ───────
    addRoute('POST', '/api/update-app', (req, res) => {
      const { execSync } = require('child_process');
      const repoRoot = path.resolve(__dirname, '..');
      try {
        // Stash any local changes (safe to ignore if nothing to stash)
        try { execSync('git stash --include-untracked', { cwd: repoRoot, encoding: 'utf8', timeout: 15000 }); } catch (_) {}
        // Fetch, checkout master, pull, install
        execSync('git checkout master', { cwd: repoRoot, encoding: 'utf8', timeout: 10000 });
        execSync('git fetch origin', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        execSync('git pull', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        execSync('npm install', { cwd: repoRoot, encoding: 'utf8', timeout: 120000 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'updated' }));
        setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err.message || '').substring(0, 500) }));
      }
    });

    // ── Restart app (relaunch Electron) ───────────────────────────────
    addRoute('POST', '/api/restart-app', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
    });

    // ── Browse for folder (native OS dialog) ────────────────────────────
    addRoute('POST', '/api/browse-folder', async (req, res) => {
      if (!win) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No window' }));
      }
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select Repository Folder',
      });
      if (result.canceled || !result.filePaths.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ canceled: true }));
      }
      const folderPath = result.filePaths[0];
      const folderName = path.basename(folderPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ canceled: false, path: folderPath, name: folderName }));
    });

    // ── Window controls (custom title bar) ───────────────────────────
    addRoute('POST', '/api/window/minimize', (req, res) => {
      if (win) win.minimize();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    addRoute('POST', '/api/window/close', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      if (win) win.close();
    });

    // ── Browser emulation + issues (CDP-backed) ──────────────────────────
    const _reBody = (req) => new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c.toString(); });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
      req.on('error', () => resolve({}));
    });
    const _reJson = (res, code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // In-memory store of observed issues per webContents.
    const _browserIssueState = new WeakMap();
    function _getIssueState(wc) {
      let s = _browserIssueState.get(wc);
      if (!s) {
        s = { listening: false, issues: [] };
        _browserIssueState.set(wc, s);
      }
      return s;
    }

    addRoute('POST', '/api/browser/emulate/device', async (req, res) => {
      try {
        const body = await _reBody(req);
        const wc = await _ensureBrowserTab();
        await _ensureDebugger(wc);
        if (body.reset) {
          await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
          await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
          return _reJson(res, 200, { ok: true, reset: true });
        }
        const width = Math.max(50, Math.min(4096, Number(body.width) || 390));
        const height = Math.max(50, Math.min(4096, Number(body.height) || 844));
        const dpr = Math.max(0.5, Math.min(5, Number(body.deviceScaleFactor) || 2));
        const mobile = body.mobile !== false;
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: dpr, mobile,
        });
        await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: !!body.touch || mobile,
        });
        _reJson(res, 200, { ok: true, width, height, dpr, mobile });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/emulate/media', async (req, res) => {
      try {
        const body = await _reBody(req);
        const wc = await _ensureBrowserTab();
        await _ensureDebugger(wc);
        const features = [];
        if (body.colorScheme) features.push({ name: 'prefers-color-scheme', value: body.colorScheme });
        if (body.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: body.reducedMotion });
        if (body.contrast) features.push({ name: 'prefers-contrast', value: body.contrast });
        if (body.forcedColors) features.push({ name: 'forced-colors', value: body.forcedColors });
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
          media: body.media || '',
          features,
        });
        _reJson(res, 200, { ok: true, features });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/emulate/throttle', async (req, res) => {
      try {
        const body = await _reBody(req);
        const wc = await _ensureBrowserTab();
        await _ensureDebugger(wc);
        if (body.cpuRate != null) {
          await wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: Math.max(1, Math.min(20, Number(body.cpuRate) || 1)) });
        }
        if (body.network) {
          const presets = {
            'offline':      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
            'slow-3g':      { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
            'fast-3g':      { offline: false, latency: 150, downloadThroughput: 180 * 1024, uploadThroughput: 85 * 1024 },
            '4g':           { offline: false, latency: 40, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 1.5 * 1024 * 1024 },
            'no-throttle':  { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
          };
          const p = presets[body.network] || presets['no-throttle'];
          await wc.debugger.sendCommand('Network.enable').catch(() => {});
          await wc.debugger.sendCommand('Network.emulateNetworkConditions', p);
        }
        _reJson(res, 200, { ok: true });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/issues/start', async (req, res) => {
      try {
        const wc = await _ensureBrowserTab();
        await _ensureDebugger(wc);
        const state = _getIssueState(wc);
        if (!state.listening) {
          wc.debugger.on('message', (_event, method, params) => {
            if (method === 'Audits.issueAdded' && params && params.issue) {
              state.issues.push({ at: Date.now(), ...params.issue });
              if (state.issues.length > 500) state.issues.splice(0, state.issues.length - 500);
            }
          });
          state.listening = true;
        }
        await wc.debugger.sendCommand('Audits.enable').catch(() => {});
        _reJson(res, 200, { ok: true });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('GET', '/api/browser/issues', async (req, res) => {
      try {
        const wc = await _ensureBrowserTab();
        const state = _getIssueState(wc);
        _reJson(res, 200, { issues: state.issues.slice(-200), count: state.issues.length });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/issues/clear', async (req, res) => {
      try {
        const wc = await _ensureBrowserTab();
        const state = _getIssueState(wc);
        state.issues = [];
        _reJson(res, 200, { ok: true });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    server.on('listening', () => {
      console.log('Server listening, swapping splash to dashboard...');
      const appUrl = `http://${HOST}:${PORT}`;

      // The main window already exists and is showing splash.html. Wait for
      // the splash minimum, then navigate the same window to the dashboard.
      const swap = () => {
        if (!win || win.isDestroyed()) return;
        try { win.loadURL(appUrl); } catch (_) {}
      };
      const elapsed = splashShownAt ? Date.now() - splashShownAt : 0;
      const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
      setTimeout(swap, remaining);

      // Re-attach the link/navigation handlers on the live window.
      if (win && !win.isDestroyed()) {
        win.webContents.setWindowOpenHandler(({ url }) => {
          if (url.startsWith(appUrl)) return { action: 'allow' };
          shell.openExternal(url);
          return { action: 'deny' };
        });
        win.webContents.on('will-navigate', (event, url) => {
          // Allow internal navigations (splash -> dashboard) and our own URL.
          if (url.startsWith(appUrl) || url.startsWith('file://')) return;
          event.preventDefault();
          shell.openExternal(url);
        });

        // ── Force whole-window repaint on focus return ───────────────────
        // User-reported bug: alt-tab back into Symphonee and the sidebars
        // and header stay pure black until the user clicks something. The
        // 3D canvas / xterm both paint themselves via rAF so they show up,
        // but static HTML layers (sidebars, tab bar, top header) wait for
        // a layout invalidation that never arrives — the OS compositor
        // is still presenting the pre-blur cached layer.
        //
        // webContents.invalidate() forces Chromium to mark the entire
        // page dirty and recomposite. Wiring it to focus + show + restore
        // covers every "comes back into view" path:
        //   - focus    : alt-tab, click on the window
        //   - show     : workspace switch, app switcher
        //   - restore  : un-minimize
        const repaintWindow = () => {
          try { if (win && !win.isDestroyed()) win.webContents.invalidate(); } catch (_) {}
        };
        win.on('focus', repaintWindow);
        win.on('show', repaintWindow);
        win.on('restore', repaintWindow);
      }
    });

    // ── Apps agent panic hotkey ────────────────────────────────────────
    // Ctrl+Alt+Shift+X from anywhere on the desktop tears down every live
    // Apps session and kills any in-flight input emission. This is the
    // emergency stop for pixel-level automation.
    try {
      const ok = globalShortcut.register('CommandOrControl+Alt+Shift+X', () => {
        try {
          const http = require('http');
          const req = http.request({
            hostname: '127.0.0.1', port: PORT, path: '/api/apps/panic', method: 'POST',
            headers: { 'content-length': 0 },
          }, (r) => { r.on('data', () => {}); r.on('end', () => {}); });
          req.on('error', () => {});
          req.end();
        } catch (_) {}
        try {
          if (win && !win.isDestroyed()) {
            win.show();
            win.focus();
            win.webContents.send('apps-panic-hotkey');
          }
        } catch (_) {}
      });
      if (!ok) console.warn('  Apps panic hotkey (Ctrl+Alt+Shift+X) not registered');
      else console.log('  Apps panic hotkey registered: Ctrl+Alt+Shift+X');
    } catch (e) {
      console.warn('  Apps panic hotkey failed:', e.message);
    }

    startServer();
  }).catch((err) => {
    dialog.showErrorBox('Symphonee - Startup Error',
      `An unexpected error occurred during startup.\n\n${err.message}`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (_) {}
  });
}
