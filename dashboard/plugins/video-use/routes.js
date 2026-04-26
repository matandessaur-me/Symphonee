// Video Use plugin -- conversation-driven video editor.
//
// Routes namespaced under /api/plugins/video-use/. The plugin shells out
// to ffmpeg/ffprobe and (optionally) whisper or ElevenLabs Scribe; nothing
// else.

'use strict';

const fs = require('fs');
const path = require('path');
const { detect, ffprobeJson } = require('./lib/ffmpeg');
const transcribeMod = require('./lib/transcribe');
const packMod = require('./lib/pack');
const renderMod = require('./lib/render');
const timelineMod = require('./lib/timeline-view');
const gradeMod = require('./lib/grade');
const edlMod = require('./lib/edl');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

module.exports = function register(ctx) {
  const { json, readBody, getConfig } = ctx;

  ctx.addRoute('GET', '/health', async (req, res) => {
    try {
      const tools = await detect(getConfig);
      json(res, { ok: true, plugin: 'video-use', tools, gradePresets: gradeMod.listPresets() });
    } catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  // Inventory a folder of source videos.
  ctx.addRoute('POST', '/inventory', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const folder = body && body.folder;
    if (!folder) return json(res, { ok: false, error: 'Missing field: folder' }, 400);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return json(res, { ok: false, error: 'folder not found' }, 400);
    const entries = fs.readdirSync(folder).filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()));
    const result = [];
    for (const name of entries) {
      const full = path.join(folder, name);
      try {
        const meta = await ffprobeJson(getConfig, full);
        const v = (meta.streams || []).find((s) => s.codec_type === 'video') || {};
        const a = (meta.streams || []).find((s) => s.codec_type === 'audio') || {};
        const fmt = meta.format || {};
        result.push({
          name,
          path: full,
          duration: Number(fmt.duration) || null,
          sizeBytes: Number(fmt.size) || null,
          video: v.codec_name ? { codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate } : null,
          audio: a.codec_name ? { codec: a.codec_name, channels: a.channels, sampleRate: a.sample_rate } : null,
        });
      } catch (e) {
        result.push({ name, path: full, error: e.message });
      }
    }
    json(res, { ok: true, folder, total: result.length, videos: result });
  });

  ctx.addRoute('POST', '/transcribe', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const { video, editDir, language, numSpeakers, provider, force, model } = body || {};
    if (!video) return json(res, { ok: false, error: 'Missing field: video' }, 400);
    const dir = editDir || path.join(path.dirname(video), 'edit');
    try {
      const r = await transcribeMod.transcribeOne(getConfig, video, dir, { language, numSpeakers, provider: provider || 'auto', force: !!force, model });
      json(res, { ok: true, ...r, editDir: dir });
    } catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  ctx.addRoute('POST', '/transcribe-batch', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const { folder, editDir, language, numSpeakers, provider, force, model } = body || {};
    if (!folder) return json(res, { ok: false, error: 'Missing field: folder' }, 400);
    const dir = editDir || path.join(folder, 'edit');
    try {
      const r = await transcribeMod.transcribeBatch(getConfig, folder, dir, { language, numSpeakers, provider: provider || 'auto', force: !!force, model });
      json(res, { ok: true, editDir: dir, ...r });
    } catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  ctx.addRoute('POST', '/pack', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const { editDir, silenceThreshold, output } = body || {};
    if (!editDir) return json(res, { ok: false, error: 'Missing field: editDir' }, 400);
    try {
      const r = packMod.pack(editDir, { silenceThreshold, output });
      json(res, { ok: true, ...r });
    } catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  ctx.addRoute('POST', '/timeline-view', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const { video, start, end, nFrames, out } = body || {};
    if (!video || typeof start !== 'number' || typeof end !== 'number') {
      return json(res, { ok: false, error: 'Required: video (string), start (number), end (number)' }, 400);
    }
    try {
      const r = await timelineMod.compose(getConfig, { video, start, end, nFrames, out });
      json(res, { ok: true, ...r });
    } catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  ctx.addRoute('POST', '/render', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const { edl, edlPath, output, editDir, sourcesBaseDir, transcriptDir, keepWorkDir } = body || {};
    try {
      let edlObj;
      if (edl) {
        // Inline EDLs that use relative source paths must declare a base dir
        // explicitly - process CWD is unsafe for a long-running server.
        const hasRelative = Object.values(edl.sources || {}).some((p) => typeof p === 'string' && !path.isAbsolute(p));
        if (hasRelative && !sourcesBaseDir) {
          return json(res, { ok: false, error: 'Inline edl has relative sources; pass sourcesBaseDir or use absolute paths' }, 400);
        }
        edlObj = edlMod.validate(edl, { sourcesBaseDir: sourcesBaseDir || null });
      } else if (edlPath) {
        edlObj = edlMod.load(edlPath);
      } else {
        return json(res, { ok: false, error: 'Provide edl (object) or edlPath (string)' }, 400);
      }
      const r = await renderMod.render(getConfig, edlObj, { output, editDir, transcriptDir, keepWorkDir: !!keepWorkDir });
      json(res, { ok: true, ...r });
    } catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });

  ctx.addRoute('POST', '/grade', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const { video, preset, filter, out } = body || {};
    if (!video) return json(res, { ok: false, error: 'Missing field: video' }, 400);
    const filterChain = filter ? filter : (preset ? gradeMod.getPreset(preset) : '');
    if (!filterChain) return json(res, { ok: false, error: 'Provide preset or filter' }, 400);
    const finalOut = out || path.join(path.dirname(video), `${path.basename(video, path.extname(video))}_graded.mp4`);
    try {
      const { ffmpegRun } = require('./lib/ffmpeg');
      await ffmpegRun(getConfig, [
        '-i', video,
        '-vf', filterChain,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'copy',
        finalOut,
      ]);
      json(res, { ok: true, out: finalOut, filter: filterChain });
    } catch (e) { json(res, { ok: false, error: e.message }, 500); }
  });
};
