// browser -- the in-app browser automation subsystem: the embedded webview
// (navigation/zoom/appearance), the in-app agent panel, the inspect/patch/
// emulate/audit/reader/brand tools, and stagehand screencast. Bundled from the
// former parts/browser.js + browser-tools.js + browser-views.js -- one tightly-
// coupled subsystem (~40 internal cross-calls + shared _browserAgentState/
// _inappToolsState/_emulateState/... ), now a single esbuild IIFE so those
// resolve internally; only the ~52 externally-reached functions are on window.
// Reads `state` + registers listeners at load -> after app.js. esc/toast/etc
// resolve via window. (May later be split into real sub-modules.) See ARCHITECTURE.md.

// ── In-app browser tab ─────────────────────────────────────────────────
// Uses Electron's <webview> tag so we can render arbitrary URLs inside a
// Symphonee tab. Gracefully degrades to an iframe when webview is unavailable
// (e.g. when the app is loaded in a regular browser for dev).
function _getInappWebview() {
  return document.querySelector('#inappBrowserFrame webview, #inappBrowserFrame iframe');
}
state._inappBrowserZoomFactor = 1;
function _clampInappBrowserZoomFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(0.25, Math.round(n * 100) / 100));
}
function _formatInappBrowserZoom(factor) {
  return Math.round(_clampInappBrowserZoomFactor(factor) * 100) + '%';
}
function _syncInappBrowserZoomUi() {
  const label = document.getElementById('inappBrowserZoomValue');
  if (label) label.textContent = _formatInappBrowserZoom(state._inappBrowserZoomFactor);
}
function _applyInappBrowserZoom(view) {
  if (!view) return;
  const factor = _clampInappBrowserZoomFactor(state._inappBrowserZoomFactor);
  const tag = (view.tagName || '').toLowerCase();
  if (tag === 'webview') {
    try {
      view.setZoomFactor(factor);
    } catch (_) {}
  } else {
    view.style.transformOrigin = 'top left';
    if (Math.abs(factor - 1) < 0.001) {
      view.style.removeProperty('transform');
      view.style.removeProperty('width');
      view.style.removeProperty('height');
    } else {
      view.style.transform = `scale(${factor})`;
      view.style.width = `${100 / factor}%`;
      view.style.height = `${100 / factor}%`;
    }
  }
  _syncInappBrowserZoomUi();
}
function inappBrowserSetZoomFactor(nextFactor) {
  state._inappBrowserZoomFactor = _clampInappBrowserZoomFactor(nextFactor);
  _applyInappBrowserZoom(_getInappWebview());
}
function inappBrowserZoomIn() {
  inappBrowserSetZoomFactor(state._inappBrowserZoomFactor + 0.1);
}
function inappBrowserZoomOut() {
  inappBrowserSetZoomFactor(state._inappBrowserZoomFactor - 0.1);
}
function inappBrowserZoomReset() {
  inappBrowserSetZoomFactor(1);
}
function applyInappBrowserAppearance() {
  const view = _getInappWebview();
  if (!view) return;
  view.style.removeProperty('color-scheme');
  if (view.tagName.toLowerCase() !== 'webview') return;
  try {
    view.executeJavaScript(`(function(){
      try {
        var key = '__symphoneeForceLightScheme';
        if (window[key]) return true;
        var originalMatchMedia = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
        if (originalMatchMedia) {
          window.matchMedia = function(query) {
            var q = String(query || '').toLowerCase();
            var result = originalMatchMedia(query);
            if (q.indexOf('prefers-color-scheme') === -1) return result;
            return new Proxy(result, {
              get: function(target, prop) {
                if (prop === 'matches') {
                  if (q.indexOf('light') !== -1) return true;
                  if (q.indexOf('dark') !== -1) return false;
                }
                var value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
              }
            });
          };
        }
        if (document.documentElement && document.documentElement.style) {
          document.documentElement.style.setProperty('color-scheme', 'light', 'important');
        }
        window[key] = true;
        return true;
      } catch (_) {
        return false;
      }
    })();`, true).catch(() => {});
  } catch (_) {}
}
function _shortenBrowserText(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, Math.max(0, maxLen - 3)) + '...';
}
function _clearBrowserSelection() {
  _browserInspectState.selected = null;
  _renderBrowserSelection();
}
function _clearBrowserSelectionAndHighlight() {
  _clearBrowserSelection();
  const view = _getInappWebview();
  if (view && view.tagName.toLowerCase() === 'webview') {
    try {
      view.executeJavaScript("(function(){var k='__symphoneeInspectBridge';if(window[k]&&window[k].clearSelected)window[k].clearSelected();})();", true).catch(() => {});
    } catch (_) {}
  }
}
function _getBrowserAgentInput() {
  return document.getElementById('inappAgentInput');
}
function _autosizeAgentInput(el) {
  const input = el || _getBrowserAgentInput();
  if (!input) return;
  input.style.height = 'auto';
  const max = 220;
  const min = 40;
  input.style.height = Math.max(min, Math.min(input.scrollHeight, max)) + 'px';
}
const _FRIENDLY_TAGS = {
  a: 'link',
  button: 'button',
  img: 'image',
  svg: 'icon',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  input: 'input',
  textarea: 'text field',
  select: 'dropdown',
  form: 'form',
  label: 'label',
  nav: 'nav',
  header: 'header',
  footer: 'footer',
  main: 'main',
  section: 'section',
  article: 'article',
  aside: 'aside',
  li: 'list item',
  ul: 'list',
  ol: 'list',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'cell',
  video: 'video',
  audio: 'audio',
  iframe: 'frame',
  span: 'text',
  div: 'block'
};
function _friendlySelectionLabel(sel) {
  if (!sel) return '';
  const tag = (sel.tagName || '').toLowerCase();
  const friendly = _FRIENDLY_TAGS[tag] || tag || 'element';
  const attrs = sel.attributes || {};
  const text = sel.text ? _shortenBrowserText(sel.text, 60) : '';
  const label = attrs['aria-label'] || attrs.alt || attrs.title || attrs.placeholder || attrs.name || '';
  if (text) return friendly + ' "' + text + '"';
  if (label) return friendly + ' "' + _shortenBrowserText(label, 60) + '"';
  if (attrs.href) return friendly + ' -> ' + _shortenBrowserText(attrs.href, 50);
  return friendly;
}
function _renderBrowserSelection() {
  const panel = document.getElementById('inappAgentSelection');
  const target = document.getElementById('inappAgentSelectionTarget');
  if (panel && target) {
    const sel = _browserInspectState.selected;
    if (!sel) {
      panel.classList.remove('open');
      target.textContent = '';
    } else {
      panel.classList.add('open');
      target.textContent = _friendlySelectionLabel(sel);
    }
  }
  if (_inspectHostActive()) {
    try {
      _renderInappCodeInspect();
    } catch (_) {}
  }
}
// The Inspect/Elements tool can be hosted in the right Tools panel OR the
// DevTools drawer. Either counts as "active" for re-rendering the selection.
function _inspectHostActive() {
  if (_inappToolsState.open && _inappToolsState.current === 'inspect') return true;
  if (typeof _dt !== 'undefined' && _dt.open && _dt.tab === 'elements') return true;
  return false;
}
function _syncInappInspectButton() {
  const btn = document.getElementById('inappInspectBtn');
  if (!btn) return;
  btn.classList.toggle('inspecting', !!_browserInspectState.enabled);
}
function _buildInappInspectScript(enabled) {
  return `(function(){
    var KEY = '__symphoneeInspectBridge';
    var PREFIX = '__SYMPHONEE_INSPECT__';
    function cleanupExisting() {
      if (!window[KEY]) return;
      try { window[KEY].cleanup && window[KEY].cleanup(); } catch (_) {}
      window[KEY] = null;
    }
    function escCss(s) {
      if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
      return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
    }
    function buildSelector(el) {
      if (!el || !el.tagName) return '';
      var parts = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        var part = node.tagName.toLowerCase();
        if (node.id) {
          part += '#' + escCss(node.id);
          parts.unshift(part);
          break;
        }
        var cls = (node.className && typeof node.className === 'string') ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) part += '.' + cls.map(escCss).join('.');
        var sib = node;
        var index = 1;
        while ((sib = sib.previousElementSibling)) index++;
        part += ':nth-child(' + index + ')';
        parts.unshift(part);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }
    function describe(el) {
      var rect = el.getBoundingClientRect();
      var attrs = {};
      try {
        if (el.attributes) {
          for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (a && a.name) attrs[a.name] = a.value || '';
          }
        }
      } catch (_) {}
      return {
        tagName: (el.tagName || '').toLowerCase(),
        selector: buildSelector(el),
        text: ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 280),
        attributes: attrs,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        url: location.href
      };
    }
    cleanupExisting();
    if (!${enabled ? 'true' : 'false'}) return 'disabled';
    var overlay = document.createElement('div');
    overlay.id = '__symphoneeInspectOverlay';
    overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:2px dashed #078efa;background:rgba(7,142,250,0.10);pointer-events:none;z-index:2147483646;box-sizing:border-box;display:none;';
    document.documentElement.appendChild(overlay);
    var selected = document.createElement('div');
    selected.id = '__symphoneeInspectSelected';
    selected.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:2px solid #f9a03f;background:rgba(249,160,63,0.14);pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;box-shadow:0 0 0 1px rgba(0,0,0,0.35),0 4px 16px rgba(249,160,63,0.35);border-radius:3px;';
    document.documentElement.appendChild(selected);
    var label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:-1px;top:-22px;padding:2px 8px;font:600 11px system-ui,-apple-system,Segoe UI,sans-serif;color:#1b1b1b;background:#f9a03f;border-radius:3px 3px 0 0;white-space:nowrap;';
    selected.appendChild(label);
    var selectedEl = null;
    function positionSelected() {
      if (!selectedEl || !selectedEl.isConnected) { selected.style.display = 'none'; return; }
      var rect = selectedEl.getBoundingClientRect();
      selected.style.display = 'block';
      selected.style.left = rect.left + 'px';
      selected.style.top = rect.top + 'px';
      selected.style.width = rect.width + 'px';
      selected.style.height = rect.height + 'px';
      label.style.top = rect.top > 24 ? '-22px' : 'auto';
      label.style.bottom = rect.top > 24 ? 'auto' : '-22px';
      label.style.borderRadius = rect.top > 24 ? '3px 3px 0 0' : '0 0 3px 3px';
    }
    function setSelected(el) {
      selectedEl = el;
      var tag = (el.tagName || '').toLowerCase();
      var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      label.textContent = text ? (tag + ' · ' + text) : tag;
      positionSelected();
    }
    function highlight(el) {
      if (!el || !el.getBoundingClientRect) return;
      var rect = el.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = rect.left + 'px';
      overlay.style.top = rect.top + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
    }
    function onMove(ev) {
      if (!ev.target || ev.target === overlay || ev.target === selected || ev.target === document.documentElement || ev.target === document.body) return;
      highlight(ev.target);
    }
    function onClick(ev) {
      if (!ev.target || ev.target === overlay || ev.target === selected) return;
      highlight(ev.target);
      setSelected(ev.target);
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      console.info(PREFIX + JSON.stringify(describe(ev.target)));
      return false;
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', positionSelected, true);
    window.addEventListener('resize', positionSelected, true);
    window[KEY] = {
      cleanup: function() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        window.removeEventListener('scroll', positionSelected, true);
        window.removeEventListener('resize', positionSelected, true);
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (selected && selected.parentNode) selected.parentNode.removeChild(selected);
      },
      clearSelected: function() { selectedEl = null; selected.style.display = 'none'; }
    };
    return 'enabled';
  })();`;
}
function _applyInappInspectMode(view) {
  const targetView = view || _getInappWebview();
  if (!targetView || targetView.tagName.toLowerCase() !== 'webview') return;
  try {
    targetView.executeJavaScript(_buildInappInspectScript(_browserInspectState.enabled), true).catch(() => {});
  } catch (_) {}
}
function _ensureBrowserAgentPanelOpen() {
  // The AI now lives as a panel inside the Tools drawer.
  if (typeof toggleBrowserDevtools === 'function') toggleBrowserDevtools(true);
  if (_dt.tab !== 'ai') { browserDevtoolsSwitch('ai'); return; }
  const panel = document.getElementById('inappAgentPanel');
  const chip = document.getElementById('inappAgentChip');
  if (!panel) return;
  _browserAgentState.open = true;
  if (chip) chip.classList.add('active');
  _loadBrowserAgentStatus();
}
function _handleInappBrowserConsoleMessage(message) {
  const text = String(message || '');
  const keyPrefix = '__SYMPHONEE_KEY__';
  if (text.startsWith(keyPrefix)) {
    try {
      _dispatchForwardedKey(JSON.parse(text.slice(keyPrefix.length)));
    } catch (_) {}
    return;
  }
  const prefix = '__SYMPHONEE_INSPECT__';
  if (!text.startsWith(prefix)) return;
  try {
    _browserInspectState.selected = JSON.parse(text.slice(prefix.length));
    _renderBrowserSelection();
    const inspectToolActive = _inspectHostActive();
    if (!inspectToolActive) {
      _ensureBrowserAgentPanelOpen();
      const input = _getBrowserAgentInput();
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(input.value.length, input.value.length);
        } catch (_) {}
      }
    }
    // One-shot capture: turn the picker off after a target lands so the user
    // must reopen Tools > Select / Inspect code to grab another element.
    // We disarm inline (not via toggleInappInspectMode, which would also
    // wipe _browserInspectState.selected and blank the Inspect code panel).
    if (_browserInspectState.enabled) {
      _browserInspectState.enabled = false;
      _syncInappInspectButton();
      const view = _ensureInappBrowser();
      if (view) {
        try {
          _applyInappInspectMode(view);
        } catch (_) {}
      }
      if (_inappToolsState.open && _inappToolsState.current === 'menu') {
        try {
          _renderInappToolsMenu();
        } catch (_) {}
      }
    }
  } catch (_) {}
}
// Handle a shortcut forwarded from inside the webview via console.info.
function _dispatchForwardedKey(payload) {
  if (!payload || typeof payload.key !== 'string') return;
  const k = payload.key;
  const shift = !!payload.shift;
  const ctrl = !!payload.ctrl;
  if (ctrl && (k === 'k' || k === 'K')) {
    openCmdPalette();
    return;
  }
  if (k === 'Escape') {
    if (state._inspectIsEditing) {
      _inspectToggleEdit();
      return;
    }
    if (state._colorPopoverEl) {
      _closeColorPopover();
      return;
    }
    const overlay = document.getElementById('symShortcutsOverlay');
    if (overlay && overlay.classList.contains('open')) {
      hideInappShortcutsHelp();
      return;
    }
    if (_inappToolsState.open) {
      closeInappToolsPanel();
      return;
    }
    if (_browserAgentState.open) {
      toggleBrowserAgentPanel();
      return;
    }
    if (_browserInspectState.enabled) {
      toggleInappInspectMode(false);
      return;
    }
    return;
  }
  if (k === '?' || k === '/' && shift) {
    showInappShortcutsHelp();
    return;
  }
  const low = k.toLowerCase();
  if (low === 'i') {
    toggleInappInspectMode();
    return;
  }
  if (low === 'h') {
    if (shift) {
      _ensureSymKit().then(() => _symKitCall('unhideAll'));
      toast('Un-hid all', 'info', {
        duration: 1000
      });
    } else if (state._inspectActiveSelector) _inspectHideSelected();
    return;
  }
  if (low === 'g') {
    toggleInappGrayscale();
    return;
  }
  if (low === 'f') {
    toggleInappFocusMode();
    return;
  }
  if (low === 't') {
    browserDevtoolsOpenMenu();
    return;
  }
  if (low === 'e') {
    _inspectToggleEdit();
    return;
  }
}
function toggleInappInspectMode(forceState) {
  const nextState = typeof forceState === 'boolean' ? forceState : !_browserInspectState.enabled;
  _browserInspectState.enabled = !!nextState;
  if (!_browserInspectState.enabled) _clearBrowserSelection();
  _syncInappInspectButton();
  const view = _ensureInappBrowser();
  if (view) _applyInappInspectMode(view);
  toast(_browserInspectState.enabled ? 'Inspect mode is on. Click an element in the page to select it.' : 'Inspect mode is off.', 'info', {
    duration: 2600
  });
}
function _ensureInappBrowser(initialUrl) {
  const frame = document.getElementById('inappBrowserFrame');
  if (!frame) return null;
  let view = _getInappWebview();
  if (view) return view;
  const supportsWebview = typeof customElements !== 'undefined' && !!customElements.get('webview');
  // Electron exposes webview as an HTML tag; createElement('webview') works.
  const tag = supportsWebview ? 'webview' : 'iframe';
  view = document.createElement(tag);
  view.setAttribute('src', initialUrl || 'https://duckduckgo.com/');
  view.setAttribute('allowpopups', '');
  view.setAttribute('style', 'flex:1;width:100%;height:100%;border:0;background:#fff;');
  if (tag === 'webview') {
    view.addEventListener('dom-ready', () => {
      applyInappBrowserAppearance();
      if (_browserInspectState.enabled) _applyInappInspectMode(view);
      _applyInappBrowserZoom(view);
      // Attach the CDP debugger as early as the page is ready so console +
      // network capture is running from the first load -- the DevTools drawer
      // then has full history even when opened after the fact.
      try { browserDevtoolsEnsureCapture(); } catch (_) {}
    });
    view.addEventListener('did-navigate', e => {
      _syncInappUrl(e.url);
      _clearBrowserSelection();
      _resetOverlayStateForNewPage();
      try { browserDevtoolsOnNavigate(e.url); } catch (_) {}
      try {
        _pageMapCache.url = '';
        _pageMapCache.map = null;
      } catch (_) {}
    });
    view.addEventListener('did-navigate-in-page', e => {
      _syncInappUrl(e.url);
      _clearBrowserSelection();
      _resetOverlayStateForNewPage();
      try {
        _pageMapCache.url = '';
        _pageMapCache.map = null;
      } catch (_) {}
    });
    view.addEventListener('page-title-updated', () => {/* could update tab title */});
    view.addEventListener('console-message', e => _handleInappBrowserConsoleMessage(e && e.message));
  } else {
    view.addEventListener('load', () => {
      try {
        _syncInappUrl(view.contentWindow.location.href);
      } catch (_) {}
      _applyInappBrowserZoom(view);
    });
  }
  frame.innerHTML = '';
  frame.appendChild(view);
  applyInappBrowserAppearance();
  _applyInappBrowserZoom(view);
  return view;
}
function _syncInappUrl(url) {
  const input = document.getElementById('inappBrowserUrl');
  if (input && url) input.value = url;
}
function _normalizeInappUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'https://duckduckgo.com/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}
function inappBrowserGo() {
  const input = document.getElementById('inappBrowserUrl');
  if (!input) return;
  const url = _normalizeInappUrl(input.value);
  const view = _ensureInappBrowser(url);
  if (!view) return;
  if (view.tagName.toLowerCase() === 'webview') {
    try {
      view.loadURL(url);
    } catch (_) {
      view.src = url;
    }
  } else {
    view.src = url;
  }
  applyInappBrowserAppearance();
  input.value = url;
}
function inappBrowserBack() {
  const v = _getInappWebview();
  if (!v) return;
  if (v.tagName.toLowerCase() === 'webview') {
    try {
      v.goBack();
    } catch (_) {}
  } else {
    try {
      v.contentWindow.history.back();
    } catch (_) {}
  }
}
function inappBrowserForward() {
  const v = _getInappWebview();
  if (!v) return;
  if (v.tagName.toLowerCase() === 'webview') {
    try {
      v.goForward();
    } catch (_) {}
  } else {
    try {
      v.contentWindow.history.forward();
    } catch (_) {}
  }
}
function inappBrowserReload() {
  const v = _getInappWebview();
  if (!v) return;
  if (v.tagName.toLowerCase() === 'webview') {
    try {
      v.reload();
    } catch (_) {}
  } else {
    try {
      v.contentWindow.location.reload();
    } catch (_) {}
  }
}
function inappBrowserOpenExternal() {
  const input = document.getElementById('inappBrowserUrl');
  const url = input && input.value ? input.value : 'https://duckduckgo.com/';
  try {
    window.open(url, '_blank');
  } catch (_) {}
}
// Open the browser tab (used by command palette / playwright automation).
function openBrowserTab(initialUrl) {
  const btn = document.getElementById('browserTabBtn');
  if (btn) {
    btn.style.removeProperty('display');
    btn.removeAttribute('hidden');
  }
  switchTab('browser');
  if (initialUrl) {
    const input = document.getElementById('inappBrowserUrl');
    if (input) input.value = initialUrl;
    setTimeout(() => {
      try {
        inappBrowserGo();
      } catch (_) {}
    }, 50);
  }
}
// Hide the browser tab. If it was active, fall back to terminal.
function closeBrowserTab() {
  const btn = document.getElementById('browserTabBtn');
  if (!btn) return;
  const wasActive = btn.classList.contains('active');
  btn.style.display = 'none';
  if (wasActive) switchTab('terminal');
}// ── Browser Agent chat panel ──────────────────────────────────────────────
// Talks to /api/browser/agent/* and listens for WS `browser-agent-step`
// frames so the user sees the agent's actions stream in real time.
const _browserAgentState = {
  threadId: 'default',
  running: false,
  open: false,
  provider: null,
  providers: []
};
const _browserInspectState = {
  enabled: false,
  selected: null
};
async function _loadBrowserAgentStatus() {
  try {
    const r = await fetch('/api/browser/agent/status?threadId=' + encodeURIComponent(_browserAgentState.threadId));
    const data = await r.json();
    _browserAgentState.providers = data.providers || [];
    _browserAgentState.provider = data.defaultProvider || null;
    _populateBrowserAgentProviderSelect();
  } catch (_) {}
}
function _populateBrowserAgentProviderSelect() {
  const sel = document.getElementById('inappAgentProvider');
  if (!sel) return;
  const opts = _browserAgentState.providers;
  const configBtn = document.getElementById('inappAgentConfigureBtn');
  if (!opts.length) {
    sel.style.display = 'none';
    if (!configBtn) {
      const row = sel.parentNode;
      const btn = document.createElement('button');
      btn.id = 'inappAgentConfigureBtn';
      btn.className = 'inapp-agent-configure';
      btn.title = 'Open AI settings to add an API key';
      btn.innerHTML = '<i data-lucide="key" style="width:12px;height:12px;"></i> Configure API Keys';
      btn.onclick = function () {
        openSettings('ai');
        toggleBrowserAgentPanel();
      };
      row.insertBefore(btn, sel);
      if (typeof lucide !== 'undefined') lucide.createIcons({
        el: btn
      });
    }
    return;
  }
  if (configBtn) configBtn.remove();
  sel.style.removeProperty('display');
  sel.disabled = false;
  sel.innerHTML = opts.map(p => `<option value="${p.key}"${p.key === _browserAgentState.provider ? ' selected' : ''}>${p.label}</option>`).join('');
}
function _onBrowserAgentProviderChange() {
  const sel = document.getElementById('inappAgentProvider');
  if (sel && sel.value) _browserAgentState.provider = sel.value;
}
function toggleBrowserAgentPanel() {
  // AI is a panel in the Tools drawer: toggle the drawer on the AI panel.
  if (_dt.open && _dt.tab === 'ai') { toggleBrowserDevtools(false); return; }
  toggleBrowserDevtools(true);
  browserDevtoolsSwitch('ai');
}
function _setBrowserAgentRunning(running) {
  _browserAgentState.running = !!running;
  const chip = document.getElementById('inappAgentChip');
  const state = document.getElementById('inappAgentState');
  const stopBtn = document.getElementById('inappAgentStopBtn');
  const send = document.getElementById('inappAgentSend');
  if (chip) chip.classList.toggle('running', running);
  if (state) {
    state.textContent = running ? 'running' : 'idle';
    state.className = 'inapp-agent-state' + (running ? ' running' : '');
  }
  if (stopBtn) stopBtn.style.display = running ? 'inline-block' : 'none';
  if (send) send.disabled = running;
}
function _appendBrowserActionReports(row, reports) {
  if (!row || !Array.isArray(reports) || !reports.length) return;
  const body = row.querySelector('.agent-msg-body');
  if (!body) return;
  const wrap = document.createElement('div');
  wrap.className = 'browser-action-report-group';
  reports.slice(-4).forEach(report => {
    const card = document.createElement('div');
    card.className = 'browser-action-report';
    const head = document.createElement('div');
    head.className = 'browser-action-report-head';
    const title = document.createElement('div');
    title.className = 'browser-action-report-title';
    title.textContent = report && report.title ? report.title : 'Browser action';
    head.appendChild(title);
    card.appendChild(head);
    const lines = Array.isArray(report && report.summaryLines) ? report.summaryLines.filter(Boolean) : [];
    if (lines.length) {
      const list = document.createElement('ul');
      list.className = 'browser-action-report-list';
      lines.forEach(line => {
        const li = document.createElement('li');
        li.textContent = line;
        list.appendChild(li);
      });
      card.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'browser-action-report-empty';
      empty.textContent = 'Relevant browser activity was captured for this action.';
      card.appendChild(empty);
    }
    const actions = document.createElement('div');
    actions.className = 'browser-action-report-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browser-action-report-expand';
    btn.textContent = 'Expand';
    btn.onclick = function () {
      openBrowserAgentDetailModal(report);
    };
    actions.appendChild(btn);
    card.appendChild(actions);
    wrap.appendChild(card);
  });
  body.appendChild(wrap);
}
function openBrowserAgentDetailModal(report) {
  const modal = document.getElementById('browserAgentDetailModal');
  const title = document.getElementById('browserAgentDetailTitle');
  const summary = document.getElementById('browserAgentDetailSummary');
  const pre = document.getElementById('browserAgentDetailPre');
  if (!modal || !title || !summary || !pre) return;
  title.textContent = report && report.title || 'Browser Action Details';
  summary.textContent = Array.isArray(report && report.summaryLines) ? report.summaryLines.join(' ') : '';
  pre.textContent = JSON.stringify(report && report.detail || report || {}, null, 2);
  modal.classList.add('open');
}
function closeBrowserAgentDetailModal() {
  const modal = document.getElementById('browserAgentDetailModal');
  if (modal) modal.classList.remove('open');
}
function _appendAgentLog(kind, text, extra) {
  const log = document.getElementById('inappAgentLog');
  if (!log) return null;
  const row = document.createElement('div');
  row.className = 'agent-msg ' + kind;
  if (kind === 'action') {
    const glyph = document.createElement('span');
    glyph.className = 'agent-action-glyph';
    glyph.textContent = '›';
    row.appendChild(glyph);
    row.appendChild(document.createTextNode(text || ''));
    if (extra && extra.fail) row.classList.add('fail');
  } else {
    const body = document.createElement('div');
    body.className = 'agent-msg-body';
    body.innerHTML = renderMarkdown(text || '');
    row.appendChild(body);
  }
  // First time: drop the hint.
  const hint = log.querySelector('.inapp-agent-hint');
  if (hint) hint.remove();
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}
function _appendBrowserAgentWaitingRow(message) {
  const log = document.getElementById('inappAgentLog');
  if (!log) return null;
  // Replace any prior waiting row so a second wait_for_user doesn't pile up.
  const prior = log.querySelector('.agent-msg.waiting');
  if (prior) prior.remove();
  const row = document.createElement('div');
  row.className = 'agent-msg waiting';
  row.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:10px 12px; border:1px solid var(--border, #444); border-radius:6px; background:rgba(255,180,0,0.08); margin:6px 0;';
  const body = document.createElement('div');
  body.className = 'agent-msg-body';
  body.style.cssText = 'font-size:13px; line-height:1.4;';
  body.textContent = message;
  row.appendChild(body);
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; align-items:center;';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Resume';
  btn.style.cssText = 'padding:4px 12px; border:1px solid var(--border, #555); background:var(--accent, #2a7); color:#fff; border-radius:4px; cursor:pointer; font-size:12px;';
  btn.onclick = async function () {
    btn.disabled = true;
    btn.textContent = 'Resuming...';
    try {
      await fetch('/api/browser/agent/resume', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          threadId: _browserAgentState.threadId
        })
      });
      row.remove();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Resume';
      _appendAgentLog('error', 'Failed to resume: ' + (e && e.message ? e.message : String(e)));
    }
  };
  actions.appendChild(btn);
  row.appendChild(actions);
  const startHint = log.querySelector('.inapp-agent-hint');
  if (startHint) startHint.remove();
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

