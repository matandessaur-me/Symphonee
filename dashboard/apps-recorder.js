// Apps Recorder - capture raw mouse + keyboard input against a specific
// window and translate the captured event stream into a recipe DSL draft.
//
// The capture side is a PowerShell helper (scripts/record-input.ps1) that
// polls GetAsyncKeyState / GetCursorPos at 60Hz and emits JSON-lines on
// stdout. This module spawns one helper per recording session, buffers its
// events in memory, and exposes:
//
//   startRecording({ hwnd }) -> { recordingId, capture }
//   stopRecording({ recordingId })  -> { events, captureRect, durationMs }
//   eventsToRecipe({ events, captureRect, name? }) -> draft recipe
//
// Only one recording at a time (matches the single-session model elsewhere).

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'scripts', 'record-input.ps1');
const MAX_EVENTS = 5000;
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 min guardrail

let current = null; // { id, hwnd, proc, events, startedAt, captureRect, buffer, autoStopTimer }

function nowId() {
  return 'rec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getActive() { return current; }

async function startRecording({ hwnd, onAutoStop }) {
  if (current) throw new Error('a recording is already in progress');
  if (hwnd == null) throw new Error('hwnd is required');
  const id = nowId();
  const proc = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-File', SCRIPT_PATH,
    '-Hwnd', String(hwnd),
  ], { windowsHide: true });

  const state = {
    id,
    hwnd,
    proc,
    events: [],
    captureRect: null,
    startedAt: Date.now(),
    buffer: '',
    autoStopTimer: null,
    errors: [],
    onAutoStop: typeof onAutoStop === 'function' ? onAutoStop : null,
  };
  current = state;

  proc.stdout.on('data', (chunk) => {
    state.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, nl).trim();
      state.buffer = state.buffer.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.type === 'start' && ev.rect) {
        state.captureRect = { w: ev.rect.w, h: ev.rect.h };
        continue;
      }
      if (ev.type === 'end') {
        state.endedReason = ev.reason || 'stopped';
        continue;
      }
      if (ev.type === 'error') {
        state.errors.push(ev.message || 'recorder error');
        continue;
      }
      if (state.events.length < MAX_EVENTS) {
        state.events.push(ev);
      } else if (!state.cappedNotified) {
        state.cappedNotified = true;
        state.errors.push('event cap (' + MAX_EVENTS + ') reached; later input dropped');
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    state.errors.push(chunk.toString('utf8').slice(0, 200));
  });
  proc.on('close', () => {
    state.closed = true;
    // If the PS process exited on its own (user hit Ctrl+Shift+Q, or the
    // target window closed) while we are still the `current` recording,
    // notify the caller so the UI can auto-stop instead of leaving the
    // user clicking a stale Stop button.
    if (current === state && typeof state.onAutoStop === 'function') {
      try { state.onAutoStop({ recordingId: state.id, reason: state.endedReason || 'proc-exit' }); } catch (_) {}
    }
  });

  state.autoStopTimer = setTimeout(() => {
    try { proc.kill(); } catch (_) {}
    state.endedReason = state.endedReason || 'auto-stop (30 min)';
  }, MAX_DURATION_MS);

  // Give the PS process a beat to emit the capture-rect start event.
  await new Promise(r => setTimeout(r, 250));
  if (state.errors.length && !state.captureRect) {
    try { proc.kill(); } catch (_) {}
    current = null;
    throw new Error('recorder failed to start: ' + state.errors.join('; '));
  }
  return { recordingId: id, captureRect: state.captureRect || null };
}

async function stopRecording({ recordingId } = {}) {
  if (!current) throw new Error('no recording in progress');
  if (recordingId && current.id !== recordingId) throw new Error('recordingId mismatch');
  const state = current;
  current = null;
  if (state.autoStopTimer) { clearTimeout(state.autoStopTimer); state.autoStopTimer = null; }
  try { state.proc.kill(); } catch (_) {}
  await new Promise(r => {
    if (state.closed) return r();
    state.proc.once('close', r);
    setTimeout(r, 500);
  });
  return {
    recordingId: state.id,
    events: state.events.slice(),
    captureRect: state.captureRect,
    durationMs: Date.now() - state.startedAt,
    reason: state.endedReason || 'user-stop',
    errors: state.errors,
  };
}

