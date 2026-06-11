/**
 * The ambient whisper - Symphonee's living presence (the liquid body).
 *
 * Not a widget: a small organism of liquid resting at the bottom edge of the
 * app. The visible shape is three gooey metaballs (an SVG blur+contrast
 * filter merges them), breathing on independent rhythms so the motion never
 * loops visibly. States:
 *   - RESTING droplet: always present, slowly breathing. Symphonee is with
 *     you even when it has nothing to say.
 *   - SWELLED capsule: a fresh thought arrives - the droplet swells into a
 *     liquid capsule with the one-line message and a jelly wobble.
 *   - PROXIMITY: the liquid leans toward the cursor as it comes near, and
 *     reopens the last thought without precise aiming.
 *   - OPEN panel: click melts the droplet upward into a calm panel with the
 *     full thought, its provenance ("because ..."), and inline actions.
 *
 * Anti-Clippy: triggers on signal (boot, focus, task events) not a timer; the
 * server's novelty gate + dial decide whether to speak; dismiss STICKS;
 * fully deactivatable. prefers-reduced-motion stills the liquid.
 *
 * Loads after app.js as /js/ambient-whisper.js. Self-contained.
 */

(() => {
  'use strict';

  const MIN_INTERVAL_MS = 90_000;
  const EXPAND_MS = 6500;          // how long a fresh thought stays swelled
  let _lastCheck = 0;
  let _current = null;
  let _disabled = false;
  let _hovering = false;
  let _collapseTimer = null;
  const _dismissed = new Set();    // titles the user dismissed -> never re-show
  let _pill = null;

  function _injectStyles() {
    if (document.getElementById('ambientWhisperStyles')) return;
    // The goo filter: blur the blobs, then crush the alpha curve so the blurred
    // edges fuse into one liquid silhouette. This is what makes it biology, not UI.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = '<defs><filter id="awGoo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b"/>' +
      '<feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -11"/></filter></defs>';
    document.body.appendChild(svg);

    const s = document.createElement('style');
    s.id = 'ambientWhisperStyles';
    s.textContent = `
      /* The shell is a CRISP PILL (Wispr Flow style) - the liquid lives INSIDE
         it, never as the silhouette. Clean edge, breathing glow. */
      #ambientWhisper{position:fixed;left:50%;bottom:14px;transform:translateX(-50%) translateY(18px);
        z-index:3200;display:none;align-items:center;box-sizing:border-box;cursor:pointer;overflow:hidden;
        min-width:170px;max-width:min(560px,84vw);height:34px;padding:0 16px;border-radius:999px;
        font-family:var(--font-ui,system-ui);font-size:12px;color:var(--text,#cdd6f4);
        background:color-mix(in srgb,var(--surface0,#1e1e2e) 86%,var(--accent,#89b4fa) 8%);
        border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 42%,transparent);
        opacity:0;animation:aw-breathe 4.4s ease-in-out infinite;
        transition:opacity .45s ease,transform .5s cubic-bezier(.2,.85,.25,1),
          min-width .55s cubic-bezier(.34,1.3,.3,1),max-width .55s cubic-bezier(.34,1.3,.3,1),
          height .5s cubic-bezier(.34,1.3,.3,1),padding .4s ease;}
      #ambientWhisper:hover{filter:brightness(1.1);}
      @keyframes aw-breathe{0%,100%{box-shadow:0 0 11px -4px var(--accent,#89b4fa),0 5px 18px -6px rgba(0,0,0,.5);}
        50%{box-shadow:0 0 24px -1px var(--accent,#89b4fa),0 5px 18px -6px rgba(0,0,0,.5);}}
      /* resting: a short pill on the waterline - always visible, always clickable */
      #ambientWhisper.aw-collapsed{min-width:84px;max-width:84px;height:15px;padding:0;}
      #ambientWhisper.aw-collapsed .aw-content{opacity:0;pointer-events:none;}
      /* the liquid INSIDE the shell: gooey metaballs clipped by the pill,
         drifting like light under glass */
      #ambientWhisper .aw-goo{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:.7;
        filter:url(#awGoo);
        transform:translateX(calc(var(--aw-lean,0)*7px));transition:transform .6s cubic-bezier(.2,.8,.2,1);}
      #ambientWhisper .aw-blob{position:absolute;border-radius:50%;
        background:color-mix(in srgb,var(--accent,#89b4fa) 30%,transparent);}
      #ambientWhisper .aw-blob.b1{left:-6%;top:14%;width:42%;height:120%;animation:aw-b1 4.6s ease-in-out infinite;}
      #ambientWhisper .aw-blob.b2{left:28%;top:-22%;width:50%;height:130%;animation:aw-b2 5.9s ease-in-out infinite;}
      #ambientWhisper .aw-blob.b3{left:62%;top:18%;width:44%;height:118%;animation:aw-b3 5.1s ease-in-out infinite;}
      /* each puddle of light breathes on its own rhythm - never loops visibly */
      @keyframes aw-b1{0%,100%{transform:translate(0,0) scale(1);}50%{transform:translate(9%,-7%) scale(1.12,.92);}}
      @keyframes aw-b2{0%,100%{transform:translate(0,0) scale(1);}45%{transform:translate(-7%,9%) scale(.93,1.1);}}
      @keyframes aw-b3{0%,100%{transform:translate(0,0) scale(1);}55%{transform:translate(-10%,-6%) scale(1.08,.94);}}
      /* a slow sheen drifting across the glass */
      #ambientWhisper .aw-sheen{position:absolute;inset:0;border-radius:inherit;pointer-events:none;overflow:hidden;
        opacity:.55;mix-blend-mode:screen;}
      #ambientWhisper .aw-sheen::before{content:'';position:absolute;inset:-20%;
        background:linear-gradient(100deg,transparent 32%,color-mix(in srgb,var(--accent,#89b4fa) 36%,transparent) 50%,transparent 68%);
        background-size:240% 100%;animation:aw-sheen 7s ease-in-out infinite;}
      @keyframes aw-sheen{0%{background-position:150% 0;}50%{background-position:-30% 0;}100%{background-position:150% 0;}}
      /* fresh thought: the liquid inside sloshes (the shell stays a pill) */
      #ambientWhisper.aw-fresh .aw-goo{animation:aw-slosh .9s cubic-bezier(.36,.07,.19,.97);}
      @keyframes aw-slosh{0%{transform:translateX(0) scale(1,1);}25%{transform:translateX(4px) scale(1.04,.94);}
        50%{transform:translateX(-3px) scale(.98,1.04);}72%{transform:translateX(2px) scale(1.01,.98);}100%{transform:translateX(0) scale(1,1);}}
      #ambientWhisper .aw-content{position:relative;z-index:1;display:flex;align-items:center;gap:9px;width:100%;
        opacity:1;transition:opacity .35s ease .12s;}
      #ambientWhisper .aw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--accent,#89b4fa);
        box-shadow:0 0 10px var(--accent,#89b4fa);animation:aw-dot 4.4s ease-in-out infinite;}
      @keyframes aw-dot{0%,100%{opacity:.55;transform:scale(.9);}50%{opacity:1;transform:scale(1.06);}}
      #ambientWhisper .aw-text{flex:1;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #ambientWhisper .aw-x{background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:15px;line-height:1;
        padding:1px 3px;cursor:pointer;flex:none;border-radius:6px;}
      #ambientWhisper .aw-x:hover{color:var(--text,#cdd6f4);}
      /* the panel melts UP out of the droplet - anchored to the waterline, not
         floating in the void like a dialog */
      #ambientWhisperModalBg{position:fixed;inset:0;z-index:3600;display:none;align-items:flex-end;justify-content:center;
        padding-bottom:62px;background:rgba(0,0,0,.32);backdrop-filter:blur(2px);font-family:var(--font-ui,system-ui);}
      #ambientWhisperModal{width:480px;max-width:90vw;border-radius:22px 22px 26px 26px;padding:0;overflow:hidden;
        background:color-mix(in srgb,var(--surface0,#1e1e2e) 90%,var(--accent,#89b4fa) 6%);
        border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 30%,var(--surface2,#45475a));
        box-shadow:0 0 44px -12px var(--accent,#89b4fa),0 18px 50px rgba(0,0,0,.55);
        transform-origin:50% 100%;transform:translateY(26px) scale(.86,.7);opacity:0;
        transition:opacity .26s ease,transform .34s cubic-bezier(.26,1.2,.32,1);}
      #ambientWhisperModal strong{color:var(--text,#cdd6f4);font-weight:600;}
      #ambientWhisperModal em{color:var(--subtext1,#cdd6f4);font-style:italic;}
      #ambientWhisperModal code{font-family:var(--font-mono,monospace);font-size:.92em;
        background:var(--surface1,#313244);padding:1px 5px;border-radius:5px;}
      @media (prefers-reduced-motion: reduce){
        #ambientWhisper,#ambientWhisper .aw-goo,#ambientWhisper .aw-blob,#ambientWhisper .aw-sheen::before,
        #ambientWhisper .aw-dot{animation:none !important;transition:opacity .2s ease !important;}
      }
    `;
    document.head.appendChild(s);
  }

  // Safe minimal markdown: escape, then **bold** *italic* `code` and line breaks.
  function _md(s) {
    let h = String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
         .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
         .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
         .replace(/\n/g, '<br>');
    return h;
  }
  function _plain(s) { return String(s == null ? '' : s).replace(/[*`_]/g, ''); }

  function _ensurePill() {
    if (_pill) return _pill;
    _injectStyles();
    const el = document.createElement('div');
    el.id = 'ambientWhisper';
    el.className = 'aw-collapsed';
    el.innerHTML =
      '<div class="aw-goo"><div class="aw-blob b1"></div><div class="aw-blob b2"></div><div class="aw-blob b3"></div></div>' +
      '<div class="aw-sheen"></div>' +
      '<div class="aw-content"><span class="aw-dot"></span><span class="aw-text"></span><button class="aw-x" title="Dismiss">&times;</button></div>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (!e.target.classList.contains('aw-x')) _openModal(); });
    el.querySelector('.aw-x').addEventListener('click', (e) => { e.stopPropagation(); _dismiss(); });
    _pill = el;
    return el;
  }

  // The droplet is ALWAYS there (unless whispers are off): presence, not popup.
  function _surface() {
    const el = _ensurePill();
    if (el.style.display !== 'flex') {
      el.style.display = 'flex';
      requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
    }
  }

  // Forgiving hover: the liquid leans toward a NEARBY cursor and swells open
  // (no precise aiming); it settles back when the cursor leaves. Throttled.
  let _moveAt = 0;
  function _proximity(e) {
    const now = Date.now();
    if (now - _moveAt < 50) return;
    _moveAt = now;
    if (!_pill || _disabled || _pill.style.display === 'none') return;
    const r = _pill.getBoundingClientRect();
    const pad = 52;
    const near = e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
    if (near) {
      // lean: -1 (cursor left of center) .. 1 (right of center)
      const cx = r.left + r.width / 2;
      const lean = Math.max(-1, Math.min(1, (e.clientX - cx) / (r.width / 2 + pad)));
      _pill.style.setProperty('--aw-lean', lean.toFixed(2));
    } else {
      _pill.style.setProperty('--aw-lean', '0');
    }
    // Only swell open on approach when there is a thought to show.
    if (near && _current && _pill.classList.contains('aw-collapsed')) { _hovering = true; _pill.classList.remove('aw-collapsed'); }
    else if (!near && _hovering) { _hovering = false; if (!_collapseTimer) _pill.classList.add('aw-collapsed'); }
  }
  document.addEventListener('mousemove', _proximity, { passive: true });

  function _showPill(nudge) {
    _current = nudge;
    // Every thought joins the session thread - even ones the user dismisses or
    // misses, so they can flip back through the cards later.
    const last = _thread[_thread.length - 1];
    if (!(last && last.kind === 'nudge' && last.n.title === nudge.title)) {
      _thread.push({ at: Date.now(), kind: 'nudge', n: nudge });
    }
    const el = _ensurePill();
    el.querySelector('.aw-text').textContent = _plain(nudge.title);
    _surface();
    el.classList.remove('aw-collapsed');
    el.classList.remove('aw-fresh');
    void el.offsetWidth;              // restart the wobble for back-to-back thoughts
    el.classList.add('aw-fresh');
    // After a few seconds, settle back into the resting droplet (unless hovered).
    clearTimeout(_collapseTimer);
    _collapseTimer = setTimeout(() => {
      _collapseTimer = null;
      if (!_hovering && _pill) _pill.classList.add('aw-collapsed');
    }, EXPAND_MS);
  }

  // Settle: clear the thought but KEEP the droplet present (it lives here).
  function _settle() {
    clearTimeout(_collapseTimer); _collapseTimer = null;
    _current = null;
    if (!_pill) return;
    _pill.classList.add('aw-collapsed');
    _pill.classList.remove('aw-fresh');
  }

  // Hide entirely (only for disable).
  function _hidePill() {
    clearTimeout(_collapseTimer); _collapseTimer = null;
    if (!_pill) { _current = null; return; }
    _pill.style.opacity = '0';
    _pill.style.transform = 'translateX(-50%) translateY(18px)';
    setTimeout(() => { if (_pill) _pill.style.display = 'none'; }, 300);
    _current = null;
  }

  const _BTN_PRIMARY = 'background:var(--accent,#89b4fa);border:none;color:#11111b;font-weight:600;font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer;';
  const _BTN_SOFT = 'background:var(--surface1,#313244);border:none;color:var(--subtext1,#cdd6f4);font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;';
  const _STATUS = (label) =>
    '<span style="font-size:12px;color:var(--subtext0,#a6adc8);display:flex;align-items:center;gap:7px;">' +
    '<span class="aw-dot" style="width:6px;height:6px;border-radius:50%;background:var(--accent,#89b4fa);box-shadow:0 0 8px var(--accent,#89b4fa);"></span>' +
    label + '</span>';

  // ── the island ──────────────────────────────────────────────────────────
  // A bottom Dynamic Island for AI: the pill morphs into a panel that holds
  // this SESSION'S whole thread - every thought Symphonee had (even dismissed
  // ones) and every Q&A, as cards you flip through with timestamps. The ask
  // box is always there; follow-ups carry the conversation so "explain more"
  // means something.
  const _thread = [];   // session history: {at, kind:'nudge', n} | {at, kind:'qa', q, a}
  let _convo = [];      // live conversation turns for follow-ups (panel lifetime)
  let _view = -1;       // which thread card is showing; -1 = the empty ask state

  function _fmtTime(ts) {
    const d = new Date(ts);
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + ':' + m + ' ' + ap;
  }

  function _renderView(modal) {
    const body = modal.querySelector('#awmBody');
    const actions = modal.querySelector('#awmActions');
    const nav = modal.querySelector('#awmNav');
    const e = _view >= 0 && _view < _thread.length ? _thread[_view] : null;
    // nav chip: flip through the session's cards
    if (_thread.length > 0) {
      const canPrev = _view !== 0;                       // from the ask state, prev opens the latest card
      const canNext = _view >= 0 && _view < _thread.length - 1;
      nav.innerHTML =
        '<button id="awmPrev" ' + (canPrev ? '' : 'disabled') + ' style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:13px;cursor:pointer;padding:0 2px;">&lsaquo;</button>' +
        '<span style="font-size:10.5px;color:var(--overlay1,#7f849c);">' + (e ? (_view + 1) + '/' + _thread.length + ' &middot; ' + _fmtTime(e.at) : _thread.length + ' this session') + '</span>' +
        '<button id="awmNext" ' + (canNext ? '' : 'disabled') + ' style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:13px;cursor:pointer;padding:0 2px;">&rsaquo;</button>';
      const prev = nav.querySelector('#awmPrev'); const next = nav.querySelector('#awmNext');
      if (prev) prev.addEventListener('click', () => { _view = _view === -1 ? _thread.length - 1 : Math.max(0, _view - 1); _renderView(modal); });
      if (next) next.addEventListener('click', () => { if (_view >= 0 && _view < _thread.length - 1) { _view += 1; _renderView(modal); } });
    } else nav.innerHTML = '';

    if (!e) {
      body.innerHTML = '<div style="font-size:13px;color:var(--subtext0,#a6adc8);">What do you want to know? I remember your notes, your decisions, and what every AI here has worked on.</div>';
      actions.innerHTML = _offHtml();
      _wireOff(modal);
      return;
    }
    if (e.kind === 'nudge') {
      const n = e.n;
      body.innerHTML =
        _md(n.title) +
        (n.detail ? '<div style="margin-top:7px;font-size:12px;line-height:1.6;color:var(--subtext0,#a6adc8);">' + _md(n.detail) + '</div>' : '') +
        // Provenance: WHY the whisper spoke - transparency keeps proactivity
        // from feeling like noise.
        (n.because ? '<div style="margin-top:9px;font-size:11px;font-style:italic;color:var(--overlay1,#7f849c);">because ' + _md(n.because) + '</div>' : '');
      const live = _current && _current.title === n.title;
      actions.innerHTML =
        '<button id="awmAct" style="' + _BTN_PRIMARY + '">' + (n.actionLabel || 'Show me') + '</button>' +
        (live ? '<button id="awmDismiss" style="' + _BTN_SOFT + '">Dismiss</button>' : '') +
        _offHtml();
      modal.querySelector('#awmAct').addEventListener('click', () => _runAction(n, modal));
      const dis = modal.querySelector('#awmDismiss');
      if (dis) dis.addEventListener('click', () => { _closeModal(); _dismiss(); });
      _wireOff(modal);
    } else {
      body.innerHTML =
        '<div style="font-size:11.5px;color:var(--overlay1,#7f849c);margin-bottom:7px;">' + _md(e.q) + '</div>' +
        '<div id="awmAnswer">' + _md(e.a) + '</div>';
      actions.innerHTML = '<button id="awmAgent" style="' + _BTN_SOFT + '">Go deeper in terminal</button>' + _offHtml();
      modal.querySelector('#awmAgent').addEventListener('click', () => { _closeModal(); _handToAgent(e.q, e.a); });
      _wireOff(modal);
    }
  }

  function _offHtml() {
    return '<span style="flex:1;"></span><button id="awmOff" style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:11px;cursor:pointer;text-decoration:underline;">Turn off</button>';
  }
  function _wireOff(modal) {
    const off = modal.querySelector('#awmOff');
    if (off) off.addEventListener('click', () => { _closeModal(); _disable(); });
  }

  function _openModal(opts) {
    opts = opts || {};
    let bg = document.getElementById('ambientWhisperModalBg');
    if (bg) bg.remove();
    bg = document.createElement('div');
    bg.id = 'ambientWhisperModalBg';
    bg.innerHTML =
      '<div id="ambientWhisperModal">' +
        '<div style="display:flex;align-items:center;gap:9px;padding:15px 18px 11px;">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent,#89b4fa);box-shadow:0 0 10px var(--accent,#89b4fa);"></span>' +
          '<strong style="font-size:13px;color:var(--text,#cdd6f4);">Symphonee</strong>' +
          '<span id="awmNav" style="display:flex;align-items:center;gap:5px;margin-left:4px;"></span>' +
          '<span style="flex:1;"></span>' +
          '<button id="awmClose" style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:17px;line-height:1;cursor:pointer;">&times;</button>' +
        '</div>' +
        '<div id="awmBody" style="padding:2px 18px 4px;font-size:14px;line-height:1.55;color:var(--text,#cdd6f4);max-height:46vh;overflow:auto;"></div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:11px 18px 4px;">' +
          '<input id="awmAsk" type="text" placeholder="Ask about your work..." style="flex:1;background:var(--surface1,#313244);border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 22%,var(--surface2,#45475a));border-radius:10px;color:var(--text,#cdd6f4);font-size:12.5px;padding:8px 12px;outline:none;font-family:inherit;"/>' +
          '<button id="awmAskGo" style="' + _BTN_PRIMARY + 'padding:8px 13px;">Ask</button>' +
        '</div>' +
        '<div id="awmActions" style="display:flex;align-items:center;gap:8px;padding:11px 18px 16px;"></div>' +
      '</div>';
    document.body.appendChild(bg);
    bg.style.display = 'flex';
    const modal = bg.querySelector('#ambientWhisperModal');
    // The island morph: the pill becomes the panel (it fades while open).
    if (_pill) { _pill.style.opacity = '0'; _pill.style.pointerEvents = 'none'; }
    requestAnimationFrame(() => { modal.style.opacity = '1'; modal.style.transform = 'translateY(0) scale(1)'; });
    bg.addEventListener('click', (e) => { if (e.target === bg) _closeModal(); });
    bg.querySelector('#awmClose').addEventListener('click', _closeModal);
    const askInput = bg.querySelector('#awmAsk');
    const go = () => { const q = askInput.value.trim(); if (q) { askInput.value = ''; _streamAsk(q, modal); } };
    bg.querySelector('#awmAskGo').addEventListener('click', go);
    askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    // default view: the latest card (the freshest thought), or the ask state
    _view = opts.askOnly ? -1 : (_thread.length ? _thread.length - 1 : -1);
    _renderView(modal);
    if (_view === -1 || opts.focusAsk) setTimeout(() => askInput.focus(), 80);
    return modal;
  }

  function _closeModal() {
    const bg = document.getElementById('ambientWhisperModalBg');
    if (bg) bg.remove();
    _convo = [];   // a closed panel ends the conversation; the thread survives
    if (_pill && !_disabled) { _pill.style.opacity = '1'; _pill.style.pointerEvents = ''; }
  }

  // Hand the thread to the user's WORKING CLI: paste a ready-made prompt into
  // the active terminal (no auto-submit - they read it and press Enter). The
  // palette is NOT the agent; the terminal is.
  function _handToAgent(question, answerSoFar) {
    try {
      const st = window.state || {};
      const tid = st.activeTermId || 'main';
      let prompt = 'Go deeper on this: ' + _plain(question).replace(/\s+/g, ' ').trim();
      const known = _plain(answerSoFar || '').replace(/\s+/g, ' ').trim();
      if (known) prompt += ' | What Symphonee already found in my local memory: ' + known.slice(0, 280);
      if (st.ws && st.ws.readyState === 1) {
        st.ws.send(JSON.stringify({ type: 'input', termId: tid, data: prompt }));
        try { if (typeof window.toast === 'function') window.toast('Prompt pasted into your terminal - press Enter to send.', 'success'); } catch (_) {}
        return true;
      }
    } catch (_) { /* fall through */ }
    // No live terminal socket: fall back to prefilling the palette.
    try { if (window.openCmdPalette) { window.openCmdPalette(question); return true; } } catch (_) {}
    return false;
  }

  // Stream a deep answer INTO the panel: status milestones while it retrieves,
  // tokens as the local model writes, then a clean final render. Follow-ups
  // carry the conversation (so "explain more" works); finished Q&As join the
  // session thread and are saved back to Mind so every CLI inherits them.
  async function _streamAsk(question, modal) {
    const body = modal.querySelector('#awmBody');
    const actions = modal.querySelector('#awmActions');
    body.innerHTML =
      '<div style="font-size:11.5px;color:var(--overlay1,#7f849c);margin-bottom:7px;">' + _md(question) + '</div>' +
      '<div id="awmAnswer"></div>';
    const answerEl = body.querySelector('#awmAnswer');
    actions.innerHTML = _STATUS('listening...');
    let text = '';
    let finale = null;
    try {
      const r = await fetch('/api/symphonee/ask/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: question, history: _convo.slice(-3) }),
      });
      if (!r.ok || !r.body) throw new Error('stream unavailable');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find(l => l.indexOf('data: ') === 0);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch (_) { continue; }
          if (ev.type === 'status') actions.innerHTML = _STATUS(ev.label + '...');
          else if (ev.type === 'token') { text += ev.text; answerEl.innerHTML = _md(text); body.scrollTop = body.scrollHeight; }
          else if (ev.type === 'done' || ev.type === 'escalate') finale = ev;
        }
      }
    } catch (_) { finale = { type: 'escalate', reason: 'offline' }; }

    if (finale && finale.type === 'done' && finale.answer) {
      _convo.push({ q: question, a: finale.answer });
      _thread.push({ at: Date.now(), kind: 'qa', q: question, a: finale.answer });
      _view = _thread.length - 1;
      _renderView(modal);
      const ask = modal.querySelector('#awmAsk');
      if (ask) ask.focus();
      // Save back to the shared brain - the next session of every CLI inherits this.
      fetch('/api/mind/save-result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer: finale.answer, citedNodeIds: finale.citedNodeIds || [], createdBy: 'symphonee' }),
      }).catch(() => {});
    } else {
      answerEl.innerHTML = '<div style="font-size:13px;color:var(--text,#cdd6f4);">I do not have enough on that - your agent can dig deeper.</div>';
      actions.innerHTML = '<button id="awmAgent" style="' + _BTN_PRIMARY + '">Hand to my terminal</button>' + _offHtml();
      modal.querySelector('#awmAgent').addEventListener('click', () => { _closeModal(); _handToAgent(question, ''); });
      _wireOff(modal);
    }
  }

  // Run the nudge's action RIGHT HERE through the same deep streaming engine.
  // No trip to the palette; the panel is the answer surface.
  function _runAction(n, modal) {
    _feedback(n.type, 'accept');
    // A one-shot nudge (a specific task) should not re-surface once the user
    // has engaged with it - acting counts as handled.
    if (n.type && (n.type.indexOf('task-failure') === 0 || n.type.indexOf('task-success') === 0)) _dismissed.add(n.title);
    _settle();
    _streamAsk((n.action && n.action.prompt) || _plain(n.title), modal);
  }

  function _feedback(type, action) {
    return fetch('/api/symphonee/ambient/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, action }),
    }).catch(() => {});
  }

  function _dismiss() {
    if (!_current) return;
    _dismissed.add(_current.title);   // sticks: never re-show this exact nudge
    _feedback(_current.type, 'dismiss');
    _settle();
    setTimeout(() => check(true), 1500);
  }

  function _disable() {
    _disabled = true;
    _hidePill();
    fetch('/api/symphonee/ambient/enabled', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
    try { if (typeof window.toast === 'function') window.toast('Symphonee whispers off. Re-enable in Settings.', 'info'); } catch (_) {}
  }

  async function check(force, opts) {
    if (_disabled) return;
    if (_current && !force) return;
    const now = Date.now();
    if (!force && now - _lastCheck < MIN_INTERVAL_MS) return;
    _lastCheck = now;
    try {
      const r = await fetch('/api/symphonee/ambient/nudge' + (opts && opts.idle ? '?idle=1' : ''));
      if (!r.ok) return;
      const d = await r.json().catch(() => ({}));
      if (d && d.enabled === false) { _disabled = true; _hidePill(); return; }
      _surface();   // the droplet lives here whether or not there is a thought
      const nudge = d && d.nudge;
      if (nudge && nudge.title && !_dismissed.has(nudge.title)) {
        if (!_current || _current.title !== nudge.title) _showPill(nudge);
      }
    } catch (_) { /* offline / not ready */ }
  }

  // The pill appears the moment the app does - it is the door to asking, so
  // it must always be there. The first nudge check follows a few seconds later.
  function _boot() {
    if (!_disabled) _surface();
    setTimeout(() => check(true), 5000);
  }
  window.addEventListener('DOMContentLoaded', _boot);
  window.addEventListener('focus', () => check(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(false); });
  if (document.readyState !== 'loading') _boot();

  // Inactivity: when the user goes quiet, ask the server for a nudge tuned to
  // the idle moment (unsaved work? momentum? an open note thread?). The rule
  // engine picks the words, and the novelty gate may choose SILENCE - which is
  // intentional: a colleague does not repeat "still here?" every few minutes.
  let _idleTimer = null;
  const IDLE_MS = 4 * 60 * 1000;
  function _resetIdle() { clearTimeout(_idleTimer); _idleTimer = setTimeout(_onIdle, IDLE_MS); }
  async function _onIdle() {
    if (_disabled || _current) return;
    await check(true, { idle: true });
  }
  ['mousemove', 'keydown', 'mousedown'].forEach(ev => window.addEventListener(ev, _resetIdle, { passive: true }));
  _resetIdle();

  // Failure/landing-triggered: the orchestrator broadcasts a task-update (and
  // has already written tasks.json) the instant a task finishes - listen on
  // the WS and force an immediate nudge check instead of waiting up to 90s.
  // Failures speak immediately; successes are the "second mind" moment (the
  // work landed - offer the next thread).
  let _taskTimer = null;
  function _connectWS() {
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type !== 'orchestrator-event' || msg.event !== 'task-update') return;
          const st = msg.task && msg.task.state;
          if (st !== 'failed' && st !== 'timeout' && st !== 'completed') return;
          // Debounce a burst of completions into one check; force past the interval.
          if (_taskTimer) return;
          _taskTimer = setTimeout(() => { _taskTimer = null; if (!_disabled) check(true); }, 1200);
        } catch (_) { /* ignore malformed frames */ }
      };
      ws.onclose = () => setTimeout(_connectWS, 4000);
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    } catch (_) { /* WS unavailable - the 90s pull still covers it */ }
  }
  _connectWS();

  // Settings re-enable + force refresh.
  window.ambientWhisperCheck = () => { _disabled = false; check(true); };

  // The front door for questions from ANYWHERE in the app (command palette,
  // future surfaces): open the liquid's panel with the question and stream the
  // deep answer there. One organism - asking and whispering share a body.
  window.ambientWhisperAsk = (question) => {
    const q = String(question || '').trim();
    _ensurePill();
    _surface();
    const modal = _openModal({ askOnly: true, focusAsk: !q });
    if (q) _streamAsk(q, modal);
    return true;
  };
})();
