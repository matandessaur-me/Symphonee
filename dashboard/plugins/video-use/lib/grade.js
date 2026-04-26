// Color grade presets. Direct port of helpers/grade.py preset block.
// Each preset is a raw ffmpeg filter chain ready to drop into -vf.

'use strict';

const PRESETS = {
  none: '',
  neutral: 'eq=contrast=1.05:saturation=1.0',
  warm: 'colortemperature=temperature=4500,eq=contrast=1.06:saturation=1.04',
  cool: 'colortemperature=temperature=7500,eq=contrast=1.04:saturation=0.98',
  cinematic: 'curves=preset=darker,eq=contrast=1.08:saturation=0.92',
  punchy: 'eq=contrast=1.12:saturation=1.10:brightness=0.02',
  flat: 'eq=contrast=0.95:saturation=0.9',
};

function getPreset(name) {
  if (!name) return '';
  if (PRESETS[name] === undefined) {
    const err = new Error(`Unknown grade preset: ${name}. Available: ${Object.keys(PRESETS).join(', ')}`);
    err.code = 'GRADE_UNKNOWN_PRESET';
    throw err;
  }
  return PRESETS[name];
}

function listPresets() { return Object.keys(PRESETS); }

// Resolve EDL `grade` field: preset name, raw filter, or null.
function resolveGrade(field) {
  if (!field) return '';
  if (field === 'auto') return PRESETS.neutral;
  if (/^[a-zA-Z0-9_\-]+$/.test(field)) {
    if (PRESETS[field] !== undefined) return PRESETS[field];
    return ''; // unknown bare token: skip rather than crash the render
  }
  return field;
}

module.exports = { PRESETS, getPreset, listPresets, resolveGrade };
