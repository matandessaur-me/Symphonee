/**
 * Persistent override for the planner's routing-rules block.
 *
 * The planner's system prompt has two parts:
 *   - structural framing (output schema, JSON rules) - hard-coded in
 *     planner.js. Never edited at runtime; changes here would break
 *     downstream JSON parsing.
 *   - editable rules - the "CLI selection rules" + "Confidence rules"
 *     section. This module owns the editable half and can swap it
 *     based on what the user (or self-iteration) decided.
 *
 * Storage: `.symphonee/planner-rules.md` if present, otherwise the
 * DEFAULT_RULES baked in below. History at
 * `.symphonee/planner-rules-history.jsonl` so we can revert.
 *
 * Plain-text content (not JSON) so the user can hand-edit if they want.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RULES_FILE_NAME = 'planner-rules.md';
const HISTORY_FILE_NAME = 'planner-rules-history.jsonl';
const MAX_HISTORY_LINES = 200;

// The default rules block. If the override file is missing or unreadable,
// this is what the planner uses. Any edit to this constant requires a
// version bump in DEFAULT_VERSION so the planner audit log knows which
// generation produced a given decision.
const DEFAULT_VERSION = 'v1';
const DEFAULT_RULES = [
  'CLI selection rules - follow these strictly:',
  '  - Use "none" ONLY for: pure greetings, trivial acknowledgements, or',
  '    questions that can be answered from memory (recall) alone.',
  '  - For code-question, code-action, plan, or browse-files intents,',
  '    you MUST pick a real CLI - never "none". Default: "claude-code".',
  '  - Prefer "codex" for SQL, schema changes, refactors, or test writing.',
  '  - Prefer "gemini" for long-context analysis (large docs, many files).',
  '  - Prefer "grok" only for quick summaries or off-the-cuff takes.',
  '  - When in doubt for any non-trivial task, pick "claude-code".',
  '',
  'Confidence rules:',
  '  - Only return confidence >= 0.7 when you are SURE about both intent AND primary_cli.',
  '  - If the intent is clear but the CLI is uncertain, return confidence < 0.7.',
  '  - High confidence with primary_cli="none" on a non-trivial task is a contradiction - lower the confidence.',
].join('\n');

function _rulesFile(repoRoot) {
  return path.join(repoRoot, '.symphonee', RULES_FILE_NAME);
}
function _historyFile(repoRoot) {
  return path.join(repoRoot, '.symphonee', HISTORY_FILE_NAME);
}
function _ensureDir(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) { /* exists */ }
}

/**
 * Load the active rules. Returns { rules, source, version } where:
 *   source = 'override' if loaded from disk, 'default' otherwise
 *   version is 'override' or DEFAULT_VERSION
 */
function loadRules(repoRoot) {
  const file = _rulesFile(repoRoot);
  if (fs.existsSync(file)) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        return { rules: trimmed, source: 'override', version: 'override' };
      }
    } catch (_) { /* fall through to default */ }
  }
  return { rules: DEFAULT_RULES, source: 'default', version: DEFAULT_VERSION };
}

/**
 * Write a new rules override. Appends the PREVIOUS state to history so we
 * can revert. Returns { ok, previous, file }.
 *
 * source param tags the history entry so we can tell apart manual edits
 * from self-iteration applies.
 */
function saveRules(repoRoot, newRules, { source = 'manual', note = null } = {}) {
  if (typeof newRules !== 'string' || !newRules.trim()) {
    return { ok: false, error: 'rules must be a non-empty string' };
  }
  const file = _rulesFile(repoRoot);
  const history = _historyFile(repoRoot);
  _ensureDir(file);
  const previous = loadRules(repoRoot);
  // append the previous state to history before overwriting
  const histRecord = {
    ts: Date.now(),
    previousSource: previous.source,
    previousRules: previous.rules,
    nextSource: source,
    note,
  };
  try {
    fs.appendFileSync(history, JSON.stringify(histRecord) + '\n', 'utf8');
  } catch (_) { /* non-fatal */ }
  // trim history if it grows past the cap
  try {
    if (fs.existsSync(history)) {
      const lines = fs.readFileSync(history, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_HISTORY_LINES) {
        const trimmed = lines.slice(-MAX_HISTORY_LINES).join('\n') + '\n';
        fs.writeFileSync(history, trimmed, 'utf8');
      }
    }
  } catch (_) { /* non-fatal */ }
  fs.writeFileSync(file, newRules.trim() + '\n', 'utf8');
  return { ok: true, previous: previous.rules, file };
}

/**
 * Revert to the previous override (or to the default if there is no
 * history). Returns { ok, revertedTo, source }.
 */
function revertRules(repoRoot) {
  const history = _historyFile(repoRoot);
  const file = _rulesFile(repoRoot);
  if (!fs.existsSync(history)) {
    // no history - just delete the override so we fall back to default
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch (_) { /* swallow */ }
    }
    return { ok: true, source: 'default', revertedTo: DEFAULT_RULES };
  }
  const lines = fs.readFileSync(history, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) {
    if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch (_) {} }
    return { ok: true, source: 'default', revertedTo: DEFAULT_RULES };
  }
  // The LAST history entry holds the state we were in before the most
  // recent saveRules. Use its previousRules.
  let last;
  try { last = JSON.parse(lines[lines.length - 1]); } catch (_) { last = null; }
  if (!last || !last.previousRules) {
    if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch (_) {} }
    return { ok: true, source: 'default', revertedTo: DEFAULT_RULES };
  }
  // Pop that history entry by rewriting without it.
  const remaining = lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : '');
  try { fs.writeFileSync(history, remaining, 'utf8'); } catch (_) { /* non-fatal */ }
  if (last.previousSource === 'default') {
    if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch (_) {} }
    return { ok: true, source: 'default', revertedTo: DEFAULT_RULES };
  }
  fs.writeFileSync(file, last.previousRules.trim() + '\n', 'utf8');
  return { ok: true, source: 'override', revertedTo: last.previousRules };
}

function readHistory(repoRoot, { limit = 20 } = {}) {
  const history = _historyFile(repoRoot);
  if (!fs.existsSync(history)) return [];
  const lines = fs.readFileSync(history, 'utf8').split('\n').filter(Boolean);
  const safeLimit = Math.max(1, Math.min(200, limit));
  return lines.slice(-safeLimit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).reverse();
}

module.exports = {
  DEFAULT_RULES,
  DEFAULT_VERSION,
  loadRules,
  saveRules,
  revertRules,
  readHistory,
  _rulesFile,
  _historyFile,
};