// ── Automation tab activity indicator ──────────────────────────────────────
// Mirrors the orchestrator-tab pulse: a green pulse dot appears on the left
// of the Automation parent tab whenever automation is running (Stagehand or
// browser-use). Pings are debounced -- the dot stays for 8s after the last
// signal, then disappears.
const _automationActivity = {
  lastPing: 0,
  idleTimer: null
};
function _markAutomationActive() {
  _automationActivity.lastPing = Date.now();
  const btn = document.getElementById('automationTabBtn');
  if (btn && !btn.querySelector('.browser-pulse-dot')) {
    const dot = document.createElement('span');
    dot.className = 'browser-pulse-dot';
    btn.insertBefore(dot, btn.firstChild);
  }
  if (_automationActivity.idleTimer) clearTimeout(_automationActivity.idleTimer);
  _automationActivity.idleTimer = setTimeout(() => {
    if (Date.now() - _automationActivity.lastPing >= 8000) {
      const b = document.getElementById('automationTabBtn');
      const d = b && b.querySelector('.browser-pulse-dot');
      if (d) d.remove();
    }
  }, 8500);
}
// Backwards-compat alias for older call sites.
function _markBrowserTabActive() {
  _markAutomationActive();
}
function _focusAutomationBrowser() {
  try {
    if (typeof switchTab === 'function') switchTab('automation');
    if (typeof switchAutomationSubTab === 'function') switchAutomationSubTab('browser');
  } catch (_) {}
}

// ── Stagehand screencast viewer ────────────────────────────────────────────
// Renders the CDP screencast frames broadcast by the Stagehand plugin so the
// user sees Stagehand's session inside the same Browser tab they use for the
// in-app webview. Auto-shows on first frame, auto-hides after 8s of silence.
const _stagehandCast = {
  lastFrame: 0,
  idleTimer: null,
  img: null
};
function handleStagehandScreencast(msg) {
  if (!msg || !msg.data) return;
  _markAutomationActive();
  // First-frame fallback: if the dispatch broadcast was missed (or dropped
  // because the user was switching tabs), the first screencast frame still
  // pulls them onto the Browser tab so they don't miss the run.
  if (!_stagehandCast.lastFrame) _focusAutomationBrowser();
  const overlay = document.getElementById('stagehandScreencastOverlay');
  const canvas = document.getElementById('stagehandScreencastCanvas');
  const urlEl = document.getElementById('stagehandScreencastUrl');
  if (!overlay || !canvas) return;
  if (overlay.style.display === 'none') overlay.style.display = 'block';
  if (urlEl && msg.url) urlEl.textContent = msg.url;
  _stagehandCast.lastFrame = Date.now();
  if (_stagehandCast.idleTimer) clearTimeout(_stagehandCast.idleTimer);
  _stagehandCast.idleTimer = setTimeout(() => {
    if (Date.now() - _stagehandCast.lastFrame >= 8000) {
      // No frames for 8s: assume the agent is finished. Hide quietly.
      overlay.style.display = 'none';
    }
  }, 8500);

  // Use a fresh Image per frame so a slow decode never gets cancelled by the
  // next frame's src assignment, and so the canvas keeps showing the latest
  // fully-decoded frame even when frames arrive faster than the GPU draws.
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth || 1280;
    if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight || 720;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.onerror = () => {/* ignore malformed frame */};
  img.src = 'data:image/jpeg;base64,' + msg.data;
}
function closeStagehandScreencast() {
  const overlay = document.getElementById('stagehandScreencastOverlay');
  if (overlay) overlay.style.display = 'none';
  fetch('/api/plugins/stagehand/screencast/stop', {
    method: 'POST'
  }).catch(() => {});
}
function handleBrowserRouterDispatch(msg) {
  if (!msg) return;
  _markAutomationActive();
  const fallbacks = Array.isArray(msg.fallbacks) ? msg.fallbacks : [];
  const stagehandFallback = fallbacks.find(f => f && f.from === 'stagehand');
  // Start: switch to Automation -> Browser so the user watches the run live.
  if (!msg.phase || msg.phase === 'start') {
    _focusAutomationBrowser();
    if (msg.driver === 'stagehand') {
      const overlay = document.getElementById('stagehandScreencastOverlay');
      if (overlay && overlay.style.display === 'none') overlay.style.display = 'block';
    }
  }
  // End/error: bring the user back to the Terminal so they can see the
  // final result printed by whatever called the router. Hide the screencast
  // overlay too so it doesn't keep showing the last frame.
  if (msg.phase === 'end' || msg.phase === 'error') {
    try {
      if (typeof switchTab === 'function') switchTab('terminal');
    } catch (_) {}
    const overlay = document.getElementById('stagehandScreencastOverlay');
    if (overlay) overlay.style.display = 'none';
    // Stop the Chromium-side screencast so we're not paying for frames the
    // user can no longer see.
    fetch('/api/plugins/stagehand/screencast/stop', {
      method: 'POST'
    }).catch(() => {});
  }
  if (stagehandFallback && typeof notify === 'function') {
    notify('Stagehand unavailable', (stagehandFallback.reason || 'Stagehand failed') + '. Fell back to browser-use.', {
      icon: 'alert-triangle'
    });
  } else if (msg.phase === 'error' && msg.driver === 'stagehand' && typeof notify === 'function') {
    notify('Stagehand failed', msg.error || 'Browser automation failed before a fallback could run.', {
      icon: 'alert-circle'
    });
  }
}
function handleBrowserAgentStep(msg) {
  if (!msg) return;
  _markBrowserTabActive();
  if (msg.threadId !== _browserAgentState.threadId) return;
  switch (msg.kind) {
    case 'provider':
      {
        const state = document.getElementById('inappAgentState');
        if (state) {
          state.textContent = msg.label || msg.provider || 'running';
        }
        break;
      }
    case 'user':
      // Echoed back; we already rendered locally when sending.
      break;
    case 'thinking':
      // Replace the previous thinking row if present.
      _browserAgentState._thinkingRow && _browserAgentState._thinkingRow.remove();
      _browserAgentState._thinkingRow = _appendAgentLog('thinking', 'Thinking (step ' + (msg.iter || '?') + ')...');
      break;
    case 'message':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      _appendAgentLog('message', msg.text || '');
      break;
    case 'action':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      _appendAgentLog('action', msg.summary || msg.tool || 'action');
      break;
    case 'observation':
      if (msg.ok === false) _appendAgentLog('action', (msg.tool || 'tool') + ' failed: ' + (msg.error || ''), {
        fail: true
      });
      break;
    case 'waiting':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      _appendBrowserAgentWaitingRow(msg.message || 'User action required.');
      break;
    case 'done':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      {
        const row = _appendAgentLog('done', msg.summary || 'Done.');
        if (row && Array.isArray(msg.reports) && msg.reports.length) _appendBrowserActionReports(row, msg.reports);
      }
      _setBrowserAgentRunning(false);
      if (typeof toast === 'function') {
        const summary = String(msg.summary || 'Browser automation completed.').replace(/\s+/g, ' ').slice(0, 200);
        toast('Browser - ' + summary, 'success', {
          duration: 5000
        });
      }
      break;
    case 'stopped':
      _appendAgentLog('message', 'Stopped by user.');
      _setBrowserAgentRunning(false);
      break;
    case 'error':
      _appendAgentLog('error', msg.message || 'Error');
      _setBrowserAgentRunning(false);
      break;
  }
}
function _composeBrowserAgentTask(task) {
  const rawTask = String(task || '').trim();
  if (!rawTask) return '';
  if (!_browserInspectState.selected) return rawTask;
  return ['Use the current browser page to help the user. You have full control of this browser and can do anything a human user could do here - navigate, click, type, scroll, fill forms, inspect, modify the DOM, read any content on the page. Act directly; do not ask for permission on routine browser actions.', '', 'A page element is currently selected. Treat it as the target element unless the user explicitly overrides that target. If the request says "this", "it", "selected", "remove this", or is otherwise ambiguous, assume it refers to the selected element below.', '', 'Selected element:', '```json', JSON.stringify(_browserInspectState.selected, null, 2), '```', '', 'User request: ' + rawTask].join('\n');
}

// ── Pre-flight page map (analyze before acting) ──────────────────────────
// Cache keyed by URL so we don't re-scan on every message. Invalidated by
// navigation events elsewhere in the agent code.
const _pageMapCache = {
  url: '',
  map: null,
  ts: 0
};
const PAGE_MAP_SCRIPT = `(function(){
  function parseColor(str){
    if (!str) return null;
    var m = String(str).match(/rgba?\\((-?[0-9.]+)[,\\s]+(-?[0-9.]+)[,\\s]+(-?[0-9.]+)(?:[,/\\s]+([0-9.]+%?))?\\)/);
    if (!m) return null;
    var a = m[4] == null ? 1 : (String(m[4]).slice(-1) === '%' ? parseFloat(m[4])/100 : parseFloat(m[4]));
    if (a <= 0.02) return null;
    var r = Math.round(parseFloat(m[1])), g = Math.round(parseFloat(m[2])), b = Math.round(parseFloat(m[3]));
    function h(v){ var x = v.toString(16); return x.length<2 ? '0'+x : x; }
    return '#' + h(r) + h(g) + h(b);
  }
  function selectorOf(el){
    if (!el || el === document.body || el === document.documentElement) return el && el.tagName ? el.tagName.toLowerCase() : null;
    if (el.id) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    var cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return cls ? tag + '.' + cls : tag;
  }
  function trimText(s, n){ s = (s || '').replace(/\\s+/g,' ').trim(); return s.length > n ? s.slice(0, n) + '...' : s; }

  var url = location.href;
  var host = location.hostname;
  var title = document.title;
  var lang = document.documentElement.getAttribute('lang') || null;
  var viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };

  // Framework fingerprint (cheap heuristics).
  var fw = [];
  try {
    if (window.React || document.querySelector('[data-reactroot], #__next, [data-reactid]')) fw.push('React');
    if (document.querySelector('#__next, script[src*="_next/"]')) fw.push('Next.js');
    if (window.Vue || document.querySelector('[data-v-app], #__nuxt')) fw.push('Vue');
    if (document.querySelector('#__nuxt, script[src*="_nuxt/"]')) fw.push('Nuxt');
    if (document.querySelector('astro-island, [astro-island]')) fw.push('Astro');
    if (document.body && /wp-/.test(document.body.className || '') || document.querySelector('meta[name="generator"][content*="WordPress" i]')) fw.push('WordPress');
    if (document.querySelector('[class*="tw-"], script[src*="tailwind"]') || /tailwind/i.test(document.documentElement.className || '')) fw.push('Tailwind');
    if (document.querySelector('[class*="MuiBox"], [class*="MuiButton"]')) fw.push('MUI');
    if (document.querySelector('[class^="sc-"], [class*=" sc-"]')) fw.push('styled-components');
    if (document.querySelector('script[src*="bootstrap"], [class*="container-fluid"]')) fw.push('Bootstrap');
    if (document.querySelector('script[src*="shopify"], meta[name="shopify-digital-wallet"]')) fw.push('Shopify');
  } catch (_) {}

  // Which element paints the page background? Walk html / body / first-child
  // until we find a non-transparent bg. This is the "real target" for
  // "change the background color" requests.
  function firstPainted(root){
    var el = root, seen = 0;
    while (el && seen < 6) {
      try {
        var bg = parseColor(getComputedStyle(el).backgroundColor);
        if (bg) return { selector: selectorOf(el), hex: bg };
      } catch (_) {}
      el = el.children && el.children[0];
      seen++;
    }
    return null;
  }
  var htmlBg = null, bodyBg = null, firstBg = null;
  try { htmlBg = parseColor(getComputedStyle(document.documentElement).backgroundColor); } catch(_){}
  try { bodyBg = parseColor(getComputedStyle(document.body).backgroundColor); } catch(_){}
  try { firstBg = firstPainted(document.body); } catch(_){}
  var backgroundTarget = (bodyBg ? { selector: 'body', hex: bodyBg } : null) || firstBg || (htmlBg ? { selector: 'html', hex: htmlBg } : null);

  // Palette (body bg/text + headings + links + first buttons + theme meta)
  var byHex = {};
  function addColor(hex, role){
    if (!hex) return;
    hex = hex.toLowerCase();
    if (!byHex[hex]) byHex[hex] = { hex: hex, roles: [] };
    if (byHex[hex].roles.indexOf(role) < 0) byHex[hex].roles.push(role);
  }
  try {
    if (bodyBg) addColor(bodyBg, 'background');
    addColor(parseColor(getComputedStyle(document.body).color), 'text');
    Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 4).forEach(function(h){ addColor(parseColor(getComputedStyle(h).color), 'heading'); });
    Array.from(document.querySelectorAll('a')).slice(0, 4).forEach(function(a){ addColor(parseColor(getComputedStyle(a).color), 'link'); });
    Array.from(document.querySelectorAll('button, [role="button"], [class*="btn"]')).slice(0, 6).forEach(function(b){
      addColor(parseColor(getComputedStyle(b).backgroundColor), 'button-bg');
      addColor(parseColor(getComputedStyle(b).color), 'button-text');
    });
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc && tc.content) addColor(tc.content.toLowerCase(), 'theme');
  } catch (_) {}
  var palette = Object.values(byHex);

  // CSS custom properties on :root that look like colors.
  var cssVars = [];
  try {
    var cs = getComputedStyle(document.documentElement);
    for (var i = 0; i < Math.min(cs.length, 400); i++) {
      var n = cs[i];
      if (n && n.indexOf('--') === 0) {
        var v = (cs.getPropertyValue(n) || '').trim();
        if (/^(#[0-9a-f]{3,8}|rgba?\\(|hsla?\\()/i.test(v)) {
          if (cssVars.length < 20) cssVars.push({ name: n, value: v });
        }
      }
    }
  } catch (_) {}

  // Typography
  var typography = {};
  try {
    var b = getComputedStyle(document.body);
    typography.body = { family: b.fontFamily, size: b.fontSize, lineHeight: b.lineHeight };
    var h1 = document.querySelector('h1'); if (h1) { var c = getComputedStyle(h1); typography.h1 = { family: c.fontFamily, size: c.fontSize, weight: c.fontWeight }; }
  } catch (_) {}

  // Major regions: semantic landmarks + first-level children of body.
  var regions = [];
  try {
    var seen = new Set();
    function push(el, label){
      if (!el || seen.has(el)) return;
      seen.add(el);
      var cs = getComputedStyle(el);
      regions.push({
        label: label,
        selector: selectorOf(el),
        tag: el.tagName.toLowerCase(),
        bg: parseColor(cs.backgroundColor),
        color: parseColor(cs.color),
        text: trimText(el.innerText || '', 80),
        children: el.children ? el.children.length : 0,
      });
    }
    ['header','nav','main','[role="main"]','section.hero,.hero','footer','aside'].forEach(function(sel){
      var el = document.querySelector(sel); if (el) push(el, sel);
    });
    if (regions.length < 6 && document.body) {
      Array.from(document.body.children).slice(0, 8).forEach(function(c, idx){ push(c, 'body >#'+(idx+1)); });
    }
  } catch (_) {}

  // Interactive surface
  var surface = {};
  try {
    surface.buttons = document.querySelectorAll('button, [role="button"]').length;
    surface.links = document.querySelectorAll('a[href]').length;
    surface.inputs = document.querySelectorAll('input, textarea, select').length;
    surface.forms = document.querySelectorAll('form').length;
    surface.images = document.querySelectorAll('img').length;
    var h1 = document.querySelector('h1');
    surface.firstHeading = h1 ? trimText(h1.innerText, 80) : null;
    var ctaLabels = Array.from(document.querySelectorAll('button, a.btn, a[class*="cta"]')).slice(0, 5).map(function(el){ return trimText(el.innerText || el.getAttribute('aria-label') || '', 40); }).filter(Boolean);
    surface.ctaLabels = ctaLabels;
  } catch (_) {}

  return {
    url: url, host: host, title: title, lang: lang, viewport: viewport,
    frameworks: fw, backgroundTarget: backgroundTarget,
    palette: palette.slice(0, 12),
    cssVars: cssVars,
    typography: typography,
    regions: regions.slice(0, 10),
    surface: surface,
  };
})();`;
async function _runPageMap() {
  const view = typeof _ensureInappBrowser === 'function' ? _ensureInappBrowser() : null;
  if (!view || view.tagName.toLowerCase() !== 'webview') return null;
  let url = '';
  try {
    url = view.getURL ? view.getURL() : view.src || '';
  } catch (_) {}
  if (url && _pageMapCache.url === url && _pageMapCache.map && Date.now() - _pageMapCache.ts < 5 * 60 * 1000) {
    return _pageMapCache.map;
  }
  try {
    const map = await view.executeJavaScript(PAGE_MAP_SCRIPT, true);
    if (map) {
      _pageMapCache.url = url;
      _pageMapCache.map = map;
      _pageMapCache.ts = Date.now();
    }
    return map;
  } catch (_) {
    return null;
  }
}
function _summarizePageMapForPrompt(map) {
  if (!map) return '';
  const lines = [];
  lines.push('Pre-flight page map (refresh by calling inspect_dom / get_page_source for specifics):');
  lines.push('- URL: ' + (map.url || '?'));
  lines.push('- Title: ' + (map.title || '?'));
  if (map.frameworks && map.frameworks.length) lines.push('- Frameworks: ' + map.frameworks.join(', '));
  if (map.backgroundTarget) lines.push('- Background paint target: `' + map.backgroundTarget.selector + '` (computed ' + map.backgroundTarget.hex + '). Use this for "change the background" requests.');
  if (map.palette && map.palette.length) {
    lines.push('- Palette (hex -> roles):');
    map.palette.forEach(p => lines.push('  - ' + p.hex + ' -> ' + (p.roles || []).join(', ')));
  }
  if (map.cssVars && map.cssVars.length) {
    lines.push('- Color CSS variables on :root:');
    map.cssVars.forEach(v => lines.push('  - ' + v.name + ': ' + v.value));
  }
  if (map.typography) {
    if (map.typography.body) lines.push('- Body type: ' + map.typography.body.family + ' @ ' + map.typography.body.size + ' / line-height ' + map.typography.body.lineHeight);
    if (map.typography.h1) lines.push('- H1: ' + map.typography.h1.family + ' @ ' + map.typography.h1.size + ' weight ' + map.typography.h1.weight);
  }
  if (map.regions && map.regions.length) {
    lines.push('- Major regions:');
    map.regions.forEach(r => {
      const bits = [r.label, '`' + r.selector + '`'];
      if (r.bg) bits.push('bg ' + r.bg);
      if (r.color) bits.push('fg ' + r.color);
      if (r.text) bits.push('"' + r.text + '"');
      lines.push('  - ' + bits.join(' | '));
    });
  }
  if (map.surface) {
    const s = map.surface;
    lines.push('- Surface: ' + (s.buttons || 0) + ' buttons, ' + (s.links || 0) + ' links, ' + (s.forms || 0) + ' forms, ' + (s.inputs || 0) + ' inputs, ' + (s.images || 0) + ' images.');
    if (s.firstHeading) lines.push('- First H1: "' + s.firstHeading + '"');
    if (s.ctaLabels && s.ctaLabels.length) lines.push('- Visible CTAs: ' + s.ctaLabels.map(x => '"' + x + '"').join(', '));
  }
  lines.push('');
  lines.push('Use this map to avoid guessing selectors. If it looks stale, call get_page_source or inspect_dom to refresh.');
  return lines.join('\n');
}
async function _sendBrowserAgentTask(task, displayText, options) {
  if (!task) return;
  if (_browserAgentState.running) return;
  _appendAgentLog('user', displayText || task);
  _setBrowserAgentRunning(true);
  // Pre-flight: analyze the page before sending to the agent. Shows a live
  // "Analyzing..." row; replaced with a "Page map ready" summary once done.
  // On cache hit we skip the row entirely.
  let pageMap = null;
  let analyzeRow = null;
  try {
    const view = _ensureInappBrowser && _ensureInappBrowser();
    let curUrl = '';
    try {
      curUrl = view && view.getURL ? view.getURL() : view ? view.src || '' : '';
    } catch (_) {}
    const cached = curUrl && _pageMapCache.url === curUrl && _pageMapCache.map && Date.now() - _pageMapCache.ts < 5 * 60 * 1000;
    if (!cached) analyzeRow = _appendAgentLog('action', 'Analyzing page...');
    pageMap = await _runPageMap();
    if (analyzeRow) {
      // _appendAgentLog('action', ...) renders as [glyph][#text]. Replace the
      // trailing text node with the finished summary without touching glyph.
      const newLabel = pageMap ? 'Page map ready (' + (pageMap.regions ? pageMap.regions.length : 0) + ' regions, ' + (pageMap.palette || []).length + ' colors)' : 'Page analysis skipped';
      let replaced = false;
      for (let i = analyzeRow.childNodes.length - 1; i >= 0; i--) {
        const n = analyzeRow.childNodes[i];
        if (n && n.nodeType === 3) {
          n.nodeValue = newLabel;
          replaced = true;
          break;
        }
      }
      if (!replaced) analyzeRow.appendChild(document.createTextNode(newLabel));
    }
  } catch (_) {
    pageMap = null;
  }
  let composedTask = _composeBrowserAgentTask(task, options || {});
  if (pageMap) {
    const summary = _summarizePageMapForPrompt(pageMap);
    if (summary) composedTask = summary + '\n\n---\n\n' + composedTask;
  }
  try {
    const res = await fetch('/api/browser/agent/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        task: composedTask,
        threadId: _browserAgentState.threadId,
        provider: _browserAgentState.provider || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      _appendAgentLog('error', data.error || 'HTTP ' + res.status);
      _setBrowserAgentRunning(false);
    } else if (data.label) {
      const state = document.getElementById('inappAgentState');
      if (state) state.title = data.label + ' (' + (data.model || '') + ')';
    }
  } catch (e) {
    _appendAgentLog('error', e.message || String(e));
    _setBrowserAgentRunning(false);
  }
}
async function sendBrowserAgent() {
  const input = document.getElementById('inappAgentInput');
  if (!input) return;
  const task = (input.value || '').trim();
  if (!task) return;
  input.value = '';
  _autosizeAgentInput(input);
  await _sendBrowserAgentTask(task);
}
async function refineBrowserAgentRequest() {
  const input = document.getElementById('inappAgentInput');
  const btn = document.getElementById('inappAgentRefine');
  if (!input) return;
  const draft = (input.value || '').trim();
  if (!draft) {
    toast('Type something first.', 'info', {
      duration: 1500
    });
    return;
  }
  if (btn) {
    btn.classList.add('refining');
    btn.textContent = 'Refining...';
  }
  try {
    const res = await fetch('/api/browser/agent/refine', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        draft,
        selection: _browserInspectState.selected || null,
        provider: _browserAgentState.provider || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || 'Refine failed');
    const refined = (data.refined || '').trim();
    if (refined && refined !== draft) {
      input.value = refined;
      _autosizeAgentInput(input);
      input.focus();
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (_) {}
      toast('Refined.', 'success', {
        duration: 1400
      });
    } else {
      toast('No changes — looked good already.', 'info', {
        duration: 1800
      });
    }
  } catch (e) {
    toast('Refine failed: ' + (e && e.message ? e.message : String(e)), 'error');
  } finally {
    if (btn) {
      btn.classList.remove('refining');
      btn.textContent = 'Refine with AI';
    }
  }
}
async function stopBrowserAgent() {
  try {
    await fetch('/api/browser/agent/stop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        threadId: _browserAgentState.threadId
      })
    });
  } catch (_) {}
}
async function resetBrowserAgent() {
  try {
    await fetch('/api/browser/agent/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        threadId: _browserAgentState.threadId
      })
    });
  } catch (_) {}
  const log = document.getElementById('inappAgentLog');
  if (log) {
    log.innerHTML = '<div class="inapp-agent-hint">Chat cleared. What should I do next?</div>';
  }
  _setBrowserAgentRunning(false);
}

// Full tab reset: destroy the webview (drops DOM, JS state, page history),
// clear the URL field, and wipe the agent chat. The webview will be
// recreated fresh on the next inappBrowserGo.
async function resetBrowserTab() {
  try {
    await resetBrowserAgent();
  } catch (_) {}
  const frame = document.getElementById('inappBrowserFrame');
  if (frame) frame.innerHTML = '';
  const input = document.getElementById('inappBrowserUrl');
  if (input) input.value = '';
  try {
    _clearBrowserSelection && _clearBrowserSelection();
  } catch (_) {}
  try {
    _resetOverlayStateForNewPage && _resetOverlayStateForNewPage();
  } catch (_) {}
  if (typeof toast === 'function') toast('Browser tab reset.', 'info');
}

