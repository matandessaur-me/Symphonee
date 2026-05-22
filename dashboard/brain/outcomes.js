/**
 * Decision outcomes - the brain's feedback loop.
 *
 * Today the brain records what it DECIDED (planner audit log) but never
 * finds out whether the decision was good. This module closes the loop:
 * callers (the user, a CLI, an automated signal) tag a decision with an
 * outcome, and the aggregate stats become a bias the planner can use on
 * future similar prompts.
 *
 * Storage: append-only JSONL at `.symphonee/outcomes.jsonl`. Records are
 * intentionally separate from the in-memory decision ring buffer because
 * outcomes are durable (we want them across restarts) while decisions
 * are ephemeral. An outcome record carries enough snapshot data
 * (intent, primaryCli) to compute stats without joining back to the
 * decision log.
 *
 * Outcome taxonomy:
 *   validated    - the decision led to a useful answer the user kept
 *   contradicted - the user later said the decision was wrong
 *   corrected    - the user re-ran with a different cli; the brain
 *                  mis-routed
 *   unused       - the answer was ignored / not saved / not acted on
 *
 * Anything more granular can be added later without breaking the file
 * format (extra keys are allowed; readers tolerate unknown fields).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VALID_OUTCOMES = new Set(['validated', 'contradicted', 'corrected', 'unused']);
const MAX_LINES_KEPT = 20_000;
const MIN_SAMPLES_FOR_STATS = 10;  // do not surface a stat with fewer samples than this

function outcomesFile(repoRoot) {
  return path.join(repoRoot, '.symphonee', 'outcomes.jsonl');
}
function ensureDir(file) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
}
function _safeStr(v, max = 200) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Record an outcome. The snapshot { intent, primaryCli } is captured at
 * outcome-record time so stats can be computed even after the decision
 * has aged out of the in-memory ring buffer.
 *
 * @param repoRoot      absolute path
 * @param decisionId    string id from the audit log (may be null)
 * @param outcome       one of VALID_OUTCOMES
 * @param snapshot      { intent, primaryCli, detail? }
 * @returns true if recorded, false if outcome is invalid
 */
