'use strict';
// Symphonee Skill Corpus -- the PROCEDURAL layer of the cognitive loop.
//
// Skills are model-neutral SKILL.md recipes ("how to do X well, the same way,
// every time") that every CLI loads, so behaviour is CONSISTENT across CLIs and
// sessions. This sits alongside the other two memory layers:
//   - Mind     = knowledge ("what we know / decided")          -> /api/mind/*
//   - plugins  = integrations ("how to reach a system")        -> /api/plugins/*
//   - SKILLS   = procedures ("how WE do a task, step by step")  -> /api/skills/*
//
// A skill is a directory under <repoRoot>/skills/<id>/SKILL.md with YAML-ish
// frontmatter (name, description, when?, tags?) and a markdown body. The body is
// the executable procedure; the catalog (name/description/when) is what gets
// injected into bootstrap + dispatched-worker prompts so an agent knows a skill
// exists and fetches the full body on demand.

const fs = require('fs');
const path = require('path');

function corpusDir(repoRoot) { return path.join(repoRoot, 'skills'); }

function safeId(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Parse a SKILL.md: leading --- frontmatter --- then markdown body. Frontmatter
// is simple `key: value` lines (no nested YAML) so the parser stays dependency
// free and matches how the rest of Symphonee reads small structured files.
function parseSkill(raw, id) {
  const fm = {};
  let body = String(raw || '');
  const m = body.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (mm) fm[mm[1].trim()] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const tags = (fm.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    id,
    name: fm.name || id,
    description: fm.description || '',
    when: fm.when || '',
    tags,
    body: body.trim(),
    valid: !!(fm.name && fm.description),
  };
}

// Load every skill in the corpus. Never throws -- a missing/empty corpus yields
// an empty list so bootstrap and dispatch keep working before any skill exists.
function loadCorpus(repoRoot) {
  const dir = corpusDir(repoRoot);
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e || !e.isDirectory()) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'); } catch (_) { continue; }
    out.push(parseSkill(raw, e.name));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// Light catalog (no body) for prompts/bootstrap.
function catalog(repoRoot) {
  return loadCorpus(repoRoot).map(s => ({
    id: s.id, name: s.name, description: s.description, when: s.when, tags: s.tags, valid: s.valid,
  }));
}

// Compact text block listing skills, for injection into a dispatched worker's
// prompt. The worker fetches the full procedure body on demand.
function catalogText(repoRoot, { max = 24 } = {}) {
  const cat = catalog(repoRoot);
  if (!cat.length) return '';
  const lines = cat.slice(0, max).map(s => {
    const trigger = s.when ? ` (when: ${s.when})` : '';
    return `  - ${s.id}: ${s.description}${trigger}`;
  });
  return `[skills: ${cat.length}] Reusable procedures for HOW to do common tasks consistently. ` +
    `Before substantive work, if one matches, fetch and FOLLOW it: GET /api/skills/item?id=<id>.\n` +
    lines.join('\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Render a skill object back to SKILL.md text (used by the author/upsert route,
// which is the seed of the learning loop: the system can write its own skills).
function renderSkill({ name, description, when, tags, body }) {
  const fm = ['---', `name: ${name}`, `description: ${description}`];
  if (when) fm.push(`when: ${when}`);
  if (tags && tags.length) fm.push(`tags: ${Array.isArray(tags) ? tags.join(', ') : tags}`);
  fm.push('---', '');
  return fm.join('\n') + '\n' + String(body || '').trim() + '\n';
}

function mountSkills(addRoute, json, ctx) {
  const { repoRoot, broadcast } = ctx;

  // List the catalog (no bodies).
  addRoute('GET', '/api/skills', (req, res) => {
    const cat = catalog(repoRoot);
    return json(res, { ok: true, total: cat.length, skills: cat });
  });

  // Fetch one full skill (the executable procedure body).
  addRoute('GET', '/api/skills/item', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = safeId(url.searchParams.get('id'));
    if (!id) return json(res, { ok: false, error: 'id required' }, 400);
    const skill = loadCorpus(repoRoot).find(s => s.id === id);
    if (!skill) return json(res, { ok: false, error: 'not found' }, 404);
    return json(res, { ok: true, skill });
  });

  // Author or update a skill. This is the learning-loop seed: a correction or a
  // recurring procedure becomes a durable, shared skill the next CLI inherits.
  addRoute('POST', '/api/skills', async (req, res) => {
    const b = await readBody(req).catch(() => ({}));
    const id = safeId(b.id || b.name);
    const name = String(b.name || '').trim();
    const description = String(b.description || '').trim();
    const body = String(b.body || '').trim();
    if (!id || !name || !description || !body) {
      return json(res, { ok: false, error: 'id/name, description and body are required' }, 400);
    }
    const dir = path.join(corpusDir(repoRoot), id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const text = renderSkill({ name, description, when: b.when, tags: b.tags, body });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
    try { if (broadcast) broadcast({ type: 'skills-changed', payload: { action: 'upsert', id } }); } catch (_) {}
    return json(res, { ok: true, id });
  });

  // Remove a skill from the corpus.
  addRoute('DELETE', '/api/skills/item', async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = safeId(url.searchParams.get('id'));
    if (!id) return json(res, { ok: false, error: 'id required' }, 400);
    const dir = path.join(corpusDir(repoRoot), id);
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(corpusDir(repoRoot)))) {
      return json(res, { ok: false, error: 'invalid id' }, 403);
    }
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
    try { if (broadcast) broadcast({ type: 'skills-changed', payload: { action: 'delete', id } }); } catch (_) {}
    return json(res, { ok: true, id });
  });

  // Surface the catalog in /api/bootstrap so EVERY CLI session opens knowing
  // which procedures exist (it fetches the body of the one it needs).
  return {
    bootstrapField() {
      const cat = catalog(repoRoot);
      return {
        enabled: cat.length > 0,
        total: cat.length,
        skills: cat,
        itemUrl: '/api/skills/item?id=<id>',
        listUrl: '/api/skills',
        message: cat.length
          ? 'Reusable procedures for HOW to do common tasks the same way every time. Before substantive work, check whether a skill matches; if so fetch its body (GET /api/skills/item?id=<id>) and FOLLOW it. When the user corrects a procedure or you find a better repeatable way, author a skill (POST /api/skills) so every future session of every CLI inherits it.'
          : 'No skills authored yet. Author the first with POST /api/skills.',
      };
    },
    catalogText: (opts) => catalogText(repoRoot, opts),
    loadCorpus: () => loadCorpus(repoRoot),
    catalog: () => catalog(repoRoot),
  };
}

module.exports = { mountSkills, loadCorpus, catalog, catalogText, parseSkill, renderSkill, safeId, corpusDir };
