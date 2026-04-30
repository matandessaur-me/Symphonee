/**
 * Verbatim message-granular extractor — produces `drawer` nodes.
 *
 * Where `cli-history` emits ONE preview node per session (cheap, lossy),
 * `cli-drawers` emits ONE node per user/assistant message (verbatim, complete).
 *
 * Sweeper pattern (lifted from mempalace/sweeper.py):
 *   - Deterministic ID per message: `drawer_<cli>_<sessionId>_<msgIdx>`.
 *     Re-running over the same file yields identical IDs, so the build
 *     dedup pass collapses re-emissions cleanly.
 *   - Manifest mtime gate: session jsonls are append-only; if mtime hasn't
 *     advanced, every message we'd emit is already in the graph and we
 *     can skip the file entirely.
 *   - Per-session message cap: verbatim of every message in a 50MB session
 *     would torch the graph. We cap at MAX_MSGS_PER_SESSION (newest first).
 *
 * Each drawer node is linked to its parent session node (the cli-history
 * node) via a `derived_from` edge so a query landing on a session can walk
 * straight into the verbatim turns.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeLabel } = require('../security');
const { normalizeId } = require('../ids');

const DEFAULT_MAX_MSGS_PER_SESSION = 60;
const DEFAULT_MAX_SESSIONS = 200;
const SCAN_BYTES_PER_FILE = 4 * 1024 * 1024; // 4 MB cap per session — verbatim is heavy
const DRAWER_LABEL_CHARS = 120;
const DRAWER_CONTENT_CHARS = 8000;

function readWhole(file, max) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(stat.size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), truncated: stat.size > max };
  } catch (_) { return { text: '', truncated: false }; }
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* corrupt line - skip */ }
  }
  return out;
}

function extractMsgText(record) {
  if (!record) return null;
  // Claude / Qwen
  if (record.type === 'user' || record.type === 'assistant') {
    const c = record.message?.content;
    if (typeof c === 'string') return { role: record.type, text: c };
    if (Array.isArray(c)) {
      const parts = [];
      for (const block of c) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text) parts.push(block.text);
        else if (block.type === 'tool_use' && block.name) parts.push(`[tool_use: ${block.name}]`);
      }
      if (parts.length) return { role: record.type, text: parts.join('\n') };
    }
    if (record.message?.parts) {
      const t = record.message.parts.find(p => p?.text)?.text;
      if (t) return { role: record.type, text: t };
    }
  }
  // Codex rollout
  if (record.payload?.input) return { role: 'user', text: String(record.payload.input) };
  if (record.payload?.user_message?.text) return { role: 'user', text: record.payload.user_message.text };
  if (record.payload?.assistant_message?.text) return { role: 'assistant', text: record.payload.assistant_message.text };
  if (record.payload?.assistant_message?.content) return { role: 'assistant', text: String(record.payload.assistant_message.content) };
  // Flat history shapes
  if (record.role && record.text) return { role: record.role, text: record.text };
  // Copilot events.jsonl (type: "user.message" / "assistant.message")
  if (record.type === 'user.message' && record.data?.content) return { role: 'user', text: record.data.content };
  if (record.type === 'assistant.message' && record.data?.content) return { role: 'assistant', text: typeof record.data.content === 'string' ? record.data.content : JSON.stringify(record.data.content) };
  // Gemini chats (type: "user" | "assistant", content is an array of {text})
  if ((record.type === 'user' || record.type === 'assistant') && Array.isArray(record.content)) {
    const text = record.content.map(p => p?.text || '').filter(Boolean).join('\n');
    if (text) return { role: record.type, text };
  }
  // Legacy Copilot flat shapes
  if (record.data?.prompt) return { role: 'user', text: record.data.prompt };
  if (record.data?.message?.content) return { role: record.data.message.role || 'assistant', text: record.data.message.content };
  return null;
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

function extractTimestamp(record, fallback) {
  if (record.timestamp) return new Date(record.timestamp).toISOString();
  if (typeof record.ts === 'number') return new Date(record.ts * (record.ts < 1e12 ? 1000 : 1)).toISOString();
  if (record.payload?.timestamp) return new Date(record.payload.timestamp).toISOString();
  return fallback;
}

// Reuse the same per-CLI session collection helpers as cli-history.
function safeReaddir(p) { try { return fs.readdirSync(p); } catch (_) { return []; } }
function safeIsDir(p)   { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
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
      } else { try { cb(full); } catch (_) {} }
    }
  }
}

