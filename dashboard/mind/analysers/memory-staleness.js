/**
 * Memory staleness analyser.
 *
 * Mind only ever ACCUMULATES memory cards. This is the first analyser that
 * checks a card against ground truth: the live repo on disk. A card that names
 * a concrete file path which no longer exists is very likely outdated -- the
 * code moved or was deleted but the memory still asserts the old shape. Those
 * are the cards that quietly make the brain WRONGER as it grows.
 *
 * We are deliberately conservative -- a false "this is stale" flag erodes the
 * very trust this feature exists to build. So we only consider tokens that look
 * like real relative paths (they contain a separator and a known code
 * extension), and we treat a card as stale ONLY when a referenced path is
 * missing AND no file with that basename exists ANYWHERE in the repo (a missing
 * basename is a confident signal; a path-base mismatch is not).
 *
 * Emits ONE insight per pass listing up to BATCH_SIZE stale cards, with the
 * existing reversible `archive-memories` action (archive hides a card from
 * wakeup/recall but keeps its history). The user can also just edit the card.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../store');

const BATCH_SIZE = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.symphonee', 'coverage', 'vendor', '.cache', 'out', '.turbo']);
const MAX_FILES = 40000;
const MAX_DEPTH = 14;
const CODE_EXT = 'js|jsx|ts|tsx|mjs|cjs|css|scss|less|json|md|mdx|ps1|psm1|cs|py|html|htm|vue|svelte|go|rs|java|rb|php|sql|ya?ml|toml|sh|c|h|cpp';
// A path-ish token: at least one separator + a known extension. Anchored on a
// boundary so we do not grab the tail of a URL or a longer identifier.
const PATH_RE = new RegExp('(?:^|[\\s("\'`\\[<])([\\w.\\-]+(?:[\\/\\\\][\\w.\\-]+)+\\.(?:' + CODE_EXT + '))\\b', 'gi');

// Per-call cache of {paths,names} indexes keyed by repoPath.
function _indexRepo(repoPath, cache) {
  if (cache.has(repoPath)) return cache.get(repoPath);
  const paths = new Set();
  const names = new Set();
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || count >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (count >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.env') { /* skip dotfiles/dirs except keep walking known */ }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const full = path.join(dir, e.name);
        const rel = path.relative(repoPath, full).split(path.sep).join('/').toLowerCase();
        paths.add(rel);
        names.add(e.name.toLowerCase());
        count++;
      }
    }
  };
  try { walk(repoPath, 0); } catch (_) {}
  const idx = { paths, names, truncated: count >= MAX_FILES };
  cache.set(repoPath, idx);
  return idx;
}

function _resolveRepoPath(card, repos, activeRepoPath, repoRoot) {
  const scopeRepo = card.scope && card.scope.repo;
  if (scopeRepo && repos[scopeRepo] && fs.existsSync(repos[scopeRepo])) return repos[scopeRepo];
  if (activeRepoPath && fs.existsSync(activeRepoPath)) return activeRepoPath;
  if (repoRoot && fs.existsSync(repoRoot)) return repoRoot;
  return null;
}

function _extractPaths(text) {
  const out = new Set();
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    let p = m[1].replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (!p || p.startsWith('http') || p.includes('://') || p.startsWith('node_modules/')) continue;
    out.add(p);
  }
  return [...out];
}

function _isPresent(rel, idx, repoBase) {
  if (idx.paths.has(rel)) return true;
  // Tolerate a leading repo-name segment ("symphonee/dashboard/x.js").
  if (repoBase && rel.startsWith(repoBase + '/') && idx.paths.has(rel.slice(repoBase.length + 1))) return true;
  // Tolerate a path recorded relative to a deeper base: match on suffix.
  for (const p of idx.paths) { if (p.endsWith('/' + rel) || p === rel) return true; }
  // Conservative basename fallback: if a file with this name exists anywhere,
  // it is probably a path-base mismatch, not a deletion -> NOT stale.
  const base = rel.split('/').pop();
  if (base && idx.names.has(base)) return true;
  return false;
}

/**
 * Core scan. Returns { stale: [{ id, label, kindOfMemory, missing[] }], total,
 * checked } without persisting anything. Used by both detect() and the health
 * endpoint.
 */
function scan({ repoRoot, space, getUiContext, getAllRepos } = {}) {
  const g = store.loadGraph(repoRoot, space);
  if (!g) return { stale: [], total: 0, checked: 0 };
  const repos = (typeof getAllRepos === 'function' ? getAllRepos() : {}) || {};
  const ui = (typeof getUiContext === 'function' ? getUiContext() : {}) || {};
  const activeRepoPath = ui.activeRepoPath || null;
  const cache = new Map();

  const memories = (g.nodes || []).filter((n) => n.kind === 'memory' && n.status !== 'archived');
  const stale = [];
  let checked = 0;
  for (const n of memories) {
    const refs = _extractPaths(String(n.body || '') + ' ' + String(n.label || ''));
    if (!refs.length) continue;
    const repoPath = _resolveRepoPath(n, repos, activeRepoPath, repoRoot);
    if (!repoPath) continue;
    const idx = _indexRepo(repoPath, cache);
    if (idx.truncated) continue; // repo too big to index confidently -> do not guess
    checked++;
    const repoBase = path.basename(repoPath).toLowerCase();
    const missing = refs.filter((r) => !_isPresent(r, idx, repoBase));
    if (missing.length) stale.push({ id: n.id, label: n.label || '', kindOfMemory: n.kindOfMemory || 'fact', missing });
  }
  return { stale, total: memories.length, checked };
}

function detect(deps = {}) {
  const { stale } = scan(deps);
  if (!stale.length) return [];
  const batch = stale.slice(0, BATCH_SIZE);
  const body = [
    `${stale.length} memory card${stale.length === 1 ? '' : 's'} reference files that no longer exist in the repo -- likely outdated.`,
    '',
    'Flagged:',
    ...batch.map((s) => `  - [${s.kindOfMemory}] ${s.label.slice(0, 90)}  (missing: ${s.missing.slice(0, 3).join(', ')})`),
    stale.length > BATCH_SIZE ? `  ... and ${stale.length - BATCH_SIZE} more` : '',
    '',
    'Archive hides them from wakeup + recall but keeps their history. You can also edit a card to re-ground it.',
  ].filter(Boolean).join('\n');
  return [{
    category: 'memory-staleness',
    title: `${stale.length} memor${stale.length === 1 ? 'y references a' : 'ies reference'} deleted file${stale.length === 1 ? '' : 's'} -- review?`,
    body,
    action: { type: 'archive-memories', payload: { ids: batch.map((s) => s.id) } },
    evidence: batch.map((s) => s.id),
  }];
}

module.exports = { detect, scan };
