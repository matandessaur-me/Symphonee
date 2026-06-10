'use strict';
// Skill Reflection -- the REFLECT -> LEARN arc of the cognitive loop.
//
// It mines Mind's accumulated corrections/lessons (and the learnings ledger) into
// *proposed* skills, so the system improves its own PROCEDURES, not just its
// knowledge. Propose-only by default: it drafts, the user accepts. Accepting
// materializes a real SKILL.md via the corpus, so every CLI then inherits it.
//
// Safe by construction: read-only over Mind, never auto-edits a skill, never
// touches anything outward-facing. The whole point is "you correct the system
// once and it becomes structural" -- this is what notices the correction.

const fs = require('fs');
const path = require('path');
const store = require('./mind/store');
const llm = require('./lib/llm');
const corpus = require('./skill-corpus');

// Procedural memory kinds -- corrections about HOW to work. 'decision'/'fact' are
// knowledge (Mind's job), so they are excluded from skill proposals.
const PROCEDURAL_KINDS = ['lesson', 'gotcha', 'pattern', 'preference', 'constraint'];

const STOP = new Set(('the a an of to and or for with in on at by is are be do does how what when use using only not no your you we our this that it its from into over per via about more most less can will should must may give given take takes goes go done first then now also just').split(' '));

function tokens(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}
function sigTokens(s) {
  return new Set(tokens(s).filter(t => t.length > 2 && !STOP.has(t)));
}
function overlap(aSet, bSet) {
  let n = 0;
  for (const t of aSet) if (bSet.has(t)) n++;
  return n;
}

function proposalsDir(repoRoot) { return path.join(corpus.corpusDir(repoRoot), '.proposals'); }

function loadProposals(repoRoot) {
  const dir = proposalsDir(repoRoot);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) {}
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

function saveProposal(repoRoot, p) {
  const dir = proposalsDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, p.id + '.json'), JSON.stringify(p, null, 2), 'utf8');
}

function removeProposal(repoRoot, id) {
  try { fs.unlinkSync(path.join(proposalsDir(repoRoot), corpus.safeId(id) + '.json')); } catch (_) {}
}

// Draft a SKILL.md proposal from one or more correction cards. Local LLM first
// (money rule: on-device before REST); a deterministic scaffold as fallback so
// the loop still produces a usable draft with no model running.
async function draftSkill(cards) {
  const primary = cards[0];
  const sourceText = cards.map(c => `- (${c.kindOfMemory || 'note'}) ${c.label}: ${String(c.body || '').slice(0, 400)}`).join('\n');
  const tags = Array.from(new Set(cards.flatMap(c => (c.tags || []).filter(t => t && t !== 'memory')))).slice(0, 6);

  let model = null;
  try { model = llm.pickChatModel(); } catch (_) {}
  if (model) {
    const sys = 'You convert recorded lessons/corrections about HOW to work into ONE reusable procedure. Output STRICT JSON only: {"name","description","when","tags","body"}. name = short imperative capability. description = one line: what it does + when to use it. when = short trigger phrase. tags = array of short strings. body = markdown with EXACTLY these sections in order: "## Use when", "## Do not use when", "## Steps (primary path)" (numbered, concrete, ordered), "## Safety", "## Verification". Model-neutral, plain ASCII, concise. No preamble.';
    const usr = `Turn these recorded corrections into one skill:\n${sourceText}\n\nReturn the JSON.`;
    try {
      const r = await llm.chatOllama(
        [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        { format: 'json', temperature: 0.2, numPredict: 900, timeoutMs: 60000 }
      );
      const j = r && r.json ? r.json : null;
      if (j && j.name && j.description && j.body) {
        return {
          name: String(j.name).slice(0, 80),
          description: String(j.description).slice(0, 220),
          when: String(j.when || '').slice(0, 160),
          tags: Array.isArray(j.tags) && j.tags.length ? j.tags.map(String).slice(0, 6) : tags,
          body: String(j.body).trim(),
          draftedBy: r.model || model,
        };
      }
    } catch (_) { /* fall through to scaffold */ }
  }

  // Heuristic scaffold (no model / bad JSON): still a valid, editable draft.
  const name = primary.label.replace(/\s+/g, ' ').trim().slice(0, 80);
  const firstSentence = String(primary.body || primary.label).split(/(?<=[.!?])\s/)[0].slice(0, 200);
  const body = [
    '## Use when',
    '- ' + (cards[0].label || 'the situation this correction described') + ' applies.',
    '',
    '## Do not use when',
    '- The situation is unrelated to the recorded lesson(s) below.',
    '',
    '## Steps (primary path)',
    '1. ' + firstSentence,
    ...cards.slice(1, 4).map((c, i) => `${i + 2}. ${String(c.body || c.label).slice(0, 200)}`),
    '',
    '## Safety',
    '- Follow the constraint exactly as recorded; do not regress to the prior behaviour.',
    '',
    '## Verification',
    '- The recorded correction is now satisfied and would not recur.',
    '',
    '> Drafted from Mind cards: ' + cards.map(c => c.id).join(', ') + '. Review and refine before accepting.',
  ].join('\n');
  return { name, description: firstSentence, when: '', tags, body, draftedBy: 'scaffold' };
}

// Is this card already covered by an existing skill? Conservative token overlap
// so we propose genuinely-new procedures and skip near-duplicates.
function coveredBySkill(card, skills) {
  const cardTok = sigTokens(card.label + ' ' + (card.tags || []).join(' '));
  for (const s of skills) {
    const skillTok = sigTokens(s.name + ' ' + s.description + ' ' + (s.tags || []).join(' '));
    if (overlap(cardTok, skillTok) >= 3) return true;
  }
  return false;
}

function mountReflection(addRoute, json, ctx) {
  const { repoRoot, getUiContext, broadcast } = ctx;
  const getSpace = () => {
    const c = getUiContext ? getUiContext() : {};
    return c.activeSpace || c.notesNamespace || '_global';
  };

  // Mine Mind for procedural corrections not yet covered by a skill, draft a
  // proposal for each, persist as pending. Returns the proposals. Never throws.
  async function runDigest({ max = 5 } = {}) {
    const space = getSpace();
    let g = null;
    try { g = store.loadGraph(repoRoot, space); } catch (_) {}
    if (!g || !Array.isArray(g.nodes)) return { ok: false, reason: 'no-graph', proposals: [] };

    const skills = corpus.catalog(repoRoot);
    const existingProposals = loadProposals(repoRoot);
    const proposedCardIds = new Set(existingProposals.flatMap(p => p.sourceCardIds || []));

    // Candidate cards: procedural-kind memories, newest first, not already
    // covered by a skill or an open proposal.
    const cards = g.nodes
      .filter(n => n && n.kind === 'memory' && PROCEDURAL_KINDS.includes(n.kindOfMemory))
      .filter(n => !proposedCardIds.has(n.id))
      .filter(n => !coveredBySkill(n, skills))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, max);

    const proposals = [];
    for (const card of cards) {
      const draft = await draftSkill([card]);
      const id = corpus.safeId(draft.name || card.label) || ('skill-' + card.id.slice(-6));
      // Skip if a skill with this id already exists (accepted earlier).
      if (skills.find(s => s.id === id)) continue;
      const p = {
        id,
        name: draft.name,
        description: draft.description,
        when: draft.when,
        tags: draft.tags,
        body: draft.body,
        sourceCardIds: [card.id],
        sourceLabels: [card.label],
        draftedBy: draft.draftedBy,
        status: 'proposed',
        createdAt: new Date().toISOString(),
      };
      try { saveProposal(repoRoot, p); proposals.push(p); } catch (_) {}
    }
    if (proposals.length && broadcast) {
      try { broadcast({ type: 'skills-changed', payload: { action: 'proposals', count: proposals.length } }); } catch (_) {}
    }
    return { ok: true, proposals, scanned: cards.length };
  }

  // Run the digest now.
  addRoute('POST', '/api/skills/reflect', async (req, res) => {
    const out = await runDigest({ max: 8 });
    return json(res, out);
  });

  // List pending proposals.
  addRoute('GET', '/api/skills/proposals', (req, res) => {
    const proposals = loadProposals(repoRoot).filter(p => p.status === 'proposed');
    return json(res, { ok: true, total: proposals.length, proposals });
  });

  // Accept a proposal -> materialize a real skill via the corpus, drop the proposal.
  addRoute('POST', '/api/skills/proposals/accept', async (req, res) => {
    const b = await readBody(req).catch(() => ({}));
    const id = corpus.safeId(b.id);
    const p = loadProposals(repoRoot).find(x => x.id === id);
    if (!p) return json(res, { ok: false, error: 'proposal not found' }, 404);
    // Allow the caller to override the draft before accepting.
    const skill = {
      id,
      name: b.name || p.name,
      description: b.description || p.description,
      when: b.when != null ? b.when : p.when,
      tags: b.tags || p.tags,
      body: b.body || p.body,
    };
    try {
      const dir = path.join(corpus.corpusDir(repoRoot), id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), corpus.renderSkill(skill), 'utf8');
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
    removeProposal(repoRoot, id);
    try { if (broadcast) broadcast({ type: 'skills-changed', payload: { action: 'accept', id } }); } catch (_) {}
    return json(res, { ok: true, id });
  });

  // Reject a proposal -> drop it.
  addRoute('POST', '/api/skills/proposals/reject', async (req, res) => {
    const b = await readBody(req).catch(() => ({}));
    const id = corpus.safeId(b.id);
    removeProposal(repoRoot, id);
    try { if (broadcast) broadcast({ type: 'skills-changed', payload: { action: 'reject', id } }); } catch (_) {}
    return json(res, { ok: true, id });
  });

  return { runDigest, loadProposals: () => loadProposals(repoRoot) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = { mountReflection };
