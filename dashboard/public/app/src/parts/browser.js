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
  if (_inappToolsState.open && _inappToolsState.current === 'inspect') {
    try {
      _renderInappCodeInspect();
    } catch (_) {}
  }
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
  const panel = document.getElementById('inappAgentPanel');
  const chip = document.getElementById('inappAgentChip');
  if (!panel || panel.classList.contains('open')) return;
  panel.classList.add('open');
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
    const inspectToolActive = _inappToolsState.open && _inappToolsState.current === 'inspect';
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
    toggleInappToolsPanelMenu();
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
    });
    view.addEventListener('did-navigate', e => {
      _syncInappUrl(e.url);
      _clearBrowserSelection();
      _resetOverlayStateForNewPage();
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
}