/**
 * Symphonee Voice (client) - lets Symphonee speak.
 *
 * speak(text): tries the server's ElevenLabs TTS (premium, the key stays
 * server-side); if there is no key or it fails, falls back to the browser's own
 * speechSynthesis - so voice works for EVERYONE and just sounds better with a
 * Symphonee Voice key.
 *
 * A speaker toggle lives in the top bar (#voiceToggleBtn). Default OFF so no one
 * is surprised by sound; the choice persists in localStorage. Other surfaces
 * call window.symphoneeSpeak(text) and check window.symphoneeVoiceOn().
 *
 * Loads after app.js as /js/symphonee-voice.js.
 */

(() => {
  'use strict';

  const LS_KEY = 'symphonee_voice_on';
  let _on = false;
  try { _on = localStorage.getItem(LS_KEY) === '1'; } catch (_) {}
  let _audio = null;

  function _btn() { return document.getElementById('voiceToggleBtn'); }
  function _renderBtn() {
    const b = _btn();
    if (!b) return;
    const icon = b.querySelector('i');
    if (icon) {
      icon.setAttribute('data-lucide', _on ? 'volume-2' : 'volume-x');
      try { if (window.lucide) lucide.createIcons({ nodes: [b] }); } catch (_) {}
    }
    b.style.color = _on ? 'var(--accent)' : 'var(--subtext0)';
    b.title = _on ? 'Symphonee Voice on - click to mute' : 'Symphonee Voice off - click to hear nudges + answers';
  }

  function _stop() {
    try { if (_audio) { _audio.pause(); _audio = null; } } catch (_) {}
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
  }

  function _playAudio(url) {
    try { _stop(); _audio = new Audio(url); _audio.play().catch(() => {}); } catch (_) {}
  }

  function _browserSpeak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.03; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  async function speak(text) {
    if (!_on || !text) return;
    const t = String(text).slice(0, 600);
    try {
      const r = await fetch('/api/symphonee/voice/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }),
      });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (r.ok && ct.includes('audio')) {
        const blob = await r.blob();
        _playAudio(URL.createObjectURL(blob));
        return;
      }
      _browserSpeak(t); // no-key / tts-error -> browser voice
    } catch (_) {
      _browserSpeak(t);
    }
  }

  function setOn(on) {
    _on = !!on;
    try { localStorage.setItem(LS_KEY, _on ? '1' : '0'); } catch (_) {}
    if (!_on) _stop();
    _renderBtn();
    if (_on) {
      try { if (window.toast) window.toast('Symphonee Voice on', 'info'); } catch (_) {}
      speak('Voice on.');
    }
  }

  window.symphoneeSpeak = speak;
  window.symphoneeVoiceOn = () => _on;
  window.symphoneeVoiceToggle = () => setOn(!_on);
  window.symphoneeVoiceSet = setOn;

  if (document.readyState !== 'loading') setTimeout(_renderBtn, 300);
  else window.addEventListener('DOMContentLoaded', () => setTimeout(_renderBtn, 300));
})();