// ── Symphonee browser kit (utilities injected into the page) ─────────────
const _SYM_BROWSER_KIT = `(function(){
  if (window.__symKit) return 'already';
  var BRACKET = '__symKit';
  var HL_ID = '__symKitHighlights';
  var FOCUS_ID = '__symKitFocusStyle';
  var DARK_ID = '__symKitDarkStyle';
  var GRAY_ID = '__symKitGrayStyle';
  function q(sel){ try { return Array.from(document.querySelectorAll(sel)); } catch(_) { return []; } }
  function ensureLayer(id){
    var l = document.getElementById(id);
    if (l) return l;
    l = document.createElement('div'); l.id = id;
    l.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.documentElement.appendChild(l);
    return l;
  }
  function clearLayer(id){ var l = document.getElementById(id); if (l) l.remove(); }
  function box(el){ return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; }
  function overlay(rect, opts){
    opts = opts || {};
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;box-sizing:border-box;border:2px solid ' + (opts.color || '#f38ba8') + ';background:' + (opts.bg || 'rgba(243,139,168,0.15)') + ';border-radius:2px;pointer-events:none;';
    if (opts.label) {
      var lbl = document.createElement('div');
      lbl.textContent = opts.label;
      lbl.style.cssText = 'position:absolute;left:0;top:-18px;background:' + (opts.color || '#f38ba8') + ';color:#1b1b1b;font:600 10px system-ui,sans-serif;padding:1px 6px;border-radius:2px 2px 0 0;white-space:nowrap;';
      d.appendChild(lbl);
    }
    return d;
  }
  function highlightAll(selector){
    clearLayer(HL_ID);
    var layer = ensureLayer(HL_ID);
    var els = q(selector).slice(0, 100);
    els.forEach(function(el, i){
      var r = box(el); if (!r || !r.width) return;
      layer.appendChild(overlay(r, { color: '#94e2d5', bg: 'rgba(148,226,213,0.15)', label: i === 0 ? selector + ' (' + els.length + ')' : null }));
    });
    return { matched: els.length };
  }
  function clearHighlight(){ clearLayer(HL_ID); }
  function setVisibility(selector, hide){
    var el = q(selector)[0]; if (!el) return { ok: false };
    if (hide) { el.dataset.symHiddenPrev = el.style.visibility || ''; el.style.visibility = 'hidden'; }
    else { el.style.visibility = el.dataset.symHiddenPrev || ''; delete el.dataset.symHiddenPrev; }
    return { ok: true, nowHidden: !!hide };
  }
  function toggleVisibility(selector){
    var el = q(selector)[0]; if (!el) return { ok: false };
    var isHidden = 'symHiddenPrev' in el.dataset || getComputedStyle(el).visibility === 'hidden';
    return setVisibility(selector, !isHidden);
  }
  function unhideAll(){
    document.querySelectorAll('[data-sym-hidden-prev]').forEach(function(el){
      el.style.visibility = el.dataset.symHiddenPrev || '';
      delete el.dataset.symHiddenPrev;
    });
    return { ok: true };
  }
  function applyDarkMode(on){
    var existing = document.getElementById(DARK_ID);
    if (!on) { if (existing) existing.remove(); return { ok: true, on: false }; }
    if (existing) return { ok: true, on: true };
    var css = ''
      + 'html{filter:invert(1) hue-rotate(180deg) !important;background:#111 !important;}'
      + 'img,video,picture,iframe,canvas,[style*="background-image"]{filter:invert(1) hue-rotate(180deg) !important;}';
    var s = document.createElement('style'); s.id = DARK_ID; s.textContent = css;
    document.documentElement.appendChild(s);
    return { ok: true, on: true };
  }
  function applyGrayscale(on){
    var existing = document.getElementById(GRAY_ID);
    if (!on) { if (existing) existing.remove(); return { ok: true, on: false }; }
    if (existing) return { ok: true, on: true };
    var s = document.createElement('style'); s.id = GRAY_ID; s.textContent = 'html{filter:grayscale(100%) !important;}';
    document.documentElement.appendChild(s);
    return { ok: true, on: true };
  }
  function applyFocusMode(on){
    var existing = document.getElementById(FOCUS_ID);
    if (!on) {
      if (existing) existing.remove();
      document.querySelectorAll('[data-sym-focus-hidden]').forEach(function(el){ el.removeAttribute('data-sym-focus-hidden'); });
      return { ok: true, on: false };
    }
    if (existing) return { ok: true, on: true };
    // Hide obvious chrome via class-list rules (scoped by tag/role so we don't nuke the main content).
    var css = ''
      + 'nav,aside,header,footer,[role="banner"],[role="complementary"],[role="contentinfo"],[role="navigation"]{display:none !important;}'
      + '.sidebar,.side-bar,[class*="-sidebar"],[class*="_sidebar"]{display:none !important;}'
      + '[class*="cookie"],[class*="newsletter"],[class*="popup"],[class*="modal"],[class*="overlay"],[class*="lightbox"]{display:none !important;}'
      + 'body{overflow:auto !important;}';
    var s = document.createElement('style'); s.id = FOCUS_ID; s.textContent = css;
    document.documentElement.appendChild(s);
    // Heuristic pass: hide any element whose COMPUTED position is fixed/sticky AND that overlaps viewport edges
    // (typical cookie banners, chat widgets, sticky headers). Leaves in-flow content alone.
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      Array.prototype.slice.call(document.body.querySelectorAll('*')).forEach(function(el){
        try {
          var cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
          var r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          var touchesEdge = r.top < 8 || r.left < 8 || (vw - r.right) < 8 || (vh - r.bottom) < 8;
          if (!touchesEdge) return;
          el.setAttribute('data-sym-focus-hidden', '1');
          el.style.setProperty('display', 'none', 'important');
        } catch (_) {}
      });
    } catch (_) {}
    return { ok: true, on: true };
  }
  function getBoxModel(selector){
    var el = q(selector)[0]; if (!el) return null;
    var cs = getComputedStyle(el);
    function n(k){ return parseFloat(cs.getPropertyValue(k)) || 0; }
    var r = el.getBoundingClientRect();
    return {
      margin: { top: n('margin-top'), right: n('margin-right'), bottom: n('margin-bottom'), left: n('margin-left') },
      border: { top: n('border-top-width'), right: n('border-right-width'), bottom: n('border-bottom-width'), left: n('border-left-width') },
      padding: { top: n('padding-top'), right: n('padding-right'), bottom: n('padding-bottom'), left: n('padding-left') },
      width: Math.round(r.width - n('padding-left') - n('padding-right') - n('border-left-width') - n('border-right-width')),
      height: Math.round(r.height - n('padding-top') - n('padding-bottom') - n('border-top-width') - n('border-bottom-width')),
      outerWidth: Math.round(r.width), outerHeight: Math.round(r.height),
    };
  }
  function esc(s){ try { return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1'); } catch(_) { return s; } }
  function altSelectors(selector){
    var el = q(selector)[0]; if (!el) return [];
    var out = [];
    function push(s, label){ if (!s) return; var n = q(s).length; if (!n) return; out.push({ selector: s, count: n, label: label }); }
    var tag = el.tagName.toLowerCase();
    if (el.id) push(tag + '#' + esc(el.id), 'id');
    var dataAttrs = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.value) dataAttrs.push('[' + a.name + '="' + a.value.replace(/"/g, '\\\\"') + '"]');
    }
    if (dataAttrs.length) push(tag + dataAttrs[0], 'data-attr');
    if (el.getAttribute && el.getAttribute('aria-label')) push(tag + '[aria-label="' + el.getAttribute('aria-label').replace(/"/g, '\\\\"') + '"]', 'aria-label');
    if (el.getAttribute && el.getAttribute('role')) push(tag + '[role="' + el.getAttribute('role') + '"]', 'role');
    if (el.name) push(tag + '[name="' + el.name + '"]', 'name');
    var cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).filter(Boolean) : [];
    cls.slice(0, 3).forEach(function(c){ push(tag + '.' + esc(c), 'class'); });
    if (cls.length >= 2) push(tag + '.' + cls.slice(0,2).map(esc).join('.'), 'classes');
    push(tag, 'tag');
    // De-dupe by selector string.
    var seen = {};
    return out.filter(function(o){ if (seen[o.selector]) return false; seen[o.selector] = 1; return true; }).slice(0, 6);
  }
  // Forward a small set of UI shortcuts from the webview back to the host
  // renderer via console.info. Host listens for __SYMPHONEE_KEY__<json>.
  var FORWARD_KEYS = { i:1, h:1, d:1, g:1, f:1, t:1, k:1, e:1, '?':1, '/':1, 'Escape':1 };
  function inEditable(t){
    if (!t) return false;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    if (t.isContentEditable) return true;
    try { if (t.closest && t.closest('[data-sym-editing]')) return true; } catch(_){}
    return false;
  }
  function onKey(ev){
    var t = ev.target;
    var isCmd = (ev.ctrlKey || ev.metaKey) && !ev.altKey;
    var k = ev.key;
    // Esc always forwards (lets the host exit inline editor / close panels).
    if (k === 'Escape') {
      console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'Escape' }));
      return; // do not preventDefault - let the page also react if it wants
    }
    if (isCmd && (k === 'k' || k === 'K')) {
      console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'k', ctrl: true, shift: !!ev.shiftKey }));
      ev.preventDefault();
      return;
    }
    if (inEditable(t)) return;
    if (isCmd) return; // only Ctrl+K passes through
    if (!FORWARD_KEYS[k] && !(k.toLowerCase && FORWARD_KEYS[k.toLowerCase()])) return;
    console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: k, shift: !!ev.shiftKey, ctrl: !!ev.ctrlKey }));
    ev.preventDefault();
  }
  document.addEventListener('keydown', onKey, true);
  window[BRACKET] = {
    highlightAll: highlightAll, clearHighlight: clearHighlight,
    setVisibility: setVisibility, toggleVisibility: toggleVisibility, unhideAll: unhideAll,
    applyDarkMode: applyDarkMode, applyGrayscale: applyGrayscale, applyFocusMode: applyFocusMode,
    getBoxModel: getBoxModel, altSelectors: altSelectors,
    state: { dark: false, gray: false, focus: false },
    cleanupKeys: function(){ document.removeEventListener('keydown', onKey, true); },
  };
  return 'installed';
})();`;
async function _ensureSymKit() {
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') return null;
  try {
    await view.executeJavaScript(_SYM_BROWSER_KIT, true);
  } catch (_) {}
  return view;
}
// On navigation, injected styles are wiped but renderer state isn't. Reset
// the flags + their menu labels so they match reality on the new page.
function _resetOverlayStateForNewPage() {
  _inappToolsState.grayscale = false;
  _inappToolsState.focus = false;
  // Re-render the tools menu if it's currently showing, so toggle pills match reality.
  if (_inappToolsState.open && _inappToolsState.current === 'menu') _renderInappToolsMenu();
}
async function _symKitCall(method, ...args) {
  const view = await _ensureSymKit();
  if (!view) return null;
  const js = `(function(){ try { return window.__symKit && window.__symKit.${method} ? window.__symKit.${method}(${args.map(a => JSON.stringify(a)).join(',')}) : null; } catch (e) { return { error: e.message || String(e) }; } })();`;
  try {
    return await view.executeJavaScript(js, true);
  } catch (_) {
    return null;
  }
}

// ── In-browser Tools (sidebar menu + sub-views) ─────────────────────────
const _inappToolsState = {
  open: false,
  current: null,
  brand: null,
  audit: null,
  patches: {
    loaded: null,
    list: []
  },
  grayscale: false,
  focus: false
};

// Legacy no-ops so any stray callers (keyboard shortcuts, etc.) keep working.
function toggleInappToolsMenu(ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  toggleInappToolsPanelMenu();
}
function closeInappToolsMenu() {}
function _closeInappToolsMenu() {}

// Open (or close) the tools panel and show the top-level menu.
function toggleInappToolsPanelMenu() {
  if (_inappToolsState.open && _inappToolsState.current === 'menu') {
    closeInappToolsPanel();
    return;
  }
  _openInappToolsPanel();
  _inappToolsState.current = 'menu';
  _renderInappToolsMenu();
}

// Tool registry: items shown in the menu. Keep order stable.
const _INAPP_TOOLS_ITEMS = [{
  kind: 'select',
  icon: 'crosshair',
  title: 'Select element',
  sub: 'Select and ask AI about this element.',
  toggle: true
}, {
  kind: 'sep'
}, {
  kind: 'brand',
  icon: 'palette',
  title: 'Detect brand',
  sub: 'Extract colors, fonts, logo, and meta from the current page.'
}, {
  kind: 'reader',
  icon: 'book-open',
  title: 'Reader view',
  sub: 'Strip the page down to its main article.'
}, {
  kind: 'sep'
}, {
  kind: 'grayscale',
  icon: 'contrast',
  title: 'Grayscale',
  sub: 'Strip color for design/accessibility review.',
  toggle: true
}, {
  kind: 'focus',
  icon: 'focus',
  title: 'Focus mode',
  sub: 'Hide navs, banners, sticky overlays.',
  toggle: true
}, {
  kind: 'sep'
}, {
  kind: 'patches',
  icon: 'history',
  title: 'Saved patches',
  sub: 'Re-apply saved DOM/style edits for this URL.'
}, {
  kind: 'shortcuts',
  icon: 'keyboard',
  title: 'Keyboard shortcuts',
  sub: 'i / h / ? / Esc'
}];
function _renderInappToolsMenu() {
  _setInappToolsTitle('Tools');
  const body = document.getElementById('inappToolsBody');
  if (!body) return;
  const esc = _escapeHtml;
  const isActive = kind => {
    if (kind === 'select') return !!(window._browserInspectState && _browserInspectState.enabled);
    if (kind === 'grayscale') return !!_inappToolsState.grayscale;
    if (kind === 'focus') return !!_inappToolsState.focus;
    return false;
  };
  const rows = _INAPP_TOOLS_ITEMS.map(it => {
    if (it.kind === 'sep') return '<div class="inapp-tools-sep"></div>';
    const active = it.toggle && isActive(it.kind) ? ' data-active="1"' : '';
    const badge = it.toggle && isActive(it.kind) ? '<span class="inapp-tools-pill">On</span>' : '';
    return '<button class="inapp-tools-item" type="button"' + active + ' data-tool-kind="' + esc(it.kind) + '">' + '<i data-lucide="' + esc(it.icon) + '"></i>' + '<div class="inapp-tools-item-copy">' + '<div class="inapp-tools-item-title">' + esc(it.title) + '</div>' + '<div class="inapp-tools-item-sub">' + esc(it.sub) + '</div>' + '</div>' + badge + '</button>';
  }).join('');
  body.innerHTML = '<div class="inapp-tools-menu-list">' + rows + '</div>';
  body.onclick = function (ev) {
    const item = ev.target && ev.target.closest && ev.target.closest('[data-tool-kind]');
    if (!item) return;
    ev.preventDefault();
    const kind = item.getAttribute('data-tool-kind');
    _runInappToolFromMenu(kind);
  };
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _runInappToolFromMenu(kind) {
  if (kind === 'select') {
    toggleInappInspectMode();
    _renderInappToolsMenu();
    return;
  }
  if (kind === 'grayscale') {
    toggleInappGrayscale().then(() => _renderInappToolsMenu());
    return;
  }
  if (kind === 'focus') {
    toggleInappFocusMode().then(() => _renderInappToolsMenu());
    return;
  }
  if (kind === 'shortcuts') {
    showInappShortcutsHelp();
    return;
  }
  openInappTool(kind);
}

// Back button for sub-views, rendered as the panel head's leading affordance.
function _setInappToolsHeadBack(label) {
  const head = document.querySelector('.inapp-tools-head');
  if (!head) return;
  const old = head.querySelector('.inapp-tools-back');
  if (old) old.remove();
  if (!label) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inapp-tools-back';
  btn.title = 'Back to tools';
  btn.setAttribute('aria-label', 'Back to tools');
  btn.innerHTML = '<i data-lucide="chevron-left"></i>';
  btn.onclick = () => {
    _inappToolsState.current = 'menu';
    _renderInappToolsMenu();
    _setInappToolsHeadBack('');
  };
  head.prepend(btn);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons({
      nodes: [btn]
    });
  } catch (_) {}
}

// Legacy shims so any stray callers continue to work.
function toggleInappMoreMenu(ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  toggleInappMorePanel();
}
function closeInappMoreMenu() {}

// "More" opens inside the same tools sidebar as a dedicated sub-view.
function toggleInappMorePanel() {
  if (_inappToolsState.open && _inappToolsState.current === 'more') {
    closeInappToolsPanel();
    return;
  }
  _openInappToolsPanel();
  _inappToolsState.current = 'more';
  _setInappToolsHeadBack('');
  _setInappToolsTitle('More');
  _renderInappMorePanel();
}
function _renderInappMorePanel() {
  const body = document.getElementById('inappToolsBody');
  if (!body) return;
  body.onclick = null;
  body.innerHTML = `
    <div class="inapp-tools-menu-list">
      <button class="inapp-tools-item" type="button" data-more-action="reset">
        <i data-lucide="refresh-ccw"></i>
        <div class="inapp-tools-item-copy">
          <div class="inapp-tools-item-title">Reset tab</div>
          <div class="inapp-tools-item-sub">Drop the webview, clear chat, start fresh.</div>
        </div>
      </button>
      <button class="inapp-tools-item" type="button" data-more-action="external">
        <i data-lucide="external-link"></i>
        <div class="inapp-tools-item-copy">
          <div class="inapp-tools-item-title">Open external</div>
          <div class="inapp-tools-item-sub">Open this URL in your system browser.</div>
        </div>
      </button>
      <div class="inapp-tools-sep"></div>
      <div style="display:flex;flex-direction:column;gap:6px;padding:4px 2px;">
        <div style="font:600 10px var(--font-ui);color:var(--subtext1);letter-spacing:0.5px;text-transform:uppercase;">Zoom</div>
        <div style="display:flex;gap:4px;align-items:center;">
          <button class="tab-bar-btn" type="button" data-more-action="zoom-out" title="Zoom out"><i data-lucide="minus" style="width:13px;height:13px;"></i></button>
          <button class="inapp-browser-zoom-value" type="button" id="inappBrowserZoomValue" data-more-action="zoom-reset" title="Reset zoom">100%</button>
          <button class="tab-bar-btn" type="button" data-more-action="zoom-in" title="Zoom in"><i data-lucide="plus" style="width:13px;height:13px;"></i></button>
        </div>
      </div>
    </div>
  `;
  body.onclick = function (ev) {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-more-action]');
    if (!t) return;
    ev.preventDefault();
    const action = t.getAttribute('data-more-action');
    if (action === 'reset') {
      resetBrowserTab();
      closeInappToolsPanel();
      return;
    }
    if (action === 'external') {
      inappBrowserOpenExternal();
      return;
    }
    if (action === 'zoom-out') {
      inappBrowserZoomOut();
      return;
    }
    if (action === 'zoom-reset') {
      inappBrowserZoomReset();
      return;
    }
    if (action === 'zoom-in') {
      inappBrowserZoomIn();
      return;
    }
  };
  try {
    _syncInappBrowserZoomUi();
  } catch (_) {}
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _openInappToolsPanel() {
  const p = document.getElementById('inappToolsPanel');
  if (!p) return;
  p.classList.add('open');
  _inappToolsState.open = true;
}
function closeInappToolsPanel() {
  const p = document.getElementById('inappToolsPanel');
  if (p) p.classList.remove('open');
  const wasInspect = _inappToolsState.current === 'inspect';
  const wasEmulate = _inappToolsState.current === 'emulate';
  _inappToolsState.open = false;
  _inappToolsState.current = null;
  _setInappToolsHeadBack('');
  if (wasInspect && _browserInspectState.enabled) toggleInappInspectMode(false);
  // Auto-reset device emulation on close so users can't get stuck with a
  // glitched page after leaving the Emulate tool with overrides applied.
  if (wasEmulate && typeof _emulateState !== 'undefined' && (_emulateState.device !== 'off' || _emulateState.colorScheme || _emulateState.reducedMotion || _emulateState.contrast || _emulateState.network !== 'no-throttle' || _emulateState.cpuRate !== 1)) {
    try {
      _resetAllEmulation();
    } catch (_) {}
  }
}
function _setInappToolsTitle(text) {
  const t = document.getElementById('inappToolsTitle');
  if (t) t.textContent = text;
}
// Tools normally render into the right-side panel (#inappToolsBody), but the
// consolidated tools (Elements/Issues/Audit/Emulate) render into the DevTools
// drawer body instead. _inappToolsTargetId points the render sink at whichever
// surface is currently hosting the tool, so interactive re-renders land there.
let _inappToolsTargetId = 'inappToolsBody';
function _setInappToolsBodyHtml(html) {
  const body = document.getElementById(_inappToolsTargetId);
  if (body) body.innerHTML = html;
}
function _setInappToolsBodyLoading(text) {
  _setInappToolsBodyHtml('<div class="inapp-tools-empty"><i data-lucide="loader"></i>' + (text || 'Working...') + '</div>');
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _setInappToolsBodyError(text) {
  _setInappToolsBodyHtml('<div class="inapp-tools-empty" style="color:var(--red);"><i data-lucide="alert-triangle"></i>' + _escapeHtml(text || 'Something went wrong.') + '</div>');
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}
async function openInappTool(kind) {
  _inappToolsTargetId = 'inappToolsBody';
  _openInappToolsPanel();
  _inappToolsState.current = kind;
  // Show a back arrow in the header so users can return to the tools menu.
  _setInappToolsHeadBack('back');
  // Reset the menu click handler since sub-views install their own.
  const body = document.getElementById('inappToolsBody');
  if (body) body.onclick = null;
  switch (kind) {
    case 'brand':
      await _runInappBrandDetect();
      break;
    case 'inspect':
      _runInappCodeInspect();
      break;
    case 'reader':
      await _runInappReaderView();
      break;
    case 'audit':
      await _runInappSiteAudit();
      break;
    case 'emulate':
      await _runInappEmulatePanel();
      break;
    case 'issues':
      await _runInappIssuesPanel();
      break;
    case 'patches':
      await _runInappPatchesPanel();
      break;
    default:
      _setInappToolsBodyHtml('<div class="inapp-tools-empty">Unknown tool.</div>');
  }
}

// ── Brand detect ─────────────────────────────────────────────────────────
const _BRAND_EXTRACT_SCRIPT = `(function(){
  function parseColor(str){
    if (!str) return null;
    var m = String(str).match(/rgba?\\((-?[0-9.]+)[,\\s]+(-?[0-9.]+)[,\\s]+(-?[0-9.]+)(?:[,/\\s]+([0-9.]+%?))?\\)/);
    if (!m) return null;
    var a = m[4] == null ? 1 : (String(m[4]).slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (a <= 0.02) return null;
    var r = Math.round(Math.max(0, Math.min(255, parseFloat(m[1]))));
    var g = Math.round(Math.max(0, Math.min(255, parseFloat(m[2]))));
    var b = Math.round(Math.max(0, Math.min(255, parseFloat(m[3]))));
    function h(v){ var x = v.toString(16); return x.length < 2 ? '0' + x : x; }
    return { hex: ('#' + h(r) + h(g) + h(b)).toLowerCase(), a: a };
  }
  function getMeta(name){
    var el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  }
  var title = document.title;
  var url = location.href;
  var host = location.hostname;
  var themeColor = getMeta('theme-color');
  var ogImage = getMeta('og:image');
  var ogSiteName = getMeta('og:site_name');
  var description = getMeta('og:description') || getMeta('description');
  var faviconEl = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  var favicon = faviconEl ? faviconEl.href : (location.origin + '/favicon.ico');

  // Palette: {hex, roles: Set, count}. Roles tell the user what the color is
  // used for (background / text / link / button-bg / button-text / border / accent / css-var).
  var byHex = {};
  function add(hex, role){
    if (!hex) return;
    hex = String(hex).toLowerCase();
    if (!byHex[hex]) byHex[hex] = { hex: hex, roles: {}, count: 0 };
    byHex[hex].roles[role] = (byHex[hex].roles[role] || 0) + 1;
    byHex[hex].count++;
  }
  function sample(el, role, prop){
    if (!el) return;
    try {
      var c = parseColor(getComputedStyle(el).getPropertyValue(prop));
      if (c) add(c.hex, role);
    } catch (_) {}
  }
  function sampleBorder(el){
    if (!el) return;
    try {
      var cs = getComputedStyle(el);
      ['border-top-color','border-right-color','border-bottom-color','border-left-color'].forEach(function(p){
        var c = parseColor(cs.getPropertyValue(p));
        if (c) add(c.hex, 'border');
      });
    } catch (_) {}
  }

  // Body defaults
  var body = document.body;
  sample(body, 'background', 'background-color');
  sample(body, 'text', 'color');

  // CSS custom properties on :root / html / body that look like color hex / rgb
  var CSSVAR_COLOR_RE = /^(#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\\(|hsla?\\()/i;
  var cssVars = [];
  try {
    var scopes = [document.documentElement, document.body];
    scopes.forEach(function(scope){
      if (!scope) return;
      var cs = getComputedStyle(scope);
      for (var i = 0; i < cs.length; i++) {
        var name = cs[i];
        if (name && name.indexOf('--') === 0) {
          var raw = cs.getPropertyValue(name).trim();
          if (CSSVAR_COLOR_RE.test(raw)) {
            var c = parseColor(raw);
            if (!c && raw.charAt(0) === '#') {
              // Expand 3-digit hex to 6-digit.
              var h = raw.replace('#','');
              if (h.length === 3) h = h.split('').map(function(x){return x+x;}).join('');
              h = h.slice(0, 6);
              c = /^[0-9a-f]{6}$/i.test(h) ? { hex: ('#' + h).toLowerCase(), a: 1 } : null;
            }
            if (c) {
              add(c.hex, 'css-var');
              if (cssVars.length < 24) cssVars.push({ name: name, hex: c.hex });
            }
          }
        }
      }
    });
  } catch (_) {}

  // Headings + links
  Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 6).forEach(function(h){ sample(h, 'heading', 'color'); });
  Array.from(document.querySelectorAll('a')).slice(0, 8).forEach(function(a){ sample(a, 'link', 'color'); });

  // Buttons: distinguish background from text explicitly.
  Array.from(document.querySelectorAll('button, [role="button"], [class*="btn"], .button, input[type="submit"], input[type="button"]')).slice(0, 10).forEach(function(b){
    sample(b, 'button-bg', 'background-color');
    sample(b, 'button-text', 'color');
    sampleBorder(b);
  });

  // Form fields
  var firstInput = document.querySelector('input[type="text"], input[type="email"], input[type="search"], textarea');
  if (firstInput) { sample(firstInput, 'input-bg', 'background-color'); sample(firstInput, 'input-text', 'color'); sampleBorder(firstInput); }

  // Theme color meta
  if (themeColor) {
    var tc = parseColor(themeColor) || (themeColor.charAt(0) === '#' ? { hex: themeColor.toLowerCase() } : null);
    if (tc) add(tc.hex, 'theme');
  }

  // Build palette. Each entry carries a primary label (most common role) + all roles.
  var ROLE_PRIORITY = ['theme','background','text','button-bg','button-text','link','heading','input-bg','input-text','border','css-var'];
  var palette = Object.keys(byHex).map(function(hex){
    var e = byHex[hex];
    var roles = Object.keys(e.roles);
    var primary = roles.slice().sort(function(a, b){
      var pa = ROLE_PRIORITY.indexOf(a); if (pa < 0) pa = 99;
      var pb = ROLE_PRIORITY.indexOf(b); if (pb < 0) pb = 99;
      return pa - pb;
    })[0] || 'color';
    return { hex: hex, role: primary, roles: roles, count: e.count };
  }).sort(function(a, b){
    var pa = ROLE_PRIORITY.indexOf(a.role); if (pa < 0) pa = 99;
    var pb = ROLE_PRIORITY.indexOf(b.role); if (pb < 0) pb = 99;
    if (pa !== pb) return pa - pb;
    return b.count - a.count;
  }).slice(0, 24);

  // Fonts
  var fonts = [];
  function addFont(family, role, size){
    family = (family || '').trim(); if (!family) return;
    var existing = fonts.find(function(f){return f.family === family;});
    if (existing){ if (existing.roles.indexOf(role) < 0) existing.roles.push(role); return; }
    fonts.push({ family: family, roles: [role], size: size });
  }
  if (body){ addFont(getComputedStyle(body).fontFamily, 'body', getComputedStyle(body).fontSize); }
  var h1 = document.querySelector('h1'); if (h1){ addFont(getComputedStyle(h1).fontFamily, 'heading', getComputedStyle(h1).fontSize); }
  var h2 = document.querySelector('h2'); if (h2){ addFont(getComputedStyle(h2).fontFamily, 'heading', getComputedStyle(h2).fontSize); }
  var btn = document.querySelector('button'); if (btn){ addFont(getComputedStyle(btn).fontFamily, 'ui', getComputedStyle(btn).fontSize); }

  return { title: title, url: url, host: host, themeColor: themeColor, ogImage: ogImage, ogSiteName: ogSiteName, description: description, favicon: favicon, palette: palette, cssVars: cssVars, fonts: fonts.slice(0, 4) };
})();`;
async function _runInappBrandDetect() {
  _setInappToolsTitle('Brand');
  _setInappToolsBodyLoading('Analyzing page...');
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') {
    _setInappToolsBodyError('Browser not ready.');
    return;
  }
  let data;
  try {
    data = await view.executeJavaScript(_BRAND_EXTRACT_SCRIPT, true);
  } catch (e) {
    _setInappToolsBodyError('Extraction failed: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  if (!data) {
    _setInappToolsBodyError('No data returned.');
    return;
  }
  _inappToolsState.brand = data;
  _renderInappBrandPanel(data);
}
function _renderInappBrandPanel(data) {
  const brandName = data.ogSiteName || data.title || data.host;
  const logoSrc = data.ogImage || data.favicon;
  const roleLabel = r => ({
    'theme': 'Theme',
    'background': 'Background',
    'text': 'Text',
    'link': 'Link',
    'heading': 'Heading',
    'button-bg': 'Button bg',
    'button-text': 'Button text',
    'border': 'Border',
    'input-bg': 'Input bg',
    'input-text': 'Input text',
    'css-var': 'CSS variable',
    'color': 'Color'
  })[r] || r;
  const palette = (data.palette || []).map(p => {
    const extraRoles = (p.roles || []).filter(r => r !== p.role);
    const subtitle = extraRoles.length ? extraRoles.map(roleLabel).join(', ') : '';
    return `
    <div class="brand-swatch" onclick="_copyText('${_escapeHtml(p.hex)}')" title="${_escapeHtml(p.hex)} — ${_escapeHtml(roleLabel(p.role))}${subtitle ? ' (also: ' + _escapeHtml(subtitle) + ')' : ''}">
      <div class="brand-swatch-chip" style="background:${_escapeHtml(p.hex)}"></div>
      <div class="brand-swatch-hex">${_escapeHtml(p.hex)}</div>
      <div class="brand-swatch-role">${_escapeHtml(roleLabel(p.role))}</div>
      ${subtitle ? `<div class="brand-swatch-sub" style="font:10px var(--font-ui);color:var(--subtext0);text-align:center;margin-top:1px;">${_escapeHtml(subtitle)}</div>` : ''}
    </div>
  `;
  }).join('');
  const cssVars = (data.cssVars || []).map(v => `
    <div class="brand-meta-row" onclick="_copyText('${_escapeHtml(v.name)}')" style="cursor:pointer;" title="Click to copy ${_escapeHtml(v.name)}">
      <span class="k" style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${_escapeHtml(v.hex)};border:1px solid rgba(0,0,0,0.15);"></span><code>${_escapeHtml(v.name)}</code></span>
      <span class="v" style="font:500 11px var(--font-mono);">${_escapeHtml(v.hex)}</span>
    </div>
  `).join('');
  const fonts = (data.fonts || []).map(f => `
    <div class="brand-font" style="font-family:${_escapeHtml(f.family)};">
      <div class="brand-font-role">${_escapeHtml(f.roles.join(' + '))}</div>
      <div class="brand-font-family">The quick brown fox</div>
      <div class="brand-font-meta">${_escapeHtml(f.family)}${f.size ? ' — ' + _escapeHtml(f.size) : ''}</div>
    </div>
  `).join('');
  const meta = [data.description ? {
    k: 'Description',
    v: data.description
  } : null, data.themeColor ? {
    k: 'Theme color',
    v: data.themeColor
  } : null, {
    k: 'Host',
    v: data.host
  }, {
    k: 'URL',
    v: data.url
  }].filter(Boolean).map(r => `<div class="brand-meta-row"><span class="k">${_escapeHtml(r.k)}</span><span class="v">${_escapeHtml(r.v)}</span></div>`).join('');
  const html = `
    <div class="brand-header">
      <div class="brand-header-logo">${logoSrc ? '<img src="' + _escapeHtml(logoSrc) + '" alt="" onerror="this.remove()"/>' : ''}</div>
      <div style="min-width:0;flex:1;">
        <div class="brand-header-name">${_escapeHtml(brandName)}</div>
        <div class="brand-header-url">${_escapeHtml(data.host)}</div>
      </div>
    </div>
    ${palette ? '<div class="brand-section-title">Palette</div><div class="brand-palette">' + palette + '</div>' : ''}
    ${cssVars ? '<div class="brand-section-title">CSS variables</div><div style="display:flex;flex-direction:column;gap:4px;">' + cssVars + '</div>' : ''}
    ${fonts ? '<div class="brand-section-title">Typography</div><div style="display:flex;flex-direction:column;gap:8px;">' + fonts + '</div>' : ''}
    ${meta ? '<div class="brand-section-title">Meta</div><div style="display:flex;flex-direction:column;gap:4px;">' + meta + '</div>' : ''}
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
      <button class="tab-bar-btn" type="button" onclick="_saveBrandToNote()"><i data-lucide="save" style="width:13px;height:13px;"></i> Save to note</button>
      <button class="tab-bar-btn" type="button" onclick="_runInappBrandDetect()"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> Refresh</button>
      <button class="tab-bar-btn" type="button" onclick="_refineBrandWithAi()"><i data-lucide="sparkles" style="width:13px;height:13px;"></i> Ask AI to refine</button>
    </div>
  `;
  _setInappToolsBodyHtml(html);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _copyText(text) {
  try {
    navigator.clipboard.writeText(text);
    toast('Copied ' + text, 'success', {
      duration: 1400
    });
  } catch (_) {}
}
async function _saveBrandToNote() {
  const data = _inappToolsState.brand;
  if (!data) return;
  const brandName = data.ogSiteName || data.title || data.host;
  const palette = (data.palette || []).map(p => `- \`${p.hex}\` — ${p.role}`).join('\n');
  const fonts = (data.fonts || []).map(f => `- **${f.roles.join(' + ')}:** ${f.family}${f.size ? ' (' + f.size + ')' : ''}`).join('\n');
  const md = [`# ${brandName}`, '', data.description ? `> ${data.description}` : null, '', `- **URL:** ${data.url}`, data.themeColor ? `- **Theme color:** \`${data.themeColor}\`` : null, data.ogImage ? `- **Logo:** ${data.ogImage}` : null, data.favicon ? `- **Favicon:** ${data.favicon}` : null, '', '## Palette', palette || '_None detected._', '', '## Typography', fonts || '_None detected._', '', `_Captured ${new Date().toISOString()}_`].filter(l => l !== null).join('\n');
  const safeName = 'Brand — ' + (brandName || data.host).replace(/[^\w\s-]/g, '').slice(0, 80);
  try {
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: safeName
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: safeName,
        content: md
      })
    });
    toast('Saved to note: ' + safeName, 'success');
  } catch (e) {
    toast('Save failed: ' + (e && e.message ? e.message : String(e)), 'error');
  }
}
function _refineBrandWithAi() {
  const data = _inappToolsState.brand;
  if (!data) return;
  _ensureBrowserAgentPanelOpen();
  const input = _getBrowserAgentInput();
  if (!input) return;
  const lines = ["Refine and enrich this brand snapshot I extracted from the current page. Identify the actual brand name if different from what's here, dedupe near-duplicate colors, label primary / secondary / accent roles, and suggest a concise brand description. Respond with a clean Markdown brief.", '', '```json', JSON.stringify(data, null, 2), '```'];
  input.value = lines.join('\n');
  _autosizeAgentInput(input);
  input.focus();
}

