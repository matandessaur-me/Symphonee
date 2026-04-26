// Transcription with provider auto-detect.
//
// Order in 'auto' mode:
//   1. whisper-cli  (whisper.cpp binary) - fastest local
//   2. whisper       (OpenAI Python CLI)
//   3. ElevenLabs Scribe (paid, network) - if ElevenLabsApiKey is set
//
// All providers normalise to the Scribe-shaped payload so pack.js works
// either way:
//   { words: [{ start, end, text, type: "word"|"audio_event"|"spacing", speaker_id? }] }

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { runBin, extractAudioMono16k } = require('./ffmpeg');

function _writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function _which(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = await runBin(cmd, [bin], { timeoutMs: 3000 });
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch (_) { return false; }
}

// ───────────────────────── whisper.cpp (whisper-cli) ─────────────────────────
// whisper-cli writes JSON next to the input when given -oj.
async function transcribeWithWhisperCpp(getConfig, audioWav, opts = {}) {
  const tmpJson = audioWav + '.json';
  const args = ['-f', audioWav, '-oj', '-of', audioWav, '-ml', '1', '-pp'];
  if (opts.language) args.push('-l', opts.language);
  if (opts.model) args.push('-m', opts.model);
  const r = await runBin('whisper-cli', args, { timeoutMs: 1800000 });
  if (r.code !== 0) throw new Error(`whisper-cli failed (${r.code}): ${r.stderr.slice(-400)}`);
  if (!fs.existsSync(tmpJson)) throw new Error('whisper-cli completed but produced no JSON');
  const raw = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
  fs.unlinkSync(tmpJson);
  return _normalizeWhisperCpp(raw);
}
function _normalizeWhisperCpp(raw) {
  // whisper.cpp -ml 1 emits per-token segments. Convert to Scribe-shaped words.
  const words = [];
  const segs = (raw && raw.transcription) || [];
  for (const seg of segs) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    const start = (seg.offsets && typeof seg.offsets.from === 'number') ? seg.offsets.from / 1000 : Number(seg.start || 0);
    const end = (seg.offsets && typeof seg.offsets.to === 'number') ? seg.offsets.to / 1000 : Number(seg.end || start);
    words.push({ type: 'word', text, start, end });
  }
  return { words, provider: 'whisper-cpp' };
}

// ───────────────────────── OpenAI whisper (python CLI) ───────────────────────
async function transcribeWithWhisperPython(getConfig, audioWav, opts = {}) {
  const outDir = path.dirname(audioWav);
  const args = [audioWav, '--model', opts.model || 'base', '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', outDir, '--verbose', 'False'];
  if (opts.language) args.push('--language', opts.language);
  const r = await runBin('whisper', args, { timeoutMs: 1800000 });
  if (r.code !== 0) throw new Error(`whisper (python) failed (${r.code}): ${r.stderr.slice(-400)}`);
  const stem = path.basename(audioWav, path.extname(audioWav));
  const jsonPath = path.join(outDir, stem + '.json');
  if (!fs.existsSync(jsonPath)) throw new Error('whisper completed but produced no JSON at ' + jsonPath);
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  fs.unlinkSync(jsonPath);
  return _normalizeWhisperPython(raw);
}
function _normalizeWhisperPython(raw) {
  const words = [];
  const segs = (raw && raw.segments) || [];
  for (const seg of segs) {
    const ws = seg.words || [];
    for (const w of ws) {
      const text = (w.word || w.text || '').trim();
      if (!text) continue;
      words.push({ type: 'word', text, start: Number(w.start || 0), end: Number(w.end || 0) });
    }
  }
  return { words, provider: 'whisper-python' };
}

// ───────────────────────── ElevenLabs Scribe ─────────────────────────────────
async function transcribeWithElevenLabs(getConfig, audioWav, opts = {}) {
  const cfg = (getConfig && getConfig()) || {};
  const apiKey = cfg.ElevenLabsApiKey;
  if (!apiKey) throw new Error('ElevenLabsApiKey not configured');

  const boundary = '----symphonee-' + Date.now();
  const fileName = path.basename(audioWav);
  const fileBuf = fs.readFileSync(audioWav);

  const fields = { model_id: 'scribe_v1', diarize: 'true', tag_audio_events: 'true', timestamps_granularity: 'word' };
  if (opts.language) fields.language_code = opts.language;
  if (opts.numSpeakers) fields.num_speakers = String(opts.numSpeakers);

  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  return await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/speech-to-text',
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 1800000,
    }, (resp) => {
      let chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (resp.statusCode !== 200) return reject(new Error(`Scribe ${resp.statusCode}: ${text.slice(0, 400)}`));
        try {
          const parsed = JSON.parse(text);
          parsed.provider = 'elevenlabs';
          resolve(parsed);
        } catch (e) { reject(new Error('Scribe returned non-JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ───────────────────────── Public API ────────────────────────────────────────
async function transcribeOne(getConfig, video, editDir, opts = {}) {
  if (!fs.existsSync(video)) throw new Error('video not found: ' + video);
  const stem = path.basename(video, path.extname(video));
  const transcriptsDir = path.join(editDir, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const outPath = path.join(transcriptsDir, stem + '.json');
  if (fs.existsSync(outPath) && !opts.force) {
    return { path: outPath, cached: true };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-use-'));
  const audioWav = path.join(tmpDir, stem + '.wav');
  try {
    await extractAudioMono16k(getConfig, video, audioWav);

    const provider = opts.provider || 'auto';
    let result;
    if (provider === 'whisper-cpp') {
      result = await transcribeWithWhisperCpp(getConfig, audioWav, opts);
    } else if (provider === 'whisper-python' || provider === 'whisper') {
      // Try cpp first, then python, when 'whisper' is requested generically
      if (provider === 'whisper' && (await _which('whisper-cli'))) {
        result = await transcribeWithWhisperCpp(getConfig, audioWav, opts);
      } else {
        result = await transcribeWithWhisperPython(getConfig, audioWav, opts);
      }
    } else if (provider === 'elevenlabs') {
      result = await transcribeWithElevenLabs(getConfig, audioWav, opts);
    } else {
      // auto
      if (await _which('whisper-cli')) {
        result = await transcribeWithWhisperCpp(getConfig, audioWav, opts);
      } else if (await _which('whisper')) {
        result = await transcribeWithWhisperPython(getConfig, audioWav, opts);
      } else {
        const cfg = (getConfig && getConfig()) || {};
        if (cfg.ElevenLabsApiKey) result = await transcribeWithElevenLabs(getConfig, audioWav, opts);
        else throw new Error('No transcription provider available. Install whisper-cli or whisper, or set ElevenLabsApiKey.');
      }
    }
    _writeJson(outPath, result);
    return { path: outPath, cached: false, provider: result.provider, words: (result.words || []).length };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

async function transcribeBatch(getConfig, folder, editDir, opts = {}) {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('folder not found: ' + folder);
  const entries = fs.readdirSync(folder).filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()));
  if (!entries.length) return { total: 0, results: [] };
  const results = [];
  for (const name of entries) {
    const full = path.join(folder, name);
    try {
      const r = await transcribeOne(getConfig, full, editDir, opts);
      results.push({ video: name, ok: true, ...r });
    } catch (e) {
      results.push({ video: name, ok: false, error: e.message });
    }
  }
  return { total: entries.length, results };
}

module.exports = { transcribeOne, transcribeBatch };
