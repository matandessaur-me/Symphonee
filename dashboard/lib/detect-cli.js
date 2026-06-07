'use strict';
// CLI / PowerShell detection + install commands.
// Shared by server.js (findShell uses detectPwsh) and routes/cli-install.js.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLI_INSTALL_COMMANDS = {
  claude:  'npm install -g @anthropic-ai/claude-code',
  gemini:  'npm install -g @google/gemini-cli',
  copilot: 'npm install -g @github/copilot',
  codex:   'npm install -g @openai/codex',

  grok:    'npm install -g @webdevtoday/grok-cli',
  qwen:    'npm install -g @qwen-code/qwen-code',
};

const PWSH_WINGET_CMD = 'winget install Microsoft.PowerShell --accept-source-agreements --accept-package-agreements';

// Detect a CLI tool via `where` first, then fall back to common npm global paths.
// After a fresh npm install the current process PATH may be stale, so we also
// check the typical npm global bin directories directly (same strategy as detectPwsh).
// Returns { installed, path, inPath } - `inPath` indicates if `where` found it (ready to use)
// vs found via fallback (installed but may need terminal restart).
function detectCli(cli) {
  // 1. Try `where` (checks current PATH - means it's ready to use right now)
  const whereCmd = `where ${cli}.cmd 2>nul || where ${cli} 2>nul`;
  try {
    const where = execSync(whereCmd, { encoding: 'utf8', timeout: 5000 }).trim();
    if (where) return { installed: true, path: where.split('\n')[0].trim(), inPath: true };
  } catch (_) {}

  // 2. Fallback: check common npm global install locations
  const npmPrefixes = [];
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 5000 }).trim();
    if (prefix) npmPrefixes.push(prefix);
  } catch (_) {}
  const appData = process.env.APPDATA || '';
  if (appData) npmPrefixes.push(path.join(appData, 'npm'));
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) npmPrefixes.push(path.join(localAppData, 'npm'));
  const nvmHome = process.env.NVM_HOME || process.env.NVM_SYMLINK || '';
  if (nvmHome) npmPrefixes.push(nvmHome);
  const seen = new Set();
  for (const prefix of npmPrefixes) {
    if (!prefix || seen.has(prefix.toLowerCase())) continue;
    seen.add(prefix.toLowerCase());
    for (const ext of ['.cmd', '.ps1', '']) {
      const candidate = path.join(prefix, cli + ext);
      try { if (fs.existsSync(candidate)) return { installed: true, path: candidate, inPath: false }; } catch (_) {}
    }
  }
  return { installed: false, path: '', inPath: false };
}

// Detect pwsh.exe via `where` first, then fall back to common install paths.
// `where` relies on the current process PATH which may be stale after a fresh install.
function detectPwsh() {
  try {
    const where = execSync('where pwsh.exe 2>nul', { encoding: 'utf8', timeout: 5000 }).trim();
    if (where) return { installed: true, path: where.split('\n')[0].trim() };
  } catch (_) {}
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '8', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', 'pwsh.exe'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return { installed: true, path: c }; } catch (_) {}
  }
  return { installed: false, path: '' };
}

module.exports = { detectCli, detectPwsh, CLI_INSTALL_COMMANDS, PWSH_WINGET_CMD };
