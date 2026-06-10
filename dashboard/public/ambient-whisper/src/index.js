/**
 * The ambient whisper - Symphonee's proactive presence (Stage 6, surfaced).
 *
 * Minimalist + futuristic, Gemini-style: a small rounded PILL that glows with
 * the chosen accent colour and shimmers very subtly (a slow glare sweep), never
 * annoying. It carries one or two lines of what Symphonee wants to say. Click it
 * and it expands into a calm modal with the full thought + actions.
 *
 * Anti-Clippy by construction:
 *   - Triggers on SIGNAL (boot, window focus), debounced - never a timer.
 *   - The server-side dial decides whether to speak at all.
 *   - Dismiss decays that nudge type, so a kind you keep dismissing goes quiet.
 *   - Fully deactivatable: "Turn off" (or Settings) flips the server flag and it
 *     never appears again until re-enabled.
 *
 * Loads after app.js as /js/ambient-whisper.js. Self-contained.
 */

(() => {
  'use strict';

  const MIN_INTERVAL_MS = 90_000;
  let _lastCheck = 0;
  let _current = null;
  let _disabled = false;
  let _pill = null;

  function _injectStyles() {
    if (document.getElementById('ambientWhisperStyles')) return;
    const s = document.createElement('style');
    s.id = 'ambientWhisperStyles';
    s.textContent = `
      #ambientWhisper{position:fixed;left:50%;bottom:16px;transform:translateX(-50%) translateY(16px);
        z-index:3200;display:none;align-items:center;gap:9px;max-width:min(560px,84vw);
        padding:8px 12px 8px 14px;border-radius:999px;cursor:pointer;
        font-family:var(--font-ui,system-ui);font-size:12px;color:var(--subtext1,#cdd6f4);
        background:color-mix(in srgb, var(--surface0,#1e1e2e) 86%, var(--accent,#89b4fa) 6%);
        border:1px solid color-mix(in srgb, var(--accent,#89b4fa) 38%, transparent);
        box-shadow:0 0 0 1px color-mix(in srgb,var(--accent,#89b4fa) 10%,transparent),
                   0 6px 22px -6px rgba(0,0,0,.5);
        opacity:0;overflow:hidden;transition:opacity .3s ease,transform .3s cubic-bezier(.2,.8,.2,1),box-shadow .3s ease;
        animation:aw-breathe 3.6s ease-in-out infinite;}
      #ambientWhisper:hover{box-shadow:0 0 22px -3px var(--accent,#89b4fa),0 6px 22px -6px rgba(0,0,0,.55);}
      #ambientWhisper::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
        background:linear-gradient(105deg,transparent 35%,color-mix(in srgb,var(--accent,#89b4fa) 26%,transparent) 50%,transparent 65%);
        background-size:220% 100%;animation:aw-shimmer 5.5s linear infinite;opacity:.55;}
      #ambientWhisper .aw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--accent,#89b4fa);
        box-shadow:0 0 9px var(--accent,#89b4fa);animation:aw-dot 3.6s ease-in-out infinite;}
      #ambientWhisper .aw-text{flex:1;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        position:relative;z-index:1;}
      #ambientWhisper .aw-x{background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:15px;line-height:1;
        padding:1px 3px;cursor:pointer;flex:none;position:relative;z-index:1;border-radius:6px;}
      #ambientWhisper .aw-x:hover{color:var(--text,#cdd6f4);}
      @keyframes aw-breathe{0%,100%{box-shadow:0 0 10px -4px var(--accent,#89b4fa),0 6px 22px -6px rgba(0,0,0,.5);}
        50%{box-shadow:0 0 20px -2px var(--accent,#89b4fa),0 6px 22px -6px rgba(0,0,0,.5);}}
      @keyframes aw-shimmer{0%{background-position:140% 0;}100%{background-position:-40% 0;}}
      @keyframes aw-dot{0%,100%{opacity:.65;}50%{opacity:1;}}
      #ambientWhisperModalBg{position:fixed;inset:0;z-index:3600;display:none;align-items:center;justify-content:center;
        background:rgba(0,0,0,.45);backdrop-filter:blur(2px);font-family:var(--font-ui,system-ui);}
      #ambientWhisperModal{width:440px;max-width:90vw;border-radius:16px;padding:0;overflow:hidden;
        background:var(--surface0,#1e1e2e);border:1px solid color-mix(in srgb,var(--accent,#89b4fa) 30%,var(--surface2,#45475a));
        box-shadow:0 0 40px -10px var(--accent,#89b4fa),0 18px 50px rgba(0,0,0,.55);
        transform:translateY(8px) scale(.98);opacity:0;transition:opacity .22s ease,transform .22s cubic-bezier(.2,.8,.2,1);}
      @media (prefers-reduced-motion: reduce){#ambientWhisper,#ambientWhisper::before,#ambientWhisper .aw-dot{animation:none !important;}}
    `;
    document.head.appendChild(s);
  }

  function _ensurePill() {
    if (_pill) return _pill;
    _injectStyles();
    const el = document.createElement('div');
    el.id = 'ambientWhisper';
    el.innerHTML = '<span class="aw-dot"></span><span class="aw-text"></span><button class="aw-x" title="Dismiss">&times;</button>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (!e.target.classList.contains('aw-x')) _openModal(); });
    el.querySelector('.aw-x').addEventListener('click', (e) => { e.stopPropagation(); _dismiss(); });
    _pill = el;
    return el;
  }

  function _showPill(nudge) {
    _current = nudge;
    const el = _ensurePill();
    el.querySelector('.aw-text').textContent = nudge.title;
    el.style.display = 'flex';
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
  }

  function _hidePill() {
    if (!_pill) return;
    _pill.style.opacity = '0';
    _pill.style.transform = 'translateX(-50%) translateY(16px)';
    setTimeout(() => { if (_pill) _pill.style.display = 'none'; }, 300);
    _current = null;
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function _openModal() {
    if (!_current) return;
    const n = _current;
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
        '<div style="padding:2px 18px 4px;font-size:14px;line-height:1.5;color:var(--text,#cdd6f4);">' + _esc(n.title) + '</div>' +
        (n.detail ? '<div style="padding:6px 18px 2px;font-size:12px;line-height:1.55;color:var(--subtext0,#a6adc8);">' + _esc(n.detail) + '</div>' : '') +
        '<div style="display:flex;align-items:center;gap:8px;padding:14px 18px 16px;">' +
          '<button id="awmReview" style="background:var(--accent,#89b4fa);border:none;color:#11111b;font-weight:600;font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer;">Review</button>' +
          '<button id="awmDismiss" style="background:var(--surface1,#313244);border:none;color:var(--subtext1,#cdd6f4);font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;">Dismiss</button>' +
          '<span style="flex:1;"></span>' +
          '<button id="awmOff" style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:11px;cursor:pointer;text-decoration:underline;">Turn off whispers</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);
    bg.style.display = 'flex';
    const modal = bg.querySelector('#ambientWhisperModal');
    requestAnimationFrame(() => { modal.style.opacity = '1'; modal.style.transform = 'translateY(0) scale(1)'; });
    const close = () => { bg.remove(); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    bg.querySelector('#awmClose').addEventListener('click', close);
    bg.querySelector('#awmReview').addEventListener('click', () => { close(); _act(); });
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
    _hidePill();
    try {
      if (n.action && n.action.kind === 'contradictions' && typeof window.openCmdPalette === 'function') {
        window.openCmdPalette('what memory is stale or superseded');
      } else if (typeof window.toast === 'function') { window.toast('Noted', 'info'); }
    } catch (_) {}
    setTimeout(() => check(true), 1200);
  }

  function _dismiss() {
    if (!_current) return;
    _feedback(_current.type, 'dismiss');
    _hidePill();
    setTimeout(() => check(true), 1200);
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
      if (d && d.nudge && d.nudge.title) {
        if (!_current || _current.title !== d.nudge.title) _showPill(d.nudge);
      } else if (!_current) { _hidePill(); }
    } catch (_) { /* offline / not ready */ }
  }

  window.addEventListener('DOMContentLoaded', () => setTimeout(() => check(true), 5000));
  window.addEventListener('focus', () => check(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(false); });
  if (document.readyState !== 'loading') setTimeout(() => check(true), 5000);

  // For testing / Settings to re-enable + force a refresh.
  window.ambientWhisperCheck = () => { _disabled = false; check(true); };
})();
