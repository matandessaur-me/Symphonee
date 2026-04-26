/**
 * CLI skills/agents/plugins extractor.
 *
 * Each AI CLI ships its own user-level pack of reusable procedures:
 *
 *   Claude Code    ~/.claude/agents/<name>.md                            (kind: agent)
 *                  ~/.claude/plugins/marketplaces/<mkt>/plugins/<pkg>/   (kind: plugin)
 *   Codex (OpenAI) ~/.codex/skills/.system/<name>/SKILL.md               (kind: skill)
 *                  ~/.codex/skills/<name>/SKILL.md                       (user-installed)
 *   Qwen Code      ~/.qwen/skills/<name>/SKILL.md                        (kind: skill)
 *
 * The on-disk format is uniform: YAML frontmatter (`name`, `description`,
 * sometimes `model`, `metadata`) plus a markdown body describing the
 * procedure. Same shape across vendors, so one extractor handles all three.
 *
 * Why ingest these into the brain: a procedure Claude has as an agent is
 * usable knowledge for Codex/Gemini/Grok, even though they cannot literally
 * invoke Claude's Agent runtime. The skill body is the *procedure*; reading
 * it lets any CLI execute the same workflow manually. The brain is where
 * that cross-CLI knowledge accrues.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractMarkdown } = require('./markdown');
const { sanitizeLabel } = require('../security');
const { normalizeId } = require('../ids');

const HOME = os.homedir();

// Each source declares: provider tag, kind tag, and a function that returns
// an array of { id, label, body, sourcePath, frontmatter? } items.
const SOURCES = [
  { provider: 'claude', kind: 'agent',  scan: () => scanFlatMarkdown(path.join(HOME, '.claude', 'agents'), 'claude_agent') },
  { provider: 'claude', kind: 'plugin', scan: () => scanClaudePluginMarketplaces(path.join(HOME, '.claude', 'plugins', 'marketplaces')) },
  { provider: 'codex',  kind: 'skill',  scan: () => scanSkillFolders(path.join(HOME, '.codex', 'skills'), 'codex_skill') },
  { provider: 'qwen',   kind: 'skill',  scan: () => scanSkillFolders(path.join(HOME, '.qwen', 'skills'), 'qwen_skill') },
];

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

// Claude-style: ~/.claude/agents/*.md - flat list of single markdown files.
function scanFlatMarkdown(dir, idPrefix) {
  const out = [];
  for (const ent of safeReaddir(dir)) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    if (ent.name === 'CLAUDE.md') continue; // not an agent, just user prefs
    const full = path.join(dir, ent.name);
    const body = safeRead(full);
    if (body == null) continue;
    const stem = ent.name.replace(/\.md$/, '');
    out.push({
      id: `${idPrefix}_${normalizeId(stem)}`,
      label: stem,
      body,
      sourcePath: full,
    });
  }
  return out;
}

// Codex/Qwen-style: <root>/<skill-or-namespace>/SKILL.md
// Walks one level deep and one level under .system/ since codex hides
// system-installed skills there.
function scanSkillFolders(root, idPrefix) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 3 || seen.has(dir)) return;
    seen.add(dir);
    for (const ent of safeReaddir(dir)) {
      if (!ent.isDirectory()) continue;
      const sub = path.join(dir, ent.name);
      const skillFile = path.join(sub, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const body = safeRead(skillFile);
        if (body != null) {
          out.push({
            id: `${idPrefix}_${normalizeId(ent.name)}`,
            label: ent.name,
            body,
            sourcePath: skillFile,
          });
        }
      } else {
        // descend - handles .system/ wrapper and user namespaces
        walk(sub, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

// Claude plugin marketplaces: ~/.claude/plugins/marketplaces/<mkt>/plugins/<pkg>/
// Each plugin folder usually has a plugin.json or README.md. We don't have a
// uniform manifest format so we fall back to README.md and synthesize a label.
function scanClaudePluginMarketplaces(root) {
  const out = [];
  for (const mkt of safeReaddir(root)) {
    if (!mkt.isDirectory()) continue;
    const pluginsDir = path.join(root, mkt.name, 'plugins');
    for (const pkg of safeReaddir(pluginsDir)) {
      if (!pkg.isDirectory()) continue;
      const pkgRoot = path.join(pluginsDir, pkg.name);
      // Prefer a manifest file; fall back to README.
      const candidates = ['plugin.json', 'manifest.json', 'package.json', 'README.md', 'README.markdown'];
      let body = null;
      let sourcePath = null;
      for (const c of candidates) {
        const f = path.join(pkgRoot, c);
        const b = safeRead(f);
        if (b != null) { body = b; sourcePath = f; break; }
      }
      if (body == null) continue;
      // If we picked a JSON manifest, synthesize a markdown body so the
      // markdown extractor can index headings/links.
      if (sourcePath.endsWith('.json')) {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) { /* leave raw */ }
        if (parsed && typeof parsed === 'object') {
          const lines = [];
          if (parsed.name) lines.push(`# ${parsed.name}`);
          if (parsed.description) lines.push('', parsed.description);
          if (Array.isArray(parsed.keywords) && parsed.keywords.length) {
            lines.push('', `Keywords: ${parsed.keywords.join(', ')}`);
          }
          body = lines.join('\n') || body;
        }
      }
      out.push({
        id: `claude_plugin_${normalizeId(mkt.name)}_${normalizeId(pkg.name)}`,
        label: `${pkg.name} (${mkt.name})`,
        body,
        sourcePath,
      });
    }
  }
  return out;
}

