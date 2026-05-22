/**
 * Rolling latency + cache hit counters for the brain.
 *
 * Lets you answer the real question: "is the brain making Symphonee
 * slower?" with numbers, not vibes. Every faculty records a sample on
 * each invocation and the perf endpoint exposes p50 / p95 / max / n
 * over the most recent N samples per faculty.
 *
 * Implementation: a fixed-size circular buffer per faculty so memory
 * stays bounded under sustained traffic. No persistence - reset on
 * server restart. Per-faculty samples cap at SAMPLES_PER_FACULTY.
 */

'use strict';

const SAMPLES_PER_FACULTY = 200;

const _samples = new Map();   // faculty -> { buf: Float64Array, len, idx }
const _counters = new Map();  // counterName -> int

function _slot(faculty) {
  let s = _samples.get(faculty);
  if (!s) {
    s = { buf: new Float64Array(SAMPLES_PER_FACULTY), len: 0, idx: 0 };
    _samples.set(faculty, s);
  }
  return s;
}

/**
 * Record a single latency sample (in ms) for a named faculty. Cheap -
 * a single array write + counter bump.
 */
function recordLatency(faculty, ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return;
  const s = _slot(faculty);
  s.buf[s.idx] = ms;
  s.idx = (s.idx + 1) % SAMPLES_PER_FACULTY;
  if (s.len < SAMPLES_PER_FACULTY) s.len++;
}

/**
 * Bump a named counter (cache hits, cache misses, errors, etc).
 */
function bump(name, by = 1) {
  _counters.set(name, (_counters.get(name) || 0) + by);
}

function _percentile(arr, p) {
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * p));
  return arr[idx];
}

/**
 * Snapshot the current rolling stats. Computes percentiles by sorting a
 * copy of each faculty's buffer - O(n log n) per faculty per call, but
 * n is capped at SAMPLES_PER_FACULTY (200) so this is well under a
 * millisecond total.
 */
function snapshot() {
  const facilities = {};
  for (const [name, s] of _samples) {
    if (!s.len) continue;
    const arr = Array.from(s.buf.slice(0, s.len)).sort((a, b) => a - b);
    facilities[name] = {
      n: arr.length,
      p50: Math.round(_percentile(arr, 0.5) * 100) / 100,
      p95: Math.round(_percentile(arr, 0.95) * 100) / 100,
      max: Math.round(arr[arr.length - 1] * 100) / 100,
      mean: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100,
    };
  }
  const counters = Object.create(null);
  for (const [name, v] of _counters) counters[name] = v;
  return { facilities, counters, samplesPerFaculty: SAMPLES_PER_FACULTY };
}

function reset() {
  _samples.clear();
  _counters.clear();
}

module.exports = { recordLatency, bump, snapshot, reset, SAMPLES_PER_FACULTY };
