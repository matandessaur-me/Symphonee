'use strict';
// Generates the per-CLI instruction files (CLAUDE.md / AGENTS.md / GEMINI.md /
// GROK.md / QWEN.md / .github/copilot-instructions.md) from INSTRUCTIONS.base.md,
// injecting an installed-plugin keyword index, then re-runs the instruction audit.
// Extracted from server.js as a factory so paths/deps stay injected.
//
// createPluginHints({ repoRoot, pluginsDir, getConfig, getUiContext, broadcast }) -> writePluginHints()

const fs = require('fs');
const path = require('path');
const { atomicWriteSync } = require('../utils/atomic-write');
const instructionAudit = require('../instruction-audit');

function createPluginHints({ repoRoot, pluginsDir, getConfig, getUiContext, broadcast }) {
  return function writePluginHints() {
    // Collect all installed plugins with instructions or keywords
    const pluginData = [];
    try {
      const dirs = fs.readdirSync(pluginsDir);
      for (const dir of dirs) {
        if (dir === 'sdk') continue;
        const mf = path.join(pluginsDir, dir, 'plugin.json');
        if (!fs.existsSync(mf)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
          const instrFile = manifest.instructions
            ? path.join(pluginsDir, dir, manifest.instructions)
            : path.join(pluginsDir, dir, 'instructions.md');
          let instructions = '';
          if (fs.existsSync(instrFile)) {
            try { instructions = fs.readFileSync(instrFile, 'utf8'); } catch (_) {}
          }
          pluginData.push({
            id: manifest.id,
            name: manifest.name,
            description: manifest.description || '',
            keywords: manifest.aiKeywords || [],
            instructions,
          });
        } catch (_) {}
      }
    } catch (_) {}

    // Build a lightweight plugin keyword index (full instructions are fetched dynamically via /api/plugins/instructions)
    let block = '';
    if (pluginData.length) {
      block += '\n## Installed Plugins\n\n';
      block += '### How Plugins Work\n\n';
      block += 'Plugins extend Symphonee with extra capabilities. Each plugin may provide:\n';
      block += '- **API routes** at `/api/plugins/<plugin-id>/` (call via curl or Invoke-RestMethod)\n';
      block += '- **PowerShell scripts** (`.ps1` files) in `dashboard/plugins/<plugin-id>/scripts/` that you can run directly\n';
      block += '- **Node.js scripts** (`.js` files) that you can run with `node`\n\n';
      block += 'You are in a shell environment (PowerShell or bash). You can run plugin scripts directly without curl if scripts exist. ';
      block += 'Fetch the plugin instructions to discover available scripts and API routes.\n\n';
      block += '### IMPORTANT: Always Ask Before Using a Plugin\n\n';
      block += 'When the user\'s request matches any of the keywords below, **ASK the user if they want to use the plugin** before proceeding. For example: "Would you like to use the Builder.io plugin for this?"\n\n';
      block += 'Do NOT silently use a plugin. Do NOT ignore plugins and search the repo instead. Ask first, then fetch the plugin\'s instructions to learn its capabilities.\n\n';
      for (const p of pluginData) {
        if (p.keywords.length) {
          block += `- **${p.name}** (${p.description}): ${p.keywords.join(', ')}\n`;
        }
      }
      block += '\nTo get detailed plugin instructions (API routes, scripts, workflows), run:\n';
      block += '```bash\ncurl -s http://127.0.0.1:3800/api/plugins/instructions\n```\n';
    }

    // Generate all instruction files from a single template (INSTRUCTIONS.base.md)
    const templatePath = path.join(repoRoot, 'INSTRUCTIONS.base.md');
    const outputFiles = [
      { out: path.join(repoRoot, 'CLAUDE.md'),    filename: 'CLAUDE.md' },
      { out: path.join(repoRoot, 'AGENTS.md'),    filename: 'AGENTS.md' },
      { out: path.join(repoRoot, 'GEMINI.md'),    filename: 'GEMINI.md' },
      { out: path.join(repoRoot, 'GROK.md'),      filename: 'GROK.md' },
      { out: path.join(repoRoot, 'QWEN.md'),      filename: 'QWEN.md' },
      { out: path.join(repoRoot, '.github', 'copilot-instructions.md'), filename: 'copilot-instructions.md' },
    ];
    const START = '<!-- PLUGIN_INSTRUCTIONS_START -->';
    const END = '<!-- PLUGIN_INSTRUCTIONS_END -->';
    const REPO_START = '<!-- REPO_CONTEXT_START -->';
    const REPO_END = '<!-- REPO_CONTEXT_END -->';
    const cfg = getConfig();
    // Orchestration (and Graph Runs) are always on; BETA toggle is gone.
    const uiCtx = getUiContext();
    const hasRepo = !!uiCtx.activeRepo;

    if (!fs.existsSync(templatePath)) {
      console.warn('  [writePluginHints] template not found: INSTRUCTIONS.base.md');
      return;
    }
    const template = fs.readFileSync(templatePath, 'utf8');

    for (const { out, filename } of outputFiles) {
      try {
        // Replace the filename placeholder
        let content = template.replace('{{FILENAME}}', filename);
        // Strip repo-specific context when in No Repo mode (handles multiple marker pairs)
        if (!hasRepo) {
          let rStart, rEnd;
          while ((rStart = content.indexOf(REPO_START)) !== -1 && (rEnd = content.indexOf(REPO_END, rStart)) !== -1) {
            content = content.substring(0, rStart) + content.substring(rEnd + REPO_END.length);
          }
        }
        // Inject plugin instructions
        const startIdx = content.indexOf(START);
        const endIdx = content.indexOf(END);
        if (startIdx === -1 || endIdx === -1) { console.warn(`  [writePluginHints] markers not found for ${filename}`); continue; }
        const before = content.substring(0, startIdx + START.length);
        const after = content.substring(endIdx);
        content = before + '\n' + block + '\n' + after;
        atomicWriteSync(out, content);
      } catch (err) { console.error(`  [writePluginHints] failed to generate ${filename}:`, err.message); }
    }
    // Re-run the instruction-coherence audit so /api/bootstrap reflects the latest
    // state. Broadcast on failure so the dashboard can show a toast.
    try {
      const audit = instructionAudit.run({ repoRoot });
      if (!audit.ok) {
        console.warn(`  [audit] FAILED: ${audit.failedChecks.join(', ')}`);
        try { broadcast({ type: 'instructions-audit', audit }); } catch (_) {}
      } else {
        console.log(`  [audit] PASS - ${audit.checks.length} checks, ${audit.ranAt}`);
      }
    } catch (e) { console.warn('  [audit] error running audit:', e.message); }
  };
}

module.exports = { createPluginHints };
