/**
 * Workflow synthesis - propose recipes from observed action shapes.
 *
 * Inputs:  recent sessions (built from `.symphonee/sequences.jsonl`).
 * Outputs: an array of draft recipes (one per mature cluster), each
 *          formatted as markdown with frontmatter so the user can
 *          accept it by dropping it into `recipes/`.
 *
 * Pipeline:
 *   1. cluster recent sessions by shape similarity (see sequences.js)
 *   2. for each cluster with count >= MIN_CLUSTER_SIZE, ask gemma4:26b
 *      to draft a recipe describing the workflow
 *   3. dedupe drafts against existing recipe slugs so we don't propose
 *      the same workflow twice
 *
 * No autonomous triggering. The brain offers /api/symphonee/synthesize
 * as an explicit endpoint. The user (or a future scheduler) decides
 * when to run synthesis.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const llm = require('../mind/llm');
const sequences = require('./sequences');

const MIN_CLUSTER_SIZE = 3;       // cluster must have N sessions before drafting
const MIN_SESSION_EVENTS = 3;     // skip tiny sessions ("opened one file")
const MAX_DRAFTS_PER_RUN = 5;     // protect gemma from a runaway pass
const REASONING_MODEL = process.env.SYMPHONEE_REASONING_MODEL || 'gemma4:26b';

function _existingRecipeSlugs(repoRoot) {
  const dir = path.join(repoRoot, 'recipes');
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/i, '').toLowerCase())
  );
}

function _summarizeCluster(cluster) {
  // Compress the cluster into a small, deterministic description gemma
  // can reason about. We sort events by frequency so the most-touched
  // shape leads.
  const tokenCount = new Map();
  const fileCount = new Map();
  const kindCount = new Map();
  for (const sess of cluster.sessions) {
    for (const ev of sess.events) {
      const tok = `${ev.kind}:${ev.file || ''}`;
      tokenCount.set(tok, (tokenCount.get(tok) || 0) + 1);
      if (ev.file) fileCount.set(ev.file, (fileCount.get(ev.file) || 0) + 1);
      kindCount.set(ev.kind, (kindCount.get(ev.kind) || 0) + 1);
    }
  }
  const topFiles = [...fileCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([file, n]) => `${file} (x${n})`);
  const kindMix = [...kindCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`);
  const repos = [...new Set(cluster.sessions.map(s => s.repo).filter(Boolean))];
  const exampleSession = cluster.sessions[0];
  const exampleSequence = exampleSession
    ? exampleSession.events.slice(0, 12).map(e => `${e.kind} ${e.file || ''}`.trim())
    : [];
  return {
    occurrences: cluster.count,
    repos,
    topFiles,
    kindMix,
    exampleSequence,
  };
}

function _buildSynthesisMessages(summary) {
  const sys = [
    'You are Symphonee proposing a new recipe for the user.',
    'A recipe is a short markdown document with YAML frontmatter that',
    'captures a repeated workflow you have observed.',
    '',
    'You will be given:',
    '  - how many times the workflow recurred',
    '  - which repos it appeared in',
    '  - the files most often touched',
    '  - the kind mix (file-change vs qa-saved vs git-event etc.)',
    '  - one example ordered sequence',
    '',
    'Return strict JSON with these keys:',
    '  slug:        short-kebab-case identifier (lowercase, no spaces)',
    '  name:        2-5 word human title',
    '  description: one sentence describing what the workflow does',
    '  icon:        a lucide icon name (default "workflow")',
    '  steps:       array of 3-7 short imperative bullets',
    '  rationale:   one sentence explaining why this is worth a recipe',
    '',
    'Rules:',
    '  - Steps must reference real concrete files/actions from the input.',
    '  - Do NOT invent files or commands not present in the input.',
    '  - If the workflow looks trivial (one file edit + commit), return',
    '    slug = null - we will skip drafting a recipe for it.',
    '  - Plain ASCII only. No emojis, em dashes, smart quotes.',
  ].join('\n');
  const user = [
    `Occurrences: ${summary.occurrences}`,
    `Repos: ${summary.repos.join(', ') || '(none specified)'}`,
    '',
    'Top files touched:',
    ...summary.topFiles.map(f => '  - ' + f),
    '',
    'Event-kind mix:',
    '  ' + (summary.kindMix.join(', ') || '(empty)'),
    '',
    'Example session (oldest to newest):',
    ...summary.exampleSequence.map(s => '  - ' + s),
    '',
    'Draft the recipe JSON now.',
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

function _draftToMarkdown(draft) {
  if (!draft || !draft.slug) return null;
  const safeIcon = String(draft.icon || 'workflow').slice(0, 32);
  const safeName = String(draft.name || draft.slug).slice(0, 80);
  const safeDesc = String(draft.description || '').slice(0, 280);
  const steps = Array.isArray(draft.steps) ? draft.steps.slice(0, 8) : [];
  const lines = [
    '---',
    'name: ' + safeName,
    'description: ' + safeDesc,
    'icon: ' + safeIcon,
    'intent: quick-summary',
    'mode: edit',
    'source: brain/synthesize',
    '---',
    '',
    'Workflow proposed by Symphonee after observing it repeat in your sessions.',
    '',
    'Steps:',
    '',
    ...steps.map((s, i) => `${i + 1}. ${String(s).slice(0, 280)}`),
    '',
    draft.rationale ? '> ' + String(draft.rationale).slice(0, 280) : '',
    '',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Main entry. Reads sessions, clusters, drafts a recipe per mature cluster.
 * Returns { drafts: [...], inspected, clustered, skipped }.
 *
 * Options:
 *   days             - look-back window (default 30)
 *   minClusterSize   - minimum sessions in a cluster (default 3)
 *   maxDrafts        - cap on how many drafts we generate this pass
 *   model            - LLM model id (default REASONING_MODEL)
 */