// ── Code inspect ─────────────────────────────────────────────────────────
state._inspectActiveSelector = '';
function _runInappCodeInspect() {
  _setInappToolsTitle('Inspect code');
  _ensureSymKit();
  if (!_browserInspectState.enabled) {
    toggleInappInspectMode(true);
  } else {
    const view = _ensureInappBrowser();
    if (view) _applyInappInspectMode(view);
  }
  _renderInappCodeInspect();
}
function _renderInappCodeInspect() {
  const sel = _browserInspectState.selected;
  if (!sel) {
    state._inspectActiveSelector = '';
    _setInappToolsBodyHtml('<div class="code-inspect-empty"><i data-lucide="mouse-pointer-click" style="width:24px;height:24px;display:block;margin:0 auto 10px;color:var(--subtext1);"></i>Inspect mode is on. Click any element in the page to inspect its code.</div>');
    try {
      if (window.lucide && lucide.createIcons) lucide.createIcons();
    } catch (_) {}
    return;
  }
  state._inspectActiveSelector = sel.selector || '';
  const attrs = sel.attributes || {};
  const attrRows = Object.keys(attrs).length ? Object.entries(attrs).map(([k, v]) => `<div class="k">${_escapeHtml(k)}</div><div class="v">${_escapeHtml(v)}</div>`).join('') : '<div class="k" style="grid-column:1/-1;color:var(--subtext0);">No attributes</div>';
  _setInappToolsBodyHtml(`
    <div class="code-inspect-head">
      <div style="display:flex;gap:6px;align-items:center;">
        <div class="code-inspect-tag" style="flex:1;">&lt;${_escapeHtml(sel.tagName || 'element')}&gt;</div>
        <button class="tab-bar-btn" type="button" id="inspectEditBtn" title="Edit text inline (E to toggle, Esc to save)" onclick="_inspectToggleEdit()"><i data-lucide="edit-3" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" id="inspectHideBtn" title="Hide / show element (H)" data-hidden="false" onclick="_inspectHideSelected()"><i data-lucide="eye" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" title="Remove element" onclick="_inspectRemoveSelected()"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" title="Scroll into view" onclick="_inspectScrollSelected()"><i data-lucide="crosshair" style="width:13px;height:13px;"></i></button>
      </div>
      ${sel.text ? '<div class="code-inspect-text" style="margin-top:6px;">' + _escapeHtml(_shortenBrowserText(sel.text, 200)) + '</div>' : ''}
    </div>
    <div id="inappInspectAltSelectors"></div>
    <div id="inappInspectBoxModel"></div>
    <div id="inappInspectQuickEdit"></div>
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Attributes</div>
      <div class="code-inspect-kv">${attrRows}</div>
    </div>
    <div id="inappCodeInspectStyles"><div class="inapp-tools-empty"><i data-lucide="loader" style="width:20px;height:20px;"></i>Loading computed styles...</div></div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
  _loadCodeInspectAll(sel).catch(() => {});
}
async function _loadCodeInspectAll(sel) {
  const selector = state._inspectActiveSelector || sel.selector || '';
  if (!selector) return;
  await _ensureSymKit();
  _renderInspectAltSelectors(selector).catch(() => {});
  _renderInspectBoxModel(selector).catch(() => {});
  await _loadCodeInspectStyles(sel, selector);
}
async function _renderInspectAltSelectors(selector) {
  const target = document.getElementById('inappInspectAltSelectors');
  if (!target) return;
  const alts = await _symKitCall('altSelectors', selector);
  if (!Array.isArray(alts) || !alts.length) {
    target.innerHTML = '';
    return;
  }
  target.innerHTML = `
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Selectors</div>
      <div onmouseleave="_symKitCall('clearHighlight')">
        ${alts.map(a => {
    const s = JSON.stringify(a.selector).replace(/"/g, '&quot;');
    return `<div class="alt-selector-row ${a.selector === state._inspectActiveSelector ? 'active' : ''}" onmouseenter="_symKitCall('highlightAll', ${s})" onclick="_pickInspectSelector(${s})"><span class="sel">${_escapeHtml(a.selector)}</span><span class="count">${a.count}</span><span class="label">${_escapeHtml(a.label)}</span></div>`;
  }).join('')}
      </div>
    </div>
  `;
}
function _pickInspectSelector(selector) {
  state._inspectActiveSelector = selector;
  _renderInspectAltSelectors(selector).catch(() => {});
  _renderInspectBoxModel(selector).catch(() => {});
  const sel = _browserInspectState.selected || {};
  _loadCodeInspectStyles(sel, selector).catch(() => {});
}
async function _renderInspectBoxModel(selector) {
  const target = document.getElementById('inappInspectBoxModel');
  if (!target) return;
  const bm = await _symKitCall('getBoxModel', selector);
  if (!bm) {
    target.innerHTML = '';
    return;
  }
  const r = n => n || 0;
  target.innerHTML = `
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Box model</div>
      <div class="box-model">
        <div class="box-model-margin">
          <span class="box-model-label">margin</span>
          <span class="box-model-edge top">${r(bm.margin.top)}</span>
          <span class="box-model-edge bottom">${r(bm.margin.bottom)}</span>
          <span class="box-model-edge left">${r(bm.margin.left)}</span>
          <span class="box-model-edge right">${r(bm.margin.right)}</span>
          <div class="box-model-border">
            <span class="box-model-label">border</span>
            <span class="box-model-edge top">${r(bm.border.top)}</span>
            <span class="box-model-edge bottom">${r(bm.border.bottom)}</span>
            <span class="box-model-edge left">${r(bm.border.left)}</span>
            <span class="box-model-edge right">${r(bm.border.right)}</span>
            <div class="box-model-padding">
              <span class="box-model-label">padding</span>
              <span class="box-model-edge top">${r(bm.padding.top)}</span>
              <span class="box-model-edge bottom">${r(bm.padding.bottom)}</span>
              <span class="box-model-edge left">${r(bm.padding.left)}</span>
              <span class="box-model-edge right">${r(bm.padding.right)}</span>
              <div class="box-model-content">${bm.width} × ${bm.height}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
function _renderInspectQuickEdit(selector, styles) {
  const target = document.getElementById('inappInspectQuickEdit');
  if (!target) return;
  const esc = v => _escapeHtml(v || '');
  const S = JSON.stringify(selector).replace(/"/g, '&quot;');
  const color = (styles['color'] || '').trim();
  const bg = (styles['background-color'] || '').trim();
  const colorHex = _rgbToHex(color);
  const bgHex = _rgbToHex(bg);
  target.innerHTML = `
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Quick edit</div>
      <div class="quick-edit-grid">
        <label>Color</label>
        <div class="color-row">
          <div class="color-chip" style="background:${esc(color) || 'transparent'}" onclick="_openColorEditorAtChip(this, ${S}, 'color', ${JSON.stringify(colorHex || '#000000').replace(/"/g, '&quot;')})" title="Pick"></div>
          <input type="text" value="${esc(color)}" onchange="_applyInspectStyle(${S}, 'color', this.value)" placeholder="e.g. #1a1a1a">
        </div>
        <label>Background</label>
        <div class="color-row">
          <div class="color-chip" style="background:${esc(bg) || 'transparent'}" onclick="_openColorEditorAtChip(this, ${S}, 'background-color', ${JSON.stringify(bgHex || '#ffffff').replace(/"/g, '&quot;')})" title="Pick"></div>
          <input type="text" value="${esc(bg)}" onchange="_applyInspectStyle(${S}, 'background-color', this.value)" placeholder="e.g. #fafafa">
        </div>
        <label>Font size</label>
        <input type="text" value="${esc(styles['font-size'])}" onchange="_applyInspectStyle(${S}, 'font-size', this.value)" placeholder="e.g. 16px">
        <label>Font weight</label>
        <select onchange="_applyInspectStyle(${S}, 'font-weight', this.value)">${['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'].map(w => `<option value="${w}" ${String(styles['font-weight']).trim() === w ? 'selected' : ''}>${w}</option>`).join('')}</select>
        <label>Padding</label>
        <input type="text" value="${esc(styles['padding'])}" onchange="_applyInspectStyle(${S}, 'padding', this.value)" placeholder="e.g. 12px 20px">
        <label>Margin</label>
        <input type="text" value="${esc(styles['margin'])}" onchange="_applyInspectStyle(${S}, 'margin', this.value)" placeholder="e.g. 0 auto">
        <label>Display</label>
        <select onchange="_applyInspectStyle(${S}, 'display', this.value)">${['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'contents'].map(d => `<option value="${d}" ${String(styles['display']).trim() === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
      </div>
    </div>
  `;
}
async function _loadCodeInspectStyles(sel, forcedSelector) {
  const view = _getInappWebview();
  if (!view || view.tagName.toLowerCase() !== 'webview') return;
  const selector = forcedSelector || sel.selector || '';
  if (!selector) return;
  const script = `(function(){
    try {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var cs = getComputedStyle(el);
      var keys = ['color','background-color','background-image','font-family','font-size','font-weight','line-height','letter-spacing','text-transform','text-align','border','border-radius','box-shadow','opacity','padding','margin','width','height','display','position','z-index','cursor','transition','transform'];
      var out = {}; keys.forEach(function(k){ try { out[k] = cs.getPropertyValue(k); } catch(_){} });
      return out;
    } catch (e) { return null; }
  })();`;
  let styles = null;
  try {
    styles = await view.executeJavaScript(script, true);
  } catch (_) {}
  _renderInspectQuickEdit(selector, styles || {});
  const target = document.getElementById('inappCodeInspectStyles');
  if (!target) return;
  if (!styles) {
    target.innerHTML = '<div class="inapp-tools-empty" style="color:var(--subtext0);">Could not read computed styles.</div>';
    return;
  }
  const groups = {
    'Typography': ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align'],
    'Colors': ['color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'opacity'],
    'Layout': ['display', 'position', 'z-index', 'width', 'height', 'padding', 'margin', 'cursor', 'transform'],
    'Motion': ['transition']
  };
  function isColor(key, val) {
    if (!val) return false;
    if (key === 'color' || key === 'background-color') return /^rgb/.test(val) && !/rgba\([^,]+,[^,]+,[^,]+,\s*0\)/.test(val);
    return false;
  }
  function wrapNumbers(val) {
    return String(val).replace(/(-?\d+(?:\.\d+)?)(px|em|rem|%)/g, '<span class="scrub" data-unit="$2" data-val="$1" onmousedown="_scrubStart(event, this)" title="Alt+drag to scrub">$1$2</span>');
  }
  const blocks = Object.entries(groups).map(([groupName, keys]) => {
    const rows = keys.filter(k => styles[k] && styles[k].trim()).map(k => {
      const v = styles[k];
      const scrubbable = !isColor(k, v) && /\d+(px|em|rem|%)/.test(v);
      let displayV = _escapeHtml(v);
      if (scrubbable) displayV = wrapNumbers(displayV);
      let swatch = '';
      if (isColor(k, v)) {
        const hex = _rgbToHex(v) || v;
        const S = JSON.stringify(state._inspectActiveSelector).replace(/"/g, '&quot;');
        const K = JSON.stringify(k).replace(/"/g, '&quot;');
        const H = JSON.stringify(hex).replace(/"/g, '&quot;');
        swatch = `<span class="chip" style="background:${_escapeHtml(v)}" onclick="_openColorEditorAtChip(this, ${S}, ${K}, ${H})"></span>`;
      }
      const propCell = `<div class="k prop" data-prop="${_escapeHtml(k)}" onmouseenter="_propdocShow(event, this)" onmouseleave="_propdocHide()">${_escapeHtml(k)}</div>`;
      const K = JSON.stringify(k).replace(/"/g, '&quot;');
      const V = JSON.stringify(v).replace(/"/g, '&quot;');
      const valCell = `<div class="v${swatch ? ' swatch' : ''}" onmouseenter="_quickviewShow(event, ${K}, ${V})" onmouseleave="_quickviewHide()" data-prop="${_escapeHtml(k)}">${swatch}${displayV}</div>`;
      return propCell + valCell;
    }).join('');
    if (!rows) return '';
    return `<div class="code-inspect-group"><div class="code-inspect-group-title">${_escapeHtml(groupName)}</div><div class="code-inspect-kv">${rows}</div></div>`;
  }).join('');
  target.innerHTML = blocks || '<div class="inapp-tools-empty">No styles.</div>';
}
async function _inspectHideSelected() {
  const sel = state._inspectActiveSelector;
  if (!sel) return;
  await _ensureSymKit();
  const res = await _symKitCall('toggleVisibility', sel);
  const nowHidden = !!(res && res.nowHidden);
  if (nowHidden) _recordPatch({
    op: 'hide',
    selector: sel
  });
  // Swap the icon between "eye-off" (element is currently hidden, click to
  // show) and "eye" (element is visible, click to hide). Lucide replaces
  // the <i> tag with an <svg> on first render, so toggling data-lucide on
  // the old <i> is a no-op — we have to re-inject a fresh <i> and rerun
  // createIcons to get a new SVG each time.
  const btn = document.getElementById('inspectHideBtn');
  if (btn) {
    btn.dataset.hidden = nowHidden ? 'true' : 'false';
    btn.title = nowHidden ? 'Show element (H)' : 'Hide element (H)';
    const iconName = nowHidden ? 'eye-off' : 'eye';
    btn.innerHTML = '<i data-lucide="' + iconName + '" style="width:13px;height:13px;"></i>';
    try {
      lucide.createIcons({
        nodes: [btn]
      });
    } catch (_) {}
  }
  toast(nowHidden ? 'Hidden (click again to show)' : 'Shown', 'success', {
    duration: 1200
  });
}
async function _inspectRemoveSelected() {
  const sel = state._inspectActiveSelector;
  if (!sel) return;
  const view = _getInappWebview();
  if (!view) return;
  const js = `(function(){ var el = document.querySelector(${JSON.stringify(sel)}); if (el && el.parentNode) { el.parentNode.removeChild(el); return true; } return false; })();`;
  try {
    await view.executeJavaScript(js, true);
  } catch (_) {}
  _recordPatch({
    op: 'remove',
    selector: sel
  });
  _clearBrowserSelection();
  toast('Removed', 'success', {
    duration: 1200
  });
}
async function _inspectScrollSelected() {
  const sel = state._inspectActiveSelector;
  if (!sel) return;
  const view = _getInappWebview();
  if (!view) return;
  const js = `(function(){ var el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; })();`;
  try {
    await view.executeJavaScript(js, true);
  } catch (_) {}
}

// ── Inline text editor ──────────────────────────────────────────────────
state._inspectIsEditing = false;
state._inspectEditStartHtml = '';
state._inspectEditingSelector = '';
state._inspectWasInspectOnBeforeEdit = false;
async function _inspectToggleEdit() {
  // While editing, we already have the target - ignore the live selector
  // (which may have been cleared when we paused inspect mode on entry).
  const sel = state._inspectIsEditing ? state._inspectEditingSelector : state._inspectActiveSelector;
  if (!sel) {
    toast('Select an element first', 'info', {
      duration: 1200
    });
    return;
  }
  const view = _getInappWebview();
  if (!view) return;
  const btn = document.getElementById('inspectEditBtn');
  if (!state._inspectIsEditing) {
    // Enter edit mode. Inspect mode captures clicks globally, so pause it.
    state._inspectWasInspectOnBeforeEdit = _browserInspectState.enabled;
    if (_browserInspectState.enabled) toggleInappInspectMode(false);
    const entered = await view.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.contentEditable = 'true';
      el.dataset.symEditing = '1';
      el.style.setProperty('outline', '2px solid #a6e3a1', 'important');
      el.style.setProperty('outline-offset', '2px', 'important');
      el.style.setProperty('cursor', 'text', 'important');
      el.focus({ preventScroll: false });
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var s = window.getSelection();
        s.removeAllRanges(); s.addRange(range);
      } catch (_) {}
      // Floating "Done editing" button pinned above the element so there's
      // always a visible way out, independent of the host's inspect panel.
      var done = document.createElement('button');
      done.id = '__symphoneeEditDone';
      done.type = 'button';
      done.textContent = 'Done editing';
      done.contentEditable = 'false';
      done.style.cssText = 'position:fixed;z-index:2147483647;padding:8px 14px;border-radius:18px;border:1px solid rgba(166,227,161,0.6);background:#1d3a28;color:#a6e3a1;font:600 12px system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,0.35);';
      function pinBtn(){
        var r = el.getBoundingClientRect();
        var top = Math.max(8, r.top - 40);
        var left = Math.min(window.innerWidth - 140, Math.max(8, r.left));
        done.style.top = top + 'px';
        done.style.left = left + 'px';
      }
      pinBtn();
      window.addEventListener('scroll', pinBtn, true);
      window.addEventListener('resize', pinBtn, true);
      done.addEventListener('mousedown', function(ev){ ev.preventDefault(); });
      done.addEventListener('click', function(ev){
        ev.preventDefault(); ev.stopPropagation();
        console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'Escape' }));
      });
      // Local Esc handler so focus-inside-the-element Esc still exits.
      function onEditKey(ev){
        if (ev.key === 'Escape') {
          ev.preventDefault(); ev.stopPropagation();
          console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'Escape' }));
        }
      }
      el.addEventListener('keydown', onEditKey, true);
      // Stash refs for the exit path.
      window.__symphoneeEditState = { el: el, done: done, pinBtn: pinBtn, onEditKey: onEditKey };
      document.documentElement.appendChild(done);
      return { html: el.innerHTML };
    })();`, true);
    if (!entered) {
      toast('Element not found', 'error');
      return;
    }
    state._inspectEditStartHtml = entered.html || '';
    state._inspectEditingSelector = sel;
    state._inspectIsEditing = true;
    if (btn) btn.classList.add('inspecting');
    toast('Editing — press Esc or click Done editing to save', 'info', {
      duration: 2400
    });
  } else {
    // Exit edit mode, commit changes.
    const committed = await view.executeJavaScript(`(function(){
      var st = window.__symphoneeEditState;
      var el = (st && st.el) || document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.contentEditable = 'false';
      delete el.dataset.symEditing;
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('cursor');
      if (el.blur) el.blur();
      if (st) {
        try { window.removeEventListener('scroll', st.pinBtn, true); } catch(_){}
        try { window.removeEventListener('resize', st.pinBtn, true); } catch(_){}
        try { el.removeEventListener('keydown', st.onEditKey, true); } catch(_){}
        try { if (st.done && st.done.parentNode) st.done.parentNode.removeChild(st.done); } catch(_){}
      }
      var existing = document.getElementById('__symphoneeEditDone');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      window.__symphoneeEditState = null;
      return { html: el.innerHTML };
    })();`, true);
    state._inspectIsEditing = false;
    if (btn) btn.classList.remove('inspecting');
    if (committed && committed.html !== state._inspectEditStartHtml) {
      _recordPatch({
        op: 'html',
        selector: sel,
        html: committed.html
      });
      toast('Edit saved', 'success', {
        duration: 1200
      });
    } else {
      toast('No changes', 'info', {
        duration: 1000
      });
    }
    state._inspectEditStartHtml = '';
    state._inspectEditingSelector = '';
    if (state._inspectWasInspectOnBeforeEdit) toggleInappInspectMode(true);
  }
}
async function _applyInspectStyle(selector, prop, value) {
  const view = _getInappWebview();
  if (!view) return;
  const js = `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.style.setProperty(${JSON.stringify(prop)}, ${JSON.stringify(String(value || ''))}); return true; })();`;
  try {
    await view.executeJavaScript(js, true);
  } catch (_) {}
  _recordPatch({
    op: 'style',
    selector,
    prop,
    value
  });
  _renderInspectBoxModel(selector).catch(() => {});
}

// ── Color popover ────────────────────────────────────────────────────────
state._colorPopoverEl = null;
function _closeColorPopover() {
  if (state._colorPopoverEl) {
    state._colorPopoverEl.remove();
    state._colorPopoverEl = null;
  }
  document.removeEventListener('mousedown', _colorPopoverClickAway, true);
}
function _colorPopoverClickAway(ev) {
  if (state._colorPopoverEl && !state._colorPopoverEl.contains(ev.target)) _closeColorPopover();
}
function _openColorEditorAtChip(chipEl, selector, prop, initialHex) {
  _closeColorPopover();
  const rect = chipEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'sym-color-popover';
  const palette = _inappToolsState.brand && _inappToolsState.brand.palette || [];
  const swatchHtml = palette.length ? `<div class="sym-color-popover-title">Brand palette</div><div class="swatches">${palette.slice(0, 12).map(p => `<div class="sw" style="background:${_escapeHtml(p.hex)}" title="${_escapeHtml(p.hex)} — ${_escapeHtml(p.role)}" data-hex="${_escapeHtml(p.hex)}"></div>`).join('')}</div>` : '';
  pop.innerHTML = `
    <div class="sym-color-popover-title">${_escapeHtml(prop)}</div>
    <input type="color" value="${_escapeHtml(initialHex || '#000000')}">
    <input class="hex" type="text" value="${_escapeHtml(initialHex || '')}" spellcheck="false">
    ${swatchHtml}
  `;
  document.body.appendChild(pop);
  const popW = pop.offsetWidth || 240;
  const left = Math.min(window.innerWidth - popW - 8, Math.max(8, rect.left));
  const top = Math.min(window.innerHeight - pop.offsetHeight - 8, rect.bottom + 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  state._colorPopoverEl = pop;
  const colorInput = pop.querySelector('input[type="color"]');
  const hexInput = pop.querySelector('input.hex');
  function apply(hex) {
    hexInput.value = hex;
    colorInput.value = hex;
    _applyInspectStyle(selector, prop, hex);
    chipEl.style.background = hex;
  }
  colorInput.oninput = () => apply(colorInput.value);
  hexInput.oninput = () => {
    const v = hexInput.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) apply(v.startsWith('#') ? v : '#' + v);
  };
  pop.querySelectorAll('.sw').forEach(sw => {
    sw.onclick = () => apply(sw.dataset.hex);
  });
  setTimeout(() => document.addEventListener('mousedown', _colorPopoverClickAway, true), 0);
}
function _rgbToHex(rgb) {
  if (!rgb) return null;
  const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return /^#[0-9a-fA-F]{3,8}$/.test(rgb) ? rgb : null;
  const h = v => {
    const x = parseInt(v, 10).toString(16);
    return x.length < 2 ? '0' + x : x;
  };
  return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}

// ── QuickView popover ────────────────────────────────────────────────────
state._quickviewEl = null;
function _quickviewHide() {
  if (state._quickviewEl) {
    state._quickviewEl.remove();
    state._quickviewEl = null;
  }
}
function _quickviewShow(ev, prop, value) {
  _quickviewHide();
  let content = '';
  const urlMatch = String(value).match(/url\((['"]?)([^'")]+)\1\)/);
  if (urlMatch && /^(https?:|data:)/.test(urlMatch[2])) {
    content = `<img src="${_escapeHtml(urlMatch[2])}" alt=""/>`;
  } else if (/^(rgb|hsl|#[0-9a-f])/i.test(String(value).trim())) {
    content = `<div class="sq-color" style="background:${_escapeHtml(value)}"></div><div style="font:10px var(--font-mono);margin-top:4px;">${_escapeHtml(value)}</div>`;
  } else {
    const bez = String(value).match(/cubic-bezier\(([^)]+)\)/);
    if (bez) {
      const pts = bez[1].split(',').map(s => parseFloat(s));
      if (pts.length === 4 && pts.every(n => !isNaN(n))) {
        content = `<svg width="160" height="80" viewBox="0 0 160 80"><path d="M 0 80 C ${pts[0] * 160} ${80 - pts[1] * 80}, ${pts[2] * 160} ${80 - pts[3] * 80}, 160 0" fill="none" stroke="#89b4fa" stroke-width="2"/></svg><div style="font:10px var(--font-mono);margin-top:4px;">${_escapeHtml(value)}</div>`;
      }
    }
  }
  if (!content) return;
  const qv = document.createElement('div');
  qv.className = 'sym-quickview';
  qv.innerHTML = content;
  document.body.appendChild(qv);
  const r = ev.target.getBoundingClientRect();
  const top = Math.min(window.innerHeight - qv.offsetHeight - 8, r.bottom + 6);
  const left = Math.min(window.innerWidth - qv.offsetWidth - 8, r.left);
  qv.style.left = left + 'px';
  qv.style.top = top + 'px';
  state._quickviewEl = qv;
}

// ── Property docs ────────────────────────────────────────────────────────
const _PROP_DOCS = {
  'color': {
    sum: 'Sets the foreground (text) color.',
    vals: '<color> | currentColor | inherit'
  },
  'background-color': {
    sum: 'Sets the background color.',
    vals: '<color> | transparent | currentColor'
  },
  'background-image': {
    sum: 'One or more background images. Multiple images stack, first on top.',
    vals: 'none | <image> | url() | linear-gradient() | radial-gradient()'
  },
  'font-family': {
    sum: 'Prioritized list of font families.',
    vals: '<family-name>, <generic> (serif | sans-serif | monospace)'
  },
  'font-size': {
    sum: 'Size of the text.',
    vals: '<length> | <percentage> | xx-small..xx-large'
  },
  'font-weight': {
    sum: 'Weight (boldness) of the font.',
    vals: '100..900 | normal | bold | lighter | bolder'
  },
  'line-height': {
    sum: 'Distance between lines of text.',
    vals: 'normal | <number> | <length> | <percentage>'
  },
  'letter-spacing': {
    sum: 'Horizontal spacing between characters.',
    vals: 'normal | <length>'
  },
  'text-transform': {
    sum: 'Capitalization.',
    vals: 'none | capitalize | uppercase | lowercase'
  },
  'text-align': {
    sum: 'Horizontal alignment of inline content.',
    vals: 'left | right | center | justify | start | end'
  },
  'padding': {
    sum: 'Space inside the border. Shorthand 1-4 values.',
    vals: '<length> | <percentage>'
  },
  'margin': {
    sum: 'Space outside the border. auto centers.',
    vals: '<length> | <percentage> | auto'
  },
  'border': {
    sum: 'Shorthand for border-width/style/color.',
    vals: '<line-width> <line-style> <color>'
  },
  'border-radius': {
    sum: 'Rounds the corners.',
    vals: '<length> | <percentage>'
  },
  'box-shadow': {
    sum: 'Drop shadow. Multiple comma-separated.',
    vals: '[inset?] <x> <y> <blur> <spread>? <color>'
  },
  'opacity': {
    sum: 'Transparency of the element and all children.',
    vals: '0 .. 1'
  },
  'display': {
    sum: 'How the element participates in layout.',
    vals: 'block | inline | inline-block | flex | grid | none | contents'
  },
  'position': {
    sum: 'Positioning scheme.',
    vals: 'static | relative | absolute | fixed | sticky'
  },
  'z-index': {
    sum: 'Stacking order on the Z axis.',
    vals: 'auto | <integer>'
  },
  'width': {
    sum: 'Inner width of the content box.',
    vals: '<length> | <percentage> | auto | min/max/fit-content'
  },
  'height': {
    sum: 'Inner height of the content box.',
    vals: '<length> | <percentage> | auto | min/max-content'
  },
  'cursor': {
    sum: 'Mouse cursor on hover.',
    vals: 'auto | pointer | text | move | grab | not-allowed | ...'
  },
  'transform': {
    sum: 'Geometric transforms.',
    vals: 'translate() | scale() | rotate() | skew() | matrix()'
  },
  'transition': {
    sum: 'Shorthand for transition-*.',
    vals: '<property> <duration> <timing>? <delay>?'
  }
};
state._propdocEl = null;
function _propdocHide() {
  if (state._propdocEl) {
    state._propdocEl.remove();
    state._propdocEl = null;
  }
}
function _propdocShow(ev, targetEl) {
  _propdocHide();
  const prop = targetEl && targetEl.dataset ? targetEl.dataset.prop : '';
  const info = _PROP_DOCS[prop];
  if (!info) return;
  const d = document.createElement('div');
  d.className = 'sym-propdoc';
  d.innerHTML = `<div class="name">${_escapeHtml(prop)}</div><div class="sum">${_escapeHtml(info.sum)}</div><div class="vals">${_escapeHtml(info.vals)}</div>`;
  document.body.appendChild(d);
  const r = targetEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - d.offsetWidth - 8, r.right + 8);
  const top = Math.min(window.innerHeight - d.offsetHeight - 8, r.top);
  d.style.left = left + 'px';
  d.style.top = top + 'px';
  state._propdocEl = d;
}

// ── Number scrubbing (Alt+drag) ─────────────────────────────────────────
state._scrubState = null;
function _scrubStart(ev, el) {
  if (!ev.altKey) return;
  ev.preventDefault();
  const unit = el.dataset.unit;
  const base = parseFloat(el.dataset.val) || 0;
  const prop = el.parentElement && el.parentElement.dataset ? el.parentElement.dataset.prop : null;
  if (!prop || !state._inspectActiveSelector) return;
  state._scrubState = {
    startX: ev.clientX,
    base,
    unit,
    prop,
    el,
    selector: state._inspectActiveSelector,
    last: base
  };
  document.addEventListener('mousemove', _scrubMove, true);
  document.addEventListener('mouseup', _scrubEnd, true);
  document.body.style.cursor = 'ew-resize';
}
function _scrubMove(ev) {
  if (!state._scrubState) return;
  const delta = ev.clientX - state._scrubState.startX;
  const step = ev.shiftKey ? 10 : 1;
  const next = Math.round((state._scrubState.base + delta * step) * 100) / 100;
  if (next === state._scrubState.last) return;
  state._scrubState.last = next;
  state._scrubState.el.textContent = next;
  _applyInspectStyle(state._scrubState.selector, state._scrubState.prop, next + state._scrubState.unit);
}
function _scrubEnd() {
  document.removeEventListener('mousemove', _scrubMove, true);
  document.removeEventListener('mouseup', _scrubEnd, true);
  document.body.style.cursor = '';
  state._scrubState = null;
}

// ── Saved patches (localStorage per URL) ────────────────────────────────
const _PATCH_STORAGE_KEY = 'symphonee.browser.patches';
function _currentPageKey() {
  const view = _getInappWebview();
  try {
    if (view && view.tagName.toLowerCase() === 'webview' && view.getURL) {
      const u = new URL(view.getURL());
      return u.origin + u.pathname;
    }
  } catch (_) {}
  return '';
}
function _loadAllPatches() {
  try {
    return JSON.parse(localStorage.getItem(_PATCH_STORAGE_KEY) || '{}');
  } catch (_) {
    return {};
  }
}
function _saveAllPatches(all) {
  try {
    localStorage.setItem(_PATCH_STORAGE_KEY, JSON.stringify(all));
  } catch (_) {}
}
function _recordPatch(entry) {
  const key = _currentPageKey();
  if (!key) return;
  const all = _loadAllPatches();
  const list = all[key] || [];
  list.push({
    ...entry,
    at: Date.now()
  });
  all[key] = list.slice(-200);
  _saveAllPatches(all);
}
async function _applyStoredPatch(p) {
  const view = _getInappWebview();
  if (!view) return;
  await _ensureSymKit();
  if (p.op === 'hide') {
    await _symKitCall('setVisibility', p.selector, true);
    return;
  }
  if (p.op === 'remove') {
    const js = `(function(){ var el = document.querySelector(${JSON.stringify(p.selector)}); if (el && el.parentNode) el.parentNode.removeChild(el); })();`;
    try {
      await view.executeJavaScript(js, true);
    } catch (_) {}
    return;
  }
  if (p.op === 'style') {
    const js = `(function(){ var el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return; el.style.setProperty(${JSON.stringify(p.prop)}, ${JSON.stringify(String(p.value || ''))}); })();`;
    try {
      await view.executeJavaScript(js, true);
    } catch (_) {}
    return;
  }
  if (p.op === 'html') {
    const js = `(function(){ var el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return; el.innerHTML = ${JSON.stringify(String(p.html || ''))}; })();`;
    try {
      await view.executeJavaScript(js, true);
    } catch (_) {}
  }
}
function _patchSummary(p) {
  const sel = _escapeHtml(String(p.selector || '').slice(0, 70));
  if (p.op === 'style') return `<code style="color:var(--subtext1);">${_escapeHtml(p.prop)}:</code> <strong>${_escapeHtml(String(p.value || '').slice(0, 50))}</strong> on <code style="color:var(--accent);">${sel}</code>`;
  if (p.op === 'html') return `Edited text on <code style="color:var(--accent);">${sel}</code>`;
  if (p.op === 'hide') return `Hid <code style="color:var(--accent);">${sel}</code>`;
  if (p.op === 'remove') return `Removed <code style="color:var(--accent);">${sel}</code>`;
  return `<code>${sel}</code>`;
}
function _patchDetailsHtml(p, realIdx) {
  const kv = [];
  kv.push(`<div class="k">Selector</div><div class="v selector">${_escapeHtml(p.selector || '')}</div>`);
  kv.push(`<div class="k">When</div><div class="v">${new Date(p.at).toLocaleString()}</div>`);
  if (p.op === 'style') {
    kv.push(`<div class="k">Property</div><div class="v">${_escapeHtml(p.prop || '')}</div>`);
    kv.push(`<div class="k">Value</div><div class="v">${_escapeHtml(String(p.value || ''))}</div>`);
  } else if (p.op === 'html') {
    const html = String(p.html || '');
    const preview = html.length > 800 ? html.slice(0, 800) + '...' : html;
    kv.push(`<div class="k">New HTML</div><div class="v code">${_escapeHtml(preview)}</div>`);
  }
  return `
    <div class="sym-patch-body" onclick="event.stopPropagation()">
      <div class="sym-patch-kv">${kv.join('')}</div>
      <div class="sym-patch-actions">
        <button class="sym-patch-btn danger" onclick="_removePatchByIndex(${realIdx})"><i data-lucide="trash-2" style="width:11px;height:11px;"></i> Delete</button>
        <button class="sym-patch-btn primary" onclick="_applyPatchByIndex(${realIdx})"><i data-lucide="play" style="width:11px;height:11px;"></i> Apply</button>
      </div>
    </div>
  `;
}
async function _runInappPatchesPanel() {
  _setInappToolsTitle('Saved patches');
  const key = _currentPageKey();
  if (!key) {
    _setInappToolsBodyHtml('<div class="inapp-tools-empty">Open a page first.</div>');
    return;
  }
  const all = _loadAllPatches();
  const list = all[key] || [];
  _inappToolsState.patches = {
    loaded: key,
    list
  };
  if (!list.length) {
    _setInappToolsBodyHtml(`<div class="inapp-tools-empty"><i data-lucide="history" style="width:24px;height:24px;display:block;margin:0 auto 10px;color:var(--subtext1);"></i>No saved patches for this page yet.<div style="margin-top:8px;font-size:11px;">Use Inspect code to hide, remove, style, or edit elements - they're recorded here automatically.</div></div>`);
    try {
      if (window.lucide && lucide.createIcons) lucide.createIcons();
    } catch (_) {}
    return;
  }
  const chev = '<svg class="sym-patch-chev" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  const rows = list.slice().reverse().map((p, i) => {
    const realIdx = list.length - 1 - i;
    const when = new Date(p.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    return `
      <div class="sym-patch-card" data-patch-id="${realIdx}">
        <div class="sym-patch-head" onclick="this.parentElement.classList.toggle('open')">
          ${chev}
          <span class="sym-patch-op op-${p.op}">${_escapeHtml(p.op)}</span>
          <span class="sym-patch-summary">${_patchSummary(p)}</span>
          <span class="sym-patch-when">${when}</span>
        </div>
        ${_patchDetailsHtml(p, realIdx)}
      </div>
    `;
  }).join('');
  _setInappToolsBodyHtml(`
    <div class="sym-patch-bar">
      <span class="count">${list.length} patch${list.length === 1 ? '' : 'es'} for this URL</span>
      <button class="sym-patch-btn primary" onclick="_applyAllPatches()"><i data-lucide="play" style="width:11px;height:11px;"></i> Apply all</button>
      <button class="sym-patch-btn danger" onclick="_clearAllPatches()"><i data-lucide="trash-2" style="width:11px;height:11px;"></i> Clear all</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">${rows}</div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _applyPatchByIndex(i) {
  const list = _inappToolsState.patches.list || [];
  const p = list[i];
  if (!p) return;
  await _applyStoredPatch(p);
  toast('Patch applied', 'success', {
    duration: 1200
  });
}
function _removePatchByIndex(i) {
  const key = _inappToolsState.patches.loaded;
  const all = _loadAllPatches();
  const list = all[key] || [];
  list.splice(i, 1);
  all[key] = list;
  _saveAllPatches(all);
  _runInappPatchesPanel();
}
async function _applyAllPatches() {
  const list = _inappToolsState.patches.list || [];
  for (const p of list) await _applyStoredPatch(p);
  toast('Applied ' + list.length + ' patches', 'success');
}
function _clearAllPatches() {
  const key = _inappToolsState.patches.loaded;
  const all = _loadAllPatches();
  delete all[key];
  _saveAllPatches(all);
  _runInappPatchesPanel();
}

// ── Dark / grayscale / focus toggles ────────────────────────────────────
// Dark-mode overlay was removed per user feedback (no clear use case).
async function toggleInappGrayscale() {
  _inappToolsState.grayscale = !_inappToolsState.grayscale;
  await _ensureSymKit();
  await _symKitCall('applyGrayscale', _inappToolsState.grayscale);
  const label = document.getElementById('inappGrayToggleLabel');
  if (label) label.textContent = _inappToolsState.grayscale ? 'Grayscale (on)' : 'Grayscale';
}
async function toggleInappFocusMode() {
  _inappToolsState.focus = !_inappToolsState.focus;
  await _ensureSymKit();
  await _symKitCall('applyFocusMode', _inappToolsState.focus);
  const label = document.getElementById('inappFocusToggleLabel');
  if (label) label.textContent = _inappToolsState.focus ? 'Focus mode (on)' : 'Focus mode';
}

// ── Shortcuts help ──────────────────────────────────────────────────────
function showInappShortcutsHelp() {
  const o = document.getElementById('symShortcutsOverlay');
  if (o) o.classList.add('open');
}
function hideInappShortcutsHelp() {
  const o = document.getElementById('symShortcutsOverlay');
  if (o) o.classList.remove('open');
}

// ── Global keyboard shortcuts (Browser tab only; ignores field focus) ───
document.addEventListener('keydown', function (ev) {
  const browserTab = document.getElementById('panel-browser');
  if (!browserTab || !browserTab.classList.contains('active')) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (ev.metaKey || ev.ctrlKey) return;
  if (ev.key === 'Escape') {
    if (state._inspectIsEditing) {
      _inspectToggleEdit();
      ev.preventDefault();
      return;
    }
    if (state._colorPopoverEl) {
      _closeColorPopover();
      ev.preventDefault();
      return;
    }
    const overlay = document.getElementById('symShortcutsOverlay');
    if (overlay && overlay.classList.contains('open')) {
      hideInappShortcutsHelp();
      ev.preventDefault();
      return;
    }
    if (_inappToolsState.open) {
      closeInappToolsPanel();
      ev.preventDefault();
      return;
    }
    if (_browserAgentState.open) {
      toggleBrowserAgentPanel();
      ev.preventDefault();
      return;
    }
    if (_browserInspectState.enabled) {
      toggleInappInspectMode(false);
      ev.preventDefault();
      return;
    }
    return;
  }
  if (ev.key === '?' || ev.key === '/' && ev.shiftKey) {
    showInappShortcutsHelp();
    ev.preventDefault();
    return;
  }
  const k = ev.key.toLowerCase();
  if (k === 'i') {
    toggleInappInspectMode();
    ev.preventDefault();
    return;
  }
  if (k === 'h') {
    if (ev.shiftKey) {
      _ensureSymKit().then(() => _symKitCall('unhideAll'));
      toast('Un-hid all', 'info', {
        duration: 1000
      });
    } else if (state._inspectActiveSelector) _inspectHideSelected();
    ev.preventDefault();
    return;
  }
  if (k === 'g') {
    toggleInappGrayscale();
    ev.preventDefault();
    return;
  }
  if (k === 'f') {
    toggleInappFocusMode();
    ev.preventDefault();
    return;
  }
  if (k === 't') {
    browserDevtoolsOpenMenu();
    ev.preventDefault();
    return;
  }
  if (k === 'k') {
    toggleBrowserAgentPanel();
    ev.preventDefault();
    return;
  }
  if (k === 'e') {
    _inspectToggleEdit();
    ev.preventDefault();
    return;
  }
}, true);// ── Reader view (overlay + scoped minimalist stylesheet) ────────────────
const _READER_FONT_SIZES = ['15px', '17px', '19px', '21px', '24px'];
const _inappReaderState = {
  active: false,
  sizeIdx: 2,
  theme: 'light',
  words: 0,
  minutes: 0,
  rootTag: ''
};
async function _runInappReaderView() {
  _setInappToolsTitle('Reader view');
  _setInappToolsBodyLoading('Building reader view...');
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') {
    _setInappToolsBodyError('Browser not ready.');
    return;
  }
  const script = `(function(){
    var KEY = '__symphoneeReader';
    if (window[KEY]) {
      var prev = document.getElementById('__symphoneeReaderOverlay');
      if (prev) prev.remove();
      try {
        if (window[KEY].prevHtmlOverflow != null) document.documentElement.style.overflow = window[KEY].prevHtmlOverflow;
        if (window[KEY].prevBodyOverflow != null) document.body.style.overflow = window[KEY].prevBodyOverflow;
      } catch (_) {}
      window[KEY] = null;
      return { applied: false };
    }
    // Find the best article root by text length, preferring semantic containers.
    var candidates = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '.entry-content', '.post-body', '.story-body', '.post', '.article', '#content', '#main', '.content', '.page-content'];
    var root = null, rootLen = 0;
    candidates.forEach(function(sel){
      try {
        document.querySelectorAll(sel).forEach(function(el){
          var len = (el.innerText || '').length;
          if (len > rootLen && len > 200) { root = el; rootLen = len; }
        });
      } catch (_) {}
    });
    if (!root) {
      document.querySelectorAll('div, section').forEach(function(el){
        var len = (el.innerText || '').length;
        if (len > rootLen && len > 600) { root = el; rootLen = len; }
      });
    }
    if (!root) root = document.body;
    // Title + byline discovery.
    var titleText = '';
    var h1 = root.querySelector('h1') || document.querySelector('h1, .article-title, .post-title, [itemprop="headline"]');
    if (h1 && h1.innerText) titleText = h1.innerText.trim();
    if (!titleText) titleText = document.title || '';
    var bylineText = '';
    var bylineEl = document.querySelector('[rel="author"], .byline, .author, [itemprop="author"]');
    if (bylineEl && bylineEl.innerText) bylineText = bylineEl.innerText.trim().slice(0, 140);
    var dateText = '';
    var dateEl = document.querySelector('time, [itemprop="datePublished"], .published, .date');
    if (dateEl) dateText = (dateEl.getAttribute('datetime') || dateEl.innerText || '').trim().slice(0, 40);

    // Clone article. Strip junk. Preserve images, figures, lists, quotes, code.
    var clone = root.cloneNode(true);
    var junkSel = [
      'script','style','noscript','form','input','button','select','textarea','nav','aside','header','footer',
      '[aria-hidden="true"]','[role="navigation"]','[role="banner"]','[role="contentinfo"]','[role="complementary"]',
      '.advert','.advertisement','[class*="advert"]','[class*="-ad-"]','[class*="_ad_"]','[class*="promo"]','[class*="newsletter"]',
      '[class*="share"]','[class*="social"]','[class*="related"]','[class*="recommended"]','[class*="comments"]','[class*="sidebar"]',
      '[class*="cookie"]','[class*="popup"]','[class*="modal"]','[class*="overlay"]',
      '[data-component*="newsletter"]','[data-module*="newsletter"]'
    ].join(',');
    clone.querySelectorAll(junkSel).forEach(function(n){ try { n.remove(); } catch(_){} });
    // Also drop the title we lifted separately so it doesn't render twice.
    if (h1 && clone.contains(h1)) try { var x = clone.querySelector('h1'); if (x) x.remove(); } catch(_){}
    // Drop empty elements after cleanup (prevents ghost whitespace blocks).
    clone.querySelectorAll('*').forEach(function(n){
      if (n.children.length === 0 && !(n.innerText || '').trim() && !['IMG','VIDEO','IFRAME','HR','BR'].includes(n.tagName)) {
        try { n.remove(); } catch(_){}
      }
    });
    // Sanitize: drop styles/classes/ids to neutralize source's CSS; make links safe + absolute.
    clone.querySelectorAll('*').forEach(function(n){
      try {
        n.removeAttribute('style');
        n.removeAttribute('class');
        n.removeAttribute('id');
        n.removeAttribute('on' + 'click');
        if (n.tagName === 'A' && n.getAttribute('href')) { n.setAttribute('target','_blank'); n.setAttribute('rel','noopener'); }
      } catch(_){}
    });
    // Resolve relative src/href against origin.
    clone.querySelectorAll('img[src],source[src]').forEach(function(img){
      try { img.setAttribute('src', new URL(img.getAttribute('src'), location.href).href); } catch(_){}
      if (img.getAttribute('srcset')) { try { img.removeAttribute('srcset'); } catch(_){} }
    });

    // Build overlay + scoped stylesheet (scoped via .sym-rv root class so it can't leak).
    var overlay = document.createElement('div');
    overlay.id = '__symphoneeReaderOverlay';
    overlay.className = 'sym-rv';
    var style = document.createElement('style');
    // Minimal, classless-style stylesheet - reads like a Markdown preview.
    // No drop caps, no book/serif typography, no floating buttons.
    style.textContent = [
      '.sym-rv{position:fixed;inset:0;z-index:2147483647;background:#ffffff;overflow:auto;-webkit-font-smoothing:antialiased;}',
      '.sym-rv *{box-sizing:border-box;max-width:100%;}',
      '.sym-rv .rv-wrap{max-width:720px;margin:20px auto 32px;padding:0 20px;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter","Helvetica Neue",Arial,sans-serif;color:#1f2328;}',
      '.sym-rv .rv-eyebrow{font-size:12px;color:#6e7681;margin-bottom:4px;}',
      '.sym-rv h1.rv-title{font-size:24px;line-height:1.25;margin:0 0 4px;font-weight:600;color:#1f2328;letter-spacing:-0.005em;}',
      '.sym-rv .rv-meta{font-size:12px;color:#6e7681;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '.sym-rv .rv-meta .rv-dot{width:3px;height:3px;border-radius:50%;background:#d0d7de;}',
      '.sym-rv .rv-body{font-size:inherit;line-height:inherit;color:inherit;}',
      '.sym-rv .rv-body p{margin:0 0 0.7em;}',
      '.sym-rv .rv-body h1,.sym-rv .rv-body h2,.sym-rv .rv-body h3,.sym-rv .rv-body h4,.sym-rv .rv-body h5,.sym-rv .rv-body h6{line-height:1.3;color:#1f2328;font-weight:600;}',
      '.sym-rv .rv-body h1{font-size:1.45em;margin:1em 0 0.35em;}',
      '.sym-rv .rv-body h2{font-size:1.25em;margin:1em 0 0.3em;padding-bottom:0.15em;border-bottom:1px solid #eaeef2;}',
      '.sym-rv .rv-body h3{font-size:1.1em;margin:0.9em 0 0.25em;}',
      '.sym-rv .rv-body h4,.sym-rv .rv-body h5,.sym-rv .rv-body h6{font-size:1em;margin:0.8em 0 0.2em;}',
      '.sym-rv .rv-body a{color:#0969da;text-decoration:underline;text-underline-offset:0.15em;}',
      '.sym-rv .rv-body a:hover{color:#0550ae;}',
      '.sym-rv .rv-body strong{font-weight:600;color:#1f2328;}',
      '.sym-rv .rv-body em{font-style:italic;}',
      '.sym-rv .rv-body ul,.sym-rv .rv-body ol{margin:0 0 0.7em;padding-left:1.4em;}',
      '.sym-rv .rv-body li{margin:0.12em 0;}',
      '.sym-rv .rv-body li > p{margin:0 0 0.25em;}',
      '.sym-rv .rv-body blockquote{margin:0.7em 0;padding:0 0.9em;border-left:3px solid #d0d7de;color:#57606a;}',
      '.sym-rv .rv-body blockquote p{margin:0 0 0.35em;}',
      '.sym-rv .rv-body code{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;font-size:0.88em;background:#f3f4f6;padding:0.1em 0.3em;border-radius:4px;}',
      '.sym-rv .rv-body pre{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;font-size:0.86em;background:#f3f4f6;padding:10px 12px;border-radius:6px;overflow-x:auto;margin:0.7em 0;line-height:1.5;color:#1f2328;}',
      '.sym-rv .rv-body pre code{background:transparent;padding:0;font-size:inherit;}',
      '.sym-rv .rv-body img,.sym-rv .rv-body video{display:block;max-width:100%;height:auto;border-radius:4px;margin:0.7em auto;}',
      '.sym-rv .rv-body figure{margin:0.7em 0;}',
      '.sym-rv .rv-body figcaption{font-size:0.9em;color:#6e7681;margin-top:4px;text-align:center;}',
      '.sym-rv .rv-body hr{border:0;border-top:1px solid #eaeef2;margin:1em 0;}',
      '.sym-rv .rv-body table{width:100%;border-collapse:collapse;margin:0.7em 0;font-size:0.95em;}',
      '.sym-rv .rv-body th,.sym-rv .rv-body td{padding:0.35em 0.6em;border:1px solid #eaeef2;text-align:left;}',
      '.sym-rv .rv-body th{font-weight:600;background:#f6f8fa;}',
      '.sym-rv::-webkit-scrollbar{width:10px;}',
      '.sym-rv::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.2);border-radius:5px;}',
      '.sym-rv::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,0.32);}',
    ].join('\\n');
    overlay.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'rv-wrap';
    var eyebrow = document.createElement('div');
    eyebrow.className = 'rv-eyebrow';
    eyebrow.textContent = location.hostname;
    var h1el = document.createElement('h1');
    h1el.className = 'rv-title';
    h1el.textContent = titleText;
    var meta = document.createElement('div');
    meta.className = 'rv-meta';
    var metaParts = [];
    if (bylineText) metaParts.push(bylineText);
    if (dateText) metaParts.push(dateText);
    // Estimated reading time (200 wpm heuristic).
    var words = (clone.innerText || '').trim().split(/\\s+/).length;
    var mins = Math.max(1, Math.round(words / 200));
    metaParts.push(mins + ' min read');
    metaParts.forEach(function(p, i){
      if (i > 0){ var dot = document.createElement('span'); dot.className = 'rv-dot'; meta.appendChild(dot); }
      var sp = document.createElement('span'); sp.textContent = p; meta.appendChild(sp);
    });
    var body = document.createElement('div');
    body.className = 'rv-body';
    body.appendChild(clone);
    wrap.appendChild(eyebrow);
    wrap.appendChild(h1el);
    wrap.appendChild(meta);
    wrap.appendChild(body);
    overlay.appendChild(wrap);

    // Font size is driven from the Symphonee tools sidebar, not an in-page bar.
    // The sidebar calls __symphoneeReaderSetFontSize(px) via executeJavaScript.
    window.__symphoneeReaderSetFontSize = function(px){
      try { wrap.style.fontSize = px; } catch (_) {}
    };
    // Reading mode (light / sepia / dark) -- injected as a high-specificity
    // theme stylesheet so it overrides the scoped reader CSS.
    window.__symphoneeReaderSetTheme = function(theme){
      try {
        var themes = {
          light: { bg:'#ffffff', fg:'#1a1a1a', muted:'#6b6b6b', link:'#1a6dd6', border:'#e6e6e6' },
          sepia: { bg:'#f4ecd8', fg:'#5b4636', muted:'#8a7a5c', link:'#9a5b2f', border:'#e2d6bd' },
          dark:  { bg:'#181818', fg:'#e8e8e8', muted:'#9a9a9a', link:'#7db4ff', border:'#333333' }
        };
        var c = themes[theme] || themes.light;
        var id = '__symphoneeReaderThemeStyle';
        var st = document.getElementById(id);
        if (!st) { st = document.createElement('style'); st.id = id; document.head.appendChild(st); }
        st.textContent = [
          '#__symphoneeReaderOverlay{background:'+c.bg+' !important;color:'+c.fg+' !important;}',
          '#__symphoneeReaderOverlay *{color:'+c.fg+';border-color:'+c.border+';}',
          '#__symphoneeReaderOverlay a{color:'+c.link+' !important;}',
          '#__symphoneeReaderOverlay .rv-eyebrow,#__symphoneeReaderOverlay .rv-meta,#__symphoneeReaderOverlay time{color:'+c.muted+' !important;}',
          '#__symphoneeReaderOverlay pre,#__symphoneeReaderOverlay code,#__symphoneeReaderOverlay blockquote{background:'+(theme==='dark'?'#222':theme==='sepia'?'#ece2c8':'#f5f5f5')+' !important;}'
        ].join('');
      } catch (_) {}
    };
    document.body.appendChild(overlay);
    overlay.scrollTop = 0;
    // Lock the underlying page scroll so only the overlay scrolls (no double scrollbars).
    var prevHtmlOverflow = document.documentElement.style.overflow;
    var prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    window[KEY] = { active: true, prevHtmlOverflow: prevHtmlOverflow, prevBodyOverflow: prevBodyOverflow };
    return { applied: true, rootTag: (root.tagName || '').toLowerCase(), rootLen: rootLen, words: words, minutes: mins };
  })();`;
  let result;
  try {
    result = await view.executeJavaScript(script, true);
  } catch (e) {
    _setInappToolsBodyError('Reader view failed: ' + (e.message || String(e)));
    return;
  }
  const on = !!(result && result.applied);
  _inappReaderState.active = on;
  if (on) {
    _inappReaderState.words = result.words || 0;
    _inappReaderState.minutes = result.minutes || 1;
    _inappReaderState.rootTag = result.rootTag || 'body';
    if (_inappReaderState.sizeIdx == null) _inappReaderState.sizeIdx = 2;
    // Push the current font-size + mode so the reader matches saved prefs.
    _inappReaderSetFontSize(_READER_FONT_SIZES[_inappReaderState.sizeIdx]);
    _inappReaderApplyTheme(_inappReaderState.theme || 'light');
  }
  _renderInappReaderSidebar();
}
function _renderInappReaderSidebar() {
  const on = _inappReaderState.active;
  const theme = _inappReaderState.theme || 'light';
  const seg = (id, label) => `<button class="rv-seg-btn${theme === id ? ' active' : ''}" data-theme="${id}" type="button">${label}</button>`;
  _setInappToolsBodyHtml(`
    <div class="rv-panel">
      <div class="rv-status">
        <i data-lucide="${on ? 'book-open-check' : 'book-open'}" class="rv-status-icon"></i>
        <div class="rv-status-copy">
          <div class="rv-status-title">${on ? 'Reader on' : 'Reader off'}</div>
          <div class="rv-status-sub">${on ? (_inappReaderState.words || 0).toLocaleString() + ' words &middot; ~' + (_inappReaderState.minutes || 1) + ' min read' : 'Strip this page to its article.'}</div>
        </div>
        <button class="rv-toggle${on ? ' on' : ''}" type="button" id="readerToggle">${on ? 'Turn off' : 'Turn on'}</button>
      </div>
      ${on ? `
      <div class="rv-row"><span class="rv-row-label">Mode</span><div class="rv-seg" id="readerThemeSeg">${seg('light', 'Light')}${seg('sepia', 'Sepia')}${seg('dark', 'Dark')}</div></div>
      <div class="rv-row"><span class="rv-row-label">Font</span><div class="rv-seg"><button class="rv-seg-btn" id="readerSizeMinus" type="button" title="Smaller">A&minus;</button><button class="rv-seg-btn" id="readerSizePlus" type="button" title="Larger">A+</button></div></div>
      <div class="rv-row"><span class="rv-row-label">Export</span><div class="rv-actions"><button class="rv-act-btn" id="readerCopy" type="button"><i data-lucide="copy"></i> Copy text</button><button class="rv-act-btn" id="readerSaveNote" type="button"><i data-lucide="file-plus-2"></i> Save as note</button></div></div>
      <div class="rv-row"><span class="rv-row-label">AI</span><div class="rv-actions"><button class="rv-act-btn rv-act-primary" id="readerAnalyze" type="button"><i data-lucide="sparkles"></i> Analyze with AI</button></div></div>
      ` : ''}
    </div>
  `);
  const toggle = document.getElementById('readerToggle');
  if (toggle) toggle.onclick = () => _runInappReaderView();
  if (on) {
    const segWrap = document.getElementById('readerThemeSeg');
    if (segWrap) segWrap.querySelectorAll('[data-theme]').forEach(b => { b.onclick = () => _inappReaderSetTheme(b.getAttribute('data-theme')); });
    const minus = document.getElementById('readerSizeMinus');
    const plus = document.getElementById('readerSizePlus');
    if (minus) minus.onclick = () => _inappReaderBumpFontSize(-1);
    if (plus) plus.onclick = () => _inappReaderBumpFontSize(+1);
    const copy = document.getElementById('readerCopy');
    if (copy) copy.onclick = _inappReaderCopy;
    const saveNote = document.getElementById('readerSaveNote');
    if (saveNote) saveNote.onclick = _inappReaderSaveNote;
    const analyze = document.getElementById('readerAnalyze');
    if (analyze) analyze.onclick = _inappReaderAnalyze;
  }
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _inappReaderApplyTheme(theme) {
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') return;
  try {
    view.executeJavaScript('try{window.__symphoneeReaderSetTheme&&window.__symphoneeReaderSetTheme(' + JSON.stringify(theme) + ');}catch(_){}', true);
  } catch (_) {}
}
function _inappReaderSetTheme(theme) {
  _inappReaderState.theme = theme;
  _inappReaderApplyTheme(theme);
  _renderInappReaderSidebar();
}
async function _inappReaderGetArticle() {
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') return null;
  try {
    const out = await view.executeJavaScript(`(function(){var o=document.getElementById('__symphoneeReaderOverlay');if(!o)return null;var h=o.querySelector('h1');var b=o.querySelector('.rv-body');return JSON.stringify({title:((h&&h.innerText)||document.title||'').trim(),text:((b&&b.innerText)||'').trim(),url:location.href});})()`, true);
    return out ? JSON.parse(out) : null;
  } catch (_) { return null; }
}
async function _inappReaderCopy() {
  const a = await _inappReaderGetArticle();
  if (!a || !a.text) { toast('No article text to copy.', 'error'); return; }
  const text = (a.title ? a.title + '\n\n' : '') + a.text;
  try { await navigator.clipboard.writeText(text); toast('Article copied (' + a.text.length.toLocaleString() + ' chars)', 'success'); }
  catch (_) { toast('Copy failed', 'error'); }
}
async function _inappReaderSaveNote() {
  const a = await _inappReaderGetArticle();
  if (!a || !a.text) { toast('No article text to save.', 'error'); return; }
  const safeName = 'Article — ' + ((a.title || 'Untitled').replace(/[^\w\s-]/g, '').trim().slice(0, 80) || 'Untitled');
  const md = ['# ' + (a.title || 'Untitled'), '', a.url ? '> Source: ' + a.url : null, '', a.text, '', '_Saved from Reader ' + new Date().toISOString() + '_'].filter(l => l !== null).join('\n');
  try {
    await notesFetch('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: safeName }) });
    await notesFetch('/api/notes/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: safeName, content: md }) });
    toast('Saved to note: ' + safeName, 'success');
  } catch (e) { toast('Failed to save note', 'error'); }
}
async function _inappReaderAnalyze() {
  const a = await _inappReaderGetArticle();
  if (!a || !a.text) { toast('No article to analyze.', 'error'); return; }
  // Hand the article to the AI panel and send it.
  try { toggleBrowserDevtools(true); } catch (_) {}
  try { browserDevtoolsSwitch('ai'); } catch (_) {}
  const snippet = a.text.slice(0, 6000);
  const prompt = `Analyze this article and give me a tight summary, the key takeaways, and anything notable or questionable.\n\nTitle: ${a.title || '(untitled)'}\nSource: ${a.url || ''}\n\n${snippet}${a.text.length > 6000 ? '\n\n[truncated]' : ''}`;
  setTimeout(() => {
    const input = document.getElementById('inappAgentInput');
    if (input) { input.value = prompt; try { _autosizeAgentInput(input); } catch (_) {} }
    try { sendBrowserAgent(); } catch (_) {}
  }, 120);
}
function _inappReaderBumpFontSize(delta) {
  const max = _READER_FONT_SIZES.length - 1;
  _inappReaderState.sizeIdx = Math.max(0, Math.min(max, (_inappReaderState.sizeIdx || 2) + delta));
  _inappReaderSetFontSize(_READER_FONT_SIZES[_inappReaderState.sizeIdx]);
  _renderInappReaderSidebar();
}
function _inappReaderSetSizeIdx(idx) {
  const max = _READER_FONT_SIZES.length - 1;
  _inappReaderState.sizeIdx = Math.max(0, Math.min(max, idx));
  _inappReaderSetFontSize(_READER_FONT_SIZES[_inappReaderState.sizeIdx]);
  _renderInappReaderSidebar();
}
function _inappReaderSetFontSize(px) {
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') return;
  try {
    view.executeJavaScript('try{window.__symphoneeReaderSetFontSize && window.__symphoneeReaderSetFontSize(' + JSON.stringify(px) + ');}catch(_){}', true);
  } catch (_) {}
}

// ── Site audit (SEO + performance + a11y) ───────────────────────────────
const _SITE_AUDIT_SCRIPT = `(function(){
  function getMeta(name){ var el = document.querySelector('meta[name="'+name+'"], meta[property="'+name+'"]'); return el ? (el.getAttribute('content') || '') : null; }
  var title = document.title || '';
  var description = getMeta('description');
  var canonical = (document.querySelector('link[rel="canonical"]') || {}).href || null;
  var robots = getMeta('robots');
  var viewport = getMeta('viewport');
  var ogTitle = getMeta('og:title');
  var ogDescription = getMeta('og:description');
  var ogImage = getMeta('og:image');
  var ogType = getMeta('og:type');
  var twitterCard = getMeta('twitter:card');
  var h1s = Array.from(document.querySelectorAll('h1')).map(function(h){ return (h.innerText || '').trim().slice(0, 80); });
  var lang = document.documentElement.getAttribute('lang') || null;
  var images = Array.from(document.querySelectorAll('img'));
  var imagesMissingAlt = images.filter(function(i){ return !i.getAttribute('alt'); }).length;
  var imagesLazy = images.filter(function(i){ return i.getAttribute('loading') === 'lazy'; }).length;
  var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  var timing = nav ? {
    ttfb: Math.round(nav.responseStart - nav.requestStart),
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
    loadEvent: Math.round(nav.loadEventEnd - nav.startTime),
    transferSize: nav.transferSize,
    encodedBodySize: nav.encodedBodySize,
    domInteractive: Math.round(nav.domInteractive - nav.startTime),
  } : null;
  var resources = (performance.getEntriesByType && performance.getEntriesByType('resource')) || [];
  var byType = { script: 0, css: 0, img: 0, font: 0, xhr: 0, other: 0 };
  var totalSize = 0;
  resources.forEach(function(r){
    totalSize += r.transferSize || 0;
    var t = r.initiatorType || 'other';
    if (t === 'script') byType.script++;
    else if (t === 'link' || t === 'css') byType.css++;
    else if (t === 'img' || t === 'imageset') byType.img++;
    else if (t === 'font') byType.font++;
    else if (t === 'xmlhttprequest' || t === 'fetch') byType.xhr++;
    else byType.other++;
  });
  var secure = location.protocol === 'https:';
  var nodeCount = document.querySelectorAll('*').length;
  var buttonsWithoutLabels = Array.from(document.querySelectorAll('button')).filter(function(b){
    return !(b.innerText || '').trim() && !b.getAttribute('aria-label');
  }).length;
  var inputsWithoutLabels = Array.from(document.querySelectorAll('input, select, textarea')).filter(function(el){
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false;
    if (el.getAttribute('aria-label')) return false;
    var id = el.id;
    if (id && document.querySelector('label[for="'+CSS.escape(id)+'"]')) return false;
    if (el.closest && el.closest('label')) return false;
    return true;
  }).length;
  var headingsOrder = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function(h){
    headingsOrder.push(parseInt(h.tagName.substring(1), 10));
  });
  var headingSkips = 0;
  for (var i = 1; i < headingsOrder.length; i++) {
    if (headingsOrder[i] - headingsOrder[i-1] > 1) headingSkips++;
  }
  return {
    url: location.href,
    host: location.hostname,
    title: title, description: description, canonical: canonical, robots: robots, viewport: viewport,
    lang: lang,
    h1s: h1s, h1Count: h1s.length,
    og: { title: ogTitle, description: ogDescription, image: ogImage, type: ogType },
    twitter: { card: twitterCard },
    images: { total: images.length, missingAlt: imagesMissingAlt, lazy: imagesLazy },
    timing: timing,
    resources: { total: resources.length, byType: byType, totalTransferBytes: totalSize },
    secure: secure,
    nodeCount: nodeCount,
    a11y: { buttonsWithoutLabels: buttonsWithoutLabels, inputsWithoutLabels: inputsWithoutLabels, headingSkips: headingSkips },
  };
})();`;

// ── Emulation panel (device + media + throttle) ─────────────────────────
const _EMULATE_DEVICES = [{
  id: 'off',
  label: 'No override',
  w: 0,
  h: 0,
  dpr: 1,
  mobile: false,
  touch: false
}, {
  id: 'iphone-14',
  label: 'iPhone 14',
  w: 390,
  h: 844,
  dpr: 3,
  mobile: true,
  touch: true
}, {
  id: 'iphone-se',
  label: 'iPhone SE',
  w: 375,
  h: 667,
  dpr: 2,
  mobile: true,
  touch: true
}, {
  id: 'pixel-7',
  label: 'Pixel 7',
  w: 412,
  h: 915,
  dpr: 2.625,
  mobile: true,
  touch: true
}, {
  id: 'ipad',
  label: 'iPad',
  w: 820,
  h: 1180,
  dpr: 2,
  mobile: true,
  touch: true
}, {
  id: 'ipad-pro',
  label: 'iPad Pro 11"',
  w: 834,
  h: 1194,
  dpr: 2,
  mobile: true,
  touch: true
}, {
  id: 'laptop',
  label: 'Laptop (1366x768)',
  w: 1366,
  h: 768,
  dpr: 1,
  mobile: false,
  touch: false
}, {
  id: 'desktop',
  label: 'Desktop (1920x1080)',
  w: 1920,
  h: 1080,
  dpr: 1,
  mobile: false,
  touch: false
}];
const _emulateState = {
  device: 'off',
  colorScheme: '',
  reducedMotion: '',
  contrast: '',
  network: 'no-throttle',
  cpuRate: 1
};
async function _runInappEmulatePanel() {
  _setInappToolsTitle('Emulate device');
  const devOpts = _EMULATE_DEVICES.map(d => `<option value="${d.id}" ${_emulateState.device === d.id ? 'selected' : ''}>${_escapeHtml(d.label)}${d.w ? ' — ' + d.w + '×' + d.h + ' @' + d.dpr + 'x' : ''}</option>`).join('');
  _setInappToolsBodyHtml(`
    <div style="font:11px/1.45 var(--font-ui);color:var(--yellow);background:color-mix(in srgb, var(--yellow) 12%, var(--surface0));border:1px solid color-mix(in srgb, var(--yellow) 35%, transparent);padding:8px 10px;border-radius:var(--radius);display:flex;gap:8px;align-items:flex-start;">
      <i data-lucide="alert-triangle" style="width:14px;height:14px;color:var(--yellow);flex-shrink:0;margin-top:1px;"></i>
      <div><strong>Heads up:</strong> device emulation rides on top of Chromium&rsquo;s DevTools protocol. Some pages flicker or lose layout when overrides are applied. If things look broken, hit <em>Reset all</em> at the bottom.</div>
    </div>
    <div class="code-inspect-group"><div class="code-inspect-group-title">Device</div>
      <div class="quick-edit-grid" style="grid-template-columns: 110px 1fr;">
        <label>Preset</label>
        <select id="emDevice" onchange="_applyEmulateDevice()">${devOpts}</select>
      </div>
    </div>
    <div class="code-inspect-group"><div class="code-inspect-group-title">Media features</div>
      <div class="quick-edit-grid" style="grid-template-columns: 130px 1fr;">
        <label>Color scheme</label>
        <select id="emColor" onchange="_applyEmulateMedia()">
          <option value="" ${_emulateState.colorScheme === '' ? 'selected' : ''}>No override</option>
          <option value="light" ${_emulateState.colorScheme === 'light' ? 'selected' : ''}>light</option>
          <option value="dark" ${_emulateState.colorScheme === 'dark' ? 'selected' : ''}>dark</option>
        </select>
        <label>Reduced motion</label>
        <select id="emMotion" onchange="_applyEmulateMedia()">
          <option value="" ${_emulateState.reducedMotion === '' ? 'selected' : ''}>No override</option>
          <option value="reduce" ${_emulateState.reducedMotion === 'reduce' ? 'selected' : ''}>reduce</option>
          <option value="no-preference" ${_emulateState.reducedMotion === 'no-preference' ? 'selected' : ''}>no-preference</option>
        </select>
        <label>Contrast</label>
        <select id="emContrast" onchange="_applyEmulateMedia()">
          <option value="" ${_emulateState.contrast === '' ? 'selected' : ''}>No override</option>
          <option value="more" ${_emulateState.contrast === 'more' ? 'selected' : ''}>more</option>
          <option value="less" ${_emulateState.contrast === 'less' ? 'selected' : ''}>less</option>
          <option value="no-preference" ${_emulateState.contrast === 'no-preference' ? 'selected' : ''}>no-preference</option>
        </select>
      </div>
    </div>
    <div class="code-inspect-group"><div class="code-inspect-group-title">Throttling</div>
      <div class="quick-edit-grid" style="grid-template-columns: 110px 1fr;">
        <label>Network</label>
        <select id="emNet" onchange="_applyEmulateThrottle()">
          <option value="no-throttle" ${_emulateState.network === 'no-throttle' ? 'selected' : ''}>No throttling</option>
          <option value="4g" ${_emulateState.network === '4g' ? 'selected' : ''}>4G</option>
          <option value="fast-3g" ${_emulateState.network === 'fast-3g' ? 'selected' : ''}>Fast 3G</option>
          <option value="slow-3g" ${_emulateState.network === 'slow-3g' ? 'selected' : ''}>Slow 3G</option>
          <option value="offline" ${_emulateState.network === 'offline' ? 'selected' : ''}>Offline</option>
        </select>
        <label>CPU throttle</label>
        <select id="emCpu" onchange="_applyEmulateThrottle()">
          ${[1, 2, 4, 6, 10, 20].map(r => `<option value="${r}" ${_emulateState.cpuRate === r ? 'selected' : ''}>${r === 1 ? 'No throttling' : r + '× slower'}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
      <button class="tab-bar-btn" type="button" onclick="_resetAllEmulation()"><i data-lucide="rotate-ccw" style="width:13px;height:13px;"></i> Reset all</button>
    </div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _applyEmulateDevice() {
  const sel = document.getElementById('emDevice');
  if (!sel) return;
  const id = sel.value;
  const d = _EMULATE_DEVICES.find(x => x.id === id) || _EMULATE_DEVICES[0];
  _emulateState.device = id;
  try {
    if (id === 'off' || !d.w) {
      await fetch('/api/browser/emulate/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reset: true
        })
      });
      toast('Device override off', 'info', {
        duration: 1200
      });
    } else {
      await fetch('/api/browser/emulate/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          width: d.w,
          height: d.h,
          deviceScaleFactor: d.dpr,
          mobile: d.mobile,
          touch: d.touch
        })
      });
      toast(d.label + ' — ' + d.w + '×' + d.h, 'success', {
        duration: 1400
      });
    }
  } catch (e) {
    toast('Emulate failed: ' + e.message, 'error');
  }
}
async function _applyEmulateMedia() {
  _emulateState.colorScheme = (document.getElementById('emColor') || {}).value || '';
  _emulateState.reducedMotion = (document.getElementById('emMotion') || {}).value || '';
  _emulateState.contrast = (document.getElementById('emContrast') || {}).value || '';
  try {
    await fetch('/api/browser/emulate/media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        colorScheme: _emulateState.colorScheme,
        reducedMotion: _emulateState.reducedMotion,
        contrast: _emulateState.contrast
      })
    });
  } catch (e) {
    toast('Media override failed: ' + e.message, 'error');
  }
}
async function _applyEmulateThrottle() {
  _emulateState.network = (document.getElementById('emNet') || {}).value || 'no-throttle';
  _emulateState.cpuRate = Number((document.getElementById('emCpu') || {}).value || 1);
  try {
    await fetch('/api/browser/emulate/throttle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        network: _emulateState.network,
        cpuRate: _emulateState.cpuRate
      })
    });
  } catch (e) {
    toast('Throttle failed: ' + e.message, 'error');
  }
}
async function _resetAllEmulation() {
  _emulateState.device = 'off';
  _emulateState.colorScheme = '';
  _emulateState.reducedMotion = '';
  _emulateState.contrast = '';
  _emulateState.network = 'no-throttle';
  _emulateState.cpuRate = 1;
  try {
    await Promise.all([fetch('/api/browser/emulate/device', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reset: true
      })
    }), fetch('/api/browser/emulate/media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    }), fetch('/api/browser/emulate/throttle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        network: 'no-throttle',
        cpuRate: 1
      })
    })]);
    toast('All emulation reset', 'success', {
      duration: 1200
    });
    _runInappEmulatePanel();
  } catch (e) {
    toast('Reset failed: ' + e.message, 'error');
  }
}

// ── Browser issues panel (Audits.issueAdded) ────────────────────────────
async function _runInappIssuesPanel() {
  _setInappToolsTitle('Browser issues');
  _setInappToolsBodyLoading('Starting capture...');
  try {
    await fetch('/api/browser/issues/start', {
      method: 'POST'
    });
  } catch (_) {}
  await _refreshIssuesPanel();
}
async function _refreshIssuesPanel() {
  let data = {
    issues: [],
    count: 0
  };
  try {
    data = await fetch('/api/browser/issues').then(r => r.json());
  } catch (_) {}
  _renderIssuesPanel(data);
}
function _issueSummary(it) {
  const code = it.code || 'Issue';
  const d = it.details || {};
  const details = d.mixedContentIssueDetails || d.contentSecurityPolicyIssueDetails || d.sameSiteCookieIssueDetails || d.lowTextContrastIssueDetails || d.deprecationIssueDetails || d.attributionReportingIssueDetails || d.quirksModeIssueDetails || d.genericIssueDetails || d.heavyAdIssueDetails || {};
  const parts = [];
  if (details.request && details.request.url) parts.push(details.request.url);
  if (details.insecureURL) parts.push(details.insecureURL);
  if (details.cookieUrl) parts.push(details.cookieUrl);
  if (details.violatedDirective) parts.push('directive: ' + details.violatedDirective);
  if (details.blockedURL) parts.push(details.blockedURL);
  if (details.thresholdRatio != null) parts.push('contrast ' + details.thresholdRatio.toFixed(2));
  if (details.reason) parts.push('reason: ' + details.reason);
  if (details.message) parts.push(details.message);
  return {
    code,
    line: parts.join(' · ').slice(0, 180)
  };
}
function _issueSeverity(code) {
  if (/SameSite|ContentSecurityPolicy|MixedContent|Heavy/i.test(code)) return 'error';
  if (/Deprecation|QuirksMode|LowTextContrast/i.test(code)) return 'warn';
  return 'info';
}
function _renderIssuesPanel(data) {
  const issues = data.issues || [];
  if (!issues.length) {
    _setInappToolsBodyHtml(`
      <div class="inapp-tools-empty" style="padding:20px;">
        <i data-lucide="shield-check" style="width:24px;height:24px;display:block;margin:0 auto 10px;color:var(--green);"></i>
        <div style="font-weight:600;color:var(--text);">No issues reported</div>
        <div style="font-size:11px;margin-top:6px;">Chrome's Audits engine is listening. Navigate or reload to capture issues.</div>
      </div>
      <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
        <button class="tab-bar-btn" type="button" onclick="_refreshIssuesPanel()"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> Refresh</button>
      </div>
    `);
    try {
      if (window.lucide && lucide.createIcons) lucide.createIcons();
    } catch (_) {}
    return;
  }
  // Group by code for compactness.
  const byCode = new Map();
  for (const it of issues) {
    const key = it.code || 'Issue';
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(it);
  }
  const cards = [];
  for (const [code, list] of byCode.entries()) {
    const sev = _issueSeverity(code);
    const color = sev === 'error' ? 'var(--red)' : sev === 'warn' ? 'var(--yellow)' : 'var(--accent)';
    const items = list.slice(-20).map(it => {
      const s = _issueSummary(it);
      return `<div style="padding:6px 10px;border-top:1px solid var(--surface0);font:11px var(--font-mono);color:var(--subtext1);">${s.line ? _escapeHtml(s.line) : '<em>no details</em>'}</div>`;
    }).join('');
    cards.push(`
      <div class="sym-patch-card">
        <div class="sym-patch-head">
          <span class="sym-patch-op" style="background:color-mix(in srgb, ${color} 14%, transparent);color:${color};border:1px solid color-mix(in srgb, ${color} 30%, transparent);">${_escapeHtml(sev)}</span>
          <span class="sym-patch-summary">${_escapeHtml(code)}</span>
          <span class="sym-patch-when">${list.length}×</span>
        </div>
        ${items}
      </div>
    `);
  }
  _setInappToolsBodyHtml(`
    <div class="sym-patch-bar">
      <span class="count">${issues.length} issue${issues.length === 1 ? '' : 's'} captured</span>
      <button class="sym-patch-btn" onclick="_refreshIssuesPanel()"><i data-lucide="refresh-cw" style="width:11px;height:11px;"></i> Refresh</button>
      <button class="sym-patch-btn danger" onclick="_clearIssues()"><i data-lucide="trash-2" style="width:11px;height:11px;"></i> Clear</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">${cards.join('')}</div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _clearIssues() {
  try {
    await fetch('/api/browser/issues/clear', {
      method: 'POST'
    });
  } catch (_) {}
  _refreshIssuesPanel();
}
async function _runInappSiteAudit() {
  _setInappToolsTitle('Site audit');
  _setInappToolsBodyLoading('Auditing page...');
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') {
    _setInappToolsBodyError('Browser not ready.');
    return;
  }
  let data;
  try {
    data = await view.executeJavaScript(_SITE_AUDIT_SCRIPT, true);
  } catch (e) {
    _setInappToolsBodyError('Audit failed: ' + (e.message || String(e)));
    return;
  }
  _inappToolsState.audit = data;
  _renderInappAuditPanel(data);
}
function _fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
function _fmtMs(n) {
  if (n == null) return '—';
  if (n < 1000) return n + ' ms';
  return (n / 1000).toFixed(2) + ' s';
}
function _auditCheck(pass, warn, text) {
  const status = pass ? 'pass' : warn ? 'warn' : 'fail';
  const color = pass ? 'var(--green)' : warn ? 'var(--yellow)' : 'var(--red)';
  const icon = pass ? 'check-circle-2' : warn ? 'alert-triangle' : 'x-circle';
  return `<div class="audit-check" style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;font:12px var(--font-ui);"><i data-lucide="${icon}" style="width:14px;height:14px;flex-shrink:0;margin-top:2px;color:${color};"></i><span style="color:var(--text);flex:1;min-width:0;">${text}</span></div>`;
}
function _renderInappAuditPanel(d) {
  const seoChecks = [_auditCheck(!!d.title && d.title.length >= 10 && d.title.length <= 70, d.title && (d.title.length > 70 || d.title.length < 10), `<strong>Title:</strong> ${d.title ? d.title.length + ' chars' : 'missing'}${d.title ? ' — ' + _escapeHtml(d.title.slice(0, 60)) + (d.title.length > 60 ? '...' : '') : ''}`), _auditCheck(!!d.description && d.description.length >= 70 && d.description.length <= 170, !!d.description, `<strong>Meta description:</strong> ${d.description ? d.description.length + ' chars' : 'missing (recommend 120-160)'}`), _auditCheck(!!d.canonical, false, `<strong>Canonical:</strong> ${d.canonical ? _escapeHtml(d.canonical) : 'missing'}`), _auditCheck(d.h1Count === 1, d.h1Count > 0, `<strong>H1:</strong> ${d.h1Count} on page${d.h1s[0] ? ' — "' + _escapeHtml(d.h1s[0]) + '"' : ''}`), _auditCheck(!!d.lang, false, `<strong>Lang attribute:</strong> ${d.lang || 'missing'}`), _auditCheck(!!d.viewport, false, `<strong>Viewport meta:</strong> ${d.viewport ? 'set' : 'missing (mobile responsiveness)'}`), _auditCheck(!!(d.og && d.og.title && d.og.description && d.og.image), !!(d.og && (d.og.title || d.og.description)), `<strong>Open Graph:</strong> ${[d.og.title && 'title', d.og.description && 'description', d.og.image && 'image'].filter(Boolean).join(', ') || 'none'}`), _auditCheck(!!(d.twitter && d.twitter.card), false, `<strong>Twitter card:</strong> ${d.twitter && d.twitter.card || 'missing'}`), _auditCheck(d.secure, false, `<strong>HTTPS:</strong> ${d.secure ? 'yes' : 'no (SEO / security penalty)'}`), d.robots ? _auditCheck(!/noindex/i.test(d.robots), /noindex/i.test(d.robots), `<strong>Robots:</strong> ${_escapeHtml(d.robots)}`) : ''].filter(Boolean).join('');
  const perfChecks = d.timing ? [_auditCheck(d.timing.ttfb < 600, d.timing.ttfb < 1500, `<strong>TTFB:</strong> ${_fmtMs(d.timing.ttfb)} <span style="color:var(--subtext0);">(target &lt;600 ms)</span>`), _auditCheck(d.timing.domContentLoaded < 2500, d.timing.domContentLoaded < 5000, `<strong>DOM ready:</strong> ${_fmtMs(d.timing.domContentLoaded)}`), _auditCheck(d.timing.loadEvent < 4000, d.timing.loadEvent < 8000, `<strong>Load event:</strong> ${_fmtMs(d.timing.loadEvent)}`), _auditCheck(d.resources.totalTransferBytes < 2 * 1024 * 1024, d.resources.totalTransferBytes < 5 * 1024 * 1024, `<strong>Transfer size:</strong> ${_fmtBytes(d.resources.totalTransferBytes)} across ${d.resources.total} resources`), _auditCheck(d.nodeCount < 1500, d.nodeCount < 3000, `<strong>DOM size:</strong> ${d.nodeCount.toLocaleString()} elements`)].join('') : '<div class="inapp-tools-empty" style="padding:10px;">No navigation timing available (try reloading the page).</div>';
  const a11yChecks = [_auditCheck(d.images.total === 0 || d.images.missingAlt === 0, d.images.missingAlt < 3, `<strong>Images without alt:</strong> ${d.images.missingAlt} of ${d.images.total}`), _auditCheck(d.a11y.buttonsWithoutLabels === 0, d.a11y.buttonsWithoutLabels < 3, `<strong>Buttons without accessible text:</strong> ${d.a11y.buttonsWithoutLabels}`), _auditCheck(d.a11y.inputsWithoutLabels === 0, d.a11y.inputsWithoutLabels < 3, `<strong>Form inputs without labels:</strong> ${d.a11y.inputsWithoutLabels}`), _auditCheck(d.a11y.headingSkips === 0, d.a11y.headingSkips < 3, `<strong>Heading-level skips:</strong> ${d.a11y.headingSkips}`)].join('');
  const resByType = d.resources.byType;
  const resBreakdown = Object.entries(resByType).filter(([, v]) => v).map(([k, v]) => `<span style="display:inline-block;margin:0 8px 4px 0;padding:2px 8px;border-radius:10px;background:var(--surface0);color:var(--subtext1);font:10px var(--font-mono);">${k}: ${v}</span>`).join('');
  _setInappToolsBodyHtml(`
    <div class="brand-header">
      <div class="brand-header-logo"><i data-lucide="gauge" style="width:22px;height:22px;color:var(--accent);"></i></div>
      <div style="min-width:0;flex:1;">
        <div class="brand-header-name">${_escapeHtml(d.title || d.host)}</div>
        <div class="brand-header-url">${_escapeHtml(d.host)}</div>
      </div>
    </div>
    <div class="brand-section-title">SEO</div>
    <div class="code-inspect-group"><div style="padding:4px 10px;">${seoChecks}</div></div>
    <div class="brand-section-title">Performance</div>
    <div class="code-inspect-group"><div style="padding:4px 10px;">${perfChecks}</div></div>
    ${resBreakdown ? '<div style="padding:0 2px;">' + resBreakdown + '</div>' : ''}
    <div class="brand-section-title">Accessibility</div>
    <div class="code-inspect-group"><div style="padding:4px 10px;">${a11yChecks}</div></div>
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
      <button class="tab-bar-btn" type="button" onclick="_saveAuditToNote()"><i data-lucide="save" style="width:13px;height:13px;"></i> Save to note</button>
      <button class="tab-bar-btn" type="button" onclick="_runInappSiteAudit()"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> Re-run</button>
    </div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _saveAuditToNote() {
  const d = _inappToolsState.audit;
  if (!d) return;
  const lines = [];
  lines.push(`# Site audit — ${d.title || d.host}`);
  lines.push('');
  lines.push(`**URL:** ${d.url}`);
  lines.push(`**Captured:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## SEO');
  lines.push(`- Title: ${d.title ? `"${d.title}" (${d.title.length} chars)` : '**missing**'}`);
  lines.push(`- Meta description: ${d.description ? `${d.description.length} chars` : '**missing**'}`);
  lines.push(`- Canonical: ${d.canonical || '**missing**'}`);
  lines.push(`- H1 count: ${d.h1Count}${d.h1s[0] ? ` — "${d.h1s[0]}"` : ''}`);
  lines.push(`- Lang: ${d.lang || '**missing**'}`);
  lines.push(`- Viewport meta: ${d.viewport || '**missing**'}`);
  lines.push(`- Open Graph: ${[d.og.title && 'title', d.og.description && 'description', d.og.image && 'image', d.og.type && 'type'].filter(Boolean).join(', ') || 'none'}`);
  lines.push(`- Twitter card: ${d.twitter && d.twitter.card || 'missing'}`);
  lines.push(`- HTTPS: ${d.secure ? 'yes' : '**no**'}`);
  if (d.robots) lines.push(`- Robots: ${d.robots}`);
  lines.push('');
  lines.push('## Performance');
  if (d.timing) {
    lines.push(`- TTFB: ${_fmtMs(d.timing.ttfb)}`);
    lines.push(`- DOM ready: ${_fmtMs(d.timing.domContentLoaded)}`);
    lines.push(`- Load event: ${_fmtMs(d.timing.loadEvent)}`);
    lines.push(`- DOM interactive: ${_fmtMs(d.timing.domInteractive)}`);
    lines.push(`- Transfer size (navigation): ${_fmtBytes(d.timing.transferSize)}`);
  }
  lines.push(`- Total resource transfer: ${_fmtBytes(d.resources.totalTransferBytes)} across ${d.resources.total} requests`);
  Object.entries(d.resources.byType).filter(([, v]) => v).forEach(([k, v]) => lines.push(`  - ${k}: ${v}`));
  lines.push(`- DOM size: ${d.nodeCount} elements`);
  lines.push('');
  lines.push('## Accessibility');
  lines.push(`- Images missing alt: ${d.images.missingAlt} / ${d.images.total}`);
  lines.push(`- Buttons without accessible text: ${d.a11y.buttonsWithoutLabels}`);
  lines.push(`- Form inputs without labels: ${d.a11y.inputsWithoutLabels}`);
  lines.push(`- Heading-level skips: ${d.a11y.headingSkips}`);
  const name = 'Audit — ' + (d.title || d.host).replace(/[^\w\s-]/g, '').slice(0, 70);
  try {
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        content: lines.join('\n')
      })
    });
    toast('Saved to note: ' + name, 'success');
  } catch (e) {
    toast('Save failed: ' + (e.message || String(e)), 'error');
  }
}

// Lazy-create the webview on first tab activation so we do not pay the cost
// at app boot.
(function wireInappBrowserOnActivate() {
  const panel = document.getElementById('panel-browser');
  if (!panel) return;
  const obs = new MutationObserver(() => {
    if (panel.classList.contains('active')) {
      _ensureInappBrowser();
    }
  });
  obs.observe(panel, {
    attributes: true,
    attributeFilter: ['class']
  });
})();

// ── DevTools drawer ────────────────────────────────────────────────────────
// Console / Network / Performance / Server-log surface for the in-app browser.
//   Console + Network stream from the CDP capture in electron/webview-driver.js
//     (live via the WS 'browser-devtools' message, backfilled over REST on open).
//   Performance reads the visited page's own Navigation + Resource Timing.
//   Server taps the active repo's dev-server terminal output (WS 'output'),
//     deliberately kept separate from Symphonee's own backend logs.
const MAX_DT_CONSOLE = 1500;
const MAX_DT_NETWORK = 1500;
const MAX_DT_SERVER_LINES = 2500;
const _dt = {
  open: false,
  dock: 'bottom',
  tab: 'console',
  console: [],
  network: [],
  netById: new Map(),
  expanded: new Set(),
  bodies: new Map(),
  terms: new Map(),       // termId -> { cwd, repo, lines, _partial, devUrl, isDev }
  serverTermId: null,
  errorCount: 0,
  perf: null,
  netTypeFilter: 'all',
  storage: { cookies: [], local: {}, session: {} },
  replHistory: [],
  replIdx: 0,
  _renderQueued: false,
  _backfilled: false,
};

function _dtStripAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[=>]/g, '');
}
function _dtApplyCr(line) {
  // Honour carriage-return redraws (spinners/progress) by keeping only the
  // last segment, and drop a trailing CR.
  const i = line.lastIndexOf('\r');
  return (i >= 0 ? line.slice(i + 1) : line).replace(/\r$/, '');
}
function _dtFmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function _dtFmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function _dtConsoleLevel(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'error' || t === 'exception' || t === 'assert') return 'error';
  if (t === 'warning' || t === 'warn') return 'warning';
  if (t === 'info') return 'info';
  return 'log';
}

// Attach the CDP debugger early (the console endpoint does so as a side effect)
// so capture is running before the user needs it.
function browserDevtoolsEnsureCapture() {
  fetch('/api/browser/console?limit=1').catch(() => {});
}

function toggleBrowserDevtools(force) {
  const el = document.getElementById('inappDevtools');
  if (!el) return;
  const next = typeof force === 'boolean' ? force : !_dt.open;
  _dt.open = next;
  el.style.display = next ? 'flex' : 'none';
  const btn = document.getElementById('inappDevtoolsBtn');
  if (btn) btn.classList.toggle('active', next);
  if (!next) {
    _dtTeardownTool(_dt.tab, '');
    _inappToolsTargetId = 'inappToolsBody';
    _browserAgentState.open = false;
    const chip = document.getElementById('inappAgentChip');
    if (chip) chip.classList.remove('active');
  }
  if (next) {
    _dt.errorCount = 0;
    _dtUpdateBadge();
    browserDevtoolsEnsureCapture();
    if (!_dt._backfilled) { _dt._backfilled = true; _dtBackfill(); }
    browserDevtoolsSwitch(_dt.tab);
  }
}

// The drawer hosts every browser tool. Panels are chosen from a single picker
// menu (no tab strip). "log" panels are drawer-native; "tool" panels reuse the
// existing _runInapp* renderers via the _inappToolsTargetId sink.
const _DT_PANELS = [
  { id: 'ai', label: 'AI', group: 'Assistant', kind: 'ai' },
  { id: 'console', label: 'Console', group: 'Inspect', kind: 'log' },
  { id: 'network', label: 'Network', group: 'Inspect', kind: 'log' },
  { id: 'performance', label: 'Performance', group: 'Inspect', kind: 'log' },
  { id: 'server', label: 'Server', group: 'Inspect', kind: 'log' },
  { id: 'storage', label: 'Storage', group: 'Inspect', kind: 'log' },
  { id: 'elements', label: 'Elements', group: 'Inspect', kind: 'tool' },
  { id: 'issues', label: 'Issues', group: 'Inspect', kind: 'tool' },
  { id: 'audit', label: 'Audit', group: 'Inspect', kind: 'tool' },
  { id: 'emulate', label: 'Emulate device', group: 'Page tools', kind: 'tool' },
  { id: 'reader', label: 'Reader view', group: 'Page tools', kind: 'tool' },
  { id: 'brand', label: 'Detect brand', group: 'Page tools', kind: 'tool' },
  { id: 'patches', label: 'Saved patches', group: 'Page tools', kind: 'tool' },
];
// One-shot / toggle actions (don't switch the visible panel).
const _DT_ACTIONS = [
  { id: 'select', label: 'Select element (AI)', icon: 'crosshair', active: () => !!(window._browserInspectState && _browserInspectState.enabled), run: () => toggleInappInspectMode() },
  { id: 'grayscale', label: 'Grayscale', icon: 'contrast', active: () => !!_inappToolsState.grayscale, run: () => toggleInappGrayscale() },
  { id: 'focus', label: 'Focus mode', icon: 'focus', active: () => !!_inappToolsState.focus, run: () => toggleInappFocusMode() },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', run: () => showInappShortcutsHelp() },
];
const _DT_TOOL_TABS = _DT_PANELS.filter(p => p.kind === 'tool').map(p => p.id);
function _dtPanel(id) { return _DT_PANELS.find(p => p.id === id); }
function _dtTeardownTool(prev, next) {
  // Leaving Elements: turn inspect mode off so the page isn't stuck in hover.
  if (prev === 'elements' && next !== 'elements') {
    try { if (window._browserInspectState && _browserInspectState.enabled) toggleInappInspectMode(false); } catch (_) {}
  }
  // Leaving Emulate: reset overrides so the user can't get stuck on a glitched page.
  if (prev === 'emulate' && next !== 'emulate') {
    try {
      if (typeof _emulateState !== 'undefined' && (_emulateState.device !== 'off' || _emulateState.colorScheme || _emulateState.reducedMotion || _emulateState.contrast || _emulateState.network !== 'no-throttle' || _emulateState.cpuRate !== 1)) _resetAllEmulation();
    } catch (_) {}
  }
}
async function _dtRunTool(tab) {
  const body = document.getElementById('inappDevtoolsBody');
  if (body) body.innerHTML = '';
  try {
    if (tab === 'elements') await _runInappCodeInspect();
    else if (tab === 'issues') await _runInappIssuesPanel();
    else if (tab === 'audit') await _runInappSiteAudit();
    else if (tab === 'emulate') await _runInappEmulatePanel();
    else if (tab === 'reader') await _runInappReaderView();
    else if (tab === 'brand') await _runInappBrandDetect();
    else if (tab === 'patches') await _runInappPatchesPanel();
  } catch (e) {
    if (body) body.innerHTML = '<div class="inapp-devtools-empty">' + _escapeHtml(String(e && e.message || e)) + '</div>';
  }
  try { if (window.lucide && lucide.createIcons) lucide.createIcons(); } catch (_) {}
}
function browserDevtoolsSwitch(tab) {
  if (!_dtPanel(tab)) tab = 'console';
  const prev = _dt.tab;
  _dt.tab = tab;
  if (prev !== tab) _dtTeardownTool(prev, tab);
  browserDevtoolsCloseMenu();
  const panel = _dtPanel(tab);
  const lbl = document.getElementById('inappDevtoolsPickerLabel');
  if (lbl) lbl.textContent = panel ? panel.label : tab;
  const isTool = panel && panel.kind === 'tool';
  const isAi = panel && panel.kind === 'ai';
  const dtBody = document.getElementById('inappDevtoolsBody');
  if (dtBody) { dtBody.classList.toggle('dt-tool-host', isTool); dtBody.style.display = isAi ? 'none' : ''; }
  // The AI panel is persistent DOM shown only on the AI panel.
  const agentPanel = document.getElementById('inappAgentPanel');
  if (agentPanel) agentPanel.classList.toggle('dt-ai-active', isAi);
  const chip = document.getElementById('inappAgentChip');
  if (chip) chip.classList.toggle('active', isAi);
  _browserAgentState.open = isAi;
  _dtUpdateControls(tab);
  if (isAi) {
    try { _loadBrowserAgentStatus(); } catch (_) {}
    setTimeout(() => { const i = document.getElementById('inappAgentInput'); if (i) i.focus(); }, 50);
    return;
  }
  if (isTool) {
    _inappToolsTargetId = 'inappDevtoolsBody';
    _dtRunTool(tab);
    return;
  }
  _inappToolsTargetId = 'inappToolsBody';
  if (tab === 'performance') _dtFetchPerformance();
  if (tab === 'server') _dtAutoSelectServerTerm();
  if (tab === 'storage') _dtFetchStorage();
  browserDevtoolsRender();
}
// Show only the controls relevant to the active panel (no header overflow).
function _dtUpdateControls(panel) {
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  const isLog = ['console', 'network', 'server', 'performance', 'storage'].includes(panel);
  show('inappDevtoolsLevel', panel === 'console');
  show('inappDevtoolsServerTerm', panel === 'server');
  show('inappDevtoolsFilter', ['console', 'network', 'server', 'storage'].includes(panel));
  show('inappDevtoolsPreserveWrap', ['console', 'network'].includes(panel));
  show('inappDevtoolsCopyBtn', isLog);
  show('inappDevtoolsExportBtn', isLog);
  show('inappDevtoolsClearBtn', ['console', 'network', 'server'].includes(panel));
  const repl = document.getElementById('inappDevtoolsRepl');
  if (repl) repl.style.display = panel === 'console' ? 'flex' : 'none';
}
// ── Panel picker menu ──────────────────────────────────────────────────────
function browserDevtoolsToggleMenu() {
  const menu = document.getElementById('inappDevtoolsMenu');
  if (!menu) return;
  if (menu.classList.contains('open')) { menu.classList.remove('open'); return; }
  browserDevtoolsRenderMenu();
  menu.classList.add('open');
}
function browserDevtoolsCloseMenu() {
  const menu = document.getElementById('inappDevtoolsMenu');
  if (menu) menu.classList.remove('open');
}
function _dtPanelCount(id) {
  if (id === 'console') return _dt.console.length;
  if (id === 'network') return _dt.network.length;
  return null;
}
function browserDevtoolsRenderMenu() {
  const menu = document.getElementById('inappDevtoolsMenu');
  if (!menu) return;
  const esc = _escapeHtml;
  const groups = {};
  _DT_PANELS.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
  let html = '';
  Object.keys(groups).forEach(g => {
    html += `<div class="dt-menu-group">${esc(g)}</div>`;
    groups[g].forEach(p => {
      const c = _dtPanelCount(p.id);
      const badge = c != null && c > 0 ? `<span class="dt-menu-count">${c}</span>` : '';
      html += `<button class="dt-menu-item${p.id === _dt.tab ? ' active' : ''}" type="button" onclick="browserDevtoolsMenuPick('${p.id}')"><span class="dt-menu-name">${esc(p.label)}</span>${badge}</button>`;
    });
  });
  html += `<div class="dt-menu-group">Page actions</div>`;
  _DT_ACTIONS.forEach(a => {
    let on = false; try { on = a.active ? !!a.active() : false; } catch (_) {}
    const pill = on ? '<span class="dt-menu-pill">On</span>' : '';
    html += `<button class="dt-menu-item" type="button" onclick="browserDevtoolsMenuAction('${a.id}')"><span class="dt-menu-name">${esc(a.label)}</span>${pill}</button>`;
  });
  html += `<div class="dt-menu-group">View</div>`;
  const zoom = _formatInappBrowserZoom(state._inappBrowserZoomFactor);
  html += `<div class="dt-zoom-row">`
    + `<span class="dt-zoom-label">Zoom</span>`
    + `<button class="dt-zoom-btn" type="button" onclick="browserDevtoolsZoom('out')" title="Zoom out">&minus;</button>`
    + `<span class="dt-zoom-value" id="dtZoomValue">${esc(zoom)}</span>`
    + `<button class="dt-zoom-btn" type="button" onclick="browserDevtoolsZoom('in')" title="Zoom in">+</button>`
    + `<button class="dt-zoom-btn dt-zoom-reset" type="button" onclick="browserDevtoolsZoom('reset')" title="Reset zoom">Reset</button>`
    + `</div>`;
  html += `<button class="dt-menu-item" type="button" onclick="browserDevtoolsResetView()"><span class="dt-menu-name">Reset view</span></button>`;
  menu.innerHTML = html;
}
function browserDevtoolsOpenMenu() {
  toggleBrowserDevtools(true);
  const menu = document.getElementById('inappDevtoolsMenu');
  if (menu && !menu.classList.contains('open')) browserDevtoolsToggleMenu();
}
function browserDevtoolsMenuPick(id) { browserDevtoolsSwitch(id); }
function browserDevtoolsMenuAction(id) {
  browserDevtoolsCloseMenu();
  const a = _DT_ACTIONS.find(x => x.id === id);
  if (a && a.run) { try { a.run(); } catch (_) {} }
}
function browserDevtoolsZoom(dir) {
  try {
    if (dir === 'in') inappBrowserZoomIn();
    else if (dir === 'out') inappBrowserZoomOut();
    else inappBrowserZoomReset();
  } catch (_) {}
  const v = document.getElementById('dtZoomValue');
  if (v) v.textContent = _formatInappBrowserZoom(state._inappBrowserZoomFactor);
}
function browserDevtoolsResetView() {
  browserDevtoolsCloseMenu();
  try { inappBrowserZoomReset(); } catch (_) {}
  try { if (typeof _resetAllEmulation === 'function') _resetAllEmulation(); } catch (_) {}
  try { if (_inappToolsState.grayscale) toggleInappGrayscale(); } catch (_) {}
  try { if (_inappToolsState.focus) toggleInappFocusMode(); } catch (_) {}
  try { inappBrowserReload(); } catch (_) {}
}

async function _dtBackfill() {
  try {
    const [c, n] = await Promise.all([
      fetch('/api/browser/console?limit=' + MAX_DT_CONSOLE).then(r => r.json()).catch(() => null),
      fetch('/api/browser/network?limit=' + MAX_DT_NETWORK).then(r => r.json()).catch(() => null),
    ]);
    if (c && Array.isArray(c.events)) _dt.console = c.events.slice(-MAX_DT_CONSOLE);
    if (n && Array.isArray(n.events)) { _dt.network = []; _dt.netById.clear(); n.events.forEach(_dtMergeNetwork); }
    browserDevtoolsRender();
  } catch (_) {}
}

function _dtMergeNetwork(ev) {
  if (!ev || !ev.requestId) return;
  let row = _dt.netById.get(ev.requestId);
  if (!row) {
    row = { requestId: ev.requestId, url: ev.url || '', method: ev.method || 'GET', resourceType: ev.resourceType || null, state: 'pending', startedAt: ev.startedAt || ev.at || null };
    _dt.netById.set(ev.requestId, row);
    _dt.network.push(row);
    if (_dt.network.length > MAX_DT_NETWORK) { const drop = _dt.network.splice(0, _dt.network.length - MAX_DT_NETWORK); drop.forEach(d => _dt.netById.delete(d.requestId)); }
  }
  if (ev.url) row.url = ev.url;
  if (ev.method) row.method = ev.method;
  if (ev.resourceType) row.resourceType = ev.resourceType;
  if (ev.requestHeaders) row.requestHeaders = ev.requestHeaders;
  if (ev.postData) row.postData = ev.postData;
  if (ev.kind === 'response') { row.status = ev.status; row.statusText = ev.statusText || null; row.mimeType = ev.mimeType || null; if (ev.responseHeaders) row.responseHeaders = ev.responseHeaders; if (ev.remoteAddress) row.remoteAddress = ev.remoteAddress; if (row.state === 'pending') row.state = 'response'; }
  if (ev.kind === 'failed') { row.state = 'failed'; row.errorText = ev.errorText || 'Failed'; row.failedAt = ev.failedAt || null; }
  if (ev.kind === 'finished') { row.state = 'done'; row.encodedDataLength = ev.encodedDataLength || 0; row.finishedAt = ev.finishedAt || null; if (row.startedAt && row.finishedAt) row.duration = row.finishedAt - row.startedAt; if (ev.status) row.status = ev.status; }
}

// WS hooks (dispatched from the central socket switch in terminals.js).
function browserDevtoolsOnEvent(msg) {
  if (!msg || !msg.event) return;
  if (msg.channel === 'console') {
    _dt.console.push(msg.event);
    if (_dt.console.length > MAX_DT_CONSOLE) _dt.console.splice(0, _dt.console.length - MAX_DT_CONSOLE);
    if (_dtConsoleLevel(msg.event.type) === 'error' && !_dt.open) { _dt.errorCount++; _dtUpdateBadge(); }
    if (_dt.open && _dt.tab === 'console') _dtScheduleRender();
  } else if (msg.channel === 'network') {
    _dtMergeNetwork(msg.event);
    if (_dt.open && _dt.tab === 'network') _dtScheduleRender();
  }
}
function browserDevtoolsOnNavigate(url) {
  _dt.curUrl = url || _dt.curUrl;
  if (!_dtPreserveOn()) {
    _dt.console = [];
    _dt.network = []; _dt.netById.clear(); _dt.expanded.clear(); _dt.bodies.clear();
    if (_dt.open) browserDevtoolsRender();
  }
}
function browserDevtoolsOnTermCwd(termId, cwd, repo) {
  if (!termId) return;
  const t = _dtTerm(termId);
  if (cwd) t.cwd = cwd;
  if (repo) t.repo = repo;
}
function browserDevtoolsOnTerminalOutput(termId, data) {
  if (!termId || data == null) return;
  const t = _dtTerm(termId);
  const clean = _dtStripAnsi(data);
  let buf = (t._partial || '') + clean;
  const parts = buf.split('\n');
  t._partial = parts.pop();
  for (const p of parts) t.lines.push(_dtApplyCr(p));
  if (t.lines.length > MAX_DT_SERVER_LINES) t.lines.splice(0, t.lines.length - MAX_DT_SERVER_LINES);
  // Dev-server fingerprinting from the stream.
  const probe = clean;
  const m = probe.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"]*/i);
  if (m) { t.devUrl = m[0]; t.isDev = true; }
  if (!t.isDev && /\b(VITE v|ready in|Local:\s+https?|webpack compiled|compiled successfully|next dev|Nuxt|nodemon|listening on|dev server|server (?:running|started|listening))/i.test(probe)) t.isDev = true;
  if (_dt.open && _dt.tab === 'server' && termId === _dt.serverTermId) _dtScheduleRender();
}
function _dtTerm(termId) {
  let t = _dt.terms.get(termId);
  if (!t) { t = { cwd: '', repo: '', lines: [], _partial: '', devUrl: null, isDev: false }; _dt.terms.set(termId, t); }
  return t;
}

function browserDevtoolsClear() {
  if (_dt.tab === 'console') _dt.console = [];
  else if (_dt.tab === 'network') { _dt.network = []; _dt.netById.clear(); _dt.expanded.clear(); _dt.bodies.clear(); }
  else if (_dt.tab === 'server') { const t = _dt.terms.get(_dt.serverTermId); if (t) { t.lines = []; t._partial = ''; } }
  else if (_dt.tab === 'performance') { _dt.perf = null; _dtFetchPerformance(); }
  browserDevtoolsRender();
}

function _dtPreserveOn() {
  const cb = document.getElementById('inappDevtoolsPreserve');
  return !!(cb && cb.checked);
}
function _dtFilterText() {
  const f = document.getElementById('inappDevtoolsFilter');
  return f && f.value ? f.value.toLowerCase() : '';
}
function _dtUpdateBadge() {
  const b = document.getElementById('inappDevtoolsBadge');
  if (!b) return;
  if (_dt.errorCount > 0) { b.textContent = _dt.errorCount > 99 ? '99+' : String(_dt.errorCount); b.style.display = ''; }
  else b.style.display = 'none';
}
function _dtScheduleRender() {
  if (_dt._renderQueued) return;
  _dt._renderQueued = true;
  requestAnimationFrame(() => { _dt._renderQueued = false; browserDevtoolsRender(); });
}

function browserDevtoolsRender() {
  const body = document.getElementById('inappDevtoolsBody');
  if (!body || !_dt.open) return;
  if (_DT_TOOL_TABS.includes(_dt.tab)) return; // tool tabs render their own body
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  if (_dt.tab === 'console') _dtRenderConsole(body);
  else if (_dt.tab === 'network') _dtRenderNetwork(body);
  else if (_dt.tab === 'performance') _dtRenderPerformance(body);
  else if (_dt.tab === 'server') _dtRenderServer(body);
  else if (_dt.tab === 'storage') _dtRenderStorage(body);
  if ((_dt.tab === 'console' || _dt.tab === 'server') && nearBottom) body.scrollTop = body.scrollHeight;
}

function _dtRenderConsole(body) {
  const lvl = (document.getElementById('inappDevtoolsLevel') || {}).value || 'all';
  const q = _dtFilterText();
  const rows = _dt.console.filter(e => {
    const level = _dtConsoleLevel(e.type);
    if (lvl !== 'all' && level !== lvl) return false;
    if (q && !((e.text || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q))) return false;
    return true;
  });
  if (!rows.length) { body.innerHTML = '<div class="inapp-devtools-empty">No console messages.' + (q || lvl !== 'all' ? ' (filtered)' : '') + '</div>'; return; }
  body.innerHTML = rows.map(e => {
    const level = _dtConsoleLevel(e.type);
    const extra = e.type === 'input' ? ' dt-input' : e.type === 'result' ? ' dt-result' : '';
    const src = e.url ? `<span class="dt-src">${_escapeHtml((e.url || '').split('/').slice(-1)[0])}${e.lineNumber != null ? ':' + e.lineNumber : ''}</span>` : '';
    return `<div class="dt-row dt-${level}${extra}"><span class="dt-time">${_dtFmtTime(e.at)}</span><span class="dt-text">${_escapeHtml(e.text || '')}</span>${src}</div>`;
  }).join('');
}

const _DT_NET_TYPES = [['all', 'All'], ['fetch', 'Fetch/XHR'], ['script', 'JS'], ['stylesheet', 'CSS'], ['image', 'Img'], ['document', 'Doc'], ['font', 'Font'], ['other', 'Other']];
function _dtNetTypeOf(r) {
  const t = (r.resourceType || '').toLowerCase();
  if (t === 'xhr' || t === 'fetch') return 'fetch';
  if (t === 'script') return 'script';
  if (t === 'stylesheet') return 'stylesheet';
  if (t === 'image') return 'image';
  if (t === 'document') return 'document';
  if (t === 'font') return 'font';
  return 'other';
}
function browserDevtoolsNetType(t) { _dt.netTypeFilter = t; browserDevtoolsRender(); }
function _dtNetToCurl(r) {
  let c = "curl '" + (r.url || '') + "'";
  if (r.method && r.method !== 'GET') c += ' \\\n  -X ' + r.method;
  const h = r.requestHeaders || {};
  Object.keys(h).forEach(k => { if (!/^:/.test(k)) c += " \\\n  -H '" + k + ': ' + String(h[k]).replace(/'/g, "'\\''") + "'"; });
  if (r.postData) c += " \\\n  --data-raw '" + String(r.postData).replace(/'/g, "'\\''") + "'";
  return c;
}
function browserDevtoolsCopyCurl(requestId) {
  const r = _dt.netById.get(requestId);
  if (!r) return;
  const c = _dtNetToCurl(r);
  if (navigator.clipboard) navigator.clipboard.writeText(c).then(() => { if (window.toast) window.toast('Copied as cURL'); }).catch(() => {});
}
function _dtHeadersBlock(title, h) {
  if (!h || !Object.keys(h).length) return '';
  const rows = Object.keys(h).map(k => `<div class="dt-kv"><b>${_escapeHtml(k)}:</b> ${_escapeHtml(String(h[k]))}</div>`).join('');
  return `<div class="dt-kv" style="margin-top:6px;"><b>${title}</b></div>${rows}`;
}
function _dtRenderNetwork(body) {
  const q = _dtFilterText();
  const tf = _dt.netTypeFilter || 'all';
  const rows = _dt.network.filter(r => (!q || (r.url || '').toLowerCase().includes(q)) && (tf === 'all' || _dtNetTypeOf(r) === tf));
  const chips = `<div class="dt-net-types">` + _DT_NET_TYPES.map(([k, lbl]) => `<button class="dt-net-type${tf === k ? ' active' : ''}" onclick="browserDevtoolsNetType('${k}')">${lbl}</button>`).join('') + `</div>`;
  if (!rows.length) { body.innerHTML = chips + '<div class="inapp-devtools-empty">No network activity.' + (q || tf !== 'all' ? ' (filtered)' : '') + '</div>'; return; }
  const head = `<div class="dt-net-head"><span>Name</span><span>Method</span><span>Status</span><span>Type</span><span>Size</span></div>`;
  const list = rows.map(r => {
    const name = (r.url || '').split('?')[0].split('/').slice(-1)[0] || r.url || '(index)';
    const statusCls = r.state === 'failed' ? 'sx' : (r.status ? 's' + String(r.status)[0] : '');
    const statusTxt = r.state === 'failed' ? 'failed' : (r.status != null ? r.status : (r.state === 'pending' ? '(pending)' : ''));
    const size = r.state === 'failed' ? '' : _dtFmtBytes(r.encodedDataLength);
    let out = `<div class="dt-net-row${r.state === 'failed' ? ' dt-failed' : ''}" onclick="browserDevtoolsToggleNetRow('${r.requestId}')" title="${_escapeHtml(r.url || '')}">`
      + `<span class="dt-net-name">${_escapeHtml(name)}</span>`
      + `<span class="dt-net-col">${_escapeHtml(r.method || '')}</span>`
      + `<span class="dt-net-status ${statusCls}">${_escapeHtml(String(statusTxt))}</span>`
      + `<span class="dt-net-col">${_escapeHtml(r.resourceType || '')}</span>`
      + `<span class="dt-net-col">${size}</span></div>`;
    if (_dt.expanded.has(r.requestId)) {
      const b = _dt.bodies.get(r.requestId);
      const dur = r.duration != null ? r.duration + ' ms' : '';
      out += `<div class="dt-net-detail" onclick="event.stopPropagation()">`
        + `<div style="margin-bottom:6px;"><button class="dt-net-curl" onclick="browserDevtoolsCopyCurl('${r.requestId}')">Copy as cURL</button></div>`
        + `<div class="dt-kv"><b>URL:</b> ${_escapeHtml(r.url || '')}</div>`
        + `<div class="dt-kv"><b>Status:</b> ${_escapeHtml(String(r.status != null ? r.status : (r.errorText || r.state)))}${r.statusText ? ' ' + _escapeHtml(r.statusText) : ''}</div>`
        + (r.mimeType ? `<div class="dt-kv"><b>Type:</b> ${_escapeHtml(r.mimeType)}</div>` : '')
        + (r.remoteAddress ? `<div class="dt-kv"><b>Remote:</b> ${_escapeHtml(r.remoteAddress)}</div>` : '')
        + (dur ? `<div class="dt-kv"><b>Duration:</b> ${dur}</div>` : '')
        + _dtHeadersBlock('Request headers', r.requestHeaders)
        + (r.postData ? `<div class="dt-kv" style="margin-top:6px;"><b>Request payload:</b></div><div>${_escapeHtml(r.postData)}</div>` : '')
        + _dtHeadersBlock('Response headers', r.responseHeaders)
        + `<div class="dt-kv" style="margin-top:6px;"><b>Response body:</b></div>`
        + `<div>${b === undefined ? '<em>loading...</em>' : (b === null ? '<em>(no body / not available)</em>' : _escapeHtml(b))}</div></div>`;
    }
    return out;
  }).join('');
  body.innerHTML = chips + head + list;
}

function browserDevtoolsToggleNetRow(requestId) {
  if (_dt.expanded.has(requestId)) { _dt.expanded.delete(requestId); browserDevtoolsRender(); return; }
  _dt.expanded.add(requestId);
  if (!_dt.bodies.has(requestId)) {
    _dt.bodies.set(requestId, undefined); // loading sentinel
    fetch('/api/browser/network-body?requestId=' + encodeURIComponent(requestId))
      .then(r => r.json()).then(d => { _dt.bodies.set(requestId, d && d.body ? d.body : null); browserDevtoolsRender(); })
      .catch(() => { _dt.bodies.set(requestId, null); browserDevtoolsRender(); });
  }
  browserDevtoolsRender();
}

async function _dtFetchPerformance() {
  const view = _getInappWebview();
  if (!view || typeof view.executeJavaScript !== 'function') { _dt.perf = { error: 'Performance metrics require the Electron webview.' }; if (_dt.open && _dt.tab === 'performance') browserDevtoolsRender(); return; }
  const js = `(function(){try{
    var nav=performance.getEntriesByType('navigation')[0]||{};
    var res=performance.getEntriesByType('resource')||[];
    var byType={},total=0,slow=[];
    res.forEach(function(r){byType[r.initiatorType]=(byType[r.initiatorType]||0)+1;total+=(r.transferSize||0);slow.push({name:r.name,dur:Math.round(r.duration),type:r.initiatorType});});
    slow.sort(function(a,b){return b.dur-a.dur;});
    var s=nav.startTime||0;
    return JSON.stringify({ts:{ttfb:nav.responseStart?Math.round(nav.responseStart-nav.requestStart):null,domInteractive:nav.domInteractive?Math.round(nav.domInteractive-s):null,domContentLoaded:nav.domContentLoadedEventEnd?Math.round(nav.domContentLoadedEventEnd-s):null,load:nav.loadEventEnd?Math.round(nav.loadEventEnd-s):null,transfer:nav.transferSize||null},count:res.length,total:total,byType:byType,slow:slow.slice(0,8),mem:(performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null)});
  }catch(e){return JSON.stringify({error:String(e)});}})()`;
  try { const out = await view.executeJavaScript(js); _dt.perf = JSON.parse(out); }
  catch (e) { _dt.perf = { error: String(e && e.message || e) }; }
  if (_dt.open && _dt.tab === 'performance') browserDevtoolsRender();
}

function _dtRenderPerformance(body) {
  const p = _dt.perf;
  if (!p) { body.innerHTML = '<div class="inapp-devtools-empty">Reading page timing...</div>'; return; }
  if (p.error) { body.innerHTML = '<div class="inapp-devtools-empty">' + _escapeHtml(p.error) + '</div>'; return; }
  const card = (val, lbl) => `<div class="dt-perf-card"><div class="dt-perf-val">${val == null ? '—' : val}</div><div class="dt-perf-lbl">${lbl}</div></div>`;
  const ms = v => v == null ? null : v + ' ms';
  const ts = p.ts || {};
  let html = '<div class="dt-perf">';
  html += '<div class="dt-perf-section-title">Page load timing</div><div class="dt-perf-grid">'
    + card(ms(ts.ttfb), 'TTFB') + card(ms(ts.domInteractive), 'DOM Interactive')
    + card(ms(ts.domContentLoaded), 'DOMContentLoaded') + card(ms(ts.load), 'Load')
    + card(ts.transfer != null ? _dtFmtBytes(ts.transfer) : null, 'Document size') + '</div>';
  html += '<div class="dt-perf-section-title">Resources</div><div class="dt-perf-grid">'
    + card(p.count, 'Requests') + card(_dtFmtBytes(p.total || 0), 'Transferred')
    + (p.mem ? card(_dtFmtBytes(p.mem.used), 'JS heap used') : '') + '</div>';
  const types = Object.keys(p.byType || {});
  if (types.length) html += '<div class="dt-perf-section-title">By type</div><div class="dt-perf-grid">' + types.map(t => card(p.byType[t], t)).join('') + '</div>';
  if (p.slow && p.slow.length) {
    html += '<div class="dt-perf-section-title">Slowest requests</div>';
    html += p.slow.map(s => `<div class="dt-row"><span class="dt-text">${_escapeHtml((s.name || '').split('/').slice(-1)[0] || s.name)}</span><span class="dt-src">${s.dur} ms</span></div>`).join('');
  }
  html += '</div>';
  body.innerHTML = html;
}

function _dtCandidateServerTerms() {
  const active = (typeof state !== 'undefined' && state && state.activeRepo) ? state.activeRepo : null;
  const all = Array.from(_dt.terms.entries()).map(([id, t]) => ({ id, ...t }));
  let cands = active ? all.filter(t => t.repo === active) : all;
  if (!cands.length) cands = all.filter(t => t.lines.length || t.isDev);
  if (!cands.length) cands = all;
  // Dev-server-like first.
  cands.sort((a, b) => (b.isDev ? 1 : 0) - (a.isDev ? 1 : 0));
  return cands;
}
function _dtAutoSelectServerTerm() {
  const cands = _dtCandidateServerTerms();
  if (!cands.length) { _dt.serverTermId = null; return; }
  if (_dt.serverTermId && cands.some(c => c.id === _dt.serverTermId)) { _dtFillServerTermSelect(cands); return; }
  // Prefer the terminal whose dev URL origin matches the page being viewed.
  let originPort = null;
  try { const u = new URL(_dt.curUrl || (_getInappWebview() && _getInappWebview().getURL ? _getInappWebview().getURL() : '')); originPort = u.port || (u.protocol === 'https:' ? '443' : '80'); } catch (_) {}
  let pick = null;
  if (originPort) pick = cands.find(c => { try { return c.devUrl && (new URL(c.devUrl).port || '') === originPort; } catch (_) { return false; } });
  pick = pick || cands.find(c => c.isDev) || cands[0];
  _dt.serverTermId = pick.id;
  _dtFillServerTermSelect(cands);
}
function _dtFillServerTermSelect(cands) {
  const sel = document.getElementById('inappDevtoolsServerTerm');
  if (!sel) return;
  cands = cands || _dtCandidateServerTerms();
  sel.innerHTML = cands.map(c => {
    const label = (c.isDev && c.devUrl ? '● ' : '') + (c.id === 'main' ? 'Main shell' : c.id) + (c.devUrl ? ' — ' + c.devUrl.replace(/^https?:\/\//, '') : '');
    return `<option value="${c.id}"${c.id === _dt.serverTermId ? ' selected' : ''}>${_escapeHtml(label)}</option>`;
  }).join('');
}
function browserDevtoolsSelectServerTerm(termId) { _dt.serverTermId = termId; browserDevtoolsRender(); }

function _dtRenderServer(body) {
  const cands = _dtCandidateServerTerms();
  if (!cands.length) { body.innerHTML = '<div class="inapp-devtools-empty">No project terminal output yet. Start your dev server in a Symphonee terminal and it will appear here.</div>'; return; }
  if (!_dt.serverTermId || !cands.some(c => c.id === _dt.serverTermId)) _dtAutoSelectServerTerm();
  _dtFillServerTermSelect(cands);
  const t = _dt.terms.get(_dt.serverTermId);
  if (!t) { body.innerHTML = '<div class="inapp-devtools-empty">No output for the selected terminal.</div>'; return; }
  const q = _dtFilterText();
  const all = t._partial ? t.lines.concat([t._partial]) : t.lines;
  const lines = q ? all.filter(l => l.toLowerCase().includes(q)) : all;
  const hint = `<div class="dt-server-hint">${t.devUrl ? 'Dev server: ' + _escapeHtml(t.devUrl) : 'Terminal output' }${t.repo ? ' · repo: ' + _escapeHtml(t.repo) : ''}</div>`;
  if (!lines.length) { body.innerHTML = hint + '<div class="inapp-devtools-empty">No output' + (q ? ' (filtered)' : '') + '.</div>'; return; }
  const rows = lines.map(l => {
    const cls = /error|exception|✖|failed|cannot|EADDRINUSE/i.test(l) ? ' dt-err' : (/warn/i.test(l) ? ' dt-warn' : '');
    return `<div class="dt-srv-line${cls}">${_escapeHtml(l) || '&nbsp;'}</div>`;
  }).join('');
  body.innerHTML = hint + '<div class="dt-server">' + rows + '</div>';
}

// Storage panel: cookies + localStorage + sessionStorage (view, edit, delete).
function _dtPrompt(msg, def) {
  if (typeof window.customPrompt === 'function') { try { return Promise.resolve(window.customPrompt(msg, def || '')); } catch (_) {} }
  return Promise.resolve(window.prompt(msg, def || ''));
}
async function _dtFetchStorage() {
  try { const c = await fetch('/api/browser/cookies').then(r => r.json()).catch(() => null); _dt.storage.cookies = (c && (c.cookies || c)) || []; } catch (_) { _dt.storage.cookies = []; }
  const view = _getInappWebview();
  if (view && typeof view.executeJavaScript === 'function') {
    try {
      const out = await view.executeJavaScript(`(function(){function d(s){var o={};try{for(var i=0;i<s.length;i++){var k=s.key(i);o[k]=s.getItem(k);}}catch(e){}return o;}return JSON.stringify({local:d(localStorage),session:d(sessionStorage)});})()`);
      const s = JSON.parse(out); _dt.storage.local = s.local || {}; _dt.storage.session = s.session || {};
    } catch (_) {}
  }
  if (_dt.open && _dt.tab === 'storage') browserDevtoolsRender();
}
function _dtStorageArea(kind) { return kind === 'session' ? 'sessionStorage' : 'localStorage'; }
async function browserDevtoolsStorageSet(kind, key) {
  const cur = (_dt.storage[kind] || {})[key];
  const val = await _dtPrompt('Set ' + kind + 'Storage["' + key + '"]', cur != null ? String(cur) : '');
  if (val == null) return;
  const view = _getInappWebview(); if (!view || !view.executeJavaScript) return;
  await view.executeJavaScript(`(function(){try{${_dtStorageArea(kind)}.setItem(${JSON.stringify(key)},${JSON.stringify(String(val))});return 1}catch(e){return String(e)}})()`).catch(() => {});
  _dtFetchStorage();
}
async function browserDevtoolsStorageAdd(kind) {
  const key = await _dtPrompt('New ' + kind + 'Storage key', '');
  if (!key) return;
  const val = await _dtPrompt('Value for "' + key + '"', '');
  if (val == null) return;
  const view = _getInappWebview(); if (!view || !view.executeJavaScript) return;
  await view.executeJavaScript(`(function(){try{${_dtStorageArea(kind)}.setItem(${JSON.stringify(key)},${JSON.stringify(String(val))});return 1}catch(e){return String(e)}})()`).catch(() => {});
  _dtFetchStorage();
}
async function browserDevtoolsStorageDel(kind, key) {
  const view = _getInappWebview(); if (!view || !view.executeJavaScript) return;
  if (kind === 'cookie') {
    await view.executeJavaScript(`(function(){try{document.cookie=${JSON.stringify(key)}+'=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';return 1}catch(e){return String(e)}})()`).catch(() => {});
  } else {
    await view.executeJavaScript(`(function(){try{${_dtStorageArea(kind)}.removeItem(${JSON.stringify(key)});return 1}catch(e){return String(e)}})()`).catch(() => {});
  }
  _dtFetchStorage();
}
function _dtStorageSection(title, kind, obj, q) {
  const keys = Object.keys(obj || {}).filter(k => !q || k.toLowerCase().includes(q) || String(obj[k]).toLowerCase().includes(q)).sort();
  const add = `<button class="dt-net-curl" onclick="browserDevtoolsStorageAdd('${kind}')">+ Add</button>`;
  let rows = keys.map(k => `<div class="dt-store-row"><span class="dt-store-key" title="${_escapeHtml(k)}">${_escapeHtml(k)}</span>`
    + `<span class="dt-store-val" title="${_escapeHtml(String(obj[k]))}">${_escapeHtml(String(obj[k]))}</span>`
    + `<span class="dt-store-act"><button onclick="browserDevtoolsStorageSet('${kind}',${JSON.stringify(k).replace(/"/g, '&quot;')})" title="Edit">✎</button>`
    + `<button onclick="browserDevtoolsStorageDel('${kind}',${JSON.stringify(k).replace(/"/g, '&quot;')})" title="Delete">×</button></span></div>`).join('');
  if (!keys.length) rows = '<div class="dt-store-empty">empty</div>';
  return `<div class="dt-store-section"><div class="dt-store-title">${title} <span>${keys.length}</span>${add}</div>${rows}</div>`;
}
function _dtRenderStorage(body) {
  const q = _dtFilterText();
  const s = _dt.storage;
  let html = '';
  html += _dtStorageSection('Local Storage', 'local', s.local, q);
  html += _dtStorageSection('Session Storage', 'session', s.session, q);
  // Cookies (read-only values; delete attempts a JS expiry).
  const cks = (s.cookies || []).filter(c => !q || (c.name || '').toLowerCase().includes(q) || (c.value || '').toLowerCase().includes(q));
  let crows = cks.map(c => `<div class="dt-store-row"><span class="dt-store-key" title="${_escapeHtml(c.name || '')}">${_escapeHtml(c.name || '')}</span>`
    + `<span class="dt-store-val" title="${_escapeHtml(c.value || '')}">${_escapeHtml(c.value || '')}<span class="dt-src"> ${_escapeHtml(c.domain || '')}${c.httpOnly ? ' httpOnly' : ''}</span></span>`
    + `<span class="dt-store-act"><button onclick="browserDevtoolsStorageDel('cookie',${JSON.stringify(c.name || '').replace(/"/g, '&quot;')})" title="Delete (non-httpOnly)">×</button></span></div>`).join('');
  if (!cks.length) crows = '<div class="dt-store-empty">no cookies</div>';
  html += `<div class="dt-store-section"><div class="dt-store-title">Cookies <span>${cks.length}</span></div>${crows}</div>`;
  body.innerHTML = html;
}

// Console REPL: run JavaScript in the page (same surface AI eval uses).
function _dtPushConsole(entry) {
  _dt.console.push(entry);
  if (_dt.console.length > MAX_DT_CONSOLE) _dt.console.splice(0, _dt.console.length - MAX_DT_CONSOLE);
  if (_dt.open && _dt.tab === 'console') browserDevtoolsRender();
}
async function browserDevtoolsRunRepl(code) {
  code = String(code || '').trim();
  if (!code) return;
  _dt.replHistory.push(code);
  _dt.replIdx = _dt.replHistory.length;
  _dtPushConsole({ type: 'input', text: '> ' + code, at: Date.now() });
  const view = _getInappWebview();
  if (!view || typeof view.executeJavaScript !== 'function') { _dtPushConsole({ type: 'error', text: 'Console REPL requires the Electron webview.', at: Date.now() }); return; }
  const wrapped = `(function(){try{var __v=eval(${JSON.stringify(code)});return JSON.stringify({ok:true,val:(function(v){try{if(v===undefined)return 'undefined';if(v===null)return 'null';if(typeof v==='function')return String(v);if(typeof v==='object')return JSON.stringify(v,null,2);return String(v);}catch(e){return String(v);}})(__v)});}catch(e){return JSON.stringify({ok:false,val:(e&&e.stack)||String(e)});}})()`;
  try {
    const out = await view.executeJavaScript(wrapped, true);
    const r = JSON.parse(out);
    _dtPushConsole({ type: r.ok ? 'result' : 'error', text: (r.ok ? '< ' : '') + r.val, at: Date.now() });
  } catch (e) { _dtPushConsole({ type: 'error', text: String(e && e.message || e), at: Date.now() }); }
}
async function _dtReplAutocomplete(input) {
  const code = input.value;
  const m = code.match(/([\w$]+(?:\.[\w$]+)*\.)?([\w$]*)$/);
  if (!m) return;
  const base = m[1] ? m[1].slice(0, -1) : '';
  const frag = m[2] || '';
  const view = _getInappWebview();
  if (!view || typeof view.executeJavaScript !== 'function') return;
  const probe = base ? `Object.getOwnPropertyNames(${base}||{})` : 'Object.getOwnPropertyNames(window)';
  let names = [];
  try { names = JSON.parse(await view.executeJavaScript(`(function(){try{return JSON.stringify(${probe});}catch(e){return '[]';}})()`)) || []; } catch (_) { return; }
  const matches = names.filter(n => n.indexOf(frag) === 0 && n !== frag);
  if (!matches.length) return;
  const head = code.slice(0, code.length - frag.length);
  if (matches.length === 1) { input.value = head + matches[0]; return; }
  let cp = matches[0];
  for (const n of matches) { while (n.indexOf(cp) !== 0) cp = cp.slice(0, -1); }
  if (cp.length > frag.length) input.value = head + cp;
  _dtPushConsole({ type: 'log', text: matches.slice(0, 50).join('   '), at: Date.now() });
}
function _dtReplKeydown(e) {
  const input = e.target;
  if (e.key === 'Enter') { e.preventDefault(); const c = input.value; input.value = ''; browserDevtoolsRunRepl(c); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (!_dt.replHistory.length) return; _dt.replIdx = Math.max(0, _dt.replIdx - 1); input.value = _dt.replHistory[_dt.replIdx] || ''; }
  else if (e.key === 'ArrowDown') { e.preventDefault(); if (!_dt.replHistory.length) return; _dt.replIdx = Math.min(_dt.replHistory.length, _dt.replIdx + 1); input.value = _dt.replHistory[_dt.replIdx] || ''; }
  else if (e.key === 'Tab') { e.preventDefault(); _dtReplAutocomplete(input); }
}

// Copy / export the active panel as text (for sharing or AI hand-off).
function _dtCurrentPanelText() {
  if (_dt.tab === 'console') return _dt.console.map(e => `[${_dtFmtTime(e.at)}] ${e.text || ''}`).join('\n');
  if (_dt.tab === 'network') return _dt.network.map(r => `${r.method || ''} ${r.state === 'failed' ? 'FAILED' : (r.status || '')} ${r.url || ''} ${r.encodedDataLength ? _dtFmtBytes(r.encodedDataLength) : ''}`.trim()).join('\n');
  if (_dt.tab === 'server') { const t = _dt.terms.get(_dt.serverTermId); return t ? (t._partial ? t.lines.concat([t._partial]) : t.lines).join('\n') : ''; }
  if (_dt.tab === 'performance') return JSON.stringify(_dt.perf || {}, null, 2);
  return '';
}
function browserDevtoolsCopy() {
  const t = _dtCurrentPanelText();
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => { if (window.toast) window.toast('Copied ' + _dt.tab + ' log'); }).catch(() => {});
}
function browserDevtoolsExport() {
  const t = _dtCurrentPanelText();
  const blob = new Blob([t], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'symphonee-' + _dt.tab + '-log.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
(function wireDevtoolsRepl() {
  const input = document.getElementById('inappDevtoolsReplInput');
  if (input) input.addEventListener('keydown', _dtReplKeydown);
})();
// Close the panel-picker menu on an outside click or Escape.
(function wireDevtoolsMenuDismiss() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('click', e => {
    const picker = document.getElementById('inappDevtoolsMenu');
    if (!picker || !picker.classList.contains('open')) return;
    const wrap = picker.closest('.inapp-devtools-picker');
    if (wrap && !wrap.contains(e.target)) browserDevtoolsCloseMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') browserDevtoolsCloseMenu(); });
})();

// Resize the drawer by dragging its top handle.
// Dock the Tools drawer bottom / left / right (Chromium-style). Bottom resizes
// height; left/right resize width. Choice persists.
function browserDevtoolsSetDock(pos) {
  if (pos !== 'bottom' && pos !== 'left' && pos !== 'right') pos = 'bottom';
  _dt.dock = pos;
  try { localStorage.setItem('symphonee-tools-dock', pos); } catch (_) {}
  const content = document.getElementById('inappBrowserContent');
  if (content) { content.classList.remove('dock-bottom', 'dock-left', 'dock-right'); content.classList.add('dock-' + pos); }
  const el = document.getElementById('inappDevtools');
  if (el) { el.classList.remove('dock-bottom', 'dock-left', 'dock-right'); el.classList.add('dock-' + pos); el.style.height = ''; el.style.width = ''; }
  document.querySelectorAll('.dt-dock-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-dock') === pos));
}
(function wireDevtoolsResize() {
  const handle = document.getElementById('inappDevtoolsResize');
  const el = document.getElementById('inappDevtools');
  if (!handle || !el) return;
  let start = 0, startSize = 0, dragging = false, vertical = false;
  handle.addEventListener('mousedown', e => {
    dragging = true;
    vertical = _dt.dock === 'bottom';
    start = vertical ? e.clientY : e.clientX;
    startSize = vertical ? el.offsetHeight : el.offsetWidth;
    document.body.style.userSelect = 'none'; e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    if (vertical) {
      const parentH = el.parentElement ? el.parentElement.offsetHeight : window.innerHeight;
      el.style.height = Math.max(120, Math.min(parentH * 0.85, startSize + (start - e.clientY))) + 'px';
    } else {
      const parentW = el.parentElement ? el.parentElement.offsetWidth : window.innerWidth;
      const delta = _dt.dock === 'right' ? (start - e.clientX) : (e.clientX - start);
      el.style.width = Math.max(280, Math.min(parentW * 0.85, startSize + delta)) + 'px';
    }
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.userSelect = ''; } });
  // Restore persisted dock position.
  try {
    const saved = localStorage.getItem('symphonee-tools-dock');
    if (saved) browserDevtoolsSetDock(saved);
  } catch (_) {}
})();

// Keyboard: D toggles the drawer while the Browser tab is active.
document.addEventListener('keydown', e => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const panel = document.getElementById('panel-browser');
  if (!panel || !panel.classList.contains('active')) return;
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
  e.preventDefault();
  toggleBrowserDevtools();
});

// ── Public surface (functions reached from index.html / other parts / generated onclick) ──
window._applyAllPatches = _applyAllPatches;
window._applyEmulateDevice = _applyEmulateDevice;
window._applyEmulateMedia = _applyEmulateMedia;
window._applyEmulateThrottle = _applyEmulateThrottle;
window._applyInspectStyle = _applyInspectStyle;
window._applyPatchByIndex = _applyPatchByIndex;
window._autosizeAgentInput = _autosizeAgentInput;
window._clearAllPatches = _clearAllPatches;
window._clearBrowserSelectionAndHighlight = _clearBrowserSelectionAndHighlight;
window._clearIssues = _clearIssues;
window._copyText = _copyText;
window._inspectHideSelected = _inspectHideSelected;
window._inspectRemoveSelected = _inspectRemoveSelected;
window._inspectScrollSelected = _inspectScrollSelected;
window._inspectToggleEdit = _inspectToggleEdit;
window._onBrowserAgentProviderChange = _onBrowserAgentProviderChange;
window._openColorEditorAtChip = _openColorEditorAtChip;
window._pickInspectSelector = _pickInspectSelector;
window._propdocHide = _propdocHide;
window._propdocShow = _propdocShow;
window._quickviewHide = _quickviewHide;
window._quickviewShow = _quickviewShow;
window._refineBrandWithAi = _refineBrandWithAi;
window._refreshIssuesPanel = _refreshIssuesPanel;
window._removePatchByIndex = _removePatchByIndex;
window._resetAllEmulation = _resetAllEmulation;
window._runInappBrandDetect = _runInappBrandDetect;
window._runInappReaderView = _runInappReaderView;
window._runInappSiteAudit = _runInappSiteAudit;
window._saveAuditToNote = _saveAuditToNote;
window._saveBrandToNote = _saveBrandToNote;
window._scrubStart = _scrubStart;
window._symKitCall = _symKitCall;
window.applyInappBrowserAppearance = applyInappBrowserAppearance;
window.toggleBrowserDevtools = toggleBrowserDevtools;
window.browserDevtoolsSwitch = browserDevtoolsSwitch;
window.browserDevtoolsToggleMenu = browserDevtoolsToggleMenu;
window.browserDevtoolsMenuPick = browserDevtoolsMenuPick;
window.browserDevtoolsMenuAction = browserDevtoolsMenuAction;
window.browserDevtoolsSetDock = browserDevtoolsSetDock;
window.browserDevtoolsZoom = browserDevtoolsZoom;
window.browserDevtoolsResetView = browserDevtoolsResetView;
window.browserDevtoolsRender = browserDevtoolsRender;
window.browserDevtoolsClear = browserDevtoolsClear;
window.browserDevtoolsCopy = browserDevtoolsCopy;
window.browserDevtoolsExport = browserDevtoolsExport;
window.browserDevtoolsToggleNetRow = browserDevtoolsToggleNetRow;
window.browserDevtoolsNetType = browserDevtoolsNetType;
window.browserDevtoolsCopyCurl = browserDevtoolsCopyCurl;
window.browserDevtoolsStorageSet = browserDevtoolsStorageSet;
window.browserDevtoolsStorageAdd = browserDevtoolsStorageAdd;
window.browserDevtoolsStorageDel = browserDevtoolsStorageDel;
window.browserDevtoolsSelectServerTerm = browserDevtoolsSelectServerTerm;
window.browserDevtoolsEnsureCapture = browserDevtoolsEnsureCapture;
window.browserDevtoolsOnEvent = browserDevtoolsOnEvent;
window.browserDevtoolsOnNavigate = browserDevtoolsOnNavigate;
window.browserDevtoolsOnTermCwd = browserDevtoolsOnTermCwd;
window.browserDevtoolsOnTerminalOutput = browserDevtoolsOnTerminalOutput;
window.closeBrowserAgentDetailModal = closeBrowserAgentDetailModal;
window.closeInappToolsPanel = closeInappToolsPanel;
window.closeStagehandScreencast = closeStagehandScreencast;
window.handleBrowserAgentStep = handleBrowserAgentStep;
window.handleBrowserRouterDispatch = handleBrowserRouterDispatch;
window.handleStagehandScreencast = handleStagehandScreencast;
window.hideInappShortcutsHelp = hideInappShortcutsHelp;
window.inappBrowserBack = inappBrowserBack;
window.inappBrowserForward = inappBrowserForward;
window.inappBrowserGo = inappBrowserGo;
window.inappBrowserReload = inappBrowserReload;
window.refineBrowserAgentRequest = refineBrowserAgentRequest;
window.resetBrowserAgent = resetBrowserAgent;
window.sendBrowserAgent = sendBrowserAgent;
window.stopBrowserAgent = stopBrowserAgent;
window.toggleBrowserAgentPanel = toggleBrowserAgentPanel;
window.toggleInappMorePanel = toggleInappMorePanel;
window.toggleInappToolsPanelMenu = toggleInappToolsPanelMenu;
