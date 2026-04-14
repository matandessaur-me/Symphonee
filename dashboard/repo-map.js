/**
 * DevOps Pilot -- Repo Map
 *
 * Token-budgeted symbol graph of a repository. Injected into worker
 * prompts so they don't waste tokens grepping around to learn the
 * codebase structure.
 *
 * Pragmatic implementation: regex-based symbol extraction per language.
 * Skips tree-sitter to avoid native binary headaches across platforms.
 * Covers JS/TS, Python, C#, Go, Rust, Java, Kotlin, Ruby, PHP. Other
 * files contribute structure (path, size) but no symbols.
 *
 * Output is a fixed-budget markdown summary: language(s), entry points,
 * top-level layout, and the most important files with their key
 * symbols. Cached per-commit (git HEAD sha) so a repeat call is free.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', 'target',
  '__pycache__', '.cache', '.vercel', '.netlify', '.turbo', 'coverage',
  '.devops-pilot', '.ai-workspace', 'venv', '.venv', 'env', '.env', 'bin', 'obj',
  'vendor', '.idea', '.vscode',
]);

const SKIP_FILES = new Set([
  '.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'poetry.lock', 'Pipfile.lock', 'composer.lock', 'go.sum',
]);

const LANG_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
};

const SOURCE_EXTS = new Set(Object.keys(LANG_BY_EXT));
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', '.csproj'];

function getCommitSha(repoPath) {
  try { return execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim(); }
  catch (_) { return null; }
}

function getCommitCounts(repoPath, files, sinceDays = 90) {
  // Returns { file: commitCount } for files modified within the window.
  const counts = {};
  try {
    const out = execSync(`git log --since="${sinceDays} days ago" --pretty=format: --name-only`, { cwd: repoPath }).toString();
    for (const line of out.split('\n')) {
      const f = line.trim();
      if (!f) continue;
      counts[f] = (counts[f] || 0) + 1;
    }
  } catch (_) {}
  const out = {};
  for (const f of files) out[f] = counts[f] || 0;
  return out;
}

function walkRepo(root) {
  const out = [];
  function walk(dir, rel) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      const r = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, r);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        if (stat.size > 1024 * 1024) continue; // skip > 1MB
        out.push({ rel: r, full, size: stat.size, ext: path.extname(entry.name).toLowerCase() });
      }
    }
  }
  walk(root, '');
  return out;
}

// ── Symbol extractors per language (regex; deliberately conservative) ──────
function extractSymbols(text, lang) {
  const symbols = [];
  const lines = text.split('\n');
  const matchers = SYMBOL_PATTERNS[lang] || [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of matchers) {
      const r = m.regex.exec(line);
      if (r) {
        symbols.push({ kind: m.kind, name: r[1], line: i + 1 });
      }
      m.regex.lastIndex = 0; // safe reset
    }
  }
  return symbols.slice(0, 40);
}

const SYMBOL_PATTERNS = {
  javascript: [
    { kind: 'class',    regex: /^\s*(?:export\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][\w]*)/ },
    { kind: 'const',    regex: /^\s*(?:export\s+)?const\s+([A-Z_][A-Z0-9_]{2,})\s*=/ },
    { kind: 'arrow',    regex: /^\s*(?:export\s+)?(?:const|let)\s+([a-zA-Z_][\w]*)\s*=\s*(?:async\s*)?\(/ },
  ],
  typescript: [
    { kind: 'class',     regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'type',      regex: /^\s*(?:export\s+)?type\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'function',  regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][\w]*)/ },
    { kind: 'arrow',     regex: /^\s*(?:export\s+)?(?:const|let)\s+([a-zA-Z_][\w]*)\s*[:=]/ },
  ],
  python: [
    { kind: 'class',    regex: /^class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'function', regex: /^(?:async\s+)?def\s+([a-zA-Z_][\w]*)/ },
  ],
  csharp: [
    { kind: 'class',     regex: /^\s*(?:public|private|protected|internal)?\s*(?:abstract\s+|sealed\s+|static\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'interface', regex: /^\s*(?:public|private|protected|internal)?\s*interface\s+(I[A-Z][A-Za-z0-9_]*)/ },
    { kind: 'method',    regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+|virtual\s+|override\s+|async\s+)?[A-Za-z<>\[\]]+\s+([A-Z][A-Za-z0-9_]*)\s*\(/ },
  ],
  go: [
    { kind: 'function', regex: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z][\w]*)\s*\(/ },
    { kind: 'type',     regex: /^type\s+([A-Z][A-Za-z0-9_]*)\s+(?:struct|interface)/ },
  ],
  rust: [
    { kind: 'struct',   regex: /^pub\s+struct\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'enum',     regex: /^pub\s+enum\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'function', regex: /^pub\s+(?:async\s+)?fn\s+([a-z_][\w]*)/ },
    { kind: 'trait',    regex: /^pub\s+trait\s+([A-Z][A-Za-z0-9_]*)/ },
  ],
  java: [
    { kind: 'class',     regex: /^\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+|static\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'interface', regex: /^\s*(?:public|private|protected)?\s*interface\s+([A-Z][A-Za-z0-9_]*)/ },
  ],
  kotlin: [
    { kind: 'class', regex: /^\s*(?:open\s+|abstract\s+|data\s+|sealed\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'fun',   regex: /^\s*(?:override\s+|suspend\s+)?fun\s+([a-zA-Z_][\w]*)\s*\(/ },
  ],
  ruby: [
    { kind: 'class',  regex: /^\s*class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'module', regex: /^\s*module\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'def',    regex: /^\s*def\s+([a-z_][\w]*[!?=]?)/ },
  ],
  php: [
    { kind: 'class',    regex: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'function', regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([a-zA-Z_][\w]*)/ },
  ],
  swift: [
    { kind: 'class',    regex: /^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?class\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'struct',   regex: /^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?struct\s+([A-Z][A-Za-z0-9_]*)/ },
    { kind: 'function', regex: /^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?func\s+([a-zA-Z_][\w]*)/ },
  ],
};

// ── Public API ──────────────────────────────────────────────────────────────
const _cache = new Map(); // repoPath -> { sha, budget, output }

async function buildRepoMap({ repoPath, repoName, budget = 4000 }) {
  if (!repoPath || !fs.existsSync(repoPath)) throw new Error('repoPath does not exist');
  const sha = getCommitSha(repoPath) || 'no-git';
  const cacheKey = `${repoPath}::${budget}`;
  const cached = _cache.get(cacheKey);
  if (cached && cached.sha === sha) return cached.output;

  const files = walkRepo(repoPath);
  const sourceFiles = files.filter(f => SOURCE_EXTS.has(f.ext));
  const manifestFiles = files.filter(f => MANIFESTS.includes(path.basename(f.rel)));

  // Detect dominant languages
  const langCount = {};
  for (const f of sourceFiles) {
    const lang = LANG_BY_EXT[f.ext];
    if (lang) langCount[lang] = (langCount[lang] || 0) + 1;
  }
  const langs = Object.entries(langCount).sort((a, b) => b[1] - a[1]).map(([l]) => l);

  // Rank files by recent commit activity and proximity to root
  const commits = getCommitCounts(repoPath, sourceFiles.map(f => f.rel.replace(/\\/g, '/')));
  const rankedFiles = sourceFiles
    .map(f => {
      const depth = (f.rel.match(/\//g) || []).length;
      const commitCount = commits[f.rel.replace(/\\/g, '/')] || 0;
      // Higher = more important: high commit count, low depth, larger size to a point
      const score = commitCount * 5 + Math.max(0, 6 - depth) + Math.min(20, Math.log2(f.size + 1));
      return { ...f, depth, commitCount, score };
    })
    .sort((a, b) => b.score - a.score);

  // Top-level layout
  const topDirs = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    if (parts.length > 1) topDirs.add(parts[0]);
  }

  // Manifest summary
  const manifestSummary = [];
  for (const m of manifestFiles) {
    let raw = '';
    try { raw = fs.readFileSync(m.full, 'utf8'); } catch (_) { continue; }
    const name = path.basename(m.rel);
    if (name === 'package.json') {
      try {
        const j = JSON.parse(raw);
        manifestSummary.push(`- **package.json**: ${j.name || '(unnamed)'} v${j.version || '?'}, deps=${Object.keys(j.dependencies || {}).length}, scripts=${Object.keys(j.scripts || {}).join(', ').slice(0, 120) || '(none)'}`);
      } catch (_) { manifestSummary.push(`- **${name}** (unparseable)`); }
    } else {
      manifestSummary.push(`- **${name}** (${raw.split('\n').length} lines)`);
    }
  }

  // Build markdown output, token-budgeted
  // Rough: 1 token ~= 4 chars. budget=4000 tokens ~= 16k chars.
  const charBudget = budget * 4;
  let out = '';
  out += `# Repo map: ${repoName || path.basename(repoPath)}\n\n`;
  out += `**Languages**: ${langs.join(', ') || 'unknown'} | **Files**: ${sourceFiles.length} source / ${files.length} total | **HEAD**: ${sha.slice(0, 8)}\n\n`;
  if (manifestSummary.length) {
    out += `## Manifests\n${manifestSummary.join('\n')}\n\n`;
  }
  out += `## Top-level layout\n`;
  for (const d of Array.from(topDirs).sort()) {
    const nFiles = files.filter(f => f.rel.startsWith(d + '/')).length;
    out += `- \`${d}/\` (${nFiles} files)\n`;
  }
  out += `\n## Top files (ranked by recent activity + structure)\n\n`;

  for (const f of rankedFiles) {
    if (out.length > charBudget) break;
    const lang = LANG_BY_EXT[f.ext];
    let symbols = [];
    try {
      const raw = fs.readFileSync(f.full, 'utf8');
      symbols = extractSymbols(raw, lang);
    } catch (_) {}
    out += `### \`${f.rel}\``;
    if (f.commitCount > 0) out += ` _(${f.commitCount} recent commits)_`;
    out += '\n';
    if (symbols.length) {
      const summary = symbols.slice(0, 12).map(s => `${s.kind} **${s.name}**`).join(', ');
      out += summary + '\n\n';
    } else {
      out += '_(no symbols extracted)_\n\n';
    }
  }

  _cache.set(cacheKey, { sha, output: out });
  return out;
}

function clearCache() { _cache.clear(); }

module.exports = { buildRepoMap, clearCache, walkRepo, extractSymbols };