async function synthesize(repoRoot, opts = {}) {
  const {
    days = 30,
    minClusterSize = MIN_CLUSTER_SIZE,
    maxDrafts = MAX_DRAFTS_PER_RUN,
    model = REASONING_MODEL,
  } = opts;

  const sessions = sequences.getRecentSessions(repoRoot, { days });
  if (!sessions.length) {
    return { drafts: [], inspected: 0, clustered: 0, skipped: 0, reason: 'no sessions' };
  }
  const clusters = sequences.clusterSessions(sessions, {
    threshold: 0.5,
    minClusterSize,
    minSessionEvents: MIN_SESSION_EVENTS,
  });
  if (!clusters.length) {
    return { drafts: [], inspected: sessions.length, clustered: 0, skipped: 0, reason: 'no mature clusters' };
  }

  const existing = _existingRecipeSlugs(repoRoot);
  const drafts = [];
  let skipped = 0;

  for (const cluster of clusters.slice(0, maxDrafts)) {
    const summary = _summarizeCluster(cluster);
    const messages = _buildSynthesisMessages(summary);
    let draft = null;
    try {
      const r = await llm.chatOllama(messages, { model, format: 'json', timeoutMs: 90000 });
      draft = r.json;
    } catch (err) {
      drafts.push({
        clusterId: cluster.id,
        ok: false,
        error: err.message,
        summary,
      });
      continue;
    }
    if (!draft || !draft.slug) {
      skipped += 1;
      drafts.push({
        clusterId: cluster.id,
        ok: false,
        reason: 'model declined (workflow too trivial)',
        summary,
      });
      continue;
    }
    const slugLower = String(draft.slug).toLowerCase();
    if (existing.has(slugLower)) {
      skipped += 1;
      drafts.push({
        clusterId: cluster.id,
        ok: false,
        reason: `recipe "${slugLower}" already exists`,
        summary,
        draft,
      });
      continue;
    }
    drafts.push({
      clusterId: cluster.id,
      ok: true,
      occurrences: cluster.count,
      slug: slugLower,
      draft,
      markdown: _draftToMarkdown(draft),
      summary,
    });
  }

  return {
    drafts,
    inspected: sessions.length,
    clustered: clusters.length,
    skipped,
  };
}

/**
 * Accept a draft - write the markdown to recipes/<slug>.md. Returns the
 * absolute path. Fails (returns null) if the file already exists - we
 * never overwrite a user-authored recipe.
 */
function acceptDraft(repoRoot, draft) {
  if (!draft || !draft.ok || !draft.slug || !draft.markdown) return null;
  const recipesDir = path.join(repoRoot, 'recipes');
  try { fs.mkdirSync(recipesDir, { recursive: true }); } catch (_) { /* exists */ }
  const file = path.join(recipesDir, draft.slug + '.md');
  if (fs.existsSync(file)) return null;
  fs.writeFileSync(file, draft.markdown, 'utf8');
  return file;
}

module.exports = {
  synthesize,
  acceptDraft,
  // exports for tests
  _summarizeCluster,
  _buildSynthesisMessages,
  _draftToMarkdown,
  MIN_CLUSTER_SIZE,
};
