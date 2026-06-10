/**
 * Safe path resolution for user-supplied relative paths.
 * Route handlers receive file paths from query strings / request bodies and
 * must never read or write outside the repo they were given (CWE-22).
 */
const path = require('path');

/**
 * Resolve a user-supplied relative path against a repo root.
 * Returns the absolute path if it stays inside the repo, otherwise null.
 * @param {string} repoPath - Absolute path of the repo root
 * @param {string} relPath - Untrusted relative path (query/body input)
 * @returns {string|null}
 */
function resolveInRepo(repoPath, relPath) {
  if (!repoPath || typeof relPath !== 'string') return null;
  if (relPath.includes('\0')) return null;
  const root = path.resolve(repoPath);
  const resolved = path.resolve(root, relPath);
  if (resolved === root) return resolved;
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * True if a user-supplied git ref/hash is unsafe to pass as a CLI argument
 * (empty, leading dash = flag injection, whitespace or control chars).
 * @param {string} ref
 * @returns {boolean}
 */
function isUnsafeGitRef(ref) {
  return !ref ||
    typeof ref !== 'string' ||
    ref.startsWith('-') ||
    /[\s"'`;|&$\\]/.test(ref);
}

module.exports = { resolveInRepo, isUnsafeGitRef };
