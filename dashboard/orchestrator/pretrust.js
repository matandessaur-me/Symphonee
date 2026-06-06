'use strict';
// Pre-trust a folder for a CLI so a dispatched one-shot task doesn't get blocked
// by the CLI's "this folder isn't trusted" gate. This is NOT auto-approve - it
// only marks the folder OK to work in. Extracted from orchestrator.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

function _pretrustCodex(cwd) {
  try {
    const cfgDir = path.join(os.homedir(), '.codex');
    const cfgPath = path.join(cfgDir, 'config.toml');
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    let toml = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
    // Codex uses [projects.'<path>'] sections (quoted paths with backslashes on
    // Windows). Check for an existing trusted entry (raw or \\?\ long-path form).
    const variants = [cwd, `\\\\?\\${cwd}`];
    const hasTrust = variants.some((v) => {
      const re = new RegExp(`\\[projects\\.'${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\][^\\[]*trust_level\\s*=\\s*"trusted"`, 'i');
      return re.test(toml);
    });
    if (hasTrust) return;
    if (toml && !toml.endsWith('\n')) toml += '\n';
    toml += `\n[projects.'${cwd}']\ntrust_level = "trusted"\n`;
    fs.writeFileSync(cfgPath, toml, 'utf8');
  } catch (_) { /* non-fatal */ }
}

function _pretrustGemini(cwd) {
  try {
    const cfgDir = path.join(os.homedir(), '.gemini');
    const cfgPath = path.join(cfgDir, 'trustedFolders.json');
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    let obj = {};
    if (fs.existsSync(cfgPath)) {
      try { obj = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (_) { obj = {}; }
    }
    if (obj[cwd] === 'TRUST_FOLDER' || obj[cwd] === 'TRUST_PARENT') return;
    obj[cwd] = 'TRUST_FOLDER';
    fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) { /* non-fatal */ }
}

// Qwen Code is a Gemini CLI fork and honors the same trustedFolders.json.
function _pretrustQwen(cwd) {
  try {
    const qwenDir = path.join(os.homedir(), '.qwen');
    const qwenPath = path.join(qwenDir, 'trustedFolders.json');
    if (!fs.existsSync(qwenDir)) fs.mkdirSync(qwenDir, { recursive: true });
    let obj = {};
    if (fs.existsSync(qwenPath)) {
      try { obj = JSON.parse(fs.readFileSync(qwenPath, 'utf8')) || {}; } catch (_) { obj = {}; }
    }
    if (obj[cwd] === 'TRUST_FOLDER' || obj[cwd] === 'TRUST_PARENT') return;
    obj[cwd] = 'TRUST_FOLDER';
    fs.writeFileSync(qwenPath, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) { /* non-fatal */ }
}

function pretrustFolderForCli(cli, cwd) {
  if (!cwd) return;
  if (cli === 'codex')  return _pretrustCodex(cwd);
  if (cli === 'gemini') return _pretrustGemini(cwd);
  if (cli === 'qwen')   return _pretrustQwen(cwd);
  // claude / copilot / grok: non-interactive modes don't gate on a folder trust list.
}

module.exports = { pretrustFolderForCli };
