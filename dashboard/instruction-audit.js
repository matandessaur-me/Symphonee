// Instruction coherence audit - runs on every server boot, every config
// save, and ships in the /api/bootstrap payload so every AI CLI sees the
// audit status at session start.
//
// Five checks (mirrors scripts/Audit-Instructions.ps1 exactly):
//   1. Hallucinated URLs - URLs mentioned in docs with no '/api/...' string
//      in dashboard/**/*.js source.
//   2. Required inline phrases - recognition-time triggers must live in
//      INSTRUCTIONS.base.md, not just the references.
//   3. Baseline atoms reachable - every atom in scripts/audit-baseline.txt
//      must be findable in the corpus (whitespace-insensitive). This is
//      the self-healing check.
//   4. Generated file sizes - CLAUDE.md and siblings under 40 KB.
//
// (Hidden routes is informational only and not exposed here.)

const fs = require('fs');
const path = require('path');

const REF_DOCS = [
  'dashboard/mind/instructions.md',
  'dashboard/instructions/apps-automation.md',
  'dashboard/instructions/browser-router.md',
];

const REQUIRED_INLINE_PHRASES = [
  { name: '/teach trigger: remember',         pattern: /remember/i },
  { name: '/teach trigger: from now on',      pattern: /from now on/i },
  { name: '/teach trigger: we decided/use',   pattern: /we (use|chose|picked|decided)/i },
  { name: '/teach trigger: prefer X over Y',  pattern: /prefer .* over/i },
  { name: '/teach trigger: watch out for',    pattern: /watch out for/i },
  { name: '/recall trigger: what did we',     pattern: /what did we/i },
  { name: '/recall trigger: have we worked',  pattern: /have we worked on/i },
  { name: '/recall trigger: what do I know',  pattern: /what do I know about/i },
  { name: 'Mind: POST /teach mentioned',      pattern: /\/api\/mind\/teach/i },
  { name: 'Mind: POST /recall mentioned',     pattern: /\/api\/mind\/recall/i },
  { name: 'Mind: POST /query mentioned',      pattern: /\/api\/mind\/query/i },
  { name: 'Mind: save-result mentioned',      pattern: /\/api\/mind\/save-result/i },
  { name: 'API token: env var mentioned',     pattern: /SYMPHONEE_TOKEN/i },
  { name: 'API token: header mentioned',      pattern: /x-symphonee-token/i },
  { name: 'API token: TOKEN_REQUIRED',         pattern: /TOKEN_REQUIRED/i },
  { name: 'Apps: /api/apps/do default',       pattern: /\/api\/apps\/do/i },
  { name: 'Apps: COM decision (Office)',      pattern: /\/api\/apps\/com/i },
  { name: 'Apps: stealth decision (UIA)',     pattern: /sandbox.*true/i },
  { name: 'Browser: router-first',            pattern: /\/api\/browser\/router/i },
  { name: 'Shell: powershell.exe (not pwsh)', pattern: /powershell\.exe/i },
  { name: 'Shell: Show-Diff.ps1 enforced',    pattern: /Show-Diff\.ps1/i },
  { name: 'Shell: never git diff',            pattern: /NEVER use .git diff/i },
  { name: 'Bootstrap: checksum tag',          pattern: /\[bootstrap:/i },
  { name: 'Bootstrap: activeRepo',            pattern: /activeRepo/i },
  { name: 'Bootstrap: activeRepoPath',        pattern: /activeRepoPath/i },
  { name: 'Plugins: ask before using',        pattern: /ASK the user/i },
  { name: 'Permissions: 403 deny = stop',     pattern: /403/i },
];

const GENERATED_FILES = [
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'GROK.md', 'QWEN.md',
  '.github/copilot-instructions.md',
];

const SIZE_WARNING_BYTES = 40000;

let _cached = null;

function loadFile(repoRoot, rel) {
  const p = path.join(repoRoot, rel);
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

function extractUrls(text) {
  const set = new Set();
  const re = /\/api\/[a-zA-Z0-9/_-]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = m[0].replace(/\?.*$/, '').replace(/\/+$/, '');
    if (u !== '/api') set.add(u);
  }
  return set;
}

function extractRoutesFromJs(repoRoot) {
  const set = new Set();
  const dashRoot = path.join(repoRoot, 'dashboard');
  if (!fs.existsSync(dashRoot)) return set;
  const re = /['"`](\/api\/[a-zA-Z0-9/_-]+)['"`]/g;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const f of entries) {
      if (f.name === 'node_modules' || f.name.startsWith('.')) continue;
      const fp = path.join(dir, f.name);
      if (f.isDirectory()) { walk(fp); continue; }
      if (!f.isFile() || !f.name.endsWith('.js') || f.name.endsWith('.test.js')) continue;
      let c;
      try { c = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
      let m;
      const localRe = new RegExp(re.source, re.flags);
      while ((m = localRe.exec(c)) !== null) {
        const u = m[1].replace(/\?.*$/, '').replace(/\/+$/, '');
        if (u !== '/api') set.add(u);
      }
    }
  }
  walk(dashRoot);
  return set;
}

function loadBaseline(repoRoot) {
  const p = path.join(repoRoot, 'scripts/audit-baseline.txt');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function normalize(s) {
  return s.replace(/\s+/g, '').toLowerCase();
}

function run({ repoRoot }) {
  const template = loadFile(repoRoot, 'INSTRUCTIONS.base.md');
  const refs = REF_DOCS.map(r => loadFile(repoRoot, r));
  const corpus = [template, ...refs].join('\n');
  const corpusNorm = normalize(corpus);

  // Check 1: hallucinated URLs
  const docUrls = extractUrls(corpus);
  const codeRoutes = extractRoutesFromJs(repoRoot);
  const hallucinated = [];
  for (const u of docUrls) {
    const base = u.replace(/\/\*$/, '');
    let found = false;
    for (const r of codeRoutes) {
      if (r === base || r.startsWith(base + '/') || base.startsWith(r + '/')) {
        found = true;
        break;
      }
    }
    if (!found) hallucinated.push(u);
  }

  // Check 2: required inline phrases (must be in the template, not just refs)
  const missingPhrases = REQUIRED_INLINE_PHRASES
    .filter(p => !p.pattern.test(template))
    .map(p => p.name);

  // Check 3: baseline atoms (whitespace-insensitive substring)
  const baseline = loadBaseline(repoRoot);
  const failedAtoms = baseline.filter(a => {
    const aNorm = normalize(a);
    return aNorm && !corpusNorm.includes(aNorm);
  });

  // Check 4: generated file sizes
  const oversized = [];
  const sizes = {};
  for (const f of GENERATED_FILES) {
    const p = path.join(repoRoot, f);
    if (!fs.existsSync(p)) continue;
    const sz = fs.statSync(p).size;
    sizes[f] = sz;
    if (sz > SIZE_WARNING_BYTES) oversized.push({ file: f, size: sz });
  }

  const checks = [
    {
      name: 'hallucinated-urls',
      ok: hallucinated.length === 0,
      summary: hallucinated.length === 0
        ? `All ${docUrls.size} doc URLs have a matching route in code.`
        : `${hallucinated.length} doc URL(s) have no matching route in code.`,
      details: { missing: hallucinated, totalDocUrls: docUrls.size, totalCodeRoutes: codeRoutes.size },
    },
    {
      name: 'required-inline-phrases',
      ok: missingPhrases.length === 0,
      summary: missingPhrases.length === 0
        ? `All ${REQUIRED_INLINE_PHRASES.length} recognition-time triggers present in INSTRUCTIONS.base.md.`
        : `${missingPhrases.length} recognition-time trigger(s) missing from INSTRUCTIONS.base.md.`,
      details: { missing: missingPhrases, total: REQUIRED_INLINE_PHRASES.length },
    },
    {
      name: 'baseline-atoms',
      ok: failedAtoms.length === 0,
      summary: failedAtoms.length === 0
        ? `All ${baseline.length} baseline atoms reachable in the corpus.`
        : `${failedAtoms.length} baseline atom(s) missing from corpus.`,
      details: { missing: failedAtoms, total: baseline.length },
    },
    {
      name: 'generated-file-sizes',
      ok: oversized.length === 0,
      summary: oversized.length === 0
        ? `All generated files under ${SIZE_WARNING_BYTES} bytes.`
        : `${oversized.length} generated file(s) over the warning threshold.`,
      details: { oversized, sizes, warningBytes: SIZE_WARNING_BYTES },
    },
  ];

  const ok = checks.every(c => c.ok);
  const result = {
    ok,
    ranAt: new Date().toISOString(),
    repoRoot,
    checks,
    // Flattened convenience fields the AI bootstrap can act on directly.
    failedChecks: checks.filter(c => !c.ok).map(c => c.name),
    failedAtoms,
    missingPhrases,
    hallucinatedUrls: hallucinated,
    oversizedFiles: oversized,
  };
  _cached = result;
  return result;
}

function getCached() { return _cached; }

module.exports = { run, getCached };
