// ── Reader view (overlay + scoped minimalist stylesheet) ────────────────
const _READER_FONT_SIZES = ['15px', '17px', '19px', '21px', '24px'];
const _inappReaderState = {
  active: false,
  sizeIdx: 2,
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
    // Push the current font-size so the reader matches the saved preference.
    _inappReaderSetFontSize(_READER_FONT_SIZES[_inappReaderState.sizeIdx]);
  }
  _renderInappReaderSidebar();
}
function _renderInappReaderSidebar() {
  const on = _inappReaderState.active;
  _setInappToolsBodyHtml(`
    <div style="text-align:center;padding:10px 4px 4px;">
      <i data-lucide="${on ? 'book-open-check' : 'book-open'}" style="width:22px;height:22px;display:block;margin:0 auto 6px;color:var(--accent);"></i>
      <div style="font:600 12px var(--font-ui);color:var(--text);">${on ? 'Reader view on' : 'Reader view off'}</div>
      <div style="font:11px/1.35 var(--font-ui);margin-top:3px;color:var(--subtext0);">${on ? 'Parsed ' + (_inappReaderState.words || 0).toLocaleString() + ' words from &lt;' + _escapeHtml(_inappReaderState.rootTag) + '&gt; &mdash; about ' + (_inappReaderState.minutes || 1) + ' min read.' : 'Click Turn on to parse the current page.'}</div>
    </div>
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;gap:4px;">
      <button class="tab-bar-btn" type="button" onclick="_runInappReaderView()"><i data-lucide="repeat" style="width:13px;height:13px;"></i> ${on ? 'Turn off' : 'Turn on'}</button>
      ${on ? `
        <button class="tab-bar-btn" type="button" id="readerSizeMinus" title="Smaller font"><i data-lucide="minus" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" id="readerSizePlus" title="Larger font"><i data-lucide="plus" style="width:13px;height:13px;"></i></button>
      ` : ''}
    </div>
  `);
  if (on) {
    const minus = document.getElementById('readerSizeMinus');
    const plus = document.getElementById('readerSizePlus');
    if (minus) minus.onclick = () => _inappReaderBumpFontSize(-1);
    if (plus) plus.onclick = () => _inappReaderBumpFontSize(+1);
  }
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
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