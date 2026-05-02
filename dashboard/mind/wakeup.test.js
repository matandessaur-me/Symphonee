'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { composeWakeUp, renderL0, renderL1 } = require('./wakeup');

function fixtureGraph() {
  return {
    version: 1,
    nodes: [
      { id: 'g1', label: 'Browser Router', kind: 'doc', createdAt: '2026-04-01T00:00:00Z' },
      { id: 'c_old', label: 'tried Postgres tuning', kind: 'conversation', createdBy: 'claude', createdAt: '2026-03-01T00:00:00Z' },
      { id: 'c_new', label: 'switched to read-replicas', kind: 'conversation', createdBy: 'codex', createdAt: '2026-04-20T00:00:00Z' },
    ],
    edges: [],
    gods: [
      { id: 'g1', label: 'Browser Router', degree: 42 },
      { id: 'g2', label: 'Permission Modes', degree: 30 },
    ],
    surprises: [],
  };
}

test('renderL0 includes activeRepo and space', () => {
  const out = renderL0({ activeRepo: 'Symphonee', activeRepoPath: '/tmp/nope', space: 'global' });
  assert.match(out, /active_repo: Symphonee/);
  assert.match(out, /mind_space: global/);
});

test('renderL0 reads an AI-instructions preamble when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-l0-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project Foo\n\nThis is the project preamble line.\n\nLater paragraph that should NOT show up.');
  try {
    const out = renderL0({ activeRepo: 'Foo', activeRepoPath: dir, space: 's' });
    assert.match(out, /Project Foo/);
    assert.match(out, /preamble line/);
    assert.doesNotMatch(out, /Later paragraph/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderL0 strips the regen-header line so the preamble is CLI-agnostic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-l0-strip-'));
  // writePluginHints generates files starting with "# <FILENAME>.md - <repo>"
  // because of {{FILENAME}} substitution. The wake-up should not surface that
  // line — it's regen plumbing, not content.
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
    '# CLAUDE.md - Symphonee\n\n**Real content:** these instructions tell the AI how to behave.\n\nMore body.');
  try {
    const out = renderL0({ activeRepo: 'Symphonee', activeRepoPath: dir, space: '_global' });
    assert.doesNotMatch(out, /# CLAUDE\.md/i, 'must not surface the regen header');
    assert.doesNotMatch(out, /\{\{FILENAME\}\}/, 'must strip raw template placeholders');
    assert.match(out, /Real content/, 'must keep the actual instructions body');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderL0 picks AGENTS.md when CLAUDE.md is absent (Codex-only user)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-l0-codex-'));
  // Simulate a user who only has Codex installed -- only AGENTS.md exists.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'),
    '# AGENTS.md - SomeRepo\n\nThis is the AGENTS instruction body.\n');
  try {
    const out = renderL0({ activeRepo: 'SomeRepo', activeRepoPath: dir, space: 's' });
    assert.doesNotMatch(out, /# AGENTS\.md/i, 'AGENTS.md regen header must also be stripped');
    assert.match(out, /AGENTS instruction body/, 'must surface the actual body');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderL1 lists god nodes and recent conversations', () => {
  const out = renderL1(fixtureGraph(), { maxChars: 4000 });
  assert.match(out, /Browser Router/);
  assert.match(out, /Permission Modes/);
  assert.match(out, /switched to read-replicas/);
  // Recent conversations should be sorted newest-first
  const newerIdx = out.indexOf('switched to read-replicas');
  const olderIdx = out.indexOf('tried Postgres');
  assert.ok(newerIdx >= 0 && olderIdx >= 0);
  assert.ok(newerIdx < olderIdx, 'newer conversation must come first');
});

test('renderL1 with empty graph degrades gracefully', () => {
  const out = renderL1({ nodes: [], edges: [], gods: [] }, { maxChars: 400 });
  assert.match(out, /No memories yet/);
});

test('composeWakeUp respects budget approximately', () => {
  const r = composeWakeUp(fixtureGraph(), { activeRepo: 'r', space: 's', budgetTokens: 200 });
  assert.ok(r.estTokens <= 250, `est ${r.estTokens} should be near 200`);
  assert.match(r.text, /## L0 - IDENTITY/);
  assert.match(r.text, /## L1 - ESSENTIAL STORY/);
});

test('composeWakeUp emits L0 even when graph is empty', () => {
  const r = composeWakeUp({ nodes: [], edges: [], gods: [] }, { activeRepo: 'X', space: 's' });
  assert.match(r.text, /active_repo: X/);
  assert.match(r.text, /No memories yet/);
});

test('composeWakeUp query-aware mode: L1 reflects the task, not god nodes', () => {
  const g = {
    version: 1,
    nodes: [
      { id: 'a', label: 'browser router stagehand fallback', kind: 'doc', tags: ['browser'] },
      { id: 'b', label: 'cooking recipes',                   kind: 'note' },
      { id: 'c', label: 'permission modes',                  kind: 'concept' },
    ],
    edges: [
      { source: 'a', target: 'c', relation: 'references', confidence: 'EXTRACTED', confidenceScore: 1, weight: 1 },
    ],
    gods: [{ id: 'b', label: 'cooking recipes', degree: 99 }], // god is irrelevant to the question
    surprises: [],
  };
  const r = composeWakeUp(g, { activeRepo: 'r', space: 's', budgetTokens: 600, question: 'browser router stagehand' });
  assert.equal(r.queryAware, true);
  assert.match(r.text, /TASK CONTEXT/);
  assert.match(r.text, /browser router stagehand/);
  // The cooking-recipes god node should NOT crowd L1 when the task is unrelated.
  assert.doesNotMatch(r.text, /\[note\] cooking recipes/);
});

test('composeWakeUp query-aware: degrades to generic L1 when question matches nothing', () => {
  const g = {
    nodes: [{ id: 'a', label: 'real node', kind: 'doc' }],
    edges: [],
    gods: [{ id: 'a', label: 'real node', degree: 5 }],
    surprises: [],
  };
  const r = composeWakeUp(g, { activeRepo: 'r', space: 's', question: 'klingon spaceship blueprints' });
  // Falls back to generic L1 -- god node 'real node' should appear.
  assert.match(r.text, /ESSENTIAL STORY/);
});

const { pickRelevantMemories, renderMemoriesBlock } = require('./wakeup');

test('pickRelevantMemories: scope.repo match scores higher than unrelated card', () => {
  const now = new Date().toISOString();
  const g = {
    nodes: [
      { id: 'm1', label: 'DYOB has its own design',  kind: 'memory', kindOfMemory: 'constraint', scope: { repo: 'DYOB3' }, tags: ['memory','DYOB'], createdAt: now },
      { id: 'm2', label: 'unrelated trivia',         kind: 'memory', kindOfMemory: 'fact',      scope: null, tags: ['memory'], createdAt: now },
    ],
    edges: [],
  };
  const picks = pickRelevantMemories(g, { activeRepo: 'DYOB3', limit: 2 });
  assert.ok(picks.length >= 1, 'expected at least one pick');
  assert.equal(picks[0].id, 'm1', 'scope.repo match should sort first');
});

test('pickRelevantMemories: in_repo edge counts toward repo relevance', () => {
  const now = new Date().toISOString();
  const g = {
    nodes: [
      { id: 'm_via_edge', label: 'connected by in_repo', kind: 'memory', kindOfMemory: 'fact',
        scope: null, tags: ['memory'], createdAt: now },
      { id: 'm_irrelevant', label: 'not connected at all', kind: 'memory', kindOfMemory: 'fact',
        scope: null, tags: ['memory'], createdAt: '2024-01-01T00:00:00Z' }, // older, no repo signal
    ],
    edges: [
      { source: 'm_via_edge', target: 'cwd_dyob3', relation: 'in_repo' },
    ],
  };
  const picks = pickRelevantMemories(g, { activeRepo: 'DYOB3', limit: 2 });
  assert.equal(picks[0].id, 'm_via_edge');
});

test('renderMemoriesBlock: empty input -> empty string', () => {
  assert.equal(renderMemoriesBlock([]), '');
});

test('renderMemoriesBlock: outputs kind tag + title', () => {
  const out = renderMemoriesBlock([
    { label: 'DYOB design', kindOfMemory: 'constraint' },
    { label: 'Use Postgres', kindOfMemory: 'decision' },
  ]);
  assert.match(out, /\[constraint\] DYOB design/);
  assert.match(out, /\[decision\] Use Postgres/);
  assert.match(out, /^memories \(durable knowledge\):/m);
});

test('composeWakeUp: memories appear in L1 when present', () => {
  const now = new Date().toISOString();
  const g = {
    nodes: [
      { id: 'm1', label: 'DYOB has its own design system', kind: 'memory',
        kindOfMemory: 'constraint', scope: { repo: 'DYOB3' }, tags: ['memory','DYOB'], createdAt: now },
    ],
    edges: [],
    gods: [],
  };
  const r = composeWakeUp(g, { activeRepo: 'DYOB3', space: '_global', budgetTokens: 600 });
  assert.match(r.text, /memories \(durable knowledge\)/);
  assert.match(r.text, /\[constraint\] DYOB has its own design/);
});
