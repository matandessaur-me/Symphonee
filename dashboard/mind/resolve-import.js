/**
 * Resolve an import specifier to an in-repo file path (relative, forward
 * slashes), or return null if the import is external.
 *
 * Order of attempts:
 *   1. Relative paths (./foo, ../bar) - resolved against fromFile's dir.
 *   2. Path alias from tsconfig/jsconfig.
 *   3. Returns null - caller marks as external.
 *
 * Each attempt is checked against `fileSet` (set of repo-relative paths) with
 * the standard extension and index-file expansions.
 */

const path = require('path');

const TS_EXTS = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_EXTS = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs'];
const CSS_EXTS = ['', '.css', '.scss', '.sass', '.less', '.styl'];

function withForwardSlashes(p) { return p.replace(/\\/g, '/'); }

function tryExtensions(candidate, fileSet, kind = 'js') {
  const norm = withForwardSlashes(candidate).replace(/^\.\//, '');
  if (fileSet.has(norm)) return norm;
  const exts = kind === 'css' ? CSS_EXTS : TS_EXTS;
  for (const ext of exts) {
    const c = norm + ext;
    if (fileSet.has(c)) return c;
  }
  for (const idx of INDEX_EXTS) {
    const c = norm + idx;
    if (fileSet.has(c)) return c;
  }
  // SCSS partial fallback: foo -> _foo
  if (kind === 'css') {
    const dir = path.posix.dirname(norm);
    const base = path.posix.basename(norm);
    const partial = dir + '/_' + base;
    for (const ext of ['.scss', '.sass']) {
      const c = partial + ext;
      if (fileSet.has(c)) return c;
    }
  }
  return null;
}

function resolveImport({ spec, fromFile, fileSet, aliases, kind = 'js' }) {
  if (!spec) return null;
  const norm = withForwardSlashes(spec);
  if (norm.startsWith('.')) {
    const dir = path.posix.dirname(withForwardSlashes(fromFile));
    const candidate = path.posix.normalize(dir + '/' + norm).replace(/^\.\//, '');
    return tryExtensions(candidate, fileSet, kind);
  }
  if (norm.startsWith('/')) {
    return tryExtensions(norm.replace(/^\/+/, ''), fileSet, kind);
  }
  if (aliases && aliases.aliases && aliases.aliases.length) {
    const { resolveAlias } = require('./aliases');
    const aliased = resolveAlias(norm, aliases);
    if (aliased) return tryExtensions(aliased, fileSet, kind);
  }
  return null;
}

module.exports = { resolveImport, tryExtensions };
