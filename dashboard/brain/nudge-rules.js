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
 *           uncommitted:{count,files}, activeRepo, activeRepoPath, intent, idle }
 *   candidate = { type, value:0..1, title, detail?, action? }
 * action.kind: 'ask' (open the palette with action.prompt), 'diff', 'open-notes'.
 *
 * Keep these few and high-signal. A nudge that is not clearly worth saying is
 * worse than silence.
 */

'use strict';

function _basenames(files, n) {
  return (files || []).slice(0, n).map(f => String(f).split(/[\\/]/).pop()).filter(Boolean);
}

// You have a pile of uncommitted work - a gentle "save your work" nudge.
function uncommittedChanges(ctx) {
  const u = (ctx && ctx.uncommitted) || {};
  if (!u.count || u.count < 6) return null;
  const repo = ctx.activeRepo || 'this project';
  const names = _basenames(u.files, 3);
  return {
    type: 'commit-reminder',
    value: Math.min(0.58 + 0.012 * u.count, 0.8),
    title: `You've got ${u.count} uncommitted changes in ${repo}. Want to review or commit them?`,
    detail: names.length
      ? `Recent edits include ${names.join(', ')}. A checkpoint or commit keeps the work safe.`
      : 'A checkpoint or commit keeps the work safe.',
    actionLabel: 'Review',
    action: { kind: 'ask', prompt: 'review my uncommitted changes' },
  };
}

// A lot has happened recently - offer to summarize where things stand. This
// leans on the broadened answer machine (conscious of notes + conversation +
// git + checkpoints), so the action actually delivers.
function offerSummary(ctx) {
  const recent = ((ctx && ctx.checkpoints) || []).length + Math.min(((ctx && ctx.git) || []).length, 6);
  if (recent < 5) return null;
  return {
    type: 'offer-summary',
    value: 0.6,
    title: "You've covered a lot of ground. Want me to summarize where things stand?",
    detail: 'I can pull together what you have been working on from your notes, our conversation, and the recent changes.',
    actionLabel: 'Summarize',
    action: { kind: 'ask', prompt: 'summarize where things stand right now' },
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
      title: `You've got unsaved work in ${repo}. Want a quick recap before you move on?`,
      actionLabel: 'Recap',
      action: { kind: 'ask', prompt: 'summarize my uncommitted changes' },
    };
  }
  if (momentum) {
    return {
      type: 'inactivity',
      value: 0.82,
      title: 'Are you out of ideas? I can suggest a sensible next step from where things stand.',
      actionLabel: 'Suggest next',
      action: { kind: 'ask', prompt: 'what should I do next' },
    };
  }
  return {
    type: 'inactivity',
    value: 0.8,
    title: 'Are you still here? I can pick up whenever you are.',
    actionLabel: 'Catch me up',
    action: { kind: 'ask', prompt: 'where did we leave off' },
  };
}

const RULES = [idleNudge, uncommittedChanges, offerSummary];

function runRules(ctx) {
  const out = [];
  for (const rule of RULES) {
    try { const c = rule(ctx); if (c && c.title) out.push(c); } catch (_) { /* a bad rule never breaks the whisper */ }
  }
  return out;
}

module.exports = { runRules, RULES, idleNudge, uncommittedChanges, offerSummary };