function extractCliSkills({ createdBy = 'mind/cli-skills' } = {}) {
  const fragments = [];
  let scanned = 0;
  const perSource = {};

  for (const src of SOURCES) {
    const items = src.scan();
    perSource[`${src.provider}_${src.kind}`] = items.length;
    if (!items.length) continue;
    scanned += items.length;

    for (const it of items) {
      // The skill body becomes a 'doc' node (skill/agent/plugin aren't all
      // in NODE_KINDS; we tag the role instead so query.js can filter on
      // tagged_with kind:skill / kind:agent / kind:plugin).
      const nodeKind = src.kind === 'plugin' ? 'plugin' : 'doc';
      const frag = extractMarkdown({
        id: it.id,
        label: `${it.label} [${src.provider} ${src.kind}]`,
        kind: nodeKind,
        source: {
          type: 'cli-skill',
          ref: it.sourcePath,
          cli: src.provider,
          skillKind: src.kind,
        },
        body: it.body,
        createdBy,
        tagPrefix: 'doc',
      });

      // Tag the node with provider and skill-kind so a query for
      // "what agents does the brain know about?" can filter.
      const cliTagId = `cli_${src.provider}`;
      const kindTagId = `skillkind_${src.kind}`;
      const now = new Date().toISOString();
      frag.nodes.push(
        {
          id: cliTagId, label: src.provider, kind: 'tag',
          source: { type: 'cli', ref: src.provider }, sourceLocation: null,
          createdBy, createdAt: now, tags: [],
        },
        {
          id: kindTagId, label: sanitizeLabel(`#${src.kind}`), kind: 'tag',
          source: { type: 'skillkind', ref: src.kind }, sourceLocation: null,
          createdBy, createdAt: now, tags: [],
        },
      );
      frag.edges.push(
        {
          source: it.id, target: cliTagId, relation: 'tagged_with',
          confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
          createdBy, createdAt: now,
        },
        {
          source: it.id, target: kindTagId, relation: 'tagged_with',
          confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
          createdBy, createdAt: now,
        },
      );

      fragments.push(frag);
    }
  }

  const nodes = []; const edges = [];
  for (const fr of fragments) { nodes.push(...fr.nodes); edges.push(...fr.edges); }
  return { nodes, edges, scanned, perSource };
}

module.exports = { extractCliSkills };
