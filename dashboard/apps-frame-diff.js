// Perceptual frame diff for the Apps tab "live view" gate.
//
// Downsamples both frames to a tiny greyscale grid and compares mean absolute
// difference. Threshold is tuned above the JPEG quantization floor so repeated
// captures of a static window read as unchanged.

const Jimp = require('jimp');

const DOWN_W = 80;
const DOWN_H = 45;
const DEFAULT_THRESHOLD = 0.008; // ~0.8% mean absolute luminance delta

async function toGreyGrid(base64) {
  const buf = Buffer.from(base64, 'base64');
  const img = await Jimp.read(buf);
  img.resize(DOWN_W, DOWN_H).greyscale();
  const { data } = img.bitmap;
  const grid = new Uint8Array(DOWN_W * DOWN_H);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) grid[j] = data[i];
  return grid;
}

async function diffFrames(prev, next, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  if (!prev || !next) return { changed: true, score: 1, reason: 'no_prev' };
  if (prev === next) return { changed: false, score: 0 };
  try {
    const [a, b] = await Promise.all([toGreyGrid(prev), toGreyGrid(next)]);
    if (a.length !== b.length) return { changed: true, score: 1, reason: 'size_changed' };
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    const score = sum / (a.length * 255);
    return { changed: score >= threshold, score };
  } catch (e) {
    return { changed: true, score: 1, reason: 'decode_error', error: e.message };
  }
}

module.exports = { diffFrames, DEFAULT_THRESHOLD, DOWN_W, DOWN_H };
