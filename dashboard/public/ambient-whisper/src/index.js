/**
 * The ambient whisper - Symphonee's proactive presence (Stage 6, surfaced).
 *
 * Minimalist + futuristic, Gemini-style. States:
 *   - EXPANDED pill: when a fresh nudge arrives, a glowing accent pill shows the
 *     one-line message for a few seconds.
 *   - COLLAPSED pill: with no new message it tucks into a thin, text-less,
 *     accent-glowing pill (the ambient presence). HOVER reveals the text again.
 *   - MODAL: CLICK either state to open a calm modal with the full thought,
 *     rendered markdown, and actions.
 *
 * Anti-Clippy: triggers on signal (boot, focus) not a timer; the server dial
 * decides whether to speak; dismiss STICKS (suppressed this session) and decays
 * the nudge kind server-side; fully deactivatable.
 *
 * Loads after app.js as /js/ambient-whisper.js. Self-contained.
 */

(() => {
  'use strict';

  const MIN_INTERVAL_MS = 90_000;
  const EXPAND_MS = 6500;          // how long a fresh nudge stays expanded
  let _lastCheck = 0;
  let _current = null;
  let _disabled = false;
  let _hovering = false;
  let _collapseTimer = null;
  const _dismissed = new Set();    // titles the user dismissed -> never re-show
  let _pill = null;

  function _injectStyles() {
    if (document.getElementById('ambientWhisperStyles')) return;
    const s = document.createElement('style');
    s.id = 'ambientWhisperStyles';
    s.textContent = `
      #ambientWhisper{position:fixed;left:50%;bottom:16px;transform:translateX(-50%) translateY(16px);
        z-index:3200;display:none;align-items:center;gap:9px;box-sizing:border-box;
        min-width:158px;max-width:min(560px,84vw);height:34px;padding:0 15px;border-radius:999px;cursor:pointer;
        font-family:var(--font-ui,system-ui);font-size:12px;color:var(--subtext1,#cdd6f4);
        background:var(--surface0,#1e1e2e);
        background:color-mix(in srgb,var(--surface0,#1e1e2e) 84%,var(--accent,#89b4fa) 9%);
        border:1px solid var(--surface2,#45475a);
        border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 42%,transparent);
        opacity:0;overflow:hidden;
        transition:opacity .35s ease,transform .4s cubic-bezier(.2,.85,.25,1),min-width .45s cubic-bezier(.2,.85,.25,1),max-width .45s cubic-bezier(.2,.85,.25,1),height .4s cubic-bezier(.2,.85,.25,1),padding .35s ease;
        animation:aw-breathe 4.4s ease-in-out infinite;}
      /* resting: an elongated, thin, living capsule - a drawer handle that breathes */
      #ambientWhisper.aw-collapsed{min-width:150px;max-width:150px;height:13px;padding:0;gap:0;}
      #ambientWhisper.aw-collapsed .aw-dot,#ambientWhisper.aw-collapsed .aw-text,#ambientWhisper.aw-collapsed .aw-x{opacity:0;max-width:0;margin:0;padding:0;}
      #ambientWhisper:hover{filter:brightness(1.08);}
      /* a slow inner light drifting back and forth - feels alive */
      #ambientWhisper::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;
        background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--accent,#89b4fa) 32%,transparent) 50%,transparent 70%);
        background-size:240% 100%;animation:aw-shimmer 6s ease-in-out infinite;opacity:.6;}
      #ambientWhisper .aw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--accent,#89b4fa);
        box-shadow:0 0 10px var(--accent,#89b4fa);animation:aw-dot 4.4s ease-in-out infinite;position:relative;z-index:1;
        transition:max-width .3s,opacity .25s;}
      #ambientWhisper .aw-text{flex:1;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        max-width:480px;opacity:1;position:relative;z-index:1;
        transition:max-width .42s cubic-bezier(.2,.85,.25,1),opacity .3s ease;}
      #ambientWhisper .aw-x{background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:15px;line-height:1;
        padding:1px 3px;cursor:pointer;flex:none;position:relative;z-index:1;border-radius:6px;
        transition:max-width .3s,opacity .2s;overflow:hidden;}
      #ambientWhisper .aw-x:hover{color:var(--text,#cdd6f4);}
      /* breathing outer glow - organic, biologic */
      @keyframes aw-breathe{0%,100%{box-shadow:0 0 11px -4px var(--accent,#89b4fa),0 5px 18px -6px rgba(0,0,0,.5);}
        50%{box-shadow:0 0 24px -1px var(--accent,#89b4fa),0 5px 18px -6px rgba(0,0,0,.5);}}
      @keyframes aw-shimmer{0%{background-position:150% 0;}50%{background-position:-30% 0;}100%{background-position:150% 0;}}
      @keyframes aw-dot{0%,100%{opacity:.55;transform:scale(.9);}50%{opacity:1;transform:scale(1.06);}}
      #ambientWhisperModalBg{position:fixed;inset:0;z-index:3600;display:none;align-items:center;justify-content:center;
        background:rgba(0,0,0,.45);backdrop-filter:blur(2px);font-family:var(--font-ui,system-ui);}
      #ambientWhisperModal{width:460px;max-width:90vw;border-radius:16px;padding:0;overflow:hidden;
        background:var(--surface0,#1e1e2e);border:1px solid var(--surface2,#45475a);
        border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 30%,var(--surface2,#45475a));
        box-shadow:0 0 40px -10px var(--accent,#89b4fa),0 18px 50px rgba(0,0,0,.55);
        transform:translateY(8px) scale(.98);opacity:0;transition:opacity .22s ease,transform .22s cubic-bezier(.2,.8,.2,1);}
      #ambientWhisperModal strong{color:var(--text,#cdd6f4);font-weight:600;}
      #ambientWhisperModal em{color:var(--subtext1,#cdd6f4);font-style:italic;}
      #ambientWhisperModal code{font-family:var(--font-mono,monospace);font-size:.92em;
        background:var(--surface1,#313244);padding:1px 5px;border-radius:5px;}
      @media (prefers-reduced-motion: reduce){#ambientWhisper,#ambientWhisper::before,#ambientWhisper .aw-dot{animation:none !important;}}
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
    el.innerHTML = '<span class="aw-dot"></span><span class="aw-text"></span><button class="aw-x" title="Dismiss">&times;</button>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (!e.target.classList.contains('aw-x')) _openModal(); });
    el.querySelector('.aw-x').addEventListener('click', (e) => { e.stopPropagation(); _dismiss(); });
    el.addEventListener('mouseenter', () => { _hovering = true; el.classList.remove('aw-collapsed'); });
    el.addEventListener('mouseleave', () => { _hovering = false; if (!_collapseTimer) el.classList.add('aw-collapsed'); });
    _pill = el;
    return el;
  }

  function _showPill(nudge) {
    _current = nudge;
    const el = _ensurePill();
    el.querySelector('.aw-text').textContent = _plain(nudge.title);
    el.classList.remove('aw-collapsed');
    el.style.display = 'flex';
    // If Symphonee Voice is on, say it aloud.
    try { if (window.symphoneeVoiceOn && window.symphoneeVoiceOn() && window.symphoneeSpeak) window.symphoneeSpeak(_plain(nudge.title)); } catch (_) {}
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
    // After a few seconds, tuck into the thin glowing pill (unless hovered).
    clearTimeout(_collapseTimer);
    _collapseTimer = setTimeout(() => {
      _collapseTimer = null;
      if (!_hovering && _pill) _pill.classList.add('aw-collapsed');
    }, EXPAND_MS);
  }

  function _hidePill() {
    clearTimeout(_collapseTimer); _collapseTimer = null;
    if (!_pill) { _current = null; return; }
    _pill.style.opacity = '0';
    _pill.style.transform = 'translateX(-50%) translateY(16px)';
    setTimeout(() => { if (_pill) _pill.style.display = 'none'; }, 300);
    _current = null;
  }

  function _openModal() {
    if (!_current) return;
    const n = _current;
    const isSuggestion = n.action && n.action.kind === 'suggestion';
    let bg = document.getElementById('ambientWhisperModalBg');
    if (bg) bg.remove();
    bg = document.createElement('div');
    bg.id = 'ambientWhisperModalBg';
    bg.innerHTML =
      '<div id="ambientWhisperModal">' +
        '<div style="display:flex;align-items:center;gap:9px;padding:15px 18px 11px;">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent,#89b4fa);box-shadow:0 0 10px var(--accent,#89b4fa);"></span>' +
          '<strong style="font-size:13px;color:var(--text,#cdd6f4);">Symphonee</strong>' +
          '<span style="flex:1;"></span>' +
          '<button id="awmClose" style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:17px;line-height:1;cursor:pointer;">&times;</button>' +
        '</div>' +
        '<div style="padding:2px 18px 4px;font-size:14px;line-height:1.55;color:var(--text,#cdd6f4);">' + _md(n.title) + '</div>' +
        (n.detail ? '<div style="padding:7px 18px 2px;font-size:12px;line-height:1.6;color:var(--subtext0,#a6adc8);">' + _md(n.detail) + '</div>' : '') +
        '<div style="display:flex;align-items:center;gap:8px;padding:15px 18px 16px;">' +
          '<button id="awmAct" style="background:var(--accent,#89b4fa);border:none;color:#11111b;font-weight:600;font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer;">' + (isSuggestion ? 'Look into this' : 'Review') + '</button>' +
          '<button id="awmDismiss" style="background:var(--surface1,#313244);border:none;color:var(--subtext1,#cdd6f4);font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;">Dismiss</button>' +
          '<span style="flex:1;"></span>' +
          '<button id="awmOff" style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:11px;cursor:pointer;text-decoration:underline;">Turn off whispers</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);
    bg.style.display = 'flex';
    const modal = bg.querySelector('#ambientWhisperModal');
    requestAnimationFrame(() => { modal.style.opacity = '1'; modal.style.transform = 'translateY(0) scale(1)'; });
    const close = () => bg.remove();
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    bg.querySelector('#awmClose').addEventListener('click', close);
    bg.querySelector('#awmAct').addEventListener('click', () => { close(); _act(); });
    bg.querySelector('#awmDismiss').addEventListener('click', () => { close(); _dismiss(); });
    bg.querySelector('#awmOff').addEventListener('click', () => { close(); _disable(); });
  }

  function _feedback(type, action) {
    return fetch('/api/symphonee/ambient/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, action }),
    }).catch(() => {});
  }

  function _act() {
    if (!_current) return;
    const n = _current;
    _feedback(n.type, 'accept');
    const prompt = (n.action && n.action.prompt) || _plain(n.title);
    _hidePill();
    try {
      if (typeof window.openCmdPalette === 'function') window.openCmdPalette(prompt);
      else if (typeof window.toast === 'function') window.toast('Noted', 'info');
    } catch (_) {}
    setTimeout(() => check(true), 1500);
  }

  function _dismiss() {
    if (!_current) return;
    _dismissed.add(_current.title);   // sticks: never re-show this exact nudge
    _feedback(_current.type, 'dismiss');
    _hidePill();
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

  async function check(force) {
    if (_disabled) return;
    if (_current && !force) return;
    const now = Date.now();
    if (!force && now - _lastCheck < MIN_INTERVAL_MS) return;
    _lastCheck = now;
    try {
      const r = await fetch('/api/symphonee/ambient/nudge');
      if (!r.ok) return;
      const d = await r.json().catch(() => ({}));
      if (d && d.enabled === false) { _disabled = true; _hidePill(); return; }
      const nudge = d && d.nudge;
      if (nudge && nudge.title && !_dismissed.has(nudge.title)) {
        if (!_current || _current.title !== nudge.title) _showPill(nudge);
      } else if (!_current) {
        _hidePill();
      }
    } catch (_) { /* offline / not ready */ }
  }

  window.addEventListener('DOMContentLoaded', () => setTimeout(() => check(true), 5000));
  window.addEventListener('focus', () => check(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(false); });
  if (document.readyState !== 'loading') setTimeout(() => check(true), 5000);

  // Inactivity: a gentle "still here?" if the user goes quiet for a while. This
  // nudge is generated client-side (only the client knows about keyboard/mouse
  // activity); it still honours the disable flag + dismiss.
  let _idleTimer = null;
  const IDLE_MS = 4 * 60 * 1000;
  function _resetIdle() { clearTimeout(_idleTimer); _idleTimer = setTimeout(_onIdle, IDLE_MS); }
  function _onIdle() {
    if (_disabled || _current) return;
    const nudge = { type: 'inactivity', title: 'Still here? I can pick up where we left off whenever you are.', action: { kind: 'ask', prompt: 'where did we leave off' } };
    if (_dismissed.has(nudge.title)) return;
    _showPill(nudge);
  }
  ['mousemove', 'keydown', 'mousedown'].forEach(ev => window.addEventListener(ev, _resetIdle, { passive: true }));
  _resetIdle();

  // Settings re-enable + force refresh.
  window.ambientWhisperCheck = () => { _disabled = false; check(true); };
})();
