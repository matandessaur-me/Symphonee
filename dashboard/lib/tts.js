/**
 * Symphonee Voice - text-to-speech via ElevenLabs.
 *
 * Gives Symphonee a literal voice: nudges, answers, and "here's what I just
 * finished" summaries can be spoken. The ElevenLabs key (one key) also powers
 * Video Use transcription, so it lives at config.ElevenLabsApiKey as the
 * "Symphonee Voice" setting.
 *
 * This module only knows how to turn text into MP3 bytes. The route
 * (POST /api/symphonee/voice/speak) reads the key from config and falls back to
 * the browser's own speechSynthesis when no key is set, so voice works for
 * everyone and just sounds better with ElevenLabs.
 */

'use strict';

const https = require('https');

const ELEVEN_BASE = 'api.elevenlabs.io';
// Rachel - a calm, neutral default ElevenLabs voice. Override per install via
// config.SymphoneeVoiceId or env.
const DEFAULT_VOICE_ID = process.env.SYMPHONEE_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_MODEL = process.env.SYMPHONEE_VOICE_MODEL || 'eleven_turbo_v2_5'; // low-latency

/**
 * Synthesize speech. Returns a Buffer of MP3 audio.
 * @param text   the text to speak (capped to keep latency + cost sane)
 * @param opts   { apiKey (required), voiceId?, modelId? }
 */
function elevenLabsTTS(text, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) return Promise.reject(new Error('no-key'));
  const voiceId = opts.voiceId || DEFAULT_VOICE_ID;
  const payload = Buffer.from(JSON.stringify({
    text: String(text || '').slice(0, 1200),
    model_id: opts.modelId || DEFAULT_MODEL,
    voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  }));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ELEVEN_BASE,
      path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': payload.length,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', (c) => { err += c; });
        res.on('end', () => reject(new Error('elevenlabs ' + res.statusCode + ': ' + err.slice(0, 200))));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('elevenlabs timeout')));
    req.end(payload);
  });
}

module.exports = { elevenLabsTTS, DEFAULT_VOICE_ID, DEFAULT_MODEL };
