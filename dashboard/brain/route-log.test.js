'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const routeLog = require('./route-log');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-routelog-'));
}

// A realistic planRoute() result for each branch, mirroring what brain/index.js
// passes in as `plan`.
const STAY = {
  ok: true, stage: 'triage', escalated: false, forceEscalated: false,
  triageConfidence: 0.92, model: 'qwen2.5:1.5b',
  decision: { intent: 'recall', primary_cli: 'none', confidence: 0.92 },
  patches: [],
};
const ESCALATE = {
  ok: true, stage: 'escalated', escalated: true, forceEscalated: false,
  triageConfidence: 0.4, triageModel: 'qwen2.5:1.5b', model: 'gemma4:26b',
  decision: { intent: 'code-action', primary_cli: 'claude-code', confidence: 0.8 },
  patches: [],
};

test('record writes one JSONL line carrying the recall-vs-escalate signal', () => {
  const root = tmpRoot();
  try {
    const rec = routeLog.record(root, {
      decisionId: 'dec_1', input: 'what did we decide about X', source: 'think',
      plan: STAY, classification: { routeClass: 'stay', escalateReason: null },
      tookMs: 120, escalationThreshold: 0.7,
    });
    assert.ok(rec);
    assert.equal(rec.routeClass, 'stay');
    assert.equal(rec.escalated, false);
    assert.equal(rec.intent, 'recall');
    assert.equal(rec.triageConfidence, 0.92);
    assert.equal(rec.escalationThreshold, 0.7);
    const all = routeLog.readRouteLog(root);
    assert.equal(all.length, 1);
    assert.equal(all[0].decisionId, 'dec_1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record falls back to error routeClass on an unknown class', () => {
  const root = tmpRoot();
  try {
    const rec = routeLog.record(root, {
      plan: STAY, classification: { routeClass: 'bogus', escalateReason: null },
    });
    assert.equal(rec.routeClass, 'error');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record with no repoRoot is a no-op (returns null, does not throw)', () => {
  assert.equal(routeLog.record(null, { plan: STAY }), null);
  assert.equal(routeLog.record('', { plan: STAY }), null);
});

test('triageConfidence falls back to decision.confidence when not surfaced at top level', () => {
  const root = tmpRoot();
  try {
    // STAY-shaped plan but without a top-level triageConfidence.
    const plan = { ...STAY, triageConfidence: undefined, decision: { intent: 'recall', confidence: 0.77 } };
    const rec = routeLog.record(root, { plan, classification: { routeClass: 'stay' } });
    assert.equal(rec.triageConfidence, 0.77);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readRouteLog tolerates malformed lines', () => {
  const root = tmpRoot();
  try {
    const file = routeLog.routeLogFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken\n{"ts":1,"routeClass":"stay","intent":"recall"}\nnotjson\n', 'utf8');
    const all = routeLog.readRouteLog(root);
    assert.equal(all.length, 1);
    assert.equal(all[0].routeClass, 'stay');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getStats computes escalation rate, reasons, and per-intent split', () => {
  const root = tmpRoot();
  try {
    // 3 stays (recall), 1 escalate (code-action).
    routeLog.record(root, { plan: STAY, classification: { routeClass: 'stay', escalateReason: null } });
    routeLog.record(root, { plan: STAY, classification: { routeClass: 'stay', escalateReason: null } });
    routeLog.record(root, { plan: STAY, classification: { routeClass: 'stay', escalateReason: null } });
    routeLog.record(root, { plan: ESCALATE, classification: { routeClass: 'escalate', escalateReason: 'low-confidence' } });

    const s = routeLog.getStats(root);
    assert.equal(s.total, 4);
    assert.equal(s.byRouteClass.stay, 3);
    assert.equal(s.byRouteClass.escalate, 1);
    assert.equal(s.escalationRate, 0.25); // 1 / (3 + 1)
    assert.equal(s.byEscalateReason['low-confidence'], 1);
    assert.equal(s.byIntent.recall.stay, 3);
    assert.equal(s.byIntent['code-action'].escalate, 1);
    assert.equal(s.byIntent['code-action'].escalationRate, 1);
    // Confidence means split by branch.
    assert.equal(s.confidence.stayMean, 0.92);
    assert.equal(s.confidence.escalateMean, 0.4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getStats is empty-safe', () => {
  const root = tmpRoot();
  try {
    const s = routeLog.getStats(root);
    assert.equal(s.total, 0);
    assert.equal(s.escalationRate, null);
    assert.equal(s.confidence.stayMean, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stats cache invalidates on append', () => {
  const root = tmpRoot();
  try {
    routeLog.record(root, { plan: STAY, classification: { routeClass: 'stay' } });
    assert.equal(routeLog.getStats(root).total, 1); // populates cache
    routeLog.record(root, { plan: ESCALATE, classification: { routeClass: 'escalate', escalateReason: 'low-confidence' } });
    assert.equal(routeLog.getStats(root).total, 2); // cache was invalidated
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pruneOld drops records older than the window', () => {
  const root = tmpRoot();
  try {
    const file = routeLog.routeLogFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const oldTs = Date.now() - 400 * 24 * 60 * 60 * 1000;
    const newTs = Date.now();
    fs.writeFileSync(file,
      JSON.stringify({ ts: oldTs, routeClass: 'stay', intent: 'recall' }) + '\n' +
      JSON.stringify({ ts: newTs, routeClass: 'escalate', intent: 'code-action' }) + '\n',
      'utf8');
    const r = routeLog.pruneOld(root, { olderThanDays: 365 });
    assert.equal(r.kept, 1);
    assert.equal(r.dropped, 1);
    assert.equal(routeLog.readRouteLog(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
