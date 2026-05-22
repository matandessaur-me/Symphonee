'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sequences = require('./sequences');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-seq-'));
}

test('recordEvent writes a JSONL line and loadEvents reads it back', () => {
  const root = tmpRoot();
  try {
    assert.ok(sequences.recordEvent(root, { kind: 'file-change', repo: 'R1', file: 'a.js' }));
    assert.ok(sequences.recordEvent(root, { kind: 'qa-saved', repo: 'R1', detail: 'foo' }));
    const events = sequences.loadEvents(root);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'file-change');
    assert.equal(events[1].kind, 'qa-saved');
    assert.equal(events[0].repo, 'R1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadEvents tolerates malformed lines without throwing', () => {
  const root = tmpRoot();
  try {
    const file = sequences.sequencesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json}\n{"ts":1,"kind":"x"}\nbroken\n', 'utf8');
    const events = sequences.loadEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildSessions splits on idle gaps', () => {
  const events = [
    { ts: 1000, kind: 'a', repo: 'R' },
    { ts: 2000, kind: 'b', repo: 'R' },
    { ts: 2000 + 11 * 60 * 1000, kind: 'c', repo: 'R' }, // 11 min later -> new session
    { ts: 2000 + 11 * 60 * 1000 + 500, kind: 'd', repo: 'R' },
  ];
  const sess = sequences.buildSessions(events);
  assert.equal(sess.length, 2);
  // newest first
  assert.equal(sess[0].events[0].kind, 'c');
  assert.equal(sess[1].events.length, 2);
});

test('buildSessions keeps different repos separate', () => {
  const events = [
    { ts: 1000, kind: 'a', repo: 'R1' },
    { ts: 1500, kind: 'b', repo: 'R2' },
    { ts: 2000, kind: 'c', repo: 'R1' },
  ];
  const sess = sequences.buildSessions(events);
  assert.equal(sess.length, 2);
  const r1 = sess.find(s => s.repo === 'R1');
  const r2 = sess.find(s => s.repo === 'R2');
  assert.equal(r1.events.length, 2);
  assert.equal(r2.events.length, 1);
});

test('shapeSignature is deterministic and order-aware', () => {
  const a = { events: [{ kind: 'f', file: 'a/b.js' }, { kind: 'g', file: 'a/c.js' }] };
  const b = { events: [{ kind: 'f', file: 'a/b.js' }, { kind: 'g', file: 'a/c.js' }] };
  const c = { events: [{ kind: 'g', file: 'a/c.js' }, { kind: 'f', file: 'a/b.js' }] };
  assert.equal(sequences.shapeSignature(a), sequences.shapeSignature(b));
  assert.notEqual(sequences.shapeSignature(a), sequences.shapeSignature(c));
});

test('clusterSessions groups similar shapes', () => {
  // Two near-identical sessions plus a third that overlaps enough to cluster.
  const mk = (events) => ({ repo: 'R', startTs: 0, endTs: 0, events });
  const s1 = mk([
    { kind: 'file-change', file: 'src/Hero.tsx' },
    { kind: 'file-change', file: 'src/Hero.styles.js' },
    { kind: 'git-event', file: null },
  ]);
  const s2 = mk([
    { kind: 'file-change', file: 'src/Hero.tsx' },
    { kind: 'file-change', file: 'src/Hero.styles.js' },
    { kind: 'git-event', file: null },
  ]);
  const s3 = mk([
    { kind: 'file-change', file: 'src/Hero.tsx' },
    { kind: 'file-change', file: 'src/Hero.styles.js' },
    { kind: 'git-event', file: null },
    { kind: 'qa-saved', file: null },
  ]);
  const noise = mk([
    { kind: 'file-change', file: 'totally/unrelated.go' },
    { kind: 'file-change', file: 'totally/other.go' },
    { kind: 'qa-saved', file: null },
  ]);
  const clusters = sequences.clusterSessions([s1, s2, s3, noise], { threshold: 0.5, minClusterSize: 3 });
  assert.equal(clusters.length, 1, 'one mature cluster expected');
  assert.equal(clusters[0].count, 3);
});

test('clusterSessions ignores sessions below minSessionEvents', () => {
  const mk = (events) => ({ repo: 'R', startTs: 0, endTs: 0, events });
  const tiny = mk([{ kind: 'file-change', file: 'a.js' }]);
  const big = mk([
    { kind: 'file-change', file: 'a.js' },
    { kind: 'file-change', file: 'b.js' },
    { kind: 'git-event', file: null },
  ]);
  // Only 1 big -> below minClusterSize so no clusters.
  const clusters = sequences.clusterSessions([tiny, tiny, tiny, big], { minClusterSize: 3, minSessionEvents: 3 });
  assert.equal(clusters.length, 0);
});

test('pruneOld drops events older than the threshold', () => {
  const root = tmpRoot();
  try {
    const file = sequences.sequencesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const fresh = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
    fs.writeFileSync(file, JSON.stringify({ ts: old, kind: 'old' }) + '\n' + JSON.stringify({ ts: fresh, kind: 'fresh' }) + '\n', 'utf8');
    const r = sequences.pruneOld(root, { olderThanDays: 30 });
    assert.equal(r.kept, 1);
    assert.equal(r.dropped, 1);
    const events = sequences.loadEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'fresh');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getRecentSessions ignores events older than the window', () => {
  const root = tmpRoot();
  try {
    const file = sequences.sequencesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const fresh = Date.now() - 1 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, [
      JSON.stringify({ ts: old, kind: 'a', repo: 'R' }),
      JSON.stringify({ ts: old + 1, kind: 'b', repo: 'R' }),
      JSON.stringify({ ts: fresh, kind: 'c', repo: 'R' }),
      JSON.stringify({ ts: fresh + 1, kind: 'd', repo: 'R' }),
    ].join('\n') + '\n', 'utf8');
    const sess = sequences.getRecentSessions(root, { days: 7 });
    // only fresh events should make it through; one session.
    assert.equal(sess.length, 1);
    assert.equal(sess[0].events.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
