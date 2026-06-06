'use strict';
// Contracts -- the INTEND arc of the cognitive loop.
//
// A contract turns "improvise a multi-step task" into "commit to a reviewable
// plan with acceptance criteria, then prove each unit with evidence." It is the
// methodology layer that makes autonomous / overnight work trustworthy and
// auditable. Modeled on the intent -> plan -> review -> execute -> final-review
// shape, persisted so it survives sessions and any CLI can read where things are.
//
// Shape:
//   contract = {
//     id, title, phase, createdBy, createdAt, updatedAt,
//     intent: { restatement, constraints[], assumptions[], unknowns[] },
//     plan:   [{ id, goal, outputs, acceptance, deps[], status, evidence }],
//     review: { planApproved, finalApproved, notes }
//   }
// phase advances: intent -> plan -> review -> execute -> final -> done.

const fs = require('fs');
const path = require('path');

const PHASES = ['intent', 'plan', 'review', 'execute', 'final', 'done'];
const UNIT_STATUS = ['pending', 'in_progress', 'done', 'blocked'];

function dir(repoRoot) { return path.join(repoRoot, '.symphonee', 'contracts'); }
function safeId(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
function fileFor(repoRoot, id) { return path.join(dir(repoRoot), safeId(id) + '.json'); }

function load(repoRoot, id) {
  try { return JSON.parse(fs.readFileSync(fileFor(repoRoot, id), 'utf8')); } catch (_) { return null; }
}
function save(repoRoot, c) {
  fs.mkdirSync(dir(repoRoot), { recursive: true });
  c.updatedAt = new Date().toISOString();
  fs.writeFileSync(fileFor(repoRoot, c.id), JSON.stringify(c, null, 2), 'utf8');
  return c;
}
function list(repoRoot) {
  let files = [];
  try { files = fs.readdirSync(dir(repoRoot)).filter(f => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir(repoRoot), f), 'utf8'));
      const total = (c.plan || []).length;
      const done = (c.plan || []).filter(u => u.status === 'done').length;
      out.push({ id: c.id, title: c.title, phase: c.phase, progress: { done, total }, createdBy: c.createdBy, updatedAt: c.updatedAt });
    } catch (_) {}
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

function normalizeUnit(u, i) {
  return {
    id: safeId(u.id || ('t' + (i + 1))) || ('t' + (i + 1)),
    goal: String(u.goal || '').trim(),
    outputs: String(u.outputs || '').trim(),
    acceptance: String(u.acceptance || '').trim(),
    deps: Array.isArray(u.deps) ? u.deps.map(safeId).filter(Boolean) : [],
    status: UNIT_STATUS.includes(u.status) ? u.status : 'pending',
    evidence: String(u.evidence || '').trim(),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function mountContracts(addRoute, json, ctx) {
  const { repoRoot, broadcast } = ctx;

  // Create a contract. Requires title + intent.restatement; plan optional at
  // creation (often added after the intent is agreed).
  addRoute('POST', '/api/contracts', async (req, res) => {
    const b = await readBody(req).catch(() => ({}));
    const title = String(b.title || '').trim();
    const intent = b.intent || {};
    if (!title || !String(intent.restatement || '').trim()) {
      return json(res, { ok: false, error: 'title and intent.restatement are required' }, 400);
    }
    const id = safeId(b.id || title) || ('contract-' + Date.now().toString(36));
    const c = {
      id, title,
      phase: PHASES.includes(b.phase) ? b.phase : 'intent',
      createdBy: String(b.createdBy || 'unknown'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      intent: {
        restatement: String(intent.restatement || '').trim(),
        constraints: Array.isArray(intent.constraints) ? intent.constraints.map(String) : [],
        assumptions: Array.isArray(intent.assumptions) ? intent.assumptions.map(String) : [],
        unknowns: Array.isArray(intent.unknowns) ? intent.unknowns.map(String) : [],
      },
      plan: Array.isArray(b.plan) ? b.plan.map(normalizeUnit) : [],
      review: { planApproved: false, finalApproved: false, notes: '' },
    };
    try { save(repoRoot, c); } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    try { if (broadcast) broadcast({ type: 'contracts-changed', payload: { action: 'create', id } }); } catch (_) {}
    return json(res, { ok: true, id, contract: c });
  });

  addRoute('GET', '/api/contracts', (req, res) => {
    return json(res, { ok: true, contracts: list(repoRoot) });
  });

  addRoute('GET', '/api/contracts/item', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const c = load(repoRoot, url.searchParams.get('id'));
    if (!c) return json(res, { ok: false, error: 'not found' }, 404);
    return json(res, { ok: true, contract: c });
  });

  // Update a contract: set the plan, advance the phase, approve a gate, or update
  // units' status + evidence. Partial -- only the provided fields change.
  addRoute('POST', '/api/contracts/update', async (req, res) => {
    const b = await readBody(req).catch(() => ({}));
    const c = load(repoRoot, b.id);
    if (!c) return json(res, { ok: false, error: 'not found' }, 404);
    if (b.intent && typeof b.intent === 'object') {
      c.intent = { ...c.intent, ...b.intent };
    }
    if (Array.isArray(b.plan)) c.plan = b.plan.map(normalizeUnit);
    if (PHASES.includes(b.phase)) c.phase = b.phase;
    if (b.review && typeof b.review === 'object') c.review = { ...c.review, ...b.review };
    // Per-unit updates: [{ id, status?, evidence? }]
    if (Array.isArray(b.units)) {
      for (const upd of b.units) {
        const unit = (c.plan || []).find(u => u.id === safeId(upd.id));
        if (!unit) continue;
        if (UNIT_STATUS.includes(upd.status)) unit.status = upd.status;
        if (upd.evidence != null) unit.evidence = String(upd.evidence).trim();
      }
    }
    // Auto-complete: if every unit is done and a final review was approved, mark done.
    const units = c.plan || [];
    if (units.length && units.every(u => u.status === 'done') && c.review.finalApproved) c.phase = 'done';
    try { save(repoRoot, c); } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    try { if (broadcast) broadcast({ type: 'contracts-changed', payload: { action: 'update', id: c.id, phase: c.phase } }); } catch (_) {}
    return json(res, { ok: true, contract: c });
  });

  addRoute('DELETE', '/api/contracts/item', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = safeId(url.searchParams.get('id'));
    if (!id) return json(res, { ok: false, error: 'id required' }, 400);
    const f = fileFor(repoRoot, id);
    if (path.resolve(f).startsWith(path.resolve(dir(repoRoot)))) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    try { if (broadcast) broadcast({ type: 'contracts-changed', payload: { action: 'delete', id } }); } catch (_) {}
    return json(res, { ok: true, id });
  });

  return { list: () => list(repoRoot), load: (id) => load(repoRoot, id), PHASES };
}

module.exports = { mountContracts, PHASES, UNIT_STATUS };
