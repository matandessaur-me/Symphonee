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
        background:color-mix(in srgb,var(--surface0,#1e1e2e) 90%,var(--accent,#89b4fa) 5%);
        border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 26%,transparent);
        opacity:0;animation:aw-breathe 4.4s ease-in-out infinite;
        transition:opacity .45s ease,transform .5s cubic-bezier(.2,.85,.25,1),
          min-width .55s cubic-bezier(.34,1.3,.3,1),max-width .55s cubic-bezier(.34,1.3,.3,1),
          height .5s cubic-bezier(.34,1.3,.3,1),padding .4s ease;}
      #ambientWhisper:hover{filter:brightness(1.1);}
      @keyframes aw-breathe{0%,100%{box-shadow:0 0 8px -5px color-mix(in srgb,var(--accent,#89b4fa) 70%,transparent),0 5px 18px -6px rgba(0,0,0,.5);}
        50%{box-shadow:0 0 15px -3px color-mix(in srgb,var(--accent,#89b4fa) 70%,transparent),0 5px 18px -6px rgba(0,0,0,.5);}}
      /* resting: a small pill on the waterline - always visible, and the
         approach-swell (see _proximity) means nobody ever aims at it small. */
      #ambientWhisper.aw-collapsed{min-width:92px;max-width:92px;height:18px;padding:0;}
      #ambientWhisper.aw-collapsed .aw-content{opacity:0;pointer-events:none;}
      /* unread thoughts: a tiny count riding the resting pill, hidden once the
         pill is open/expanded (the content speaks for itself then) */
      #ambientWhisper .aw-badge{position:absolute;right:7px;top:50%;transform:translateY(-50%);z-index:2;
        display:none;align-items:center;justify-content:center;min-width:13px;height:13px;padding:0 3px;
        border-radius:999px;background:var(--accent,#89b4fa);color:#11111b;font-size:9px;font-weight:700;line-height:1;}
      #ambientWhisper:not(.aw-collapsed) .aw-badge{display:none !important;}
      /* the liquid INSIDE the shell: gooey metaballs clipped by the pill,
         drifting like light under glass */
      #ambientWhisper .aw-goo{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:.5;
        filter:url(#awGoo);
        transform:translateX(calc(var(--aw-lean,0)*7px));transition:transform .6s cubic-bezier(.2,.8,.2,1);}
      #ambientWhisper .aw-blob{position:absolute;border-radius:50%;
        background:color-mix(in srgb,var(--accent,#89b4fa) 22%,transparent);}
      #ambientWhisper .aw-blob.b1{left:-6%;top:14%;width:42%;height:120%;animation:aw-b1 4.6s ease-in-out infinite;}
      #ambientWhisper .aw-blob.b2{left:28%;top:-22%;width:50%;height:130%;animation:aw-b2 5.9s ease-in-out infinite;}
      #ambientWhisper .aw-blob.b3{left:62%;top:18%;width:44%;height:118%;animation:aw-b3 5.1s ease-in-out infinite;}
      /* each puddle of light breathes on its own rhythm - never loops visibly */
      @keyframes aw-b1{0%,100%{transform:translate(0,0) scale(1);}50%{transform:translate(9%,-7%) scale(1.12,.92);}}
      @keyframes aw-b2{0%,100%{transform:translate(0,0) scale(1);}45%{transform:translate(-7%,9%) scale(.93,1.1);}}
      @keyframes aw-b3{0%,100%{transform:translate(0,0) scale(1);}55%{transform:translate(-10%,-6%) scale(1.08,.94);}}
      /* a slow sheen drifting across the glass */
      #ambientWhisper .aw-sheen{position:absolute;inset:0;border-radius:inherit;pointer-events:none;overflow:hidden;
        opacity:.32;mix-blend-mode:screen;}
      #ambientWhisper .aw-sheen::before{content:'';position:absolute;inset:-20%;
        background:linear-gradient(100deg,transparent 32%,color-mix(in srgb,var(--accent,#89b4fa) 36%,transparent) 50%,transparent 68%);
        background-size:240% 100%;animation:aw-sheen 7s ease-in-out infinite;}
      @keyframes aw-sheen{0%{background-position:150% 0;}50%{background-position:-30% 0;}100%{background-position:150% 0;}}
      /* synapse pulse: every time the shared brain learns something (a Mind
         write), the liquid flares briefly - alive, learning, seeing */
      #ambientWhisper.aw-synapse .aw-goo{animation:aw-synapse 1.4s ease-out;}
      @keyframes aw-synapse{0%{opacity:.5;}16%{opacity:.95;}100%{opacity:.5;}}
      /* working: while dispatched tasks run, the liquid flows fast - the pill
         is a peripheral-vision readout of the AI workforce */
      #ambientWhisper.aw-busy .aw-goo{opacity:.62;}
      #ambientWhisper.aw-busy .aw-blob.b1{animation-duration:1.7s;}
      #ambientWhisper.aw-busy .aw-blob.b2{animation-duration:2.2s;}
      #ambientWhisper.aw-busy .aw-blob.b3{animation-duration:1.9s;}
      #ambientWhisper.aw-busy .aw-sheen::before{animation-duration:2.6s;}
      /* running-count badge variant: outlined, not filled (it is status, not news) */
      #ambientWhisper .aw-badge.aw-badge-run{background:transparent;border:1px solid var(--accent,#89b4fa);
        color:var(--accent,#89b4fa);}
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
      /* the island opens as a STACK above the waterline: the card panel (the
         rectangle that expands) with the floating Ask Symphonee bar BELOW it -
         two distinct components, so replying to a card and asking something
         new are never confused */
      #ambientWhisperModalBg{position:fixed;inset:0;z-index:3600;display:none;align-items:flex-end;justify-content:center;
        padding-bottom:62px;background:rgba(0,0,0,.24);backdrop-filter:blur(2px);font-family:var(--font-ui,system-ui);}
      #awmStack{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:92vw;}
      #ambientWhisperModal{width:480px;max-width:92vw;border-radius:22px;padding:0;overflow:hidden;box-sizing:border-box;
        background:color-mix(in srgb,var(--surface0,#1e1e2e) 90%,var(--accent,#89b4fa) 6%);
        border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 20%,var(--surface2,#45475a));
        box-shadow:0 0 26px -14px color-mix(in srgb,var(--accent,#89b4fa) 70%,transparent),0 18px 50px rgba(0,0,0,.5);
        transform-origin:50% 100%;transform:translateY(26px) scale(.86,.7);opacity:0;
        transition:opacity .26s ease,transform .34s cubic-bezier(.26,1.2,.32,1);}
      #ambientWhisperModal strong{color:var(--text,#cdd6f4);font-weight:600;}
      #ambientWhisperModal em{color:var(--subtext1,#cdd6f4);font-style:italic;}
      #ambientWhisperModal code{font-family:var(--font-mono,monospace);font-size:.92em;
        background:var(--surface1,#313244);padding:1px 5px;border-radius:5px;}
      /* the Ask Symphonee bar: its own floating pill under the card */
      #awAskBar{display:flex;align-items:center;gap:9px;width:480px;max-width:92vw;box-sizing:border-box;
        height:46px;padding:0 8px 0 16px;border-radius:999px;
        background:color-mix(in srgb,var(--surface0,#1e1e2e) 90%,var(--accent,#89b4fa) 6%);
        border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 20%,var(--surface2,#45475a));
        box-shadow:0 0 18px -12px color-mix(in srgb,var(--accent,#89b4fa) 70%,transparent),0 12px 36px rgba(0,0,0,.45);
        opacity:0;transform:translateY(14px);
        transition:opacity .26s ease .06s,transform .3s cubic-bezier(.26,1.2,.32,1) .06s;}
      #awAskBar input{flex:1;background:transparent;border:none;outline:none;color:var(--text,#cdd6f4);
        font-size:13px;font-family:inherit;min-width:0;}
      #awAskBar input::placeholder{color:var(--overlay1,#7f849c);}
      /* comfortable touch targets everywhere in the island. Nav chips are
         VISIBLE at rest (a quiet filled circle), not bare glyphs you have to
         hunt for. */
      .awm-icon-btn{width:30px;height:30px;display:flex;align-items:center;justify-content:center;flex:none;
        background:var(--surface1,#313244);border:1px solid var(--surface2,#45475a);
        color:var(--subtext1,#bac2de);font-size:17px;line-height:1;
        cursor:pointer;border-radius:999px;padding:0;}
      .awm-icon-btn:hover:not(:disabled){background:var(--surface2,#45475a);color:var(--text,#cdd6f4);}
      .awm-icon-btn:disabled{opacity:.25;cursor:default;}
      .awm-reply{flex:1;background:var(--surface1,#313244);border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 18%,var(--surface2,#45475a));
        border-radius:11px;color:var(--text,#cdd6f4);font-size:12.5px;padding:9px 13px;outline:none;font-family:inherit;min-width:0;}
      .awm-reply::placeholder{color:var(--overlay1,#7f849c);}
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

  // Rotating invitations: each approach teaches one more thing the pill can
  // do. Persisted index so the rotation continues across sessions; advances at
  // most every few seconds so hover-bouncing does not churn it.
  const _HINTS = [
    'Ask me anything about your work...',
    'Ask me what changed today',
    'Ask me where we left off',
    'Ask me what your AIs worked on',
    'Ask me what to do next',
    'Ask me about any of your projects',
  ];
  let _hintAt = 0;
  let _hintCur = null;
  function _nextHint() {
    const now = Date.now();
    if (_hintCur && now - _hintAt < 8000) return _hintCur;
    let i = 0;
    try { i = parseInt(localStorage.getItem('aw-hint') || '0', 10) || 0; } catch (_) {}
    _hintCur = _HINTS[i % _HINTS.length];
    _hintAt = now;
    try { localStorage.setItem('aw-hint', String(i + 1)); } catch (_) {}
    return _hintCur;
  }

  // The badge wears two hats: unread thoughts (filled - news) win over the
  // running-task count (outlined - status). The human eye tracks change; a
  // tiny number says "something here" without shouting.
  const _running = new Set();   // dispatched task ids currently in flight
  function _updateBadge() {
    if (!_pill) return;
    let b = _pill.querySelector('.aw-badge');
    if (!b) { b = document.createElement('span'); b.className = 'aw-badge'; _pill.appendChild(b); }
    const unread = _thread.filter(c => !c._seen).length;
    if (unread) {
      b.classList.remove('aw-badge-run');
      b.textContent = unread > 9 ? '9+' : String(unread);
      b.style.display = 'flex';
    } else if (_running.size) {
      b.classList.add('aw-badge-run');
      b.textContent = String(_running.size);
      b.style.display = 'flex';
    } else {
      b.style.display = 'none';
    }
    _pill.classList.toggle('aw-busy', _running.size > 0);
  }

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
    // dock position survives restarts (percent of viewport width)
    try {
      const pos = parseFloat(localStorage.getItem('aw-pos') || '');
      if (pos >= 8 && pos <= 92) el.style.left = pos + '%';
    } catch (_) {}
    el.addEventListener('click', (e) => {
      if (_dragSuppress) return;   // a drag is not a click
      if (!e.target.classList.contains('aw-x')) _openModal();
    });
    el.querySelector('.aw-x').addEventListener('click', (e) => { e.stopPropagation(); _dismiss(); });
    // drag to dock: slide the pill anywhere along the waterline
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      _drag = { startX: e.clientX, startPct: parseFloat(el.style.left) || 50, moved: false };
    });
    _pill = el;
    return el;
  }

  let _drag = null;
  let _dragSuppress = false;
  document.addEventListener('mousemove', (e) => {
    if (!_drag || !_pill) return;
    const dx = e.clientX - _drag.startX;
    if (!_drag.moved && Math.abs(dx) < 7) return;
    _drag.moved = true;
    const pct = Math.max(8, Math.min(92, _drag.startPct + (dx / window.innerWidth) * 100));
    _pill.style.left = pct + '%';
  }, { passive: true });
  document.addEventListener('mouseup', () => {
    if (!_drag) return;
    if (_drag.moved) {
      _dragSuppress = true;
      try { localStorage.setItem('aw-pos', String(parseFloat(_pill.style.left) || 50)); } catch (_) {}
      setTimeout(() => { _dragSuppress = false; }, 80);
    }
    _drag = null;
  });

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
    // Swell open on approach - ALWAYS. With a thought it shows the thought;
    // silent it invites the ask with a ROTATING capability hint, so over time
    // the user learns everything the pill can do just by passing near it.
    if (near && _pill.classList.contains('aw-collapsed')) {
      _hovering = true;
      if (!_current) _pill.querySelector('.aw-text').textContent = _nextHint();
      _pill.classList.remove('aw-collapsed');
    } else if (!near && _hovering) {
      _hovering = false;
      if (!_collapseTimer) _pill.classList.add('aw-collapsed');
    }
  }
  document.addEventListener('mousemove', _proximity, { passive: true });

  function _showPill(nudge) {
    _current = nudge;
    // Every thought joins the session thread - even ones the user dismisses or
    // misses, so they can flip back through the cards later.
    const last = _thread[_thread.length - 1];
    if (!(last && last.kind === 'nudge' && last.n.title === nudge.title)) {
      _thread.push({ at: Date.now(), kind: 'nudge', n: nudge, turns: [] });
      _updateBadge();
      _saveThread();
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

  // Synapse pulse: a brief flare of the inner liquid whenever the shared brain
  // learns (any Mind write broadcast). Restartable for bursts; never stacks.
  let _synTimer = null;
  function _synapse() {
    if (_disabled) return;
    const el = _ensurePill();
    el.classList.remove('aw-synapse');
    void el.offsetWidth;
    el.classList.add('aw-synapse');
    clearTimeout(_synTimer);
    _synTimer = setTimeout(() => { if (_pill) _pill.classList.remove('aw-synapse'); }, 1500);
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
  // A bottom Dynamic Island for AI, opened as a STACK of two distinct
  // components:
  //   - the CARD PANEL: one card per TOPIC. A nudge is a topic; a question
  //     starts a topic. Each card holds its whole conversation (turn after
  //     turn) and its own reply input - replying continues THAT topic, never
  //     spawns a new card. Flip through cards with the nav chip (timestamps).
  //   - the ASK SYMPHONEE BAR: a separate floating pill BELOW the panel.
  //     Typing there always starts a NEW topic. No ambiguity.
  const _thread = [];   // topic cards: {at, kind:'nudge'|'qa', n?, turns:[{q,a,at}], pinned?, _seen?}
  let _view = -1;       // which card is showing; -1 = no card (just the ask bar)

  // Topics survive restarts: recent cards (24h) come back, PINNED cards come
  // back forever. The thread is the user's short-term shared memory with
  // Symphonee - it should not evaporate on every restart.
  const THREAD_KEY = 'aw-thread-v1';
  const THREAD_TTL_MS = 24 * 60 * 60 * 1000;
  function _saveThread() {
    try { localStorage.setItem(THREAD_KEY, JSON.stringify(_thread.slice(-20))); } catch (_) { /* storage full / private mode */ }
  }
  (function _loadThread() {
    try {
      const arr = JSON.parse(localStorage.getItem(THREAD_KEY) || '[]');
      const now = Date.now();
      for (const c of arr) {
        if (c && c.at && (c.pinned || now - c.at <= THREAD_TTL_MS)) _thread.push(c);
      }
    } catch (_) { /* corrupted store - start fresh */ }
  })();

  function _fmtTime(ts) {
    const d = new Date(ts);
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + ':' + m + ' ' + ap;
  }

  // The static content of a card: the nudge (if any) plus every conversation
  // turn so far.
  function _cardHtml(card) {
    let h = '';
    if (card.kind === 'nudge' && card.n) {
      const n = card.n;
      h += _md(n.title) +
        (n.detail ? '<div style="margin-top:7px;font-size:12px;line-height:1.6;color:var(--subtext0,#a6adc8);">' + _md(n.detail) + '</div>' : '') +
        // Provenance: WHY the whisper spoke - transparency keeps proactivity
        // from feeling like noise.
        (n.because ? '<div style="margin-top:9px;font-size:11px;font-style:italic;color:var(--overlay1,#7f849c);">because ' + _md(n.because) + '</div>' : '');
    }
    const turns = card.turns || [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      // Answer-aware follow-ups: chips on the LATEST turn open what the
      // answer talked about (a note, a file, a task result).
      const chips = (i === turns.length - 1 && t.actions && t.actions.length)
        ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;">' +
            t.actions.map((a, j) =>
              '<button class="awm-turn-act" data-act="' + j + '" style="background:var(--surface1,#313244);border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 22%,var(--surface2,#45475a));color:var(--subtext1,#bac2de);font-size:11px;padding:6px 11px;border-radius:999px;cursor:pointer;font-family:inherit;">' +
              _md(a.label) + '</button>').join('') +
          '</div>'
        : '';
      h += '<div style="margin-top:' + (h ? '12px' : '0') + ';padding-top:' + (h ? '10px' : '0') + ';' + (h ? 'border-top:1px solid var(--surface1,#313244);' : '') + '">' +
        '<div style="font-size:11.5px;color:var(--overlay1,#7f849c);margin-bottom:5px;">' + _md(t.q) + '</div>' +
        '<div>' + _md(t.a) + '</div>' +
        chips +
      '</div>';
    }
    return h;
  }

  // Run an answer-derived action: open the thing the answer talked about.
  async function _runTurnAction(a, modal) {
    if (!a) return;
    if (a.type === 'open-note') {
      _closeModal();
      try { if (typeof window.switchTab === 'function') window.switchTab('notes'); } catch (_) {}
      try { if (typeof window.openNote === 'function') window.openNote(a.name); } catch (_) {}
    } else if (a.type === 'open-file') {
      _closeModal();
      try { if (typeof window.switchTab === 'function') window.switchTab('files'); } catch (_) {}
      try { if (typeof window.viewFile === 'function') window.viewFile(a.path); } catch (_) {}
    } else if (a.type === 'open-task') {
      // Pull the full result INLINE - the card is the surface.
      try {
        const r = await fetch('/api/orchestrator/task?id=' + encodeURIComponent(a.id));
        const d = await r.json().catch(() => ({}));
        const body = modal.querySelector('#awmBody');
        if (body && d && (d.result || d.error)) {
          const block = document.createElement('div');
          block.setAttribute('style', 'margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--surface1,#313244);font-size:12px;line-height:1.6;color:var(--subtext1,#bac2de);max-height:180px;overflow:auto;white-space:pre-wrap;');
          block.textContent = (d.result || d.error || '').slice(0, 4000);
          body.appendChild(block);
          body.scrollTop = body.scrollHeight;
        }
      } catch (_) { /* quiet */ }
    }
  }

  function _renderView(modal) {
    const panel = modal;
    const body = panel.querySelector('#awmBody');
    const actions = panel.querySelector('#awmActions');
    const nav = panel.querySelector('#awmNav');
    const replyRow = panel.querySelector('#awmReplyRow');
    const card = _view >= 0 && _view < _thread.length ? _thread[_view] : null;

    // No card: the panel hides entirely - the floating ask bar stands alone,
    // with tappable suggestion chips teaching what to ask.
    panel.style.display = card ? 'block' : 'none';
    const chips = document.getElementById('awChips');
    if (chips) chips.style.display = card ? 'none' : 'flex';
    if (!card) return;
    if (!card._seen) { card._seen = true; _saveThread(); }   // opened = read
    _updateBadge();

    // nav chip: flip through the session's topic cards (real touch targets)
    if (_thread.length > 1) {
      nav.innerHTML =
        '<button id="awmPrev" class="awm-icon-btn" ' + (_view > 0 ? '' : 'disabled') + '>&lsaquo;</button>' +
        '<span style="font-size:10.5px;color:var(--overlay1,#7f849c);white-space:nowrap;">' + (_view + 1) + '/' + _thread.length + ' &middot; ' + _fmtTime(card.at) + '</span>' +
        '<button id="awmNext" class="awm-icon-btn" ' + (_view < _thread.length - 1 ? '' : 'disabled') + '>&rsaquo;</button>';
      nav.querySelector('#awmPrev').addEventListener('click', () => { if (_view > 0) { _view -= 1; _renderView(modal); } });
      nav.querySelector('#awmNext').addEventListener('click', () => { if (_view < _thread.length - 1) { _view += 1; _renderView(modal); } });
    } else {
      nav.innerHTML = '<span style="font-size:10.5px;color:var(--overlay1,#7f849c);white-space:nowrap;">' + _fmtTime(card.at) + '</span>';
    }
    // pin: keep this topic beyond the 24h thread window
    const pin = document.createElement('button');
    pin.setAttribute('style', 'background:transparent;border:1px solid ' + (card.pinned ? 'var(--accent,#89b4fa)' : 'var(--surface2,#45475a)') + ';color:' + (card.pinned ? 'var(--accent,#89b4fa)' : 'var(--overlay1,#7f849c)') + ';font-size:10px;padding:4px 9px;border-radius:999px;cursor:pointer;font-family:inherit;margin-left:5px;');
    pin.textContent = card.pinned ? 'Pinned' : 'Pin';
    pin.title = card.pinned ? 'Unpin - let this topic expire with the thread' : 'Keep this topic beyond the 24h window';
    pin.addEventListener('click', () => { card.pinned = !card.pinned; _saveThread(); _renderView(modal); });
    nav.appendChild(pin);

    body.innerHTML = _cardHtml(card);
    body.scrollTop = (card.turns && card.turns.length) ? body.scrollHeight : 0;
    // wire the answer-derived action chips (latest turn only)
    const lastTurn = card.turns && card.turns[card.turns.length - 1];
    body.querySelectorAll('.awm-turn-act').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = lastTurn && lastTurn.actions && lastTurn.actions[parseInt(btn.dataset.act, 10)];
        _runTurnAction(a, modal);
      });
    });

    // the card's own reply input - continuing THIS topic
    replyRow.style.display = 'flex';
    replyRow.innerHTML =
      '<input id="awmReply" class="awm-reply" type="text" placeholder="Reply to this thread..."/>' +
      '<button id="awmReplyGo" style="' + _BTN_PRIMARY + 'padding:9px 14px;">Reply</button>';
    const replyInput = replyRow.querySelector('#awmReply');
    const goReply = () => { const q = replyInput.value.trim(); if (q) { replyInput.value = ''; _streamAsk(q, modal, card); } };
    replyRow.querySelector('#awmReplyGo').addEventListener('click', goReply);
    replyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goReply(); });

    // actions: the nudge's own action (until used), dismiss while live, handoff
    let act = '';
    const hasTurns = card.turns && card.turns.length;
    if (card.kind === 'nudge' && card.n && !hasTurns) {
      act += '<button id="awmAct" style="' + _BTN_PRIMARY + '">' + (card.n.actionLabel || 'Show me') + '</button>';
      if (_current && _current.title === card.n.title) act += '<button id="awmDismiss" style="' + _BTN_SOFT + '">Dismiss</button>';
    }
    if (hasTurns) act += '<button id="awmAgent" style="' + _BTN_SOFT + '">Go deeper in terminal</button>';
    actions.innerHTML = act + _offHtml();
    const actBtn = actions.querySelector('#awmAct');
    if (actBtn) actBtn.addEventListener('click', () => _runAction(card.n, modal, card));
    const dis = actions.querySelector('#awmDismiss');
    if (dis) dis.addEventListener('click', () => { _closeModal(); _dismiss(); });
    const agent = actions.querySelector('#awmAgent');
    if (agent) agent.addEventListener('click', () => {
      const last = card.turns[card.turns.length - 1];
      _closeModal(); _handToAgent(last.q, last.a);
    });
    _wireOff(modal);
  }

  function _offHtml() {
    return '<span style="flex:1;"></span><button id="awmOff" style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:11px;cursor:pointer;text-decoration:underline;padding:8px 4px;">Turn off</button>';
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
      '<div id="awmStack">' +
        '<div id="ambientWhisperModal">' +
          '<div style="display:flex;align-items:center;gap:7px;padding:13px 12px 9px 18px;">' +
            '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:var(--accent,#89b4fa);box-shadow:0 0 10px var(--accent,#89b4fa);"></span>' +
            '<strong style="font-size:13px;color:var(--text,#cdd6f4);">Symphonee</strong>' +
            '<span id="awmNav" style="display:flex;align-items:center;gap:3px;margin-left:4px;"></span>' +
            '<span style="flex:1;"></span>' +
            '<button id="awmClose" class="awm-icon-btn">&times;</button>' +
          '</div>' +
          '<div id="awmBody" style="padding:2px 18px 4px;font-size:14px;line-height:1.55;color:var(--text,#cdd6f4);max-height:44vh;overflow:auto;"></div>' +
          '<div id="awmReplyRow" style="display:flex;align-items:center;gap:8px;padding:12px 18px 4px;"></div>' +
          '<div id="awmActions" style="display:flex;align-items:center;gap:8px;padding:10px 18px 14px;"></div>' +
        '</div>' +
        '<div id="awChips" style="display:none;gap:8px;flex-wrap:wrap;justify-content:center;max-width:480px;"></div>' +
        '<div id="awAskBar">' +
          '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:var(--accent,#89b4fa);box-shadow:0 0 10px var(--accent,#89b4fa);"></span>' +
          '<input id="awAskNew" type="text" placeholder="Ask Symphonee anything... (new topic)"/>' +
          '<button id="awAskGo" style="' + _BTN_PRIMARY + 'padding:9px 16px;border-radius:999px;">Ask</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);
    bg.style.display = 'flex';
    const modal = bg.querySelector('#ambientWhisperModal');
    const askBar = bg.querySelector('#awAskBar');
    // The island morph: the pill becomes the stack (it fades while open).
    if (_pill) { _pill.style.opacity = '0'; _pill.style.pointerEvents = 'none'; }
    requestAnimationFrame(() => {
      modal.style.opacity = '1'; modal.style.transform = 'translateY(0) scale(1)';
      askBar.style.opacity = '1'; askBar.style.transform = 'translateY(0)';
    });
    bg.addEventListener('click', (e) => { if (e.target === bg) _closeModal(); });
    bg.querySelector('#awmClose').addEventListener('click', _closeModal);
    // a new topic card, from the ask bar or a suggestion chip
    const newTopic = (q) => {
      const card = { at: Date.now(), kind: 'qa', turns: [] };
      _thread.push(card);
      _view = _thread.length - 1;
      _streamAsk(q, modal, card);
    };
    // the Ask Symphonee bar ALWAYS starts a new topic card
    const askInput = bg.querySelector('#awAskNew');
    const goNew = () => {
      const q = askInput.value.trim();
      if (!q) return;
      askInput.value = '';
      newTopic(q);
    };
    bg.querySelector('#awAskGo').addEventListener('click', goNew);
    askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goNew(); });
    // suggestion chips: one tap teaches what asking feels like. Static set
    // renders instantly; the context-aware set (drawn from what is actually
    // going on - a finished task, an edited note) replaces it when it lands.
    const chips = bg.querySelector('#awChips');
    const CHIP = 'background:color-mix(in srgb,var(--surface0,#1e1e2e) 88%,var(--accent,#89b4fa) 5%);border:1px solid var(--surface2,#45475a);color:var(--subtext1,#bac2de);font-size:11.5px;padding:8px 14px;border-radius:999px;cursor:pointer;font-family:inherit;';
    const fillChips = (list) => {
      chips.innerHTML = '';
      for (const q of list) {
        const c = document.createElement('button');
        c.setAttribute('style', CHIP);
        c.textContent = q;
        c.addEventListener('mouseenter', () => { c.style.borderColor = 'var(--accent,#89b4fa)'; c.style.color = 'var(--text,#cdd6f4)'; });
        c.addEventListener('mouseleave', () => { c.style.borderColor = 'var(--surface2,#45475a)'; c.style.color = 'var(--subtext1,#bac2de)'; });
        c.addEventListener('click', () => newTopic(q));
        chips.appendChild(c);
      }
    };
    fillChips(['What changed today?', 'Where did we leave off?', 'What should I do next?']);
    fetch('/api/symphonee/ambient/chips').then(r => r.json()).then(d => {
      if (d && Array.isArray(d.chips) && d.chips.length && document.getElementById('awChips')) fillChips(d.chips);
    }).catch(() => {});
    // default view: the latest card (the freshest topic), or just the ask bar
    _view = opts.askOnly ? -1 : (_thread.length ? _thread.length - 1 : -1);
    _renderView(modal);
    setTimeout(() => askInput.focus(), 80);
    return modal;
  }

  // Keyboard: Escape closes the island; left/right arrows flip cards when the
  // focus is not in an input. Muscle memory beats hunting for chips.
  document.addEventListener('keydown', (e) => {
    const bg = document.getElementById('ambientWhisperModalBg');
    if (!bg) return;
    if (e.key === 'Escape') { _closeModal(); return; }
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const modal = bg.querySelector('#ambientWhisperModal');
    if (e.key === 'ArrowLeft') {
      if (_view === -1 && _thread.length) { _view = _thread.length - 1; _renderView(modal); }
      else if (_view > 0) { _view -= 1; _renderView(modal); }
    } else if (e.key === 'ArrowRight' && _view >= 0 && _view < _thread.length - 1) {
      _view += 1; _renderView(modal);
    }
  });

  function _closeModal() {
    const bg = document.getElementById('ambientWhisperModalBg');
    if (bg) bg.remove();
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

  // Stream a deep answer INTO a topic card: the card's prior turns ride along
  // as conversation history (so "explain more" works), status milestones show
  // while retrieving, tokens render as the model writes, and the finished turn
  // is appended to THAT card - never a new one. Grounded answers save back to
  // Mind so every CLI inherits them.
  async function _streamAsk(question, modal, card) {
    const panel = modal;
    panel.style.display = 'block';
    const body = panel.querySelector('#awmBody');
    const actions = panel.querySelector('#awmActions');
    const replyRow = panel.querySelector('#awmReplyRow');
    if (replyRow) replyRow.style.display = 'none';   // one question at a time
    if (!card.turns) card.turns = [];
    const history = card.turns.slice(-3).map(t => ({ q: t.q, a: t.a }));
    const prior = _cardHtml(card);
    body.innerHTML = prior +
      '<div style="margin-top:' + (prior ? '12px' : '0') + ';padding-top:' + (prior ? '10px' : '0') + ';' + (prior ? 'border-top:1px solid var(--surface1,#313244);' : '') + '">' +
        '<div style="font-size:11.5px;color:var(--overlay1,#7f849c);margin-bottom:5px;">' + _md(question) + '</div>' +
        '<div id="awmAnswer"></div>' +
      '</div>';
    const answerEl = body.querySelector('#awmAnswer');
    body.scrollTop = body.scrollHeight;
    actions.innerHTML = _STATUS('listening...');
    let text = '';
    let finale = null;
    try {
      const r = await fetch('/api/symphonee/ask/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: question, history }),
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
      card.turns.push({ q: question, a: finale.answer, at: Date.now(), actions: finale.actions || [] });
      _saveThread();
      _renderView(modal);
      const reply = panel.querySelector('#awmReply');
      if (reply) reply.focus();
      // Save back to the shared brain - the next session of every CLI inherits this.
      fetch('/api/mind/save-result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer: finale.answer, citedNodeIds: finale.citedNodeIds || [], createdBy: 'symphonee' }),
      }).catch(() => {});
    } else {
      answerEl.innerHTML = '<div style="font-size:13px;color:var(--text,#cdd6f4);">I do not have enough on that - your agent can dig deeper.</div>';
      actions.innerHTML = '<button id="awmAgent" style="' + _BTN_PRIMARY + '">Hand to my terminal</button>' + _offHtml();
      panel.querySelector('#awmAgent').addEventListener('click', () => { _closeModal(); _handToAgent(question, ''); });
      if (replyRow) replyRow.style.display = 'flex';
      _wireOff(modal);
    }
  }

  // Run the nudge's action RIGHT HERE through the same deep streaming engine,
  // INSIDE the nudge's own card - the answer becomes that topic's first turn.
  function _runAction(n, modal, card) {
    _feedback(n.type, 'accept');
    // A one-shot nudge (a specific task) should not re-surface once the user
    // has engaged with it - acting counts as handled.
    if (n.type && (n.type.indexOf('task-failure') === 0 || n.type.indexOf('task-success') === 0)) _dismissed.add(n.title);
    _settle();
    _streamAsk((n.action && n.action.prompt) || _plain(n.title), modal, card);
  }

  function _feedback(type, action) {
    return fetch('/api/symphonee/ambient/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, action }),
    }).then(r => r.json()).then(d => {
      // The whisper just turned itself down after a dismissal streak - say so
      // once, plainly. Respect for attention should be visible, not sneaky.
      if (d && d.autoTuned) {
        try { if (typeof window.toast === 'function') window.toast('Noted - I will speak up less often. (You can re-tune me in Settings.)', 'info'); } catch (_) {}
      }
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
    if (!_disabled) { _surface(); _updateBadge(); }
    // seed the running-task monitor with whatever is already in flight
    fetch('/api/orchestrator/tasks?state=running').then(r => r.json()).then(d => {
      const tasks = Array.isArray(d) ? d : (d && d.tasks) || [];
      for (const t of tasks) if (t && t.id) _running.add(t.id);
      if (tasks.length) _updateBadge();
    }).catch(() => {});
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
          // The brain just learned something - let the liquid show it.
          if (msg.type === 'mind-update') { _synapse(); return; }
          if (msg.type !== 'orchestrator-event' || msg.event !== 'task-update') return;
          const t = msg.task || {};
          const st = t.state;
          // Ambient task monitor: the liquid flows fast while work is in
          // flight, and the badge counts the running tasks.
          if (t.id) {
            if (st === 'running' || st === 'pending' || st === 'queued') _running.add(t.id);
            else _running.delete(t.id);
            _updateBadge();
          }
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
  // future surfaces): open the island with the question as a NEW topic card
  // and stream the deep answer there. One organism - asking and whispering
  // share a body.
  window.ambientWhisperAsk = (question) => {
    const q = String(question || '').trim();
    _ensurePill();
    _surface();
    const modal = _openModal({ askOnly: true });
    if (q) {
      const card = { at: Date.now(), kind: 'qa', turns: [] };
      _thread.push(card);
      _view = _thread.length - 1;
      _streamAsk(q, modal, card);
    }
    return true;
  };
})();
