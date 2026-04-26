/**
 * CLI history extractor.
 *
 * Pulls each AI CLI's local conversation/session history from disk and
 * ingests it as `conversation` nodes in the shared brain. This is THE
 * mechanism for "what Claude figured out at 2pm is available to Codex at
 * 4pm" - their per-CLI session logs become first-class graph nodes.
 *
 * Detected sources (skipped silently if the dir does not exist):
 *
 *   Claude Code      ~/.claude/projects/<slug>/<sessionId>.jsonl
 *                    ~/.claude/history.jsonl                    (lightweight, prompts only)
 *   Codex (OpenAI)   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<id>.jsonl
 *                    ~/.codex/history.jsonl                     (lightweight, prompts only)
 *   Gemini CLI       ~/.gemini/history/<project>/                (often empty)
 *   Grok CLI         ~/.grok/sessions/<id>.jsonl
 *   Qwen Code        ~/.qwen/projects/<slug>/chats/<id>.jsonl
 *   GitHub Copilot   ~/.copilot/session-state/<uuid>/events.jsonl
 *
 * Each *session* becomes one node (not each message - that would explode
 * the graph). Edges: session --tagged_with--> cli_<name>, and
 * session --tagged_with--> cwd_<repo-slug> when the session declared a cwd.
 *
 * Filter by activeRepoPath by default so the brain stays scoped; pass
 * `allRepos: true` to ingest every session across every project.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel, normalizeId } = require('../ids');

const DEFAULT_MAX_PER_CLI = 200;
const DEFAULT_LABEL_CHARS = 140;
const SCAN_BYTES_PER_FILE = 256 * 1024;       // read at most 256K when scanning a session jsonl
const PREVIEW_CHARS = 4000;

// ---- per-CLI parsers -------------------------------------------------------

function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch (_) { return ''; }
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* corrupt line - skip */ }
  }
  return out;
}

// Extract the first user message text from any of the supported jsonl shapes
function firstUserText(records) {
  for (const r of records) {
    if (!r) continue;
    // Claude / Qwen
    if (r.type === 'user' && r.message?.content) {
      const c = r.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const txt = c.find(x => x?.type === 'text')?.text;
        if (txt) return txt;
      }
    }
    // Qwen alt: parts[].text
    if (r.type === 'user' && r.message?.parts) {
      const t = r.message.parts.find(p => p?.text)?.text;
      if (t) return t;
    }
    // Codex rollout: payload.input or payload.user_message.text
    if (r.payload?.input) return typeof r.payload.input === 'string' ? r.payload.input : '';
    if (r.payload?.user_message?.text) return r.payload.user_message.text;
    // Codex/Claude flat history
    if (r.text) return r.text;
    if (r.display) return r.display;
    // Copilot events: data.prompt or data.message
    if (r.data?.prompt) return r.data.prompt;
    if (r.data?.message?.content) return r.data.message.content;
  }
  return '';
}

function extractCwd(records) {
  for (const r of records) {
    if (!r) continue;
    if (r.cwd) return r.cwd;
    if (r.payload?.cwd) return r.payload.cwd;
    if (r.data?.context?.cwd) return r.data.context.cwd;
  }
  return null;
}

function extractStartTime(records, fallbackMtime) {
  for (const r of records) {
    if (!r) continue;
    if (r.timestamp) return new Date(r.timestamp).toISOString();
    if (r.startTime) return new Date(r.startTime).toISOString();
    if (typeof r.ts === 'number') return new Date(r.ts * (r.ts < 1e12 ? 1000 : 1)).toISOString();
    if (r.data?.startTime) return new Date(r.data.startTime).toISOString();
  }
  return fallbackMtime ? new Date(fallbackMtime).toISOString() : new Date().toISOString();
}

// ---- per-CLI session collectors --------------------------------------------

function collectClaude(opts) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const slug of fs.readdirSync(root)) {
    const projDir = path.join(root, slug);
    if (!safeIsDir(projDir)) continue;
    let entries;
    try { entries = fs.readdirSync(projDir); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      sessions.push({ cli: 'claude', file: path.join(projDir, entry), projectSlug: slug });
    }
  }
  return sessions;
}

function collectCodex(opts) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  walkDirs(root, (file) => {
    if (file.endsWith('.jsonl')) sessions.push({ cli: 'codex', file });
  }, 4);
  return sessions;
}

function collectGemini(opts) {
  const root = path.join(os.homedir(), '.gemini', 'history');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  walkDirs(root, (file) => {
    if (file.endsWith('.json') || file.endsWith('.jsonl')) sessions.push({ cli: 'gemini', file });
  }, 3);
  return sessions;
}

function collectGrok(opts) {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const f of safeReaddir(root)) {
    if (f.endsWith('.jsonl')) sessions.push({ cli: 'grok', file: path.join(root, f) });
  }
  return sessions;
}

function collectQwen(opts) {
  const root = path.join(os.homedir(), '.qwen', 'projects');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const slug of safeReaddir(root)) {
    const chats = path.join(root, slug, 'chats');
    if (!fs.existsSync(chats)) continue;
    for (const f of safeReaddir(chats)) {
      if (f.endsWith('.jsonl')) sessions.push({ cli: 'qwen', file: path.join(chats, f), projectSlug: slug });
    }
  }
  return sessions;
}

function collectCopilot(opts) {
  const root = path.join(os.homedir(), '.copilot', 'session-state');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const sid of safeReaddir(root)) {
    const events = path.join(root, sid, 'events.jsonl');
    if (fs.existsSync(events)) sessions.push({ cli: 'copilot', file: events, sessionId: sid });
  }
  return sessions;
}