function collectAll() {
  const sessions = [];
  const home = os.homedir();
  const claudeRoot = path.join(home, '.claude', 'projects');
  if (fs.existsSync(claudeRoot)) {
    for (const slug of safeReaddir(claudeRoot)) {
      const projDir = path.join(claudeRoot, slug);
      if (!safeIsDir(projDir)) continue;
      for (const f of safeReaddir(projDir)) {
        if (f.endsWith('.jsonl')) sessions.push({ cli: 'claude', file: path.join(projDir, f), projectSlug: slug });
      }
    }
  }
  const codexRoot = path.join(home, '.codex', 'sessions');
  if (fs.existsSync(codexRoot)) walkDirs(codexRoot, (file) => { if (file.endsWith('.jsonl')) sessions.push({ cli: 'codex', file }); }, 4);
  const qwenRoot = path.join(home, '.qwen', 'projects');
  if (fs.existsSync(qwenRoot)) {
    for (const slug of safeReaddir(qwenRoot)) {
      const chats = path.join(qwenRoot, slug, 'chats');
      if (!fs.existsSync(chats)) continue;
      for (const f of safeReaddir(chats)) {
        if (f.endsWith('.jsonl')) sessions.push({ cli: 'qwen', file: path.join(chats, f) });
      }
    }
  }
  const grokRoot = path.join(home, '.grok', 'sessions');
  if (fs.existsSync(grokRoot)) {
    for (const f of safeReaddir(grokRoot)) {
      if (f.endsWith('.jsonl')) sessions.push({ cli: 'grok', file: path.join(grokRoot, f) });
    }
  }
  const copilotRoot = path.join(home, '.copilot', 'session-state');
  if (fs.existsSync(copilotRoot)) {
    for (const sid of safeReaddir(copilotRoot)) {
      const events = path.join(copilotRoot, sid, 'events.jsonl');
      if (fs.existsSync(events)) sessions.push({ cli: 'copilot', file: events, sessionId: sid });
    }
  }
  const geminiRoot = path.join(home, '.gemini', 'tmp');
  if (fs.existsSync(geminiRoot)) {
    for (const proj of safeReaddir(geminiRoot)) {
      const chats = path.join(geminiRoot, proj, 'chats');
      if (!fs.existsSync(chats)) continue;
      for (const f of safeReaddir(chats)) {
        if (f.endsWith('.jsonl')) sessions.push({ cli: 'gemini', file: path.join(chats, f) });
      }
    }
  }
  return sessions;
}

function cwdMatchesRepo(cwd, activeRepoPath) {
  if (!cwd || !activeRepoPath) return false;
  const norm = (s) => s.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(cwd) === norm(activeRepoPath) || norm(cwd).startsWith(norm(activeRepoPath) + '/');
}

function extractCliDrawers({
  activeRepoPath = null,
  allRepos = false,
  maxMsgsPerSession = DEFAULT_MAX_MSGS_PER_SESSION,
  maxSessions = DEFAULT_MAX_SESSIONS,
  manifest = null,
  incremental = false,
} = {}) {
  const sessions = collectAll();
  for (const s of sessions) {
    try { s.mtime = fs.statSync(s.file).mtimeMs; } catch (_) { s.mtime = 0; }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  const kept = sessions.slice(0, maxSessions);

  const nodes = [];
  const edges = [];
  let scanned = 0, skippedUnchanged = 0, skippedOtherRepo = 0, drawersEmitted = 0;
  const manifestKey = (s) => `cli-drawers:${s.file}`;

  for (const s of kept) {
    // Mtime skip only on incremental builds (see cli-history for rationale).
    if (incremental && manifest) {
      const prev = manifest.get(manifestKey(s));
      if (prev && prev.mtimeMs === s.mtime) { skippedUnchanged++; continue; }
    }
    const { text, truncated } = readWhole(s.file, SCAN_BYTES_PER_FILE);
    if (!text) continue;
    const records = parseJsonl(text);
    if (!records.length) continue;
    const cwd = extractCwd(records);
    if (!allRepos && activeRepoPath && cwd && !cwdMatchesRepo(cwd, activeRepoPath)) {
      skippedOtherRepo++;
      continue;
    }

    const sessionId = (s.sessionId || path.basename(s.file).replace(/\.jsonl$/i, '')).slice(0, 80);
    const sessionNodeId = `clisess_${s.cli}_${normalizeId(sessionId)}`.slice(0, 120);
    const sessionMtimeIso = new Date(s.mtime || Date.now()).toISOString();

    // Walk records, take the LAST N messages (newest-most-relevant).
    const msgs = [];
    let msgIdx = 0;
    for (const r of records) {
      const m = extractMsgText(r);
      if (!m) continue;
      m.idx = msgIdx++;
      m.timestamp = extractTimestamp(r, sessionMtimeIso);
      msgs.push(m);
    }
    const recent = msgs.slice(-maxMsgsPerSession);

    for (const m of recent) {
      const drawerId = `drawer_${s.cli}_${normalizeId(sessionId)}_${m.idx}`.slice(0, 140);
      const labelText = (m.text || '').replace(/\s+/g, ' ').slice(0, DRAWER_LABEL_CHARS) || `${s.cli} ${m.role} msg ${m.idx}`;
      nodes.push({
        id: drawerId,
        label: sanitizeLabel(labelText),
        kind: 'drawer',
        source: { type: 'cli-drawers', cli: s.cli, sessionId, msgIdx: m.idx, file: s.file },
        sourceLocation: { file: s.file },
        createdBy: s.cli,
        createdAt: m.timestamp,
        tags: ['drawer', 'verbatim', s.cli, m.role].filter(Boolean),
        content: sanitizeLabel(String(m.text || '').slice(0, DRAWER_CONTENT_CHARS)),
        role: m.role,
        truncated: !!truncated,
      });
      // Link drawer back to its parent session node (which cli-history emits).
      // The dangling-edge tolerance in build.js means this works even if
      // cli-history isn't run in the same build.
      edges.push({
        source: drawerId,
        target: sessionNodeId,
        relation: 'derived_from',
        confidence: 'EXTRACTED',
        confidenceScore: 1.0,
        weight: 1.0,
        createdBy: s.cli,
        createdAt: m.timestamp,
      });
      drawersEmitted++;
    }
    scanned++;
    if (manifest) manifest.set(manifestKey(s), { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs: s.mtime });
  }

  return { nodes, edges, scanned, skippedUnchanged, skippedOtherRepo, drawersEmitted };
}

module.exports = { extractCliDrawers };