function recordOutcome(repoRoot, decisionId, outcome, snapshot = {}) {
  if (!VALID_OUTCOMES.has(outcome)) return false;
  const file = outcomesFile(repoRoot);
  ensureDir(file);
  const record = {
    ts: Date.now(),
    decisionId: _safeStr(decisionId, 64),
    outcome,
    intent: _safeStr(snapshot.intent, 64),
    primaryCli: _safeStr(snapshot.primaryCli, 32),
    detail: _safeStr(snapshot.detail, 300),
  };
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Load all outcome records, ascending by ts. Tolerates partial / malformed
 * lines.
 */
function readOutcomes(repoRoot, { sinceMs = null, untilMs = null } = {}) {
  const file = outcomesFile(repoRoot);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (typeof rec.ts !== 'number') continue;
      if (!VALID_OUTCOMES.has(rec.outcome)) continue;
      if (sinceMs && rec.ts < sinceMs) continue;
      if (untilMs && rec.ts > untilMs) continue;
      out.push(rec);
    } catch (_) { /* skip */ }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Aggregate stats. Returns four views over the outcome stream:
 *
 *   total         - { validated, contradicted, corrected, unused, n }
 *   byIntent      - { [intent]: { ..._counts..., validatedRate, n } }
 *   byCli         - { [cli]:    { ..._counts..., validatedRate, n } }
 *   byIntentCli   - { [intent]: { [cli]: { ..._counts..., validatedRate, n } } }
 *
 * Only buckets with n >= MIN_SAMPLES_FOR_STATS get a `validatedRate`. Buckets
 * with fewer samples still appear in the counts but rate is null - too few
 * data points to bias anything on.
 */
function getStats(repoRoot, opts = {}) {
  const records = readOutcomes(repoRoot, opts);
  const total = { validated: 0, contradicted: 0, corrected: 0, unused: 0, n: 0 };
  const byIntent = Object.create(null);
  const byCli = Object.create(null);
  const byIntentCli = Object.create(null);

  function _bucket() { return { validated: 0, contradicted: 0, corrected: 0, unused: 0, n: 0 }; }
  function _rate(b) {
    if (b.n < MIN_SAMPLES_FOR_STATS) return null;
    return Math.round((b.validated / b.n) * 1000) / 1000;
  }

  for (const r of records) {
    total[r.outcome] += 1;
    total.n += 1;
    if (r.intent) {
      const b = byIntent[r.intent] || (byIntent[r.intent] = _bucket());
      b[r.outcome] += 1;
      b.n += 1;
    }
    if (r.primaryCli) {
      const b = byCli[r.primaryCli] || (byCli[r.primaryCli] = _bucket());
      b[r.outcome] += 1;
      b.n += 1;
    }
    if (r.intent && r.primaryCli) {
      const intentRow = byIntentCli[r.intent] || (byIntentCli[r.intent] = Object.create(null));
      const b = intentRow[r.primaryCli] || (intentRow[r.primaryCli] = _bucket());
      b[r.outcome] += 1;
      b.n += 1;
    }
  }

  // attach rates
  for (const k of Object.keys(byIntent)) byIntent[k].validatedRate = _rate(byIntent[k]);
  for (const k of Object.keys(byCli)) byCli[k].validatedRate = _rate(byCli[k]);
  for (const intent of Object.keys(byIntentCli)) {
    for (const cli of Object.keys(byIntentCli[intent])) {
      byIntentCli[intent][cli].validatedRate = _rate(byIntentCli[intent][cli]);
    }
  }

  return { total, byIntent, byCli, byIntentCli };
}

/**
 * For a given intent, return the historically best-performing CLI (the
 * one with the highest validatedRate) if and only if there is enough
 * sample data. Returns null otherwise. The planner uses this to bias
 * its triage prompt.
 *
 * Tie-break: highest n wins (more evidence > slightly higher rate on
 * thin data).
 */
function bestCliFor(stats, intent) {
  if (!stats || !stats.byIntentCli || !stats.byIntentCli[intent]) return null;
  const candidates = Object.entries(stats.byIntentCli[intent])
    .filter(([, b]) => b.validatedRate !== null)
    .sort((a, b) => {
      if (b[1].validatedRate !== a[1].validatedRate) return b[1].validatedRate - a[1].validatedRate;
      return b[1].n - a[1].n;
    });
  if (!candidates.length) return null;
  const [cli, bucket] = candidates[0];
  return {
    cli,
    validatedRate: bucket.validatedRate,
    n: bucket.n,
    validated: bucket.validated,
  };
}

/**
 * Build a short, advisory hint line the planner can splice into its
 * system prompt. Empty string if nothing useful to surface yet.
 *
 * Example output:
 *   "Historical note: codex has 8/10 validated outcomes on code-action."
 */
function buildPromptHint(stats, intent) {
  const best = bestCliFor(stats, intent);
  if (!best) return '';
  const pct = Math.round(best.validatedRate * 100);
  return `Historical note: ${best.cli} has ${best.validated}/${best.n} validated outcomes (${pct}%) on ${intent} tasks. Use this as a tiebreaker, not a hard rule.`;
}

/**
 * Prune outcomes older than `olderThanDays`. Read-rewrite cycle.
 */
function pruneOld(repoRoot, { olderThanDays = 180, maxLines = MAX_LINES_KEPT } = {}) {
  const file = outcomesFile(repoRoot);
  if (!fs.existsSync(file)) return { kept: 0, dropped: 0 };
  const sinceMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const all = readOutcomes(repoRoot, {});
  const kept = all.filter(r => r.ts >= sinceMs).slice(-maxLines);
  const dropped = all.length - kept.length;
  const next = kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '');
  fs.writeFileSync(file, next, 'utf8');
  return { kept: kept.length, dropped };
}

module.exports = {
  VALID_OUTCOMES,
  MIN_SAMPLES_FOR_STATS,
  outcomesFile,
  recordOutcome,
  readOutcomes,
  getStats,
  bestCliFor,
  buildPromptHint,
  pruneOld,
};
