/**
 * File co-edit analyser.
 *
 * Reads `git log --name-only --since=30.days` from the active repo,
 * counts how often pairs / triples of files appear in the same commit,
 * and emits an insight when a set of 2-5 files co-occurs >= MIN_COUNT
 * times. The suggestion: bundle them into a recipe.
 *
 * Why git commits as the signal:
 *   - Already on disk, no extra tracking.
 *   - Captures intent (the user grouped these in one commit).
 *   - Skips trivial bursts (single-file commits don't generate edges).
 *
 * Action payload describes a recipe stub the user can later flesh out.
 * For v1 we just suggest the recipe; full auto-create lives in /act.
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const llm = require('../llm');

const MIN_COUNT = 4;
const MAX_INSIGHTS = 3;
const SINCE = '30.days';
const SKIP_PATTERNS = [
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /\.min\.(js|css)$/i,
  /^dist\//,
  /^build\//,
  /^node_modules\//,
  /^\.next\//,
  /^\.symphonee\//,
];

function _activeRepoPath(getUiContext) {
  if (typeof getUiContext !== 'function') return null;
  try {
    const ui = getUiContext();
    return ui && ui.activeRepoPath ? ui.activeRepoPath : null;
  } catch (_) { return null; }
}

function _gitLogCommits(repoPath) {
  // Returns an array of arrays — each inner array is the file list for
  // one commit. We parse a custom delimiter so commit boundaries are
  // unambiguous even when commit messages contain blank lines.
  let raw = '';
  try {
    raw = execSync(`git -C "${repoPath}" log --name-only --pretty=format:%n--SYM-COMMIT--%n --since=${SINCE}`, {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) { return []; }
  const blocks = raw.split('--SYM-COMMIT--');
  const out = [];
  for (const b of blocks) {
    const files = b.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!files.length) continue;
    const filtered = files.filter(f => !SKIP_PATTERNS.some(rx => rx.test(f)));
    if (filtered.length >= 2 && filtered.length <= 8) out.push(filtered);
  }
  return out;
}

function _countSets(commits, minSize = 2, maxSize = 5) {
  const counts = new Map();
  for (const files of commits) {
    if (files.length < minSize || files.length > maxSize) continue;
    const key = files.slice().sort().join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sets = [];
  for (const [key, count] of counts) {
    if (count >= MIN_COUNT) sets.push({ files: key.split('|'), count });
  }
  sets.sort((a, b) => b.count - a.count);
  return sets.slice(0, MAX_INSIGHTS);
}

async function _llmName(set) {
  if (!llm.pickChatModel()) {
    return {
      title: `Recipe: edit ${set.files.length} files together`,
      slug: 'edit-bundle-' + set.files.length,
      description: `These ${set.files.length} files were committed together ${set.count} times in the last 30 days.`,
    };
  }
  const fileList = set.files.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const sys = [
    'You name a developer recipe based on a set of files that are always changed together.',
    'A "recipe" here is a saved workflow that opens / edits these files together.',
    '',
    'Respond with JSON only. Schema:',
    '{',
    '  "title": "<short imperative title under 80 chars>",',
    '  "slug": "<lowercase kebab-case slug under 40 chars>",',
    '  "description": "<1-2 sentence description of what this recipe would do>"',
    '}',
  ].join('\n');
  const user = `These ${set.files.length} files have been committed together ${set.count} times in the last 30 days:\n\n${fileList}\n\nName the recipe.`;
  try {
    const r = await llm.chatOllama([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { format: 'json', timeoutMs: 25_000, numPredict: 250 });
    return r.json || {};
  } catch (_) { return {}; }
}

async function detect({ getUiContext } = {}) {
  const repoPath = _activeRepoPath(getUiContext);
  if (!repoPath) return [];
  const commits = _gitLogCommits(repoPath);
  if (commits.length === 0) return [];
  const sets = _countSets(commits);
  if (!sets.length) return [];
  const out = [];
  for (const s of sets) {
    const naming = await _llmName(s);
    const slug = (naming.slug || `edit-${s.files.length}-files`).slice(0, 40).replace(/[^a-z0-9_-]/g, '-');
    const title = naming.title || `These ${s.files.length} files always change together`;
    const description = naming.description || `Committed together ${s.count} times in the last 30 days.`;
    const body = [
      description,
      '',
      'Files:',
      ...s.files.map(f => `  - ${f}`),
      '',
      `Co-occurrence: ${s.count} commits in the last 30 days.`,
    ].join('\n');
    out.push({
      category: 'co-edit',
      title: `Always edited together: ${s.files.length} files (${s.count}x in 30d) -- save as recipe?`,
      body,
      action: {
        type: 'create-recipe',
        payload: {
          slug,
          title,
          description,
          files: s.files,
        },
      },
      // Evidence here is the file paths themselves, prefixed so they're
      // distinct from real graph node IDs. The signature dedup hashes
      // this verbatim, so the same file set won't refire.
      evidence: s.files.map(f => 'file::' + f),
    });
  }
  return out;
}

module.exports = { detect };
