/**
 * Symphonee Voice (client) - lets Symphonee speak, with a modern, elegant
 * woman's voice.
 *
 * speak(text): tries the server's ElevenLabs TTS (premium, the key stays
 * server-side, a female voice); if there is no key or it fails, falls back to
 * the BEST available female browser voice via speechSynthesis - so voice works
 * for everyone and just sounds better with a key.
 *
 * On by default (the point is to hear Symphonee); a speaker toggle in the top
 * bar mutes/unmutes, persisted. Other surfaces call window.symphoneeSpeak(text)
 * and check window.symphoneeVoiceOn().
 */

(() => {
  'use strict';

  const LS_KEY = 'symphonee_voice_on';
  // On by default - mute is one click away. (Explicit '0' = the user muted it.)
  let _on = true;
  try { if (localStorage.getItem(LS_KEY) === '0') _on = false; } catch (_) {}
  let _audio = null;
  let _voice = null;

  // ── browser voice picker: a natural, female, English voice ──────────────────
  const PREF = [/aria/i, /jenny/i, /jane/i, /sonia/i, /libby/i, /natasha/i, /clara/i,
    /google uk english female/i, /google us english/i, /samantha/i, /zira/i, /female/i];
  function _pickVoice() {
    let vs = [];
    try { vs = window.speechSynthesis.getVoices() || []; } catch (_) {}
    if (!vs.length) return null;
    const en = vs.filter(v => /^en/i.test(v.lang || ''));
    const pool = en.length ? en : vs;
    for (const re of PREF) { const v = pool.find(v => re.test(v.name || '')); if (v) return v; }
    return pool[0];
  }
  try {
    _voice = _pickVoice();
    if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = () => { _voice = _pickVoice() || _voice; };
  } catch (_) {}

  function _btn() { return document.getElementById('voiceToggleBtn'); }
  function _renderBtn() {
    const b = _btn();
    if (!b) return;
    const icon = b.querySelector('i');
    if (icon) {
      icon.setAttribute('data-lucide', _on ? 'volume-2' : 'volume-x');
      try { if (window.lucide) lucide.createIcons({ nodes: [b] }); } catch (_) {}
    }
    b.style.color = _on ? 'var(--accent)' : 'var(--overlay1,#7f849c)';
    b.style.filter = _on ? 'drop-shadow(0 0 5px var(--accent,#89b4fa))' : 'none';
    b.title = _on ? 'Symphonee Voice on - click to mute' : 'Symphonee Voice muted - click to unmute';
  }

  function _stop() {
    try { if (_audio) { _audio.pause(); _audio = null; } } catch (_) {}
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
  }
  function _playAudio(url) { try { _stop(); _audio = new Audio(url); _audio.play().catch(() => {}); } catch (_) {} }

  function _browserSpeak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (!_voice) _voice = _pickVoice();
      if (_voice) u.voice = _voice;
      u.lang = (_voice && _voice.lang) || 'en-US';
      u.rate = 1.0; u.pitch = 1.06; u.volume = 1.0; // a touch bright + elegant
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  async function speak(text) {
    if (!_on || !text) return;
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!t) return;
    try {
      const r = await fetch('/api/symphonee/voice/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }),
      });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (r.ok && ct.includes('audio')) { _playAudio(URL.createObjectURL(await r.blob())); return; }
      _browserSpeak(t); // no-key / tts-error -> browser voice
    } catch (_) { _browserSpeak(t); }
  }

  function setOn(on) {
    const was = _on;
    _on = !!on;
    try { localStorage.setItem(LS_KEY, _on ? '1' : '0'); } catch (_) {}
    if (!_on) _stop();
    _renderBtn();
    try { if (window.toast) window.toast(_on ? 'Symphonee Voice on' : 'Symphonee Voice muted', 'info'); } catch (_) {}
    // Only greet when the user explicitly turns it ON (never auto-speak on load).
    if (_on && !was) speak('Voice on.');
  }

  window.symphoneeSpeak = speak;
  window.symphoneeVoiceOn = () => _on;
  window.symphoneeVoiceToggle = () => setOn(!_on);
  window.symphoneeVoiceSet = setOn;

  if (document.readyState !== 'loading') setTimeout(_renderBtn, 300);
  else window.addEventListener('DOMContentLoaded', () => setTimeout(_renderBtn, 300));
})();
