/**
 * Cross-repo pattern analyser.
 *
 * Finds symbols, recipes, or notes whose canonical name appears in
 * 2+ different repos (via in_repo -> cwd_<slug> edges). If the same
 * concept shows up across projects, it might be worth extracting into
 * a shared library or template.
 *
 * Conservative for v1: only emits insights for symbols (functions /
 * components) where >= 2 repos contain a node with the exact same
 * canonical label. The LLM then names the extraction proposal.
 *
 * The "action" here is `extract-shared` which creates a note describing
 * the proposal — actually extracting code across two repos is too
 * destructive for an auto-button. The note becomes a todo the user
 * works through manually.
 */

'use strict';

const store = require('../store');
const llm = require('../llm');

const MIN_REPOS = 2;
const MAX_INSIGHTS = 3;
const ELIGIBLE_KINDS = new Set(['symbol', 'recipe', 'note']);

function _canonical(label) {
  if (!label || typeof label !== 'string') return '';
  return label
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')      // strip file extension
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function _repoSlugFromCwdId(id) {
  return typeof id === 'string' && id.startsWith('cwd_') ? id.slice(4) : null;
}

async function _llmName(label, repos) {
  if (!llm.pickChatModel()) {
    return {
      title: `Shared: ${label}`,
      summary: `'${label}' appears in ${repos.join(', ')}.`,
    };
  }
  const sys = [
    'You analyze a developer\'s knowledge graph to suggest extracting shared code.',
    'The same symbol or pattern appears in multiple separate repos. Suggest whether extraction is worth it and a short title for the proposal.',
    '',
    'Respond with JSON only. Schema:',
    '{',
    '  "is_useful": true | false,',
    '  "title": "<short title under 80 chars>" | null,',
    '  "summary": "<2-3 sentence rationale>" | null',
    '}',
    '',
    'is_useful=false when the name is generic (e.g. "index", "config", "App") or the repos are obviously unrelated.',
  ].join('\n');
  const user = `The symbol "${label}" appears in ${repos.length} repos: ${repos.join(', ')}. Worth extracting?`;
  try {
    const r = await llm.chatOllama([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { format: 'json', timeoutMs: 25_000, numPredict: 250 });
    return r.json || {};
  } catch (_) { return {}; }
}

async function detect({ repoRoot, space } = {}) {
  const g = store.loadGraph(repoRoot, space);
  if (!g) return [];
  // Build: nodeId -> set of repo slugs it belongs to.
  const inRepo = new Map();
  for (const e of (g.edges || [])) {
    if (e.relation !== 'in_repo') continue;
    const slug = _repoSlugFromCwdId(e.target);
    if (!slug) continue;
    if (!inRepo.has(e.source)) inRepo.set(e.source, new Set());
    inRepo.get(e.source).add(slug);
  }
  // Group eligible nodes by canonical label.
  const byCanon = new Map();
  for (const n of (g.nodes || [])) {
    if (!ELIGIBLE_KINDS.has(n.kind)) continue;
    const key = _canonical(n.label);
    if (!key || key.length < 3) continue;
    const slugs = inRepo.get(n.id);
    if (!slugs || slugs.size === 0) continue;
    if (!byCanon.has(key)) byCanon.set(key, { label: n.label, kind: n.kind, repos: new Set(), nodeIds: [] });
    const slot = byCanon.get(key);
    for (const s of slugs) slot.repos.add(s);
    slot.nodeIds.push(n.id);
  }
  const candidates = Array.from(byCanon.values())
    .filter(c => c.repos.size >= MIN_REPOS)
    .sort((a, b) => b.repos.size - a.repos.size)
    .slice(0, MAX_INSIGHTS);
  if (!candidates.length) return [];
  const out = [];
  for (const c of candidates) {
    const repos = Array.from(c.repos);
    const naming = await _llmName(c.label, repos);
    if (naming && naming.is_useful === false) continue;
    const title = `'${c.label}' lives in ${repos.length} repos -- extract to a shared spot?`;
    const body = [
      naming.summary || `'${c.label}' appears in ${repos.join(', ')}.`,
      '',
      'Repos:',
      ...repos.map(r => `  - ${r}`),
      '',
      'Acting on this creates a note titled "' + (naming.title || c.label) + '" so you can plan the extraction at your own pace.',
    ].join('\n');
    out.push({
      category: 'cross-repo',
      title,
      body,
      action: {
        type: 'extract-shared',
        payload: {
          symbol: c.label,
          kind: c.kind,
          repos,
          noteTitle: naming.title || `Extract shared: ${c.label}`,
          noteBody: naming.summary || body,
        },
      },
      evidence: c.nodeIds.slice(0, 8),
    });
  }
  return out;
}

module.exports = { detect };
