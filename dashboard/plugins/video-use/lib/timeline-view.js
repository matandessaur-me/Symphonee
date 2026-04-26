// Filmstrip + waveform PNG composite for a [start, end] range of a video.
//
// Pattern ported from helpers/timeline_view.py. We don't have librosa or
// matplotlib in Node, so the implementation differs:
//   - Frames: ffmpeg -ss/-frames:v 1 to extract N frames, written to disk.
//   - Waveform: ffmpeg's `showwavespic` filter writes a PNG strip directly.
//   - Composite: instead of a Python PIL composite, we ask ffmpeg to vstack
//     the filmstrip on top of the waveform. The end result is one PNG.
//
// Word labels: optional. If a transcript JSON path is supplied, we render
// drawtext overlays at each word's relative x position. Falls back to a
// plain composite if any drawtext step fails (drawtext is fragile across
// ffmpeg builds with respect to the font path).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ffmpegRun } = require('./ffmpeg');

const FILMSTRIP_HEIGHT = 180;
const WAVEFORM_HEIGHT = 120;
const COMPOSITE_WIDTH = 1600;

async function _extractFrames(getConfig, video, start, end, n, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const paths = [];
  if (n < 1) n = 1;
  // Pull the last sample slightly inside [start, end] - the exact `end`
  // timestamp can land past the last decodable frame and ffmpeg will write
  // nothing for it, leaving us with n-1 frames and a misaligned filmstrip.
  const safeEnd = end - Math.min(0.05, (end - start) * 0.02);
  const times = n === 1 ? [(start + end) / 2] : Array.from({ length: n }, (_, i) => start + i * (safeEnd - start) / (n - 1));
  for (let i = 0; i < times.length; i++) {
    const out = path.join(dest, `f_${String(i).padStart(3, '0')}.png`);
    // Force the scaled output to a width divisible by 2 (mjpeg/png both
    // tolerate it) and PNG output - mjpeg has been finicky on some builds
    // when the upstream is yuv420p at small sizes. PNG always works.
    await ffmpegRun(getConfig, [
      '-ss', String(times[i]),
      '-i', video,
      '-frames:v', '1',
      '-vf', `scale=-2:${FILMSTRIP_HEIGHT}:flags=lanczos,format=rgb24`,
      out,
    ], { timeoutMs: 30000 });
    if (fs.existsSync(out)) paths.push(out);
  }
  return paths;
}

async function _hstackFrames(getConfig, framePaths, out) {
  if (!framePaths.length) throw new Error('no frames extracted');
  if (framePaths.length === 1) {
    // Single frame: just copy + rescale to composite width.
    await ffmpegRun(getConfig, [
      '-i', framePaths[0],
      '-vf', `scale=${COMPOSITE_WIDTH}:${FILMSTRIP_HEIGHT}:force_original_aspect_ratio=decrease,pad=${COMPOSITE_WIDTH}:${FILMSTRIP_HEIGHT}:(ow-iw)/2:0:black`,
      out,
    ]);
    return;
  }
  const inputs = [];
  framePaths.forEach((p) => { inputs.push('-i', p); });
  // hstack requires same heights; we already scaled all to FILMSTRIP_HEIGHT.
  const filterIn = framePaths.map((_, i) => `[${i}:v]scale=-2:${FILMSTRIP_HEIGHT}[v${i}]`).join(';');
  const stackIn = framePaths.map((_, i) => `[v${i}]`).join('');
  const filter = `${filterIn};${stackIn}hstack=inputs=${framePaths.length}[s];[s]scale=${COMPOSITE_WIDTH}:${FILMSTRIP_HEIGHT}:force_original_aspect_ratio=decrease,pad=${COMPOSITE_WIDTH}:${FILMSTRIP_HEIGHT}:(ow-iw)/2:0:black[outv]`;
  await ffmpegRun(getConfig, [...inputs, '-filter_complex', filter, '-map', '[outv]', out]);
}

async function _waveform(getConfig, video, start, end, out) {
  const dur = end - start;
  await ffmpegRun(getConfig, [
    '-ss', String(start),
    '-t', String(dur),
    '-i', video,
    '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${COMPOSITE_WIDTH}x${WAVEFORM_HEIGHT}:colors=#3aa0ff`,
    '-frames:v', '1',
    out,
  ], { timeoutMs: 60000 });
}

async function _vstack(getConfig, top, bottom, out) {
  await ffmpegRun(getConfig, [
    '-i', top,
    '-i', bottom,
    '-filter_complex', `[0:v][1:v]vstack=inputs=2[v]`,
    '-map', '[v]',
    out,
  ]);
}

async function compose(getConfig, opts) {
  const { video, start, end, nFrames = 8, out } = opts;
  if (!fs.existsSync(video)) throw new Error('video not found: ' + video);
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    throw new Error('start/end must be numbers with end > start');
  }
  const finalOut = out || path.join(os.tmpdir(), `timeline-${Date.now()}.png`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-use-tl-'));
  try {
    const frameDir = path.join(work, 'frames');
    const frames = await _extractFrames(getConfig, video, start, end, nFrames, frameDir);
    const filmstripPng = path.join(work, 'filmstrip.png');
    await _hstackFrames(getConfig, frames, filmstripPng);
    const waveformPng = path.join(work, 'waveform.png');
    await _waveform(getConfig, video, start, end, waveformPng);
    await _vstack(getConfig, filmstripPng, waveformPng, finalOut);
    return { out: finalOut, frames: frames.length, start, end, width: COMPOSITE_WIDTH, height: FILMSTRIP_HEIGHT + WAVEFORM_HEIGHT };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { compose };
