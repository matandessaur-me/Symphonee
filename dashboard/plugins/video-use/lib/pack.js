// Pack all transcripts in <editDir>/transcripts/ into one takes_packed.md.
//
// Direct port of helpers/pack_transcripts.py from browser-use/video-use.
// Walks the word list, breaks phrases on silence >= threshold OR speaker
// change. Output is the LLM's primary reading view of an edit session.

'use strict';

const fs = require('fs');
const path = require('path');

function _formatTime(sec) {
  return Number(sec || 0).toFixed(2).padStart(6, '0');
}
function _formatDuration(sec) {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}m ${s.toFixed(1).padStart(4, '0')}s`;
}

function groupIntoPhrases(words, silenceThreshold = 0.5) {
  const phrases = [];
  let current = [];
  let currentStart = null;
  let currentSpeaker = null;
  let prevEnd = null;

  function flush() {
    if (!current.length) return;
    const parts = [];
    for (const w of current) {
      const t = w.type || 'word';
      let raw = (w.text || '').trim();
      if (!raw) continue;
      if (t === 'audio_event' && !raw.startsWith('(')) raw = '(' + raw + ')';
      parts.push(raw);
    }
    if (!parts.length) {
      current = []; currentStart = null; currentSpeaker = null;
      return;
    }
    let text = parts.join(' ').replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ \?/g, '?').replace(/ !/g, '!');
    const last = current[current.length - 1];
    const endTime = (last.end != null ? last.end : (last.start != null ? last.start : currentStart || 0));
    phrases.push({ start: currentStart, end: endTime, text, speakerId: currentSpeaker });
    current = []; currentStart = null; currentSpeaker = null;
  }

  for (const w of words || []) {
    const t = w.type || 'word';
    if (t === 'spacing') {
      if (typeof w.start === 'number' && typeof w.end === 'number' && (w.end - w.start) >= silenceThreshold) flush();
      continue;
    }
    if (typeof w.start !== 'number') continue;
    const speaker = w.speaker_id != null ? w.speaker_id : null;
    if (currentSpeaker !== null && speaker !== null && speaker !== currentSpeaker) flush();
    if (prevEnd !== null && (w.start - prevEnd) >= silenceThreshold) flush();
    if (currentStart === null) { currentStart = w.start; currentSpeaker = speaker; }
    current.push(w);
    prevEnd = w.end != null ? w.end : w.start;
  }
  flush();
  return phrases;
}

function packOne(jsonPath, silenceThreshold) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const words = data.words || [];
  const phrases = groupIntoPhrases(words, silenceThreshold);
  let duration = 0;
  if (phrases.length) duration = phrases[phrases.length - 1].end - phrases[0].start;
  return { name: path.basename(jsonPath, path.extname(jsonPath)), duration, phrases };
}

function renderMarkdown(entries, silenceThreshold) {
  const lines = [];
  lines.push('# Packed transcripts');
  lines.push('');
  lines.push(`Phrase-level, grouped on silences >= ${silenceThreshold.toFixed(1)}s or speaker change.`);
  lines.push('Use `[start-end]` ranges to address cuts in the EDL.');
  lines.push('');
  for (const entry of entries) {
    lines.push(`## ${entry.name}  (duration: ${_formatDuration(entry.duration)}, ${entry.phrases.length} phrases)`);
    if (!entry.phrases.length) {
      lines.push('  _no speech detected_');
      lines.push('');
      continue;
    }
    for (const p of entry.phrases) {
      let spkTag = '';
      if (p.speakerId != null) {
        let s = String(p.speakerId);
        if (s.startsWith('speaker_')) s = s.slice('speaker_'.length);
        spkTag = ` S${s}`;
      }
      lines.push(`  [${_formatTime(p.start)}-${_formatTime(p.end)}]${spkTag} ${p.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function pack(editDir, opts = {}) {
  const silenceThreshold = typeof opts.silenceThreshold === 'number' ? opts.silenceThreshold : 0.5;
  const transcriptsDir = path.join(editDir, 'transcripts');
  if (!fs.existsSync(transcriptsDir)) throw new Error('no transcripts directory at ' + transcriptsDir);
  const files = fs.readdirSync(transcriptsDir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  if (!files.length) throw new Error('no .json files in ' + transcriptsDir);
  const entries = files.map((f) => packOne(path.join(transcriptsDir, f), silenceThreshold));
  const md = renderMarkdown(entries, silenceThreshold);
  const outPath = opts.output || path.join(editDir, 'takes_packed.md');
  fs.writeFileSync(outPath, md);
  const totalPhrases = entries.reduce((a, e) => a + e.phrases.length, 0);
  const totalDuration = entries.reduce((a, e) => a + e.duration, 0);
  return { outPath, totalSources: entries.length, totalPhrases, totalDuration, sizeBytes: Buffer.byteLength(md, 'utf8') };
}

module.exports = { pack, groupIntoPhrases };
