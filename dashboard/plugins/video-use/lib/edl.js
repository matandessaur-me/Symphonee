// EDL (Edit Decision List) schema + validator.
//
// Pattern ported from browser-use/video-use - the JSON the LLM produces and
// render.js executes. Validation is intentionally tight: a malformed EDL
// blows up entire renders, so we want to fail fast at /render with a clear
// message instead of mid-pipeline.

'use strict';

const fs = require('fs');
const path = require('path');

function _err(msg, ctx) {
  const err = new Error(msg + (ctx ? ` (${ctx})` : ''));
  err.code = 'EDL_INVALID';
  throw err;
}

function validate(edl, { sourcesBaseDir = null } = {}) {
  if (!edl || typeof edl !== 'object') _err('edl must be an object');
  if (edl.version !== 1 && edl.version !== undefined) _err('edl.version must be 1');
  if (!edl.sources || typeof edl.sources !== 'object') _err('edl.sources missing');
  if (!Array.isArray(edl.segments) || !edl.segments.length) _err('edl.segments must be a non-empty array');

  const sources = {};
  for (const [id, p] of Object.entries(edl.sources)) {
    if (typeof p !== 'string' || !p.length) _err(`edl.sources.${id} must be a non-empty string`);
    let resolved = p;
    if (!path.isAbsolute(p) && sourcesBaseDir) resolved = path.resolve(sourcesBaseDir, p);
    if (!fs.existsSync(resolved)) _err(`source file not found: ${resolved}`, `edl.sources.${id}`);
    sources[id] = resolved;
  }

  const segments = edl.segments.map((seg, i) => {
    if (!seg || typeof seg !== 'object') _err(`segments[${i}] must be an object`);
    if (typeof seg.source !== 'string') _err(`segments[${i}].source must be string`);
    if (!sources[seg.source]) _err(`segments[${i}].source references unknown source: ${seg.source}`);
    if (typeof seg.in !== 'number' || seg.in < 0) _err(`segments[${i}].in must be a non-negative number`);
    if (typeof seg.out !== 'number' || seg.out <= seg.in) _err(`segments[${i}].out must be a number greater than .in`);
    return {
      source: seg.source,
      sourcePath: sources[seg.source],
      in: seg.in,
      out: seg.out,
      grade: typeof seg.grade === 'string' ? seg.grade : null,
    };
  });

  const KNOWN_SUB_STYLES = new Set(['uppercase-2word', 'natural', 'verbatim']);
  let subtitles = { enabled: false, style: null };
  if (edl.subtitles !== undefined) {
    if (!edl.subtitles || typeof edl.subtitles !== 'object') _err('edl.subtitles must be an object');
    const style = edl.subtitles.style || 'uppercase-2word';
    if (!KNOWN_SUB_STYLES.has(style)) _err(`edl.subtitles.style must be one of: ${Array.from(KNOWN_SUB_STYLES).join(', ')}`);
    subtitles = { enabled: !!edl.subtitles.enabled, style };
  }

  let audioFadeMs = 30;
  if (edl.audioFadeMs !== undefined) {
    if (typeof edl.audioFadeMs !== 'number' || !isFinite(edl.audioFadeMs) || edl.audioFadeMs < 0 || edl.audioFadeMs > 1000) {
      _err('edl.audioFadeMs must be a finite number in [0, 1000]');
    }
    audioFadeMs = edl.audioFadeMs;
  }

  return { version: 1, sources, segments, subtitles, audioFadeMs };
}

function load(edlPath) {
  if (!fs.existsSync(edlPath)) _err('edl file not found', edlPath);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(edlPath, 'utf8')); }
  catch (e) { _err('edl file is not valid JSON: ' + e.message); }
  return validate(raw, { sourcesBaseDir: path.dirname(path.resolve(edlPath)) });
}

module.exports = { validate, load };
