// ── Browser Agent chat panel ──────────────────────────────────────────────
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
  const panel = document.getElementById('inappAgentPanel');
  const chip = document.getElementById('inappAgentChip');
  if (!panel) return;
  _browserAgentState.open = !panel.classList.contains('open');
  panel.classList.toggle('open', _browserAgentState.open);
  if (chip) chip.classList.toggle('active', _browserAgentState.open);
  if (_browserAgentState.open) {
    _loadBrowserAgentStatus();
    setTimeout(() => {
      const i = document.getElementById('inappAgentInput');
      if (i) i.focus();
    }, 50);
  }
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
  kind: 'inspect',
  icon: 'code-2',
  title: 'Inspect code',
  sub: 'Human-readable view of tag, attributes, and computed styles.'
}, {
  kind: 'reader',
  icon: 'book-open',
  title: 'Reader view',
  sub: 'Strip the page down to its main article.'
}, {
  kind: 'audit',
  icon: 'gauge',
  title: 'Site audit',
  sub: 'SEO checks, performance timing, accessibility hints.'
}, {
  kind: 'emulate',
  icon: 'smartphone',
  title: 'Emulate device',
  sub: 'Viewport presets, color-scheme, reduced-motion.'
}, {
  kind: 'issues',
  icon: 'alert-octagon',
  title: 'Browser issues',
  sub: 'Live problems Chrome reports (CSP, mixed content, cookies).'
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
function _setInappToolsBodyHtml(html) {
  const body = document.getElementById('inappToolsBody');
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
    toggleInappToolsPanelMenu();
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
}, true);