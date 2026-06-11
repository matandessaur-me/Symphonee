/**
 * Rule-based nudge engine - the reliable heart of the ambient whisper.
 *
 * The local model (qwen 1.5b) cannot be trusted to free-form genuinely helpful
 * nudges - it paraphrases commits into "do this code task". So the GOOD nudges
 * come from RULES: deterministic detectors of high-value situations, each with a
 * warm, human, ready-phrased message. The fuzzy model is only a last-resort
 * fallback (in brain/index.js) when no rule fires.
 *
 * Each rule is `(ctx) => candidate | null`, pure and side-effect free.
 *   ctx = { git:[lines], checkpoints:[labels], conversation:[{role,text}],
 *           uncommitted:{count,files}, failures:[...], successes:[...],
 *           mindNew:[...], notesEdited:[...], shownCounts:{family:n},
 *           activeRepo, activeRepoPath, intent, idle }
 *   candidate = { type, value:0..1, title, detail?, because, action?,
 *                 fingerprint?, once? }
 *
 * Anti-repetition contract (enforced by ambient.isNovel, fed from here):
 *   - `because`     - one short lowercase clause: WHY the whisper is speaking.
 *                     Rendered as provenance ("because ...") in the modal.
 *   - `fingerprint` - a stamp of the UNDERLYING STATE for standing rules. The
 *                     whisper never repeats itself while the state it described
 *                     is unchanged.
 *   - `once`        - instance rules (a specific task, a specific card) speak
 *                     exactly once, ever.
 *   - phrase pools  - rules with recurring moments rotate wording via
 *                     ctx.shownCounts so the whisper never sounds canned.
 *
 * Keep these few and high-signal. A nudge that is not clearly worth saying is
 * worse than silence.
 */

'use strict';

function _basenames(files, n) {
  return (files || []).slice(0, n).map(f => String(f).split(/[\\/]/).pop()).filter(Boolean);
}

// Deterministic phrase rotation: the Nth time a family speaks, it uses the Nth
// phrasing. Variety without randomness (testable, reproducible).
function _pick(variants, ctx, family) {
  const n = (ctx && ctx.shownCounts && ctx.shownCounts[family]) || 0;
  return variants[n % variants.length];
}

function _minutesAgo(ts) {
  if (!ts) return null;
  const m = Math.round((Date.now() - ts) / 60000);
  return m <= 1 ? 'a minute ago' : `${m} minutes ago`;
}

// You have a pile of uncommitted work - a gentle "save your work" nudge.
function uncommittedChanges(ctx) {
  const u = (ctx && ctx.uncommitted) || {};
  if (!u.count || u.count < 6) return null;
  const repo = ctx.activeRepo || 'this project';
  const names = _basenames(u.files, 3);
  const title = _pick([
    `You've got ${u.count} uncommitted changes in ${repo}. Want to review or commit them?`,
    `${repo} is carrying ${u.count} unsaved changes. Worth a checkpoint?`,
    `Quite a bit of uncommitted work has built up in ${repo} - shall we look it over?`,
  ], ctx, 'commit-reminder');
  return {
    type: 'commit-reminder',
    value: Math.min(0.58 + 0.012 * u.count, 0.8),
    title,
    detail: names.length
      ? `Recent edits include ${names.join(', ')}. A checkpoint or commit keeps the work safe.`
      : 'A checkpoint or commit keeps the work safe.',
    because: `${u.count} files have changed in ${repo} since your last commit`,
    // State stamp: repo + size bucket. The count ticking 9 -> 10 is the same
    // situation; crossing a bucket (or a different repo) is a new one.
    fingerprint: `${repo}:${Math.floor(u.count / 5)}`,
    actionLabel: 'Review',
    action: { kind: 'ask', prompt: 'review my uncommitted changes' },
  };
}

// A lot has happened recently - offer to summarize where things stand. This
// leans on the broadened answer machine (conscious of notes + conversation +
// git + checkpoints), so the action actually delivers.
function offerSummary(ctx) {
  const git = (ctx && ctx.git) || [];
  const checkpoints = (ctx && ctx.checkpoints) || [];
  const recent = checkpoints.length + Math.min(git.length, 6);
  if (recent < 5) return null;
  const title = _pick([
    "You've covered a lot of ground. Want me to summarize where things stand?",
    'A lot just moved. Want the short version of where this leaves us?',
    "Things have been busy - I can sketch the state of play if that's useful.",
  ], ctx, 'offer-summary');
  return {
    type: 'offer-summary',
    value: 0.6,
    title,
    detail: 'I can pull together what you have been working on from your notes, our conversation, and the recent changes.',
    because: `${checkpoints.length} checkpoints and ${Math.min(git.length, 6)} commits landed in the recent stretch`,
    // The latest commit line stamps the burst; no new commits = same burst.
    fingerprint: `${git[0] || ''}:${checkpoints.length}`,
    actionLabel: 'Summarize',
    action: { kind: 'ask', prompt: 'summarize where things stand right now' },
  };
}

// A dispatched CLI task just failed. Per the research, execution FAILURE is the
// one moment to speak immediately - it is high-signal and the user is in a
// debugging mindset. Phrasing adapts to the error classification so it is
// specific, not generic. Highest value of any rule so it wins the moment.
function taskFailure(ctx) {
  const f = ((ctx && ctx.failures) || [])[0];
  if (!f) return null;
  const who = f.cli && f.cli !== 'task' ? `Your ${f.cli}` : 'A dispatched';
  const c = f.classification || {};
  let reason;
  if (f.state === 'timeout') reason = 'timed out';
  else if (c.providerOut || c.transient) reason = 'hit a temporary provider issue';
  else if (c.authError) reason = 'failed on authentication';
  else if (c.flagError) reason = 'failed on a bad CLI flag';
  else if (c.modelError) reason = 'failed on the model';
  else reason = 'did not finish';
  const firstLine = (f.error || '').split('\n')[0].trim();
  const tail = firstLine ? ` (${firstLine.slice(0, 80)})` : '';
  return {
    type: 'task-failure:' + (f.id || 'x'),
    value: 0.9,
    once: true,
    title: `${who} task ${reason}${tail}. Want me to look at what went wrong?`,
    detail: f.prompt ? `The task was: "${f.prompt}". I can read the error and suggest a fix.` : 'I can read the error and suggest a fix.',
    because: `the ${f.cli && f.cli !== 'task' ? f.cli + ' ' : ''}task you dispatched ${f.state === 'timeout' ? 'timed out' : 'failed'} ${_minutesAgo(f.completedAt) || 'just now'}`,
    actionLabel: 'Diagnose',
    action: { kind: 'ask', prompt: `what went wrong with my last ${f.cli && f.cli !== 'task' ? f.cli + ' ' : ''}task and how do i fix it` },
  };
}

// A dispatched CLI task just LANDED. This is the "second mind" moment the
// whisper exists for: the work arrived, so offer the gist and the next thread
// to pull - not a reminder, a continuation. Slightly below failure (a break
// outranks a landing) but above everything else.
function taskSuccess(ctx) {
  const s = ((ctx && ctx.successes) || [])[0];
  if (!s) return null;
  const who = s.cli && s.cli !== 'task' ? `your ${s.cli}` : 'your dispatched';
  const title = _pick([
    `Nice - ${who} task just landed. Want the gist and a next step?`,
    `${who.charAt(0).toUpperCase() + who.slice(1)} task is done. I can sum it up and suggest where to take it.`,
    `That ${s.cli && s.cli !== 'task' ? s.cli + ' ' : ''}task finished. Shall I pull out what matters and draft the follow-up?`,
  ], ctx, 'task-success');
  return {
    type: 'task-success:' + (s.id || 'x'),
    value: 0.88,
    once: true,
    title,
    detail: s.prompt
      ? `The task was: "${s.prompt}". I can summarize what it produced and draft the prompt that continues it.`
      : 'I can summarize what it produced and draft the prompt that continues it.',
    because: `the ${s.cli && s.cli !== 'task' ? s.cli + ' ' : ''}task you dispatched finished ${_minutesAgo(s.completedAt) || 'just now'}`,
    actionLabel: 'Next step',
    action: { kind: 'ask', prompt: `my ${s.cli && s.cli !== 'task' ? s.cli + ' ' : ''}task just finished - give me the gist of what it produced and draft the next prompt to continue the work` },
  };
}

// The shared brain just learned something durable (a fresh memory card). Speak
// once, softly: knowledge arriving is worth a glance, not an alarm.
function mindDelta(ctx) {
  const m = ((ctx && ctx.mindNew) || [])[0];
  if (!m || !m.title) return null;
  return {
    type: 'mind-delta:' + (m.id || 'x'),
    value: 0.7,
    once: true,
    title: `Just committed to memory: "${m.title}". Want to see how it fits what you're doing?`,
    detail: 'A new card landed in the shared brain. I can connect it to your current work.',
    because: `a new ${m.kindOfMemory || 'memory'} card${m.createdBy ? ' from ' + m.createdBy : ''} landed in the shared brain`,
    actionLabel: 'Show me',
    action: { kind: 'ask', prompt: `what did you just learn - tell me about "${m.title}" and how it relates to what I am working on` },
  };
}

// The user was writing in a note recently and has now gone quiet - offer to
// pick the thread back up. Idle-only: while they are active it stays silent.
function noteRevisit(ctx) {
  if (!ctx || !ctx.idle) return null;
  const n = ((ctx && ctx.notesEdited) || [])[0];
  if (!n || !n.name) return null;
  return {
    type: 'note-revisit',
    value: 0.84,
    title: `You were writing in "${n.name}" earlier. Want to pick that thread back up?`,
    detail: 'I can summarize where the note left off and suggest how to continue it.',
    because: `you edited the note "${n.name}" ${_minutesAgo(n.editedAt) || 'recently'} and have gone quiet since`,
    fingerprint: n.name,
    actionLabel: 'Pick it up',
    action: { kind: 'ask', prompt: `summarize my note "${n.name}" and suggest how to continue it` },
  };
}

// The user has gone quiet (an explicit idle check). Say ONE context-aware thing,
// tuned to what is actually on their plate: unsaved work to recap, live momentum
// to pick a next step from, or just silence. Only fires when ctx.idle - on every
// other check it stays out of the way. High value so it wins the idle moment.
function idleNudge(ctx) {
  if (!ctx || !ctx.idle) return null;
  const repo = (ctx && ctx.activeRepo) || 'this project';
  const u = (ctx && ctx.uncommitted) || {};
  const momentum = (((ctx && ctx.git) || []).length
    + ((ctx && ctx.checkpoints) || []).length
    + ((ctx && ctx.conversation) || []).length) >= 3;
  if (u.count >= 1) {
    return {
      type: 'inactivity',
      value: 0.85,
      title: _pick([
        `You've got unsaved work in ${repo}. Want a quick recap before you move on?`,
        `Before this goes cold - there's unsaved work in ${repo}. Recap it?`,
        `${repo} still has changes in flight. Want me to walk back through them?`,
      ], ctx, 'inactivity'),
      because: `you went quiet with ${u.count} unsaved ${u.count === 1 ? 'change' : 'changes'} in ${repo}`,
      fingerprint: `unsaved:${repo}:${Math.floor(u.count / 5)}`,
      actionLabel: 'Recap',
      action: { kind: 'ask', prompt: 'summarize my uncommitted changes' },
    };
  }
  if (momentum) {
    return {
      type: 'inactivity',
      value: 0.82,
      title: _pick([
        'Are you out of ideas? I can suggest a sensible next step from where things stand.',
        'Stuck on what comes next? I have a suggestion ready if you want it.',
        'If the momentum stalled, I can point at the most sensible next move.',
      ], ctx, 'inactivity'),
      because: 'you went quiet right after a productive stretch',
      fingerprint: `momentum:${(ctx.git || [])[0] || ''}`,
      actionLabel: 'Suggest next',
      action: { kind: 'ask', prompt: 'what should I do next' },
    };
  }
  return {
    type: 'inactivity',
    value: 0.8,
    title: _pick([
      'Are you still here? I can pick up whenever you are.',
      'All quiet. Want me to catch you up on where we left off?',
      'Taking a beat? Say the word and I will pull the threads back together.',
    ], ctx, 'inactivity'),
    because: 'it has been quiet for a few minutes',
    fingerprint: 'silence',
    actionLabel: 'Catch me up',
    action: { kind: 'ask', prompt: 'where did we leave off' },
  };
}

const RULES = [taskFailure, taskSuccess, mindDelta, idleNudge, noteRevisit, uncommittedChanges, offerSummary];

function runRules(ctx) {
  const out = [];
  for (const rule of RULES) {
    try { const c = rule(ctx); if (c && c.title) out.push(c); } catch (_) { /* a bad rule never breaks the whisper */ }
  }
  return out;
}

module.exports = { runRules, RULES, taskFailure, taskSuccess, mindDelta, noteRevisit, idleNudge, uncommittedChanges, offerSummary };
