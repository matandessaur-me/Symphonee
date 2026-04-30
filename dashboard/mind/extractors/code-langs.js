/**
 * Multi-language code extraction.
 *
 * Regex-based, no native deps, no Electron rebuild concerns. Covers Go,
 * Java, Kotlin, Scala, Rust, Ruby, PHP, Swift, plain CSS/SCSS/LESS, plus
 * Svelte/Vue (via embedded <script> + import-from-style blocks).
 *
 * For each language we extract:
 *   - imports (specifier + isExternal flag)
 *   - top-level declarations (functions / classes / methods / structs / interfaces)
 *
 * Call-site extraction is intentionally JS-only - the regex would be too noisy
 * across these many syntaxes. Mind's symbol-context view still works on
 * caller files because callers are expressed via 'imports' + 'defines' pairs.
 */

const path = require('path');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel, normalizeId } = require('../ids');

const LANG_BY_EXT = {
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala', '.sc': 'scala',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css', '.styl': 'css',
  '.svelte': 'svelte',
  '.vue': 'vue',
};

const PATTERNS = {
  go: {
    imports: [
      // single line: import "fmt"
      /^\s*import\s+"([^"]+)"/gm,
      // grouped: import (\n  "fmt"\n  alias "pkg")\n
      /^\s*import\s+\([^)]*?"([^"]+)"/gms,
    ],
    decls: [
      { re: /^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?([A-Za-z_][\w]*)\s*\(/gm, kind: 'function' },
      { re: /^\s*type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/gm, kind: 'type' },
    ],
  },
  java: {
    imports: [/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm],
    decls: [
      { re: /^\s*(?:public|private|protected|abstract|final|static|\s)+\s*(class|interface|enum)\s+([A-Z][\w]*)/gm, kind: 'type', nameGroup: 2 },
      { re: /^\s*(?:public|private|protected|static|final|abstract|synchronized|\s)+\s+[A-Za-z_][\w<>,?\s\[\]]*\s+([A-Za-z_][\w]*)\s*\(/gm, kind: 'method' },
    ],
  },
  kotlin: {
    imports: [/^\s*import\s+([A-Za-z_][\w.]*)/gm],
    decls: [
      { re: /^\s*(?:abstract\s+|open\s+|sealed\s+|data\s+|inner\s+|enum\s+|annotation\s+)?(class|interface|object)\s+([A-Z][\w]*)/gm, kind: 'type', nameGroup: 2 },
      { re: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+|inline\s+|suspend\s+|override\s+|abstract\s+|operator\s+)?fun\s+(?:<[^>]+>\s+)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_][\w]*)\s*\(/gm, kind: 'function' },
    ],
  },
  scala: {
    imports: [/^\s*import\s+([A-Za-z_][\w.{}_,\s]*)/gm],
    decls: [
      { re: /^\s*(?:abstract\s+|sealed\s+|case\s+|final\s+)?(class|object|trait)\s+([A-Z][\w]*)/gm, kind: 'type', nameGroup: 2 },
      { re: /^\s*def\s+([A-Za-z_][\w]*)\s*[\[\(]/gm, kind: 'function' },
    ],
  },
  rust: {
    imports: [/^\s*use\s+([A-Za-z_][\w:]*(?:::\*)?(?:::\{[^}]+\})?)/gm],
    decls: [
      { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?fn\s+([a-z_][\w]*)\s*[<\(]/gm, kind: 'function' },
      { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait|type)\s+([A-Z][\w]*)/gm, kind: 'type', nameGroup: 2 },
      { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?mod\s+([a-z_][\w]*)/gm, kind: 'module' },
    ],
  },
  ruby: {
    imports: [
      /^\s*require\s+(?:_relative\s+)?["']([^"']+)["']/gm,
      /^\s*require_relative\s+["']([^"']+)["']/gm,
    ],
    decls: [
      { re: /^\s*(class|module)\s+([A-Z][\w:]*)/gm, kind: 'type', nameGroup: 2 },
      { re: /^\s*def\s+(?:self\.)?([a-z_][\w?!]*)/gm, kind: 'method' },
    ],
  },
  php: {
    imports: [
      /^\s*use\s+([A-Za-z_][\w\\]*)\s*(?:as\s+\w+)?\s*;/gm,
      /^\s*require(?:_once)?\s+["']([^"']+)["']/gm,
      /^\s*include(?:_once)?\s+["']([^"']+)["']/gm,
    ],
    decls: [
      { re: /^\s*(?:abstract\s+|final\s+)?(class|interface|trait)\s+([A-Z][\w]*)/gm, kind: 'type', nameGroup: 2 },
      { re: /^\s*(?:public|private|protected|static|\s)+\s*function\s+([A-Za-z_][\w]*)\s*\(/gm, kind: 'method' },
      { re: /^\s*function\s+([A-Za-z_][\w]*)\s*\(/gm, kind: 'function' },
    ],
  },
  swift: {
    imports: [/^\s*import\s+([A-Za-z_][\w.]*)/gm],
    decls: [
      { re: /^\s*(?:public\s+|private\s+|fileprivate\s+|internal\s+|open\s+|final\s+)?(class|struct|enum|protocol|actor)\s+([A-Z][\w]*)/gm, kind: 'type', nameGroup: 2 },
      { re: /^\s*(?:public\s+|private\s+|fileprivate\s+|internal\s+|open\s+|static\s+|override\s+|final\s+)?func\s+([A-Za-z_][\w]*)\s*[<(]/gm, kind: 'function' },
    ],
  },
  css: {
    imports: [/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/gm],
    decls: [], // CSS rules are too noisy to surface as symbols by default
  },
  // Svelte / Vue: pull <script> imports + <style> @imports.
  svelte: {
    imports: [/import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/gm, /@import\s+["']([^"']+)["']/gm],
    decls: [],
  },
  vue: {
    imports: [/import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/gm, /@import\s+["']([^"']+)["']/gm],
    decls: [],
  },
};

function langOf(extLower) { return LANG_BY_EXT[extLower] || null; }
function supportedExts() { return Object.keys(LANG_BY_EXT); }

function extractMultiLang({ relPath, fullPath, body, lang, createdBy, aliases, fileSet, resolveOne }) {
  const cfg = PATTERNS[lang];
  if (!cfg) return null;
  const id = makeIdFromLabel(relPath, 'code');
  const nodes = [{
    id,
    label: sanitizeLabel(path.basename(relPath)),
    kind: 'code',
    source: { type: 'file', ref: relPath, file: fullPath },
    sourceLocation: { file: relPath },
    createdBy,
    createdAt: new Date().toISOString(),
    tags: ['code', lang, path.extname(relPath).slice(1) || lang],
  }];
  const edges = [];

  for (const re of cfg.imports) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body))) {
      const spec = m[1];
      if (!spec) continue;
      const { target, unresolved } = resolveOne
        ? resolveOne(spec, relPath, aliases, fileSet, lang === 'css' ? 'css' : 'js')
        : { target: `ext_${normalizeId(spec)}`, unresolved: true };
      edges.push({
        source: id, target, relation: 'imports',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
        ...(unresolved ? { unresolved: true, spec } : {}),
      });
    }
  }

  for (const decl of cfg.decls) {
    decl.re.lastIndex = 0;
    let m;
    while ((m = decl.re.exec(body))) {
      const name = decl.nameGroup ? m[decl.nameGroup] : m[1];
      if (!name) continue;
      const subId = `${id}__${normalizeId(name)}`;
      const line = body.slice(0, m.index).split('\n').length;
      nodes.push({
        id: subId,
        label: sanitizeLabel(decl.kind === 'function' || decl.kind === 'method' ? `${name}()` : name),
        kind: 'code',
        source: { type: 'symbol', ref: name, file: relPath, lang, symbolKind: decl.kind },
        sourceLocation: { file: relPath, line },
        createdBy,
        createdAt: new Date().toISOString(),
        tags: ['symbol', decl.kind, lang],
      });
      edges.push({
        source: id, target: subId, relation: 'defines',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }
  }

  return { nodes, edges, rawCalls: null };
}

module.exports = { extractMultiLang, langOf, supportedExts, PATTERNS };
