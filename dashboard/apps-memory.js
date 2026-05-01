/**
 * Apps per-app memory.
 *
 * Each target app gets a markdown file under dashboard/app-memory/<exe>.md.
 * The agent reads this file into its system prompt at session start and
 * can append to it through the writeMemory tool as it learns.
 *
 * App identity = lowercased process executable name (no .exe), because
 * window titles change but process names don't.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'app-memory');
const MAX_NOTE_BYTES = 2048;
const SYSTEM_PROMPT_BUDGET = 4096;

function _ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function normalizeApp(app) {
  const s = String(app || '').trim().toLowerCase();
  // Strip common .exe suffixes and any path separators.
  return s.replace(/\.exe$/, '').replace(/[\/\\:*?"<>|]/g, '').slice(0, 80) || 'unknown';
}

function filePath(app) {
  return path.join(DIR, normalizeApp(app) + '.md');
}

function _readFrontmatter(body) {
  if (!body.startsWith('---\n')) return { meta: {}, rest: body };
  const end = body.indexOf('\n---\n', 4);
  if (end < 0) return { meta: {}, rest: body };
  const head = body.slice(4, end);
  const meta = {};
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2];
  }
  return { meta, rest: body.slice(end + 5) };
}

function _writeFrontmatter(meta, rest) {
  const lines = Object.keys(meta).map(k => `${k}: ${meta[k]}`);
  return '---\n' + lines.join('\n') + '\n---\n' + rest;
}

function loadMemory(app) {
  _ensureDir();
  const p = filePath(app);
  if (!fs.existsSync(p)) return '';
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

// Canonical sections for the memory file. Anything the agent writes is
// remapped into one of these so the file stays tidy instead of growing a
// new ad-hoc heading every session.
const CANON_SECTIONS = ['Instructions', 'DOs', "DON'T DOs", 'Nice to know', 'Keybindings'];

// Map common alias/legacy names onto the canonical section headings.
function _canonSection(section) {
  const s = String(section || '').trim().toLowerCase();
  if (!s) return 'Nice to know';
  if (/^(instructions?|user instructions?|user-instructions?)$/.test(s)) return 'Instructions';
  if (/^(dos?|successful workflows?|what worked|working|successes)$/.test(s)) return 'DOs';
  if (/^(don'?t ?dos?|known failure modes?|failures?|do not retry|don'?t retry|anti-pattern)$/.test(s)) return "DON'T DOs";
  if (/^(nice to know|ui map|tips|quirks|notes|summary|misc)$/.test(s)) return 'Nice to know';
  if (/^(keybindings( that work)?|shortcuts?|hotkeys?)$/.test(s)) return 'Keybindings';
  return 'Nice to know';
}

// Reject "noise" bullets that describe the agent's own stuckness rather
// than app-specific knowledge. Anything matching these reads like session
// narration, not a reusable note.
const NOISE_PATTERNS = [
  /reached\s+\d+\s+(stuck|attempts)/i,
  /after\s+\d+\s+(attempts?|stuck|iterations)/i,
  /\b(stuck declarations?|stopping\.?|halting|handed? off|ending session|user takeover|user to take over)\b/i,
  /\bunable to (successfully|proceed|make progress)/i,
  /\b(not responding to clicks?|does not respond)/i,
  /\bi (cannot|could not|was unable|gave up)\b/i,
];
function _isNoiseNote(note) {
  const s = String(note || '').trim();
  if (!s || s.length < 4) return true;
  return NOISE_PATTERNS.some(re => re.test(s));
}

function _ensureFile(app) {
  _ensureDir();
  const p = filePath(app);
  if (fs.existsSync(p)) return p;
  const now = new Date().toISOString();
  const initial = _writeFrontmatter({
    app: normalizeApp(app),
    firstSeen: now,
    lastUpdated: now,
    sessions: '1',
  },
    `# ${normalizeApp(app)}\n\n` +
    `Concrete, reusable notes built up while an AI agent drove this app. ` +
    `Only decision-useful bullets live here — no session narration.\n\n` +
    `## Instructions\n\n(User-written guidance. The AI reads this first on every session.)\n\n` +
    `## DOs\n\n(Workflows that actually worked — minimal steps only.)\n\n` +
    `## DON'T DOs\n\n(Approaches that failed predictably. Future sessions should skip these.)\n\n` +
    `## Nice to know\n\n(UI map, quirks, where things live.)\n\n` +
    `## Keybindings\n\n(Verified shortcuts. Prefer these over click paths.)\n\n`
  );
  fs.writeFileSync(p, initial, 'utf8');
  return p;
}

// Replace the entire memory file for an app. Used by the Instructions UI
// when the user wants to clean up accumulated noise from prior sessions
// (duplicate failure bullets, outdated notes, etc).
function replaceMemory(app, body) {
  _ensureFile(app);
  const p = filePath(app);
  const raw = fs.readFileSync(p, 'utf8');
  const { meta } = _readFrontmatter(raw);
  meta.lastUpdated = new Date().toISOString();
  const clean = String(body || '').replace(/^---\r?\n[\s\S]*?\n---\r?\n/, '');
  fs.writeFileSync(p, _writeFrontmatter(meta, clean.trimStart()), 'utf8');
  return { ok: true, app: normalizeApp(app), bytes: Buffer.byteLength(clean, 'utf8') };
}

// Wipe everything except the frontmatter, producing a fresh file. Useful
// when the agent has polluted its own memory with duplicate dead-end notes.
function clearMemory(app) {
  _ensureFile(app);
  const p = filePath(app);
  const raw = fs.readFileSync(p, 'utf8');
  const { meta } = _readFrontmatter(raw);
  meta.lastUpdated = new Date().toISOString();
  meta.sessions = '0';
  const fresh =
    `# ${normalizeApp(app)}\n\n` +
    `Concrete, reusable notes built up while an AI agent drove this app. ` +
    `Only decision-useful bullets live here — no session narration.\n\n` +
    `## Instructions\n\n(User-written guidance. The AI reads this first on every session.)\n\n` +
    `## DOs\n\n(Workflows that actually worked — minimal steps only.)\n\n` +
    `## DON'T DOs\n\n(Approaches that failed predictably. Future sessions should skip these.)\n\n` +
    `## Nice to know\n\n(UI map, quirks, where things live.)\n\n` +
    `## Keybindings\n\n(Verified shortcuts. Prefer these over click paths.)\n\n`;
  fs.writeFileSync(p, _writeFrontmatter(meta, fresh), 'utf8');
  return { ok: true, app: normalizeApp(app) };
}

function bumpSession(app) {
  _ensureFile(app);
  const p = filePath(app);
  const body = fs.readFileSync(p, 'utf8');
  const { meta, rest } = _readFrontmatter(body);
  meta.lastUpdated = new Date().toISOString();
  meta.sessions = String((parseInt(meta.sessions, 10) || 0) + 1);
  fs.writeFileSync(p, _writeFrontmatter(meta, rest), 'utf8');
}

function appendSection(app, section, note) {
  if (!section || !note) throw new Error('section and note are required');
  const trimmed = String(note).trim();
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes > MAX_NOTE_BYTES) {
    const e = new Error(`note is ${bytes} bytes; must be <= ${MAX_NOTE_BYTES}`);
    e.code = 'note_too_large';
    throw e;
  }
  // Silently drop noise bullets instead of polluting the file.
  if (_isNoiseNote(trimmed)) {
    return { ok: true, dropped: 'noise', app: normalizeApp(app), section };
  }
  const canon = _canonSection(section);
  _ensureFile(app);
  const p = filePath(app);
  const body = fs.readFileSync(p, 'utf8');
  const { meta, rest } = _readFrontmatter(body);
  const headerRe = new RegExp(`(^|\\n)## ${canon.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n`, 'i');
  const dateSlug = new Date().toISOString().slice(0, 10);
  const bullet = `- ${dateSlug}: ${trimmed}`;
  // Dedupe: if the same bullet text (ignoring date) already exists under
  // this section, skip. Prevents the "same failure mode 70 times" pattern.
  const existingRe = new RegExp('^-\\s+\\d{4}-\\d{2}-\\d{2}:\\s+' + trimmed.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&').slice(0, 120), 'im');
  if (existingRe.test(rest)) {
    return { ok: true, dedup: true, app: normalizeApp(app), section: canon };
  }
  let updated;
  if (headerRe.test(rest)) {
    updated = rest.replace(headerRe, (m) => m + bullet + '\n');
  } else {
    updated = rest.trimEnd() + `\n\n## ${canon}\n${bullet}\n`;
  }
  meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(p, _writeFrontmatter(meta, updated), 'utf8');
  return { ok: true, app: normalizeApp(app), section: canon, bytes, path: p };
}

function replaceSection(app, section, body) {
  if (!section) throw new Error('section required');
  const bytes = Buffer.byteLength(body || '', 'utf8');
  if (bytes > MAX_NOTE_BYTES * 2) {
    const e = new Error(`section body is ${bytes} bytes; must be <= ${MAX_NOTE_BYTES * 2}`);
    e.code = 'note_too_large';
    throw e;
  }
  _ensureFile(app);
  const p = filePath(app);
  const raw = fs.readFileSync(p, 'utf8');
  const { meta, rest } = _readFrontmatter(raw);
  const sectionRe = new RegExp(
    `(^|\\n)(## ${section.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n)([\\s\\S]*?)(?=\\n## |$)`,
    'i'
  );
  let updated;
  if (sectionRe.test(rest)) {
    updated = rest.replace(sectionRe, (_m, lead, header) => lead + header + (body.trim() + '\n'));
  } else {
    updated = rest.trimEnd() + `\n\n## ${section}\n${body.trim()}\n`;
  }
  meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(p, _writeFrontmatter(meta, updated), 'utf8');
  return { ok: true, app: normalizeApp(app), section, bytes };
}

function buildSystemPromptAddition(app) {
  if (!app) return '';
  const body = loadMemory(app);
  if (!body) return '';
  if (Buffer.byteLength(body, 'utf8') <= SYSTEM_PROMPT_BUDGET) {
    return '\n\n## Prior notes for this app\n\n' + body.trim() +
      '\n\nThese are things you (or past sessions) learned about this app. Apply them. When you discover something new that would help a future session, call writeMemory.';
  }
  // Truncate and point at readMemory.
  const trunc = body.slice(0, SYSTEM_PROMPT_BUDGET);
  return '\n\n## Prior notes for this app (truncated)\n\n' + trunc +
    `\n\n[truncated; call readMemory({app: "${normalizeApp(app)}"}) for the full file]\n\n` +
    'Apply these notes. When you discover something new, call writeMemory.';
}

module.exports = {
  DIR,
  normalizeApp,
  filePath,
  loadMemory,
  appendSection,
  replaceSection,
  replaceMemory,
  clearMemory,
  bumpSession,
  buildSystemPromptAddition,
};