// Timing between events is preserved as explicit WAIT steps, coarsened to the
// nearest 100ms so a 1.2s idle becomes WAIT 1200 rather than a stream of tiny
// waits.
function eventsToRecipe({ events, captureRect, name, description }) {
  const steps = [];
  const printableBuffer = []; // accumulate chars into a single TYPE step
  let lastTs = null;

  const flushType = () => {
    if (!printableBuffer.length) return;
    steps.push({ verb: 'TYPE', target: '', text: printableBuffer.join('') });
    printableBuffer.length = 0;
  };

  const pushGapWait = (ts) => {
    if (lastTs == null) return;
    const gap = ts - lastTs;
    // Only emit a WAIT when the pause is meaningful (>150ms) and bucket to the
    // nearest 100ms so the recipe is readable.
    if (gap >= 150) {
      flushType();
      const rounded = Math.min(10000, Math.round(gap / 100) * 100);
      steps.push({ verb: 'WAIT', target: String(rounded), text: '' });
    }
  };

  // When the recorder probed a UIA selector at click time, emit the step
  // with that selector instead of raw x,y. Survives resizes and costs no
  // vision tokens. Raw coords remain as a fallback comment in step.notes.
  // UIA target stashes raw coords alongside the selector so the runner can
  // fall back to a scaled coord click if the selector misses at playback.
  const uiaStepTarget = (selector, x, y) => JSON.stringify({ uia: selector, xy: x + ',' + y });
  const uiaDragTarget = (selector, x, y) => JSON.stringify({ uia: selector, xy: x + ',' + y });

  for (const ev of events) {
    const ts = ev.ts || Date.now();
    pushGapWait(ts);
    if (ev.type === 'click') {
      flushType();
      if (ev.button === 'left') {
        if (ev.uia) {
          const note = 'UIA: ' + (ev.uiaName || ev.uia.id || '?') + (ev.uiaType ? ' (' + ev.uiaType + ')' : '') + ' @' + ev.x + ',' + ev.y;
          steps.push({ verb: 'CLICK', target: uiaStepTarget(ev.uia, ev.x, ev.y), text: '', notes: note });
        } else {
          steps.push({ verb: 'CLICK', target: `${ev.x},${ev.y}`, text: '', notes: 'recorded click' });
        }
      } else if (ev.button === 'right') {
        steps.push({ verb: 'RIGHT_CLICK', target: `${ev.x},${ev.y}`, text: '', notes: 'recorded right-click' });
      } else {
        steps.push({ verb: 'WAIT', target: '100', text: '', notes: `skipped ${ev.button}-click at ${ev.x},${ev.y}` });
      }
    } else if (ev.type === 'drag') {
      flushType();
      if (ev.button === 'left') {
        const from = ev.uiaFrom ? uiaDragTarget(ev.uiaFrom, ev.fromX, ev.fromY) : `${ev.fromX},${ev.fromY}`;
        const to = ev.uiaTo ? uiaDragTarget(ev.uiaTo, ev.toX, ev.toY) : `${ev.toX},${ev.toY}`;
        const bits = [];
        if (ev.uiaFromName || ev.uiaToName) bits.push('UIA: ' + (ev.uiaFromName || '?') + ' -> ' + (ev.uiaToName || '?'));
        steps.push({ verb: 'DRAG', target: from, text: to, notes: bits.length ? bits.join(' ') : 'recorded drag' });
      }
    } else if (ev.type === 'key') {
      // Combos (Ctrl/Alt/Meta + key, or a named non-printable) become PRESS.
      // Plain printable characters coalesce into a single TYPE step.
      const hasModifier = ev.ctrl || ev.alt || ev.meta;
      const named = ev.name;
      if (named || hasModifier) {
        flushType();
        const parts = [];
        if (ev.ctrl) parts.push('Ctrl');
        if (ev.alt) parts.push('Alt');
        if (ev.shift && (named || hasModifier)) parts.push('Shift');
        if (ev.meta) parts.push('Meta');
        parts.push(named || (ev.char != null ? ev.char : ('VK_' + ev.vk)));
        steps.push({ verb: 'PRESS', target: parts.join('+'), text: '', notes: 'recorded key' });
      } else if (ev.char != null) {
        printableBuffer.push(ev.char);
      }
    }
    lastTs = ts;
  }
  flushType();

  // Collapse adjacent WAIT steps (happens when we skipped non-emitting events
  // but still recorded their gaps).
  const collapsed = [];
  for (const s of steps) {
    const prev = collapsed[collapsed.length - 1];
    if (s.verb === 'WAIT' && prev && prev.verb === 'WAIT') {
      const sum = (parseInt(prev.target, 10) || 0) + (parseInt(s.target, 10) || 0);
      prev.target = String(Math.min(10000, sum));
    } else {
      collapsed.push(s);
    }
  }

  return {
    name: name || ('Recording ' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)),
    description: description || 'Captured via the Automations recorder. Review and refine before saving.',
    captureRect: captureRect || null,
    variables: {},
    inputs: [],
    steps: collapsed,
  };
}

module.exports = {
  startRecording,
  stopRecording,
  eventsToRecipe,
  getActive,
};
