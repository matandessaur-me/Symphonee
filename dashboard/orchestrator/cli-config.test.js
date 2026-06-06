'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cfg = require('./cli-config');
const { pretrustFolderForCli } = require('./pretrust');

const CLIS = ['claude', 'gemini', 'codex', 'copilot', 'grok', 'qwen'];

test('cli-config exposes all maps for all 6 CLIs', () => {
  for (const m of ['HEADLESS_FLAGS', 'CLI_MODELS', 'CLI_CONFIG']) {
    for (const c of CLIS) assert.ok(cfg[m][c], `${m} missing ${c}`);
  }
  assert.equal(cfg.CLI_CONFIG.claude.label, 'Claude Code');
  assert.equal(cfg.CLI_MODELS.gemini.defaultModel, 'flash');
  assert.deepEqual(cfg.ESCALATION_ORDER, ['copilot', 'gemini', 'grok', 'qwen', 'codex', 'claude']);
});

test('pretrustFolderForCli is a no-op for non-gated CLIs / missing cwd (no home writes)', () => {
  assert.equal(typeof pretrustFolderForCli, 'function');
  assert.doesNotThrow(() => pretrustFolderForCli('claude', 'C:/x'));   // claude: not folder-gated -> no write
  assert.doesNotThrow(() => pretrustFolderForCli('copilot', 'C:/x'));
  assert.doesNotThrow(() => pretrustFolderForCli('gemini', ''));        // no cwd -> early return
});
