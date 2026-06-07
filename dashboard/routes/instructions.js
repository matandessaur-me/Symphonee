// AI Instructions + AI providers endpoints. Serves the split instruction files
// from dashboard/instructions/ so CLAUDE.md stays small, plus the coherence
// audit and the provider/model catalog. Extracted from server.js verbatim.
//
//   GET  /api/ai/providers              - SDK providers + which have keys
//   GET  /api/instructions              - all instruction files concatenated
//   GET  /api/instructions/audit        - cached coherence audit
//   POST /api/instructions/audit        - force a re-run
//   GET  /api/instructions/<name>       - a single instruction file

const fs = require('fs');
const path = require('path');
const instructionAudit = require('../instruction-audit');

const instrDir = path.join(__dirname, '..', 'instructions');

function readInstrFile(name) {
  const p = path.join(instrDir, name + '.md');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// Core instructions are plugin-agnostic. Plugin-specific rules live in each
// plugin's own instructions.md (served by /api/plugins/instructions).
function stripPluginMarkers(content) { return content; }

function mountInstructions(addRoute, json, deps) {
  const { getConfig, repoRoot, broadcast } = deps;

  // Lists AI providers Symphonee can talk to via SDK, marking which ones the
  // user actually has keys for (saved in Settings -> AI Keys, or in env).
  addRoute('GET', '/api/ai/providers', (req, res) => {
    const cfg = getConfig() || {};
    const saved = cfg.AiApiKeys || {};
    const providers = [
      {
        key: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY',
        models: [
          { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
          { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
          { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
        ],
      },
      {
        key: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY',
        models: [
          { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
          { id: 'openai/gpt-4o', label: 'GPT-4o' },
          { id: 'openai/o3', label: 'o3' },
          { id: 'openai/o4-mini', label: 'o4-mini' },
        ],
      },
      {
        key: 'google', label: 'Google Gemini', envKey: 'GEMINI_API_KEY',
        models: [
          { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
          { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
          { id: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)' },
        ],
      },
      {
        key: 'xai', label: 'xAI Grok', envKey: 'XAI_API_KEY',
        models: [
          { id: 'xai/grok-4', label: 'Grok 4' },
          { id: 'xai/grok-3', label: 'Grok 3' },
          { id: 'xai/grok-3-mini-fast', label: 'Grok 3 Mini Fast' },
        ],
      },
    ].map((p) => ({
      ...p,
      configured: !!saved[p.envKey] || !!process.env[p.envKey],
    }));
    json(res, { ok: true, providers });
  });

  // Merged: returns all instruction files concatenated (config-aware).
  addRoute('GET', '/api/instructions', (req, res) => {
    try {
      // Order: behavioral rules first (survive compaction better), reference tables last.
      const priorityOrder = ['workflows.md', 'orchestrator.md', 'api-reference.md'];
      const files = fs.readdirSync(instrDir).filter((f) => f.endsWith('.md')).sort((a, b) => {
        const ai = priorityOrder.indexOf(a), bi = priorityOrder.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
      const sections = files.map((f) => stripPluginMarkers(fs.readFileSync(path.join(instrDir, f), 'utf8')));
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(sections.join('\n\n---\n\n'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // Coherence audit. GET returns the cached result; POST forces a refresh.
  // Every /api/bootstrap response also embeds the cached audit (self-healing chain).
  addRoute('GET', '/api/instructions/audit', (req, res) => {
    let result = instructionAudit.getCached();
    if (!result) { try { result = instructionAudit.run({ repoRoot }); } catch (e) { return json(res, { error: e.message }, 500); } }
    return json(res, result);
  });
  addRoute('POST', '/api/instructions/audit', async (req, res) => {
    try {
      const result = instructionAudit.run({ repoRoot });
      try { broadcast({ type: 'instructions-audit', audit: result }); } catch (_) {}
      return json(res, result);
    } catch (e) { return json(res, { error: e.message }, 500); }
  });

  // Individual: /api/instructions/{name} serves a single file.
  addRoute('__PREFIX__', '/api/instructions', (req, res, url, subpath) => {
    const name = (subpath || '').replace(/^\//, '').replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) { json(res, { error: 'Missing instruction name' }, 400); return; }
    const content = readInstrFile(name);
    if (!content) { json(res, { error: `Instruction "${name}" not found` }, 404); return; }
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(stripPluginMarkers(content));
  });

  console.log('  AI Instructions endpoint mounted (/api/instructions/*)');
}

module.exports = { mountInstructions };
