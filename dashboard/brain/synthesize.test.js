'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const synth = require('./synthesize');

test('_summarizeCluster reports occurrences, repos, top files, kind mix', () => {
  const cluster = {
    id: 'c',
    count: 3,
    sessions: [
      { repo: 'R1', startTs: 0, endTs: 0, events: [
        { kind: 'file-change', file: 'a.js' },
        { kind: 'file-change', file: 'b.js' },
        { kind: 'git-event', file: null },
      ] },
      { repo: 'R1', startTs: 0, endTs: 0, events: [
        { kind: 'file-change', file: 'a.js' },
        { kind: 'file-change', file: 'b.js' },
      ] },
      { repo: 'R2', startTs: 0, endTs: 0, events: [
        { kind: 'file-change', file: 'a.js' },
      ] },
    ],
  };
  const s = synth._summarizeCluster(cluster);
  assert.equal(s.occurrences, 3);
  assert.deepEqual(s.repos.sort(), ['R1', 'R2']);
  assert.equal(s.topFiles[0], 'a.js (x3)');
  assert.ok(s.kindMix[0].startsWith('file-change:'));
  assert.ok(Array.isArray(s.exampleSequence));
  assert.ok(s.exampleSequence.length >= 1);
});

test('_buildSynthesisMessages includes system rules + summary in user content', () => {
  const summary = {
    occurrences: 4,
    repos: ['R'],
    topFiles: ['x (x4)'],
    kindMix: ['file-change:4'],
    exampleSequence: ['file-change x'],
  };
  const msgs = synth._buildSynthesisMessages(summary);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Symphonee/);
  assert.match(msgs[0].content, /steps:/);
  assert.match(msgs[1].content, /Occurrences: 4/);
  assert.match(msgs[1].content, /R/);
});

test('_draftToMarkdown produces frontmatter + numbered steps', () => {
  const md = synth._draftToMarkdown({
    slug: 'hero-update',
    name: 'Hero Update',
    description: 'Edit Hero and styles together',
    icon: 'wand',
    steps: ['Open Hero.tsx', 'Edit styles', 'Commit'],
    rationale: 'Observed 5 times in last 30 days',
  });
  assert.match(md, /^---\nname: Hero Update/);
  assert.match(md, /icon: wand/);
  assert.match(md, /1\. Open Hero\.tsx/);
  assert.match(md, /3\. Commit/);
  assert.match(md, /> Observed 5 times/);
});

test('_draftToMarkdown returns null when slug missing', () => {
  assert.equal(synth._draftToMarkdown(null), null);
  assert.equal(synth._draftToMarkdown({}), null);
  assert.equal(synth._draftToMarkdown({ slug: null, name: 'x' }), null);
});

test('_draftToMarkdown truncates oversized inputs', () => {
  const long = 'x'.repeat(1000);
  const md = synth._draftToMarkdown({
    slug: 'a',
    name: long,
    description: long,
    steps: [long, long],
    rationale: long,
  });
  // name capped at 80, description at 280, steps at 280 each
  assert.ok(md.length < 4000);
});

test('MIN_CLUSTER_SIZE is sane', () => {
  assert.ok(typeof synth.MIN_CLUSTER_SIZE === 'number');
  assert.ok(synth.MIN_CLUSTER_SIZE >= 2 && synth.MIN_CLUSTER_SIZE <= 10);
});
