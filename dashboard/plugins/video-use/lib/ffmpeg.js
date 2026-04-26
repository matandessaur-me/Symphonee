// ffmpeg / ffprobe wrappers for video-use.
//
// Resolves binaries from plugin settings (FfmpegPath / FfprobePath), falls
// back to "ffmpeg"/"ffprobe" on PATH. All shell-outs go through this file
// so we have one place to swap the executor and to enforce timeouts.

'use strict';

const { spawn } = require('child_process');

function _resolveBins(getConfig) {
  const cfg = (getConfig && getConfig()) || {};
  return {
    ffmpeg: cfg.FfmpegPath || 'ffmpeg',
    ffprobe: cfg.FfprobePath || 'ffprobe',
  };
}

// Run a binary, return { code, stdout, stderr }. Promise resolves on exit
// regardless of code; the caller decides what's an error.
function runBin(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch (_) {} }, opts.timeoutMs);
    }
    proc.stdout.on('data', (c) => { stdout += c.toString(); if (stdout.length > 5_000_000) stdout = stdout.slice(-5_000_000); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 5_000_000) stderr = stderr.slice(-5_000_000); });
    proc.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

async function ffprobeJson(getConfig, file) {
  const { ffprobe } = _resolveBins(getConfig);
  const r = await runBin(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { timeoutMs: 30000 });
  if (r.code !== 0) throw new Error(`ffprobe failed (${r.code}): ${r.stderr.slice(0, 500)}`);
  try { return JSON.parse(r.stdout); }
  catch (e) { throw new Error('ffprobe returned non-JSON output: ' + r.stdout.slice(0, 200)); }
}

async function detect(getConfig) {
  const bins = _resolveBins(getConfig);
  const out = { ffmpeg: { ok: false, path: bins.ffmpeg, version: null }, ffprobe: { ok: false, path: bins.ffprobe, version: null } };
  try {
    const r = await runBin(bins.ffmpeg, ['-version'], { timeoutMs: 5000 });
    if (r.code === 0) {
      out.ffmpeg.ok = true;
      const m = r.stdout.match(/ffmpeg version (\S+)/);
      out.ffmpeg.version = m ? m[1] : null;
    }
  } catch (_) {}
  try {
    const r = await runBin(bins.ffprobe, ['-version'], { timeoutMs: 5000 });
    if (r.code === 0) {
      out.ffprobe.ok = true;
      const m = r.stdout.match(/ffprobe version (\S+)/);
      out.ffprobe.version = m ? m[1] : null;
    }
  } catch (_) {}
  return out;
}

async function extractAudioMono16k(getConfig, video, dest) {
  const { ffmpeg } = _resolveBins(getConfig);
  const r = await runBin(ffmpeg, [
    '-y',
    '-i', video,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    dest,
  ], { timeoutMs: 600000 });
  if (r.code !== 0) throw new Error(`ffmpeg extract-audio failed (${r.code}): ${r.stderr.slice(-500)}`);
  return dest;
}

async function ffmpegRun(getConfig, args, opts = {}) {
  const { ffmpeg } = _resolveBins(getConfig);
  const r = await runBin(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeoutMs: opts.timeoutMs || 1800000 });
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.slice(-500)}`);
  return r;
}

module.exports = { runBin, ffprobeJson, detect, extractAudioMono16k, ffmpegRun, _resolveBins };
