'use strict';
// Git routes - extracted from server.js (behavior-preserving).
// Registered via addRoute so they match before the legacy if-chain.
//
// ctx: { getRepoPath, broadcast, swrGit, guard }
//   getRepoPath(repoName) -> absolute path | null
//   broadcast(msg)        -> push a WS message to all clients
//   swrGit                -> SWRCache instance (branch list cache)
//   guard                 -> BusyGuard instance (serializes git mutations)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { gitAsync, gitSync, currentBranch } = require('../utils/git-async');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function mountGit(addRoute, json, ctx) {
  const { getRepoPath, broadcast, swrGit, guard } = ctx;

  function isUnsafeBranchName(branch) {
    return !branch ||
      branch.startsWith('-') ||
      /\s/.test(branch) ||
      /[;|&$`"'\\]/.test(branch) ||
      /[\r\n]/.test(branch);
  }

  // Legacy sync wrapper (kept for non-critical reads; async preferred for new code)
  function gitExec(repoPath, cmd, timeoutMs) {
    return gitSync(repoPath, cmd, timeoutMs);
  }

  async function handleGitStatus(url, res) {
    const repoName = url.searchParams.get('repo');
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    // Run git OFF the main event loop (gitAsync = spawn) so the 10s status poll
    // does not freeze the whole UI. `git status -u` is slow on big / untracked-
    // heavy repos, and the legacy gitExec/gitSync would block the Electron main
    // process (server.js runs in it) for the duration -- the recurring freeze.
    let branch = '', status = '';
    try { branch = await currentBranch(repoPath); } catch (_) {}
    try { status = await gitAsync(repoPath, 'status --porcelain -u'); } catch (_) {}
    const statusMap = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', '?': 'new', 'U': 'conflict' };
    const statusLabel = { 'modified': 'M', 'added': 'A', 'deleted': 'D', 'renamed': 'R', 'new': 'N', 'conflict': 'U' };
    const files = status ? status.split('\n').filter(Boolean).map(line => {
      // Git porcelain: XY filename -- X=index status, Y=worktree status
      const x = line.charAt(0);
      const y = line.charAt(1);
      let file;
      if (line.charAt(2) === ' ') {
        file = line.substring(3); // standard: XY<space>filename
      } else {
        file = line.substring(2); // no separator: XYfilename
      }
      // Handle renamed files: "R  old-name -> new-name"
      if (file.includes(' -> ')) {
        file = file.split(' -> ').pop();
      }
      // Strip any trailing \r from Windows line endings
      file = file.replace(/\r$/, '').trim();
      const raw = (x + y).trim() || '?';
      const statusChar = raw.charAt(0);
      const cls = statusMap[statusChar] || 'modified';
      return { status: statusLabel[cls], statusClass: cls, file };
    }).filter(f => f.file) : [];

    json(res, { branch, files, clean: files.length === 0 });
  }

  async function handleGitDiff(url, res) {
    const repoName = url.searchParams.get('repo');
    const filePath = url.searchParams.get('path') || '';
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    // gitAsync (spawn) instead of the blocking gitExec so loading a large diff
    // does not freeze the main process / whole UI. Returns '' on error to match
    // the old gitExec-tolerant behavior.
    const g = async (cmd) => { try { return await gitAsync(repoPath, cmd); } catch (_) { return ''; } };

    let diff = '';
    if (filePath) {
      // Try staged + unstaged diff against HEAD (ignore CRLF differences on Windows)
      diff = await g(`diff --ignore-cr-at-eol HEAD -- "${filePath}"`);
      // Try unstaged only
      if (!diff) diff = await g(`diff --ignore-cr-at-eol -- "${filePath}"`);
      // Try staged only
      if (!diff) diff = await g(`diff --ignore-cr-at-eol --cached -- "${filePath}"`);
      // For untracked/new files, show entire content as additions
      if (!diff) {
        const fullPath = path.join(repoPath, filePath);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            diff = `diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
              lines.map(l => `+${l}`).join('\n');
          } catch (_) {}
        }
      }
    } else {
      diff = await g('diff --ignore-cr-at-eol HEAD');
      if (!diff) diff = await g('diff --ignore-cr-at-eol');
      // Include untracked (new) files in the combined diff
      const status = await g('status --porcelain');
      if (status) {
        const untrackedFiles = status.split('\n').filter(Boolean)
          .filter(l => l.startsWith('??'))
          .map(l => l.substring(3).replace(/\r$/, '').trim());
        for (const uf of untrackedFiles) {
          const fullPath = path.join(repoPath, uf);
          if (fs.existsSync(fullPath)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const fileDiff = `diff --git a/${uf} b/${uf}\nnew file\n--- /dev/null\n+++ b/${uf}\n@@ -0,0 +1,${lines.length} @@\n` +
                lines.map(l => `+${l}`).join('\n');
              diff = diff ? diff + '\n' + fileDiff : fileDiff;
            } catch (_) {}
          }
        }
      }
    }

    json(res, { diff: diff || 'No changes', filePath });
  }

  async function handleGitBranches(url, res) {
    const repoName = url.searchParams.get('repo');
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    try {
      const data = await swrGit.get('branches:' + repoPath, async () => {
        const current = await currentBranch(repoPath);
        const output = await gitAsync(repoPath, 'branch --format="%(refname:short)"');
        const branches = output ? output.split('\n').filter(Boolean) : [];
        return { current, branches };
      });
      json(res, data);
    } catch (err) {
      console.error('handleGitBranches error:', err.message);
      json(res, { error: 'Failed to list branches' }, 500);
    }
  }

  async function handleGitLog(url, res) {
    const repoName = url.searchParams.get('repo');
    const count = url.searchParams.get('count') || '20';
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    let output = '';
    try { output = await gitAsync(repoPath, `log -${count} --pretty=format:"%h|%s|%an|%ar"`); } catch (_) {}
    const commits = output ? output.split('\n').filter(Boolean).map(line => {
      const [hash, subject, author, date] = line.replace(/^"|"$/g, '').split('|');
      return { hash, subject, author, date };
    }) : [];

    json(res, { commits });
  }

  async function handleCommitDiff(url, res) {
    const repoName = url.searchParams.get('repo');
    const hash = url.searchParams.get('hash');
    const filePath = url.searchParams.get('path') || '';
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
    if (!hash) return json(res, { error: 'hash required' }, 400);

    const pathArg = filePath ? ` -- "${filePath}"` : '';
    const g = async (cmd) => { try { return await gitAsync(repoPath, cmd); } catch (_) { return ''; } };
    const diff = await g(`diff --ignore-cr-at-eol ${hash}~1 ${hash}${pathArg}`);
    const stat = await g(`diff --ignore-cr-at-eol --stat=999 ${hash}~1 ${hash}`);
    const msg = await g(`log -1 --pretty=format:"%s" ${hash}`);

    json(res, { diff: diff || 'No changes', stat, message: msg, hash });
  }

  // ── Git Actions (checkout, pull, push, fetch) - async with busy guards ────
  async function handleGitCheckout(req, res) {
    try {
      const body = await readBody(req);
      const repoPath = getRepoPath(body.repo);
      if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
      if (!body.branch) return json(res, { error: 'branch required' }, 400);
      if (isUnsafeBranchName(body.branch)) return json(res, { error: 'Invalid branch name' }, 400);

      await guard.run(`git:${repoPath}`, 'checkout', async () => {
        // Check for uncommitted changes
        const status = await gitAsync(repoPath, 'status --porcelain');
        if (status && status.trim()) {
          throw Object.assign(new Error('You have uncommitted changes. Commit or stash them before switching branches.'), { dirty: true });
        }

        // Fetch latest from remote before switching
        await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });

        const result = await gitAsync(repoPath, `checkout ${body.branch}`);
        const current = await currentBranch(repoPath);

        // Pull latest changes after switching (best-effort, don't fail the checkout)
        let pullMsg = '';
        try {
          pullMsg = await gitAsync(repoPath, 'pull', { timeout: 30000 });
        } catch (_) {
          // Pull failed - checkout still succeeded, continue
        }

        // Notify UI of branch change
        swrGit.clear();
        broadcast({ type: 'git-changed', repo: body.repo, branch: current });
        json(res, { ok: true, branch: current, message: result, pullMessage: pullMsg });
      }, 60000);
    } catch (e) {
      const status = e.dirty ? 400 : (e.message.includes('busy') ? 409 : 500);
      json(res, { error: e.message, dirty: e.dirty || false }, status);
    }
  }

  async function handleGitPull(req, res) {
    try {
      const body = await readBody(req);
      const repoPath = getRepoPath(body.repo);
      if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

      await guard.run(`git:${repoPath}`, 'pull', async () => {
        await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });
        const result = await gitAsync(repoPath, 'pull', { timeout: 30000 });
        const branch = await currentBranch(repoPath);
        swrGit.clear();
        broadcast({ type: 'git-changed', repo: body.repo, branch });
        json(res, { ok: true, branch, message: result });
      }, 60000);
    } catch (e) {
      json(res, { error: e.message }, e.message.includes('busy') ? 409 : 500);
    }
  }

  async function handleGitPush(req, res) {
    try {
      const body = await readBody(req);
      const repoPath = getRepoPath(body.repo);
      if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

      await guard.run(`git:${repoPath}`, 'push', async () => {
        const branch = await currentBranch(repoPath);
        if (isUnsafeBranchName(branch)) {
          throw Object.assign(new Error('Current branch name is unsafe to use in git commands.'), { invalidBranch: true });
        }
        await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });

        let behindCount = 0;
        try {
          const behind = await gitAsync(repoPath, `rev-list --count HEAD..origin/${branch}`);
          behindCount = parseInt(behind, 10) || 0;
        } catch (_) {
          // Remote branch doesn't exist yet - not behind, safe to push
        }
        if (behindCount > 0) {
          throw Object.assign(
            new Error(`Your branch is ${behindCount} commit(s) behind origin/${branch}. Pull first, then push.`),
            { needsPull: true }
          );
        }

        const result = await gitAsync(repoPath, `push -u origin ${branch}`, { timeout: 30000 });
        swrGit.clear();
        broadcast({ type: 'git-changed', repo: body.repo, branch });
        json(res, { ok: true, branch, message: result || 'Pushed successfully' });
      }, 60000);
    } catch (e) {
      const status = e.invalidBranch ? 400 : (e.needsPull ? 409 : (e.message.includes('busy') ? 409 : 500));
      json(res, { error: e.message, needsPull: e.needsPull || false }, status);
    }
  }

  async function handleGitFetch(req, res) {
    try {
      const body = await readBody(req);
      const repoPath = getRepoPath(body.repo);
      if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

      await guard.run(`git:${repoPath}`, 'fetch', async () => {
        await gitAsync(repoPath, 'fetch --prune', { timeout: 30000 });
        const current = await currentBranch(repoPath);
        const localOut = await gitAsync(repoPath, 'branch --format="%(refname:short)"');
        const remoteOut = await gitAsync(repoPath, 'branch -r --format="%(refname:short)"');
        const local = localOut ? localOut.split('\n').filter(Boolean) : [];
        const remote = remoteOut ? remoteOut.split('\n').filter(Boolean)
          .filter(b => !b.includes('/HEAD'))
          .map(b => b.replace(/^origin\//, '')) : [];
        const remoteOnly = remote.filter(r => !local.includes(r));

        json(res, { ok: true, current, local, remoteOnly });
      }, 60000);
    } catch (e) {
      json(res, { error: e.message }, e.message.includes('busy') ? 409 : 500);
    }
  }

  // ── Git Discard (restore file to HEAD) ──────────────────────────────────────
  async function handleGitDiscard(req, res) {
    try {
      const body = await readBody(req);
      const repoPath = getRepoPath(body.repo);
      if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
      if (!body.path) return json(res, { error: 'path required' }, 400);

      const filePath = body.path;

      // Check if the file is untracked (new) or tracked
      const status = gitExec(repoPath, `status --porcelain -- "${filePath}"`);
      const statusCode = status ? status.substring(0, 2) : '';

      if (statusCode.trim().startsWith('?')) {
        // Untracked file - remove it
        gitExec(repoPath, `clean -f -- "${filePath}"`);
      } else {
        // Tracked file - unstage and restore
        gitExec(repoPath, `reset HEAD -- "${filePath}"`);
        gitExec(repoPath, `checkout -- "${filePath}"`);
      }

      json(res, { ok: true, discarded: filePath });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  // ── Split Diff ──────────────────────────────────────────────────────────────
  function handleSplitDiff(url, res) {
    const repoName = url.searchParams.get('repo');
    const filePath = url.searchParams.get('path') || '';
    const base = url.searchParams.get('base') || 'HEAD';
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    try {
      // Get the original version from git
      let original = '';
      try {
        const result = spawnSync('git', ['-C', repoPath, 'show', `${base}:${filePath}`], {
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        if (!result.error && result.status === 0) original = result.stdout || '';
      } catch (_) { original = ''; }

      // Get the current version from disk
      const fullPath = path.join(repoPath, filePath);
      let modified = '';
      try { modified = fs.readFileSync(fullPath, 'utf8'); } catch (_) {}

      // Normalize line endings to LF so diff doesn't flag every line
      original = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      modified = modified.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      json(res, { original, modified, filePath, base });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  // ── Route registrations ─────────────────────────────────────────────────
  addRoute('GET',    '/api/git/status',      (req, res, url) => handleGitStatus(url, res));
  addRoute('GET',    '/api/git/diff',        (req, res, url) => handleGitDiff(url, res));
  addRoute('GET',    '/api/git/branches',    (req, res, url) => handleGitBranches(url, res));
  addRoute('GET',    '/api/git/log',         (req, res, url) => handleGitLog(url, res));
  addRoute('GET',    '/api/git/commit-diff', (req, res, url) => handleCommitDiff(url, res));
  addRoute('GET',    '/api/git/split-diff',  (req, res, url) => handleSplitDiff(url, res));
  addRoute('POST',   '/api/git/checkout',    (req, res) => handleGitCheckout(req, res));
  addRoute('POST',   '/api/git/pull',        (req, res) => handleGitPull(req, res));
  addRoute('POST',   '/api/git/push',        (req, res) => handleGitPush(req, res));
  addRoute('POST',   '/api/git/fetch',       (req, res) => handleGitFetch(req, res));
  addRoute('POST',   '/api/git/discard',     (req, res) => handleGitDiscard(req, res));

  return { gitExec };
}

module.exports = { mountGit };
