/**
 * Async Git Operations
 * Replaces synchronous execSync git calls with non-blocking child_process.spawn.
 * Includes timeout guards, busy locks, and streaming support.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Resolve config path relative to this file: <repoRoot>/config/config.json
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'config.json');

function getGitHubPAT() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return cfg && cfg.GitHubPAT ? String(cfg.GitHubPAT) : null;
  } catch (_) { return null; }
}

// Returns git -c flags that inject the PAT as a Basic auth header for github.com
// so network ops skip Git Credential Manager entirely.
function githubAuthFlags() {
  const pat = getGitHubPAT();
  if (!pat) return [];
  const basic = Buffer.from(`x-access-token:${pat}`).toString('base64');
  return [
    '-c', `http.https://github.com/.extraheader=AUTHORIZATION: Basic ${basic}`,
  ];
}

// ── Busy locks per repo (prevents concurrent git ops on same repo) ──────────
const busyRepos = new Map(); // repoPath -> { operation, startTime }

function isBusy(repoPath) {
  const entry = busyRepos.get(repoPath);
  if (!entry) return false;
  // Auto-expire after 60 seconds (safety valve)
  if (Date.now() - entry.startTime > 60000) {
    busyRepos.delete(repoPath);
    return false;
  }
  return true;
}

function getBusyOperation(repoPath) {
  const entry = busyRepos.get(repoPath);
  return entry ? entry.operation : null;
}

function setBusy(repoPath, operation) {
  busyRepos.set(repoPath, { operation, startTime: Date.now() });
}

function clearBusy(repoPath) {
  busyRepos.delete(repoPath);
}

/**
 * Execute a git command asynchronously.
 * @param {string} repoPath - Path to the git repository
 * @param {string} cmd - Git command (e.g., 'status --porcelain')
 * @param {object} opts - Options
 * @param {number} opts.timeout - Timeout in ms (default 10000)
 * @param {boolean} opts.lock - Whether to acquire a busy lock (default false)
 * @param {string} opts.lockName - Name of the operation for busy lock
 * @returns {Promise<string>} - Trimmed stdout
 */
function gitAsync(repoPath, cmd, opts = {}) {
  const timeout = opts.timeout || 10000;
  const lock = opts.lock || false;
  const lockName = opts.lockName || cmd.split(' ')[0];

  return new Promise((resolve, reject) => {
    if (lock && isBusy(repoPath)) {
      const current = getBusyOperation(repoPath);
      return reject(new Error(`Git operation in progress: ${current}. Please wait.`));
    }

    if (lock) setBusy(repoPath, lockName);

    const args = [...githubAuthFlags(), '-C', repoPath, ...parseArgs(cmd)];
    const proc = spawn('git', args, {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      if (lock) clearBusy(repoPath);
      reject(new Error(`Git command timed out after ${timeout}ms: git ${cmd}`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (lock) clearBusy(repoPath);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const msg = (stderr || stdout || '').trim();
        const err = new Error(`git ${cmd} exited with code ${code}: ${msg}`);
        err.exitCode = code;
        err.stdout = stdout.trim();
        err.stderr = stderr.trim();
        reject(err);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (lock) clearBusy(repoPath);
      reject(err);
    });
  });
}

/**
 * Parse a command string into args array, respecting quotes.
 */
function parseArgs(cmd) {
  const args = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ') {
      if (current) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Execute git command synchronously as fallback (for startup/init).
 * Wraps execSync but with better error handling.
 */
function gitSync(repoPath, cmd, timeoutMs) {
  const { execSync } = require('child_process');
  const authPrefix = githubAuthFlags().map(a => a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
  const prefix = authPrefix ? `${authPrefix} ` : '';
  try {
    return execSync(`git ${prefix}-C "${repoPath}" ${cmd}`, {
      encoding: 'utf8',
      timeout: timeoutMs || 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return (e.stdout || e.stderr || e.message || '').trim();
  }
}

module.exports = { gitAsync, gitSync, isBusy, getBusyOperation, setBusy, clearBusy };