// Lightweight roll-up files: just user prompts grouped by sessionId.
function collectClaudeHistory() {
  const f = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(f)) return [];
  return [{ cli: 'claude', file: f, kind: 'rollup' }];
}
function collectCodexHistory() {
  const f = path.join(os.homedir(), '.codex', 'history.jsonl');
  if (!fs.existsSync(f)) return [];
  return [{ cli: 'codex', file: f, kind: 'rollup' }];
}

// ---- dir helpers -----------------------------------------------------------

function safeIsDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch (_) { return []; } }
function walkDirs(root, cb, maxDepth) {
  const stack = [{ p: root, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) {
        if (d < maxDepth) stack.push({ p: full, d: d + 1 });
      } else {
        try { cb(full); } catch (_) {}
      }
    }
  }
}

// Slug for the session's working dir, used as a tag node so all sessions in
// the same repo cluster.
function repoSlug(cwd) {
  if (!cwd) return null;
  return normalizeId(path.basename(cwd.replace(/[\\/]+$/, ''))).slice(0, 40);
}

// Compare a session's cwd to the active repo path - tolerate trailing slashes
// and slash flavor.
function cwdMatchesRepo(cwd, activeRepoPath) {
  if (!cwd || !activeRepoPath) return false;
  const norm = (s) => s.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(cwd) === norm(activeRepoPath) || norm(cwd).startsWith(norm(activeRepoPath) + '/');
}

// ---- main extractor --------------------------------------------------------

function extractCliHistory({ activeRepoPath, allRepos = false, maxPerCli = DEFAULT_MAX_PER_CLI, createdBy = 'mind/cli-history' }) {
  const collectors = [
    collectClaude, collectCodex, collectGemini, collectGrok, collectQwen, collectCopilot,
  ];
  const rolling = [...collectClaudeHistory(), ...collectCodexHistory()];

  let allSessions = [];
  for (const c of collectors) {
    try { allSessions = allSessions.concat(c({})); } catch (_) {}
  }

  // Newest first (by mtime), cap per CLI.
  for (const s of allSessions) {
    try { s.mtime = fs.statSync(s.file).mtimeMs; } catch (_) { s.mtime = 0; }
  }
  allSessions.sort((a, b) => b.mtime - a.mtime);

  const perCliCount = new Map();
  const kept = [];
  for (const s of allSessions) {
    const n = perCliCount.get(s.cli) || 0;
    if (n >= maxPerCli) continue;
    perCliCount.set(s.cli, n + 1);
    kept.push(s);
  }

  const nodes = [];
  const edges = [];
  const seenCli = new Set();
  const seenRepo = new Set();
  let scanned = 0;
  let skippedOtherRepo = 0;

  for (const s of kept) {
    const text = readHead(s.file, SCAN_BYTES_PER_FILE);
    if (!text) continue;
    const records = parseJsonl(text);
    if (!records.length) continue;
    const cwd = extractCwd(records);
    if (!allRepos && activeRepoPath && cwd && !cwdMatchesRepo(cwd, activeRepoPath)) {
      skippedOtherRepo++;
      continue;
    }
    const startTime = extractStartTime(records, s.mtime);
    const userText = firstUserText(records);
    const labelBase = userText || `${s.cli} session ${path.basename(s.file)}`;
    const label = sanitizeLabel(labelBase.slice(0, DEFAULT_LABEL_CHARS));
    const sessionId = path.basename(s.file).replace(/\.jsonl$/i, '').slice(0, 80);
    const id = `clisess_${s.cli}_${normalizeId(sessionId)}`.slice(0, 120);

    nodes.push({
      id, label,
      kind: 'conversation',
      source: { type: 'cli-history', cli: s.cli, file: s.file, sessionId, cwd },
      sourceLocation: { file: s.file },
      createdBy: s.cli,
      createdAt: startTime,
      tags: ['cli-session', s.cli, repoSlug(cwd)].filter(Boolean),
      preview: sanitizeLabel(userText.slice(0, PREVIEW_CHARS)),
      messageCount: records.length,
    });

    // CLI tag node + edge
    const cliId = `cli_${s.cli}`;
    if (!seenCli.has(cliId)) {
      seenCli.add(cliId);
      nodes.push({
        id: cliId, label: sanitizeLabel(s.cli), kind: 'tag',
        source: { type: 'cli', ref: s.cli }, sourceLocation: null,
        createdBy, createdAt: new Date().toISOString(), tags: [],
      });
    }
    edges.push({
      source: id, target: cliId, relation: 'tagged_with',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy: s.cli, createdAt: new Date().toISOString(),
    });

    // Repo tag node + edge (so all sessions in the same repo cluster)
    if (cwd) {
      const slug = repoSlug(cwd);
      const repoTagId = `cwd_${slug}`;
      if (!seenRepo.has(repoTagId)) {
        seenRepo.add(repoTagId);
        nodes.push({
          id: repoTagId, label: sanitizeLabel(`@${slug}`), kind: 'tag',
          source: { type: 'cwd', ref: cwd }, sourceLocation: null,
          createdBy, createdAt: new Date().toISOString(), tags: [],
        });
      }
      edges.push({
        source: id, target: repoTagId, relation: 'tagged_with',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }

    scanned++;
  }

  return { nodes, edges, scanned, skippedOtherRepo, perCli: Object.fromEntries(perCliCount) };
}

module.exports = { extractCliHistory };
