'use strict';
// CLI configuration + model intelligence for the orchestrator (pure data).
// Extracted from orchestrator.js. Verified against each CLI's --help output.

// Headless CLI flags per provider.
//   args:        base flags for headless/non-interactive mode
//   promptMode:  'stdin' | 'flag' (-p "prompt") | 'positional' (trailing arg)
//   shell:       spawn shell option (false avoids cmd.exe quoting issues)
const HEADLESS_FLAGS = {
  claude:  { cmd: 'claude',  args: ['-p'], promptMode: 'stdin' },
  gemini:  { cmd: 'gemini',  args: [],                   promptMode: 'stdin' },
  codex:   { cmd: 'codex',   args: ['exec'],             promptMode: 'stdin' },
  copilot: { cmd: process.platform === 'win32' ? 'copilot.cmd' : 'copilot', args: ['-p'],     promptMode: 'flag',  shell: false },
  grok:    { cmd: process.platform === 'win32' ? 'grok.cmd'    : 'grok',    args: ['--print'], promptMode: 'positional', shell: false },
  qwen:    { cmd: process.platform === 'win32' ? 'qwen.cmd'    : 'qwen',    args: ['-p'],      promptMode: 'flag',       shell: false },
};

// Grounded model availability per CLI and account type. Update when models change.
const CLI_MODELS = {
  claude: {
    models: ['opus', 'sonnet', 'haiku'],
    modelIds: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'sonnet',
    modelFlag: '--model',
    effortFlag: '--effort',
    effortValues: ['low', 'medium', 'high', 'max'],
    permissionFlag: '--dangerously-skip-permissions',
    autoPermission: true,
    outputFormatFlag: '--output-format',
    systemPromptFlag: '--append-system-prompt',
    worktreeFlag: '--worktree',
    extraHeadless: [],
    notes: 'All models work with both API key and subscription auth.',
  },
  gemini: {
    models: ['flash', 'flash-lite'],
    modelIds: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash'],
    paidModels: ['pro', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
    defaultModel: 'flash',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--approval-mode',
    autoPermission: 'yolo',
    outputFormatFlag: '-o',
    systemPromptFlag: null,
    worktreeFlag: '--worktree',
    extraHeadless: [],
    notes: 'Free tier: flash/flash-lite only. Pro models require API billing enabled on Google Cloud project.',
  },
  codex: {
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1-codex'],
    modelIds: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'],
    apiKeyOnlyModels: ['o3', 'o4-mini', 'gpt-4.1'],
    notSupported: ['gpt-4o'],
    defaultModel: 'gpt-5.4',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--dangerously-bypass-approvals-and-sandbox',
    autoPermission: true,
    outputFormatFlag: '--json',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'ChatGPT account: gpt-5.x models only. o3/o4-mini/gpt-4.1 require an OpenAI API key. gpt-4o is not available in Codex at all.',
  },
  copilot: {
    models: ['claude-sonnet-4.6', 'gpt-5.4', 'gpt-4.1', 'gpt-5-mini'],
    modelIds: ['claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-5.3-codex', 'gemini-3-pro-preview'],
    freeModels: ['gpt-5-mini', 'gpt-4.1'],
    defaultModel: 'claude-sonnet-4.6',
    modelFlag: '--model',
    effortFlag: '--effort',
    effortValues: ['low', 'medium', 'high', 'xhigh'],
    permissionFlag: '--yolo',
    autoPermission: true,
    silentFlag: '--silent',
    outputFormatFlag: '--output-format',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'gpt-5-mini and gpt-4.1 are free (no premium requests). Claude/GPT-5.4/Gemini consume premium requests. Requires Copilot Pro+ for premium models.',
  },
  grok: {
    models: ['grok-4', 'grok-3', 'grok-3-mini-fast'],
    modelIds: ['grok-4', 'grok-4-latest', 'grok-4.20', 'grok-3', 'grok-3-latest', 'grok-3-mini-fast', 'grok-code-fast-1', 'grok-4-1-fast-reasoning'],
    defaultModel: 'grok-3-mini-fast',
    modelFlag: '--model',
    effortFlag: null,
    permissionFlag: '--permission-mode',
    autoPermission: 'full',
    outputFormatFlag: '--output-format',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'All models require xAI API key with loaded credits. grok-3-mini-fast is cheapest.',
  },
  qwen: {
    models: ['qwen3-coder-plus', 'qwen3-coder-flash'],
    modelIds: ['qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-max', 'qwen3-max-preview', 'qwen-plus', 'qwen-turbo'],
    paidModels: ['qwen3-max', 'qwen-plus'],
    defaultModel: 'qwen3-coder-plus',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--yolo',
    autoPermission: true,
    outputFormatFlag: '-o',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'Qwen Code is a Gemini CLI fork. Auth via DashScope (DASHSCOPE_API_KEY) or OpenAI-compatible endpoint. Qwen3-Coder models are code-specialized.',
  },
};

// Provider abstraction: launch config, cost tier, idle-detection patterns.
//   tier: 1=basic, 2=mid, 3=premium ; costRank: 1=cheapest .. 5=most expensive
const CLI_CONFIG = {
  claude:  { cmd: 'claude',  label: 'Claude Code', pipeMode: true, tier: 3, costRank: 5, idlePattern: /[❯>]\s*$/ },
  gemini:  { cmd: 'gemini',  label: 'Gemini CLI',  pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
  codex:   { cmd: 'codex',   label: 'Codex CLI',   pipeMode: true, tier: 2, costRank: 3, idlePattern: /[❯>$]\s*$/ },
  copilot: { cmd: 'copilot', label: 'Copilot CLI', pipeMode: true, tier: 1, costRank: 1, idlePattern: /[❯>]\s*$/ },
  grok:    { cmd: 'grok',    label: 'Grok Code',   pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
  qwen:    { cmd: 'qwen',    label: 'Qwen Code',   pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
};

// Cross-model escalation chain (cheapest first); skips circuit-broken / uninstalled CLIs.
const ESCALATION_ORDER = ['copilot', 'gemini', 'grok', 'qwen', 'codex', 'claude'];

module.exports = { HEADLESS_FLAGS, CLI_MODELS, CLI_CONFIG, ESCALATION_ORDER };
