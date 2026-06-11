/**
 * The ambient observer - the whisper's brain, kept alive WITHOUT a face.
 *
 * The pill UI is gone (user decision), but its core insight survives: the
 * context bus (commits, finished tasks, edited notes) is high-signal primary
 * activity. This module watches that bus in the background and periodically
 * distills what ACTUALLY happened into a compact activity digest saved to
 * Mind (an obs_ conversation node). The payoff is consciousness, not chrome:
 * "what did I do today?" answers from real dated digests; every CLI inherits
 * the same picture of the day.
 *
 * Rules-first and deterministic - no LLM, no prose. Quiet by design:
 *   - a digest only forms when at least MIN_EVENTS new things happened
 *     since the last one, and never more than one per MIN_GAP_MS
 *   - it records DELTAS (new commits, newly finished tasks, newly edited
 *     notes), never restates standing state
 *   - state survives restarts in .symphonee/observer.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIN_EVENTS = 2;                        // fewer than this is not a story
const MIN_GAP_MS = 30 * 60 * 1000;           // at most one digest per 30 min
const DEFAULT_TICK_MS = 10 * 60 * 1000;      // how often we look

function _stateFile(repoRoot) { return path.join(repoRoot, '.symphonee', 'observer.json'); }

function loadState(repoRoot) {
  try {
    const s = JSON.parse(fs.readFileSync(_stateFile(repoRoot), 'utf8'));
    return { lastAt: 0, headLine: null, taskIds: [], noteStamps: {}, ...s };
  } catch (_) { return { lastAt: 0, headLine: null, taskIds: [], noteStamps: {} }; }
}

function saveState(repoRoot, state) {
  const file = _stateFile(repoRoot);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
  try {
    fs.writeFileSync(file, JSON.stringify({
      lastAt: state.lastAt || 0,
      headLine: state.headLine || null,
      taskIds: (state.taskIds || []).slice(-50),
      noteStamps: state.noteStamps || {},
    }, null, 2), 'utf8');
  } catch (_) { /* best effort */ }
}

/**
 * Pure: compare the live context bus against the last digest's state and
 * compose the next digest. Returns { title, body, state } or null when not
 * enough genuinely NEW activity happened.
 */
function composeDigest(ctx, prev, now = Date.now()) {
  prev = prev || { lastAt: 0, headLine: null, taskIds: [], noteStamps: {} };
  if (now - (prev.lastAt || 0) < MIN_GAP_MS) return null;

  const lines = [];
  let events = 0;

  // Commits: only when the head moved since the last digest. The git lines
  // carry relative ages, so the digest stays self-describing.
  const git = (ctx && ctx.git) || [];
  const headLine = git[0] || null;
  if (headLine && headLine !== prev.headLine) {
    const fresh = [];
    for (const l of git) {
      if (l === prev.headLine) break;       // everything below was already digested
      fresh.push(l);
    }
    if (fresh.length) {
      lines.push('Commits: ' + fresh.slice(0, 6).map(l => String(l).trim()).join(' | '));
      events += fresh.length;
    }
  }

  // Tasks: completions/failures we have not digested before.
  const seen = new Set(prev.taskIds || []);
  const doneTasks = [];
  for (const s of (ctx && ctx.successes) || []) {
    if (s.id && !seen.has(s.id)) doneTasks.push(`${s.cli || 'task'} completed${s.prompt ? ': ' + s.prompt.slice(0, 90) : ''}`);
  }
  for (const f of (ctx && ctx.failures) || []) {
    if (f.id && !seen.has(f.id)) doneTasks.push(`${f.cli || 'task'} ${f.state || 'failed'}${f.prompt ? ': ' + f.prompt.slice(0, 90) : ''}`);
  }
  if (doneTasks.length) {
    lines.push('Tasks: ' + doneTasks.join(' | '));
    events += doneTasks.length;
  }

  // Notes: edited since their last digested stamp.
  const stamps = { ...(prev.noteStamps || {}) };
  const editedNotes = [];
  for (const n of (ctx && ctx.notesEdited) || []) {
    if (!n || !n.name) continue;
    if (!stamps[n.name] || n.editedAt > stamps[n.name]) {
      editedNotes.push(n.name);
      stamps[n.name] = n.editedAt;
    }
  }
  if (editedNotes.length) {
    lines.push('Notes edited: ' + editedNotes.join(', '));
    events += editedNotes.length;
  }

  if (events < MIN_EVENTS || !lines.length) return null;

  const d = new Date(now);
  const title = `Activity digest - ${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const repo = (ctx && ctx.activeRepo) ? `Repo: ${ctx.activeRepo}\n` : '';
  return {
    title,
    body: repo + lines.join('\n'),
    state: {
      lastAt: now,
      headLine: headLine || prev.headLine,
      taskIds: [
        ...(prev.taskIds || []),
        ...((ctx && ctx.successes) || []).map(s => s.id),
        ...((ctx && ctx.failures) || []).map(f => f.id),
      ].filter(Boolean).slice(-50),
      noteStamps: stamps,
    },
  };
}

/**
 * Start the background loop. Deps are injected so the module stays testable:
 *   gather() -> Promise<ctx>   (the whisper's context bus)
 *   save({title, body, tags})  (mind.saveObservation)
 * Returns { stop, tick } - tick is exposed for tests/manual runs.
 */
function start({ repoRoot, gather, save, intervalMs = DEFAULT_TICK_MS } = {}) {
  if (!repoRoot || typeof gather !== 'function' || typeof save !== 'function') {
    return { stop() {}, tick: async () => null };
  }
  let running = false;
  async function tick() {
    if (running) return null;
    running = true;
    try {
      const ctx = await gather();
      const prev = loadState(repoRoot);
      const digest = composeDigest(ctx, prev);
      if (!digest) return null;
      const id = save({ title: digest.title, body: digest.body, tags: ['activity', ctx && ctx.activeRepo].filter(Boolean) });
      if (id) saveState(repoRoot, digest.state);
      return id || null;
    } catch (_) {
      return null;   // the observer never breaks the host
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();             // never keep the process alive
  // first look ~90s after boot so a fresh session's activity lands early
  const first = setTimeout(tick, 90 * 1000);
  if (first.unref) first.unref();
  return { stop: () => { clearInterval(timer); clearTimeout(first); }, tick };
}

module.exports = { composeDigest, loadState, saveState, start, MIN_EVENTS, MIN_GAP_MS };
