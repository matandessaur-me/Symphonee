/**
 * Symphonee -- Git-based working-tree checkpoints (the "undo" behind the ledger)
 *
 * A checkpoint snapshots the active repo's tracked working tree WITHOUT
 * disturbing it (`git stash create`, which writes a commit object capturing the
 * working tree + index and returns its sha, but does not modify anything). We
 * pin that commit under refs/symphonee/checkpoints/<id> so git never GCs it.
 *
 * Restore reverts TRACKED files to the snapshot tree via `git restore`. This is
 * deliberately non-destructive to newly-created (untracked) files, and always
 * takes a fresh safety checkpoint of the current state first -- so an undo is
 * itself undoable. This works for ANY change in the repo (including edits a CLI
 * made through its own terminal), because git itself is the record.
 *
 * Scope is honest: this covers the active git repo's working tree. It does not
 * undo external/irreversible actions (a push, a publish, a sent email) -- those
 * are recorded in the ledger but flagged as non-revertible.
 */

const fs = require('fs');
const path = require('path');
const { gitAsync } = require('../utils/git-async');

let _dir = null;

function init({ dir } = {}) {
  _dir = dir || null;
  if (_dir) { try { fs.mkdirSync(_dir, { recursive: true }); } catch (_) {} }
  return module.exports;
}

function _file(id) { return path.join(_dir, id + '.json'); }

async function _isRepo(repoPath) {
  try { await gitAsync(repoPath, 'rev-parse --is-inside-work-tree'); return true; } catch (_) { return false; }
}

/**
 * Create a checkpoint of repoPath's current working tree. Non-destructive.
 */
async function create(repoPath, { label, repo, auto } = {}) {
  if (!repoPath || !(await _isRepo(repoPath))) throw new Error('Not a git repository');
  const head = await gitAsync(repoPath, 'rev-parse HEAD').catch(() => '');
  const branch = await gitAsync(repoPath, 'rev-parse --abbrev-ref HEAD').catch(() => '');
  let stash = '';
  // `git stash create` returns a sha when there are changes, empty when clean.
  try { stash = await gitAsync(repoPath, 'stash create', { timeout: 20000 }); } catch (_) { stash = ''; }
  stash = (stash || '').trim();

  const id = 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  if (stash) {
    try { await gitAsync(repoPath, 'update-ref refs/symphonee/checkpoints/' + id + ' ' + stash); } catch (_) {}
  }
  let changed = 0;
  try { const s = await gitAsync(repoPath, 'status --porcelain'); changed = s ? s.split('\n').filter(Boolean).length : 0; } catch (_) {}

  const cp = {
    id, ts: new Date().toISOString(),
    repo: repo || null, repoPath,
    label: label || null,
    head, branch,
    stash: stash || null,   // snapshot tree source; null => clean-tree checkpoint
    changed,                // number of changed tracked paths at checkpoint time
    auto: !!auto,
  };
  if (_dir) { try { fs.writeFileSync(_file(id), JSON.stringify(cp, null, 2)); } catch (_) {} }
  return cp;
}

function get(id) {
  if (!_dir || !id) return null;
  try { return JSON.parse(fs.readFileSync(_file(id), 'utf8')); } catch (_) { return null; }
}

function list({ repo, limit = 50 } = {}) {
  if (!_dir) return [];
  let files = [];
  try { files = fs.readdirSync(_dir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
  let cps = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(_dir, f), 'utf8')); } catch (_) { return null; } }).filter(Boolean);
  if (repo) cps = cps.filter((c) => c.repo === repo);
  cps.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return cps.slice(0, Math.max(1, Math.min(500, limit)));
}

/**
 * Restore a checkpoint. Takes a fresh safety checkpoint first, then reverts
 * tracked files to the snapshot tree. Returns { restored, safety }.
 */
async function restore(id) {
  const cp = get(id);
  if (!cp) throw new Error('Checkpoint not found');
  const repoPath = cp.repoPath;
  if (!(await _isRepo(repoPath))) throw new Error('Repository unavailable');

  // Safety: snapshot current state so this undo is itself reversible.
  const safety = await create(repoPath, { label: 'auto: before undo of ' + (cp.label || cp.id), repo: cp.repo, auto: true }).catch(() => null);

  // Source tree: the stash snapshot if there was one, else the recorded HEAD
  // (a checkpoint taken on a clean tree restores by discarding back to HEAD).
  const source = cp.stash || cp.head;
  if (!source) throw new Error('Checkpoint has no restorable source');

  await gitAsync(repoPath, 'restore --source=' + source + ' --worktree --staged -- .', { timeout: 30000, lock: true, lockName: 'undo-restore' });
  return { restored: cp, safety };
}

module.exports = { init, create, get, list, restore };
