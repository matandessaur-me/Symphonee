/**
 * The ambient whisper - Symphonee's proactive presence (Stage 6, surfaced).
 *
 * A quiet, non-modal line near the bottom of the window. It NEVER steals focus
 * and NEVER pops a modal. It shows the single highest-value nudge the brain
 * decided is worth saying - and only when the dial + trust let it through.
 *
 * Anti-Clippy by construction:
 *   - Trigger on SIGNAL, not a timer: it checks on boot and on window focus
 *     (you came back, a natural lull), debounced. No clock-driven nagging.
 *   - GATE is server-side (the dial). This client only displays what the brain
 *     already decided to surface.
 *   - EARN trust: dismiss decays that nudge type server-side, so a kind of
 *     suggestion you keep dismissing goes quiet for good.
 *
 * Loads after app.js as /js/ambient-whisper.js. Self-contained; reads nothing
 * from the shell except the global toast/openCmdPalette if present.
 */

(() => {
  'use strict';

  const MIN_INTERVAL_MS = 90_000;   // debounce between automatic checks
  let _lastCheck = 0;
  let _current = null;              // the nudge currently shown
  let _el = null;

  function _ensureEl() {
    if (_el) return _el;
    const el = document.createElement('div');
    el.id = 'ambientWhisper';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%) translateY(20px)',
      'bottom:14px', 'z-index:3200', 'display:none', 'align-items:center', 'gap:10px',
      'max-width:min(680px,86vw)', 'padding:7px 10px 7px 13px',
      'background:var(--surface0,#1e1e2e)', 'border:1px solid var(--surface2,#45475a)',
      'border-radius:10px', 'box-shadow:0 8px 28px rgba(0,0,0,0.38)',
      'font-family:var(--font-ui,system-ui)', 'font-size:12px', 'color:var(--subtext1,#bac2de)',
      'opacity:0', 'transition:opacity .22s ease, transform .22s ease', 'cursor:default',
    ].join(';');
    el.innerHTML =
      '<span style="width:7px;height:7px;border-radius:50%;background:var(--accent,#89b4fa);flex:none;box-shadow:0 0 8px var(--accent,#89b4fa);"></span>' +
      '<span id="ambientWhisperText" style="flex:1;line-height:1.35;"></span>' +
      '<button id="ambientWhisperAct" style="background:var(--accent,#89b4fa);border:none;color:#11111b;font-weight:600;font-size:11px;padding:3px 9px;border-radius:6px;cursor:pointer;flex:none;">Review</button>' +
      '<button id="ambientWhisperDismiss" title="Dismiss (and stop showing this kind)" style="background:transparent;border:none;color:var(--overlay1,#7f849c);font-size:14px;line-height:1;padding:2px 4px;cursor:pointer;flex:none;">&times;</button>';
    document.body.appendChild(el);
    el.querySelector('#ambientWhisperAct').addEventListener('click', _act);
    el.querySelector('#ambientWhisperDismiss').addEventListener('click', _dismiss);
    _el = el;
    return el;
  }

  function _show(nudge) {
    _current = nudge;
    const el = _ensureEl();
    el.querySelector('#ambientWhisperText').textContent = nudge.title;
    el.style.display = 'flex';
    // next frame -> animate in
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateX(-50%) translateY(0)';
    });
  }

  function _hide() {
    if (!_el) return;
    _el.style.opacity = '0';
    _el.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => { if (_el) _el.style.display = 'none'; }, 220);
    _current = null;
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
    _hide();
    // Best-effort follow-through to a real surface, defensively.
    try {
      if (n.action && n.action.kind === 'contradictions' && typeof window.openCmdPalette === 'function') {
        window.openCmdPalette('what memory is stale or superseded');
      } else if (typeof window.toast === 'function') {
        window.toast('Noted', 'info');
      }
    } catch (_) {}
    // A dismissed/handled slot may free the next nudge.
    setTimeout(() => check(true), 1200);
  }

  function _dismiss() {
    if (!_current) return;
    _feedback(_current.type, 'dismiss');
    _hide();
    setTimeout(() => check(true), 1200); // show the next one, if any
  }

  // Check for a nudge. force=true bypasses the debounce (after an interaction).
  async function check(force) {
    if (_current && !force) return;            // already showing something
    const now = Date.now();
    if (!force && now - _lastCheck < MIN_INTERVAL_MS) return;
    _lastCheck = now;
    try {
      const r = await fetch('/api/symphonee/ambient/nudge');
      if (!r.ok) return;
      const d = await r.json().catch(() => ({}));
      if (d && d.nudge && d.nudge.title) {
        if (!_current || _current.title !== d.nudge.title) _show(d.nudge);
      } else if (!_current) {
        _hide();
      }
    } catch (_) { /* offline / not ready */ }
  }

  // Triggers: boot (settle first), and window focus (a natural lull). Never a timer.
  window.addEventListener('DOMContentLoaded', () => setTimeout(() => check(true), 5000));
  window.addEventListener('focus', () => check(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(false); });
  // If DOM is already ready (script loads late), kick a delayed first check.
  if (document.readyState !== 'loading') setTimeout(() => check(true), 5000);

  // Expose for manual testing / other surfaces.
  window.ambientWhisperCheck = () => check(true);
})();
