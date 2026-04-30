/**
 * tsconfig / jsconfig path-alias loader.
 *
 * Reads compilerOptions.paths from tsconfig.json or jsconfig.json (following
 * `extends` chains up to 5 hops) and produces an array of pattern entries the
 * import resolver can match against.
 *
 * Alias entry shape: { pattern: '@/components/*', prefix: '@/components/',
 *   suffix: '*', targets: [{ prefix: 'src/components/', suffix: '*' }] }
 *
 * Patterns containing `*` translate to a single wildcard slot; multi-`*`
 * patterns are rejected (tsconfig spec only allows one).
 */

const fs = require('fs');
const path = require('path');

const MAX_EXTENDS = 5;

function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      if (c === '\\' && i + 1 < text.length) { out += c + n; i += 2; continue; }
      if (c === stringChar) { inString = false; }
      out += c; i++; continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

function readJsonWithComments(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const trimmed = raw.replace(/^﻿/, '');
  return JSON.parse(stripJsonComments(trimmed));
}

function loadTsconfigChain(startFile, hops = 0) {
  if (hops > MAX_EXTENDS) return null;
  if (!fs.existsSync(startFile)) return null;
  let cfg;
  try { cfg = readJsonWithComments(startFile); } catch (_) { return null; }
  if (cfg.extends) {
    const baseDir = path.dirname(startFile);
    let extendsPath = cfg.extends;
    if (extendsPath.startsWith('.')) {
      extendsPath = path.resolve(baseDir, extendsPath);
    } else {
      extendsPath = path.resolve(baseDir, 'node_modules', extendsPath);
    }
    if (!extendsPath.endsWith('.json')) extendsPath += '.json';
    const parent = loadTsconfigChain(extendsPath, hops + 1);
    if (parent) {
      cfg.compilerOptions = {
        ...(parent.compilerOptions || {}),
        ...(cfg.compilerOptions || {}),
        paths: {
          ...((parent.compilerOptions && parent.compilerOptions.paths) || {}),
          ...((cfg.compilerOptions && cfg.compilerOptions.paths) || {}),
        },
      };
      if (!cfg.compilerOptions.baseUrl && parent.compilerOptions && parent.compilerOptions.baseUrl) {
        cfg.compilerOptions.baseUrl = parent.compilerOptions.baseUrl;
      }
    }
  }
  return cfg;
}

function compilePattern(pattern) {
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) {
    return { prefix: pattern, suffix: '', exact: true };
  }
  if (pattern.indexOf('*', starIndex + 1) !== -1) return null;
  return {
    prefix: pattern.slice(0, starIndex),
    suffix: pattern.slice(starIndex + 1),
    exact: false,
  };
}

function loadPathAliases(repoRoot) {
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  for (const name of candidates) {
    const file = path.join(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    const cfg = loadTsconfigChain(file);
    if (!cfg || !cfg.compilerOptions) continue;
    const baseUrl = cfg.compilerOptions.baseUrl
      ? path.resolve(repoRoot, cfg.compilerOptions.baseUrl)
      : repoRoot;
    const paths = cfg.compilerOptions.paths || {};
    const aliases = [];
    for (const [pat, targets] of Object.entries(paths)) {
      const compiledPat = compilePattern(pat);
      if (!compiledPat) continue;
      const compiledTargets = (targets || [])
        .map(compilePattern)
        .filter(Boolean);
      if (!compiledTargets.length) continue;
      aliases.push({
        pattern: pat,
        prefix: compiledPat.prefix,
        suffix: compiledPat.suffix,
        exact: compiledPat.exact,
        targets: compiledTargets.map(t => {
          // Preserve trailing slash on wildcard prefixes - path.resolve strips
          // it, but the wildcard substitution depends on it.
          const trailing = (t.prefix.endsWith('/') || t.prefix.endsWith('\\')) ? '/' : '';
          const resolved = path.relative(repoRoot, path.resolve(baseUrl, t.prefix)).replace(/\\/g, '/');
          return {
            prefix: t.exact ? resolved : (resolved + (resolved && !resolved.endsWith('/') ? trailing : '')),
            suffix: t.suffix,
            exact: t.exact,
          };
        }),
      });
    }
    if (aliases.length) return { aliases, baseUrl, configFile: file };
  }
  return { aliases: [], baseUrl: repoRoot, configFile: null };
}

function resolveAlias(spec, aliasesInfo) {
  if (!aliasesInfo || !aliasesInfo.aliases.length) return null;
  for (const a of aliasesInfo.aliases) {
    if (a.exact) {
      if (spec === a.prefix) {
        const t = a.targets[0];
        return t.exact ? t.prefix : null;
      }
      continue;
    }
    if (spec.startsWith(a.prefix) && spec.endsWith(a.suffix)) {
      const middle = spec.slice(a.prefix.length, spec.length - a.suffix.length);
      const t = a.targets[0];
      if (!t) continue;
      const out = t.exact ? t.prefix : (t.prefix + middle + t.suffix);
      return out.replace(/^\.\//, '');
    }
  }
  return null;
}

module.exports = {
  loadPathAliases,
  resolveAlias,
  // exported for tests
  _stripJsonComments: stripJsonComments,
  _compilePattern: compilePattern,
};
