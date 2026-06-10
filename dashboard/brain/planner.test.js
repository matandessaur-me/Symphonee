'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const planner = require('./planner');

test('sanity check: code-action with none overrides to claude-code and clamps confidence', () => {
  const r = planner._sanityCheckDecision({ intent: 'code-action', primary_cli: 'none', confidence: 0.9 });
  assert.equal(r.decision.primary_cli, 'claude-code');
  assert.equal(r.decision.confidence, 0.5);
  assert.equal(r.patches.length, 2);
  assert.equal(r.patches[0].kind, 'intent-implies-cli');
  assert.equal(r.patches[1].kind, 'confidence-clamp');
});

test('sanity check: code-question with missing cli gets the default', () => {
  const r = planner._sanityCheckDecision({ intent: 'code-question', confidence: 0.9 });
  assert.equal(r.decision.primary_cli, 'claude-code');
  assert.equal(r.patches.length, 2);
});

test('sanity check: plan intent also requires a CLI', () => {
  const r = planner._sanityCheckDecision({ intent: 'plan', primary_cli: 'none', confidence: 0.8 });
  assert.equal(r.decision.primary_cli, 'claude-code');
  assert.ok(r.patches.find(p => p.kind === 'intent-implies-cli'));
});

test('sanity check: browse-files intent also requires a CLI', () => {
  const r = planner._sanityCheckDecision({ intent: 'browse-files', primary_cli: 'none', confidence: 0.8 });
  assert.equal(r.decision.primary_cli, 'claude-code');
  assert.ok(r.patches.find(p => p.kind === 'intent-implies-cli'));
});

test('sanity check: greeting with none is allowed (no override)', () => {
  const r = planner._sanityCheckDecision({ intent: 'greeting', primary_cli: 'none', confidence: 0.95 });
  assert.equal(r.decision.primary_cli, 'none');
  assert.equal(r.decision.confidence, 0.95);
  assert.equal(r.patches.length, 0);
});

test('sanity check: recall with none is allowed', () => {
  const r = planner._sanityCheckDecision({ intent: 'recall', primary_cli: 'none', confidence: 0.9 });
  assert.equal(r.decision.primary_cli, 'none');
  assert.equal(r.patches.length, 0);
});

test('sanity check: ambiguous with none is allowed (recall path)', () => {
  const r = planner._sanityCheckDecision({ intent: 'ambiguous', primary_cli: 'none', confidence: 0.4 });
  assert.equal(r.patches.length, 0);
});

test('sanity check: code-action already has claude-code -> no patches', () => {
  const r = planner._sanityCheckDecision({ intent: 'code-action', primary_cli: 'claude-code', confidence: 0.85 });
  assert.equal(r.decision.primary_cli, 'claude-code');
  assert.equal(r.decision.confidence, 0.85);
  assert.equal(r.patches.length, 0);
});

test('sanity check: code-action with codex -> no patches (codex is a valid CLI)', () => {
  const r = planner._sanityCheckDecision({ intent: 'code-action', primary_cli: 'codex', confidence: 0.85 });
  assert.equal(r.decision.primary_cli, 'codex');
  assert.equal(r.patches.length, 0);
});

test('sanity check: malformed input returns empty patches without throwing', () => {
  const r1 = planner._sanityCheckDecision(null);
  assert.deepEqual(r1.patches, []);
  const r2 = planner._sanityCheckDecision({});
  assert.deepEqual(r2.patches, []);
});

test('sanity check: missing confidence does not crash the clamp', () => {
  const r = planner._sanityCheckDecision({ intent: 'code-action', primary_cli: 'none' });
  assert.equal(r.decision.primary_cli, 'claude-code');
  // Confidence-clamp only fires when confidence was > 0.5; missing means it stays missing.
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0].kind, 'intent-implies-cli');
});

test('INTENTS_REQUIRING_CLI is the documented set', () => {
  assert.ok(planner.INTENTS_REQUIRING_CLI.has('code-question'));
  assert.ok(planner.INTENTS_REQUIRING_CLI.has('code-action'));
  assert.ok(planner.INTENTS_REQUIRING_CLI.has('plan'));
  assert.ok(planner.INTENTS_REQUIRING_CLI.has('browse-files'));
  assert.ok(!planner.INTENTS_REQUIRING_CLI.has('greeting'));
  assert.ok(!planner.INTENTS_REQUIRING_CLI.has('recall'));
});

test('INTENT_DEFAULT_CLI defaults all required intents to claude-code', () => {
  for (const intent of planner.INTENTS_REQUIRING_CLI) {
    assert.equal(planner.INTENT_DEFAULT_CLI[intent], 'claude-code', `default for ${intent}`);
  }
});

test('exported constants are present', () => {
  assert.equal(typeof planner.planRoute, 'function');
  assert.equal(typeof planner.recomputeIntent, 'function');
  assert.equal(typeof planner.classifyRoute, 'function');
  assert.equal(typeof planner.TRIAGE_MODEL, 'string');
  assert.equal(typeof planner.REASONING_MODEL, 'string');
  assert.equal(typeof planner.ESCALATION_THRESHOLD, 'number');
  assert.ok(Array.isArray(planner.KNOWN_INTENTS));
});

// ── classifyRoute: the recall-vs-escalate signal Stage 0 logs ─────────────

test('classifyRoute: confident triage stay (no escalation)', () => {
  const r = planner.classifyRoute({ ok: true, stage: 'triage', escalated: false });
  assert.equal(r.routeClass, 'stay');
  assert.equal(r.escalateReason, null);
});

test('classifyRoute: low-confidence escalation', () => {
  const r = planner.classifyRoute({ ok: true, stage: 'escalated', escalated: true, forceEscalated: false });
  assert.equal(r.routeClass, 'escalate');
  assert.equal(r.escalateReason, 'low-confidence');
});

test('classifyRoute: forced escalation from a sanity-check patch', () => {
  const r = planner.classifyRoute({ ok: true, stage: 'escalated', escalated: true, forceEscalated: true });
  assert.equal(r.routeClass, 'escalate');
  assert.equal(r.escalateReason, 'force-patch');
});

test('classifyRoute: escalation attempted but reasoning model errored (fallback to triage)', () => {
  const r = planner.classifyRoute({ ok: true, stage: 'triage-only', escalated: false });
  assert.equal(r.routeClass, 'stay-fallback');
  assert.equal(r.escalateReason, 'escalation-failed');
});

test('classifyRoute: triage itself failed', () => {
  const r = planner.classifyRoute({ ok: false, stage: 'triage', escalated: false });
  assert.equal(r.routeClass, 'error');
  assert.equal(r.escalateReason, 'triage-error');
});

test('classifyRoute: null / non-object input is treated as an error, not a throw', () => {
  assert.equal(planner.classifyRoute(null).routeClass, 'error');
  assert.equal(planner.classifyRoute(undefined).routeClass, 'error');
  assert.equal(planner.classifyRoute('nope').routeClass, 'error');
});
