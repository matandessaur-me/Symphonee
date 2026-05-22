'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const selfIter = require('./self-iterate');

test('MIN_SAMPLES_FOR_ITERATION is a reasonable threshold', () => {
  assert.ok(selfIter.MIN_SAMPLES_FOR_ITERATION >= 10);
  assert.ok(selfIter.MIN_SAMPLES_FOR_ITERATION <= 50);
});

test('_detectFailurePatterns returns [] when total samples below threshold', () => {
  const stats = {
    total: { n: 5, validated: 1, contradicted: 0, corrected: 0, unused: 4 },
    byIntent: {},
    byCli: {},
    byIntentCli: {},
  };
  assert.deepEqual(selfIter._detectFailurePatterns(stats), []);
});

test('_detectFailurePatterns flags low-validatedRate intent x cli pairs', () => {
  const stats = {
    total: { n: 30, validated: 10, contradicted: 0, corrected: 15, unused: 5 },
    byIntent: {},
    byCli: {},
    byIntentCli: {
      'code-action': {
        'grok':         { n: 15, validated: 3,  contradicted: 0, corrected: 10, unused: 2, validatedRate: 0.2 },
        'claude-code':  { n: 15, validated: 13, contradicted: 0, corrected: 1,  unused: 1, validatedRate: 0.866 },
      },
    },
  };
  const patterns = selfIter._detectFailurePatterns(stats);
  assert.ok(patterns.length >= 1);
  assert.match(patterns[0], /code-action/);
  assert.match(patterns[0], /grok/);
  assert.match(patterns[0], /20%/);
});

test('_detectFailurePatterns also surfaces a CLI with low global rate', () => {
  const stats = {
    total: { n: 30, validated: 5, contradicted: 0, corrected: 0, unused: 25 },
    byIntent: {},
    byCli: {
      'grok': { n: 30, validated: 5, contradicted: 0, corrected: 0, unused: 25, validatedRate: 0.166 },
    },
    byIntentCli: {},
  };
  const patterns = selfIter._detectFailurePatterns(stats);
  assert.ok(patterns.find(p => /grok/.test(p)));
});

test('_detectFailurePatterns ignores buckets without enough samples', () => {
  const stats = {
    total: { n: 30, validated: 5, contradicted: 0, corrected: 0, unused: 25 },
    byIntent: {},
    byCli: {
      'grok': { n: 3, validated: 0, contradicted: 0, corrected: 0, unused: 3, validatedRate: 0 },
    },
    byIntentCli: {
      'code-action': {
        'grok': { n: 4, validated: 0, contradicted: 0, corrected: 4, unused: 0, validatedRate: null },
      },
    },
  };
  const patterns = selfIter._detectFailurePatterns(stats);
  assert.deepEqual(patterns, []);
});

test('_buildIterationMessages embeds current rules + patterns', () => {
  const msgs = selfIter._buildIterationMessages(
    'CLI selection rules:\n  - default rule\n',
    ['pattern A', 'pattern B'],
    25,
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /strict JSON/);
  assert.match(msgs[0].content, /rules: string/);
  assert.match(msgs[0].content, /25/);
  assert.match(msgs[1].content, /default rule/);
  assert.match(msgs[1].content, /pattern A/);
  assert.match(msgs[1].content, /pattern B/);
});

test('exported propose / accept / revert functions are present', () => {
  assert.equal(typeof selfIter.propose, 'function');
  assert.equal(typeof selfIter.accept, 'function');
  assert.equal(typeof selfIter.revert, 'function');
});
