// EDL renderer.
//
// Pipeline mirrors helpers/render.py from browser-use/video-use:
//   1. Per-segment extract with grade + 30ms audio fades baked in.
//   2. Lossless -c copy concat into base.mp4.
//   3. If subtitles enabled: build master SRT from per-source transcripts +
//      EDL output offsets, burn via subtitles filter.
//
// Out of scope for v1: HDR tonemap, animation overlays, manim/remotion
// dispatch. Those are flagged in the plugin instructions and can be added
// later without breaking this contract.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ffmpegRun } = require('./ffmpeg');
const grade = require('./grade');

function _safeStem(s) {
  return String(s).replace(/[^\w.\-]+/g, '_').slice(0, 64);
}

function _extractSegmentArgs(seg, outFile, fadeMs) {
  const fadeS = (fadeMs || 30) / 1000;
  const dur = seg.out - seg.in;
  const fadeOutStart = Math.max(0, dur - fadeS);
  const filter = grade.resolveGrade(seg.grade);
  const vf = filter ? filter : 'null';
  const af = `afade=t=in:st=0:d=${fadeS},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeS}`;
  return [
    '-ss', String(seg.in),
    '-to', String(seg.out),
    '-i', seg.sourcePath,
    '-vf', vf,
    '-af', af,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    outFile,
  ];
}

async function _renderSegments(getConfig, edl, workDir) {
  const segDir = path.join(workDir, 'segs');
  fs.mkdirSync(segDir, { recursive: true });
  const segPaths = [];
  for (let i = 0; i < edl.segments.length; i++) {
    const seg = edl.segments[i];
    const segOut = path.join(segDir, `s_${String(i).padStart(4, '0')}_${_safeStem(seg.source)}.mp4`);
    await ffmpegRun(getConfig, _extractSegmentArgs(seg, segOut, edl.audioFadeMs));
    segPaths.push(segOut);
  }
  return segPaths;
}

async function _concat(getConfig, segPaths, baseOut, workDir) {
  const listFile = path.join(workDir, 'concat.txt');
  fs.writeFileSync(listFile, segPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpegRun(getConfig, [
    '-f', 'concat', '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    baseOut,
  ]);
}

// ───────────────────────── Subtitles ─────────────────────────────────────────
const SRT_STYLE = 'FontName=Helvetica,FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=90';

function _formatSrtTime(sec) {
  if (sec < 0) sec = 0;
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Take Scribe-shaped words from a transcript JSON, restrict to the segment
// window (in source time), shift to output time (out_offset), and emit
// 2-word UPPERCASE chunks.
function _wordsForSegment(transcriptJson, segIn, segOut, outOffset) {
  const words = (transcriptJson && transcriptJson.words) || [];
  const out = [];
  for (const w of words) {
    if (w.type === 'spacing') continue;
    const ws = Number(w.start);
    const we = Number(w.end != null ? w.end : ws);
    if (we < segIn || ws > segOut) continue;
    const text = (w.text || '').trim();
    if (!text) continue;
    const start = Math.max(ws, segIn) - segIn + outOffset;
    const end = Math.min(we, segOut) - segIn + outOffset;
    if (end <= start) continue;
    out.push({ start, end, text });
  }
  return out;
}

function _chunkWords(words, chunkSize = 2) {
  const out = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    const slice = words.slice(i, i + chunkSize);
    if (!slice.length) continue;
    out.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      text: slice.map((w) => w.text.toUpperCase()).join(' '),
    });
  }
  return out;
}

function _buildSrt(edl, transcriptDir) {
  const cues = [];
  let outOffset = 0;
  for (const seg of edl.segments) {
    const transcriptPath = path.join(transcriptDir, seg.source + '.json');
    if (fs.existsSync(transcriptPath)) {
      try {
        const tjson = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
        const segWords = _wordsForSegment(tjson, seg.in, seg.out, outOffset);
        const chunks = _chunkWords(segWords, 2);
        cues.push(...chunks);
      } catch (_) { /* skip on parse failure */ }
    }
    outOffset += seg.out - seg.in;
  }
  const lines = [];
  cues.forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${_formatSrtTime(c.start)} --> ${_formatSrtTime(c.end)}`);
    lines.push(c.text);
    lines.push('');
  });
  return lines.join('\n');
}

async function _burnSubtitles(getConfig, baseIn, srtPath, finalOut) {
  // The subtitles= filter requires the path to be ffmpeg-escaped. On Windows
  // backslashes and the drive-letter colon both need escaping.
  const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const filter = `subtitles='${escaped}':force_style='${SRT_STYLE}'`;
  await ffmpegRun(getConfig, [
    '-i', baseIn,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'copy',
    finalOut,
  ]);
}

// ───────────────────────── Main entry ────────────────────────────────────────
async function render(getConfig, edl, opts = {}) {
  const finalOut = opts.output || path.join(os.tmpdir(), `video-use-${Date.now()}.mp4`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-use-render-'));
  const stats = { startedAt: Date.now(), segments: edl.segments.length, finalOut };
  try {
    const segPaths = await _renderSegments(getConfig, edl, workDir);
    stats.segmentsRendered = segPaths.length;

    const baseOut = path.join(workDir, 'base.mp4');
    await _concat(getConfig, segPaths, baseOut, workDir);

    if (edl.subtitles && edl.subtitles.enabled) {
      const transcriptDir = opts.transcriptDir || (opts.editDir ? path.join(opts.editDir, 'transcripts') : null);
      if (!transcriptDir || !fs.existsSync(transcriptDir)) {
        // Subtitles requested but no transcripts available: fall through to
        // a copy of base as the final.
        fs.copyFileSync(baseOut, finalOut);
        stats.subtitlesSkipped = 'no transcripts directory';
      } else {
        const srt = _buildSrt(edl, transcriptDir);
        const srtPath = path.join(workDir, 'master.srt');
        fs.writeFileSync(srtPath, srt);
        await _burnSubtitles(getConfig, baseOut, srtPath, finalOut);
        stats.subtitlesBurned = true;
      }
    } else {
      fs.copyFileSync(baseOut, finalOut);
    }
    stats.finishedAt = Date.now();
    stats.elapsedMs = stats.finishedAt - stats.startedAt;
    return stats;
  } finally {
    if (!opts.keepWorkDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    } else {
      stats.workDir = workDir;
    }
  }
}

module.exports = { render };
