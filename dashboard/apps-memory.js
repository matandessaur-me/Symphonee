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
    `Short notes an AI agent built up while driving this application.\n\n` +
    `## Summary\n\n(to be filled in)\n\n` +
    `## UI map\n\n` +
    `## Keybindings that work\n\n` +
    `## Successful workflows\n\n` +
    `## Known failure modes\n\n` +
    `## Calibration\n\n`
  );
  fs.writeFileSync(p, initial, 'utf8');
  return p;
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
  const bytes = Buffer.byteLength(note, 'utf8');
  if (bytes > MAX_NOTE_BYTES) {
    const e = new Error(`note is ${bytes} bytes; must be <= ${MAX_NOTE_BYTES}`);
    e.code = 'note_too_large';
    throw e;
  }
  _ensureFile(app);
  const p = filePath(app);
  const body = fs.readFileSync(p, 'utf8');
  const { meta, rest } = _readFrontmatter(body);
  const headerRe = new RegExp(`(^|\\n)## ${section.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n`, 'i');
  let updated;
  if (headerRe.test(rest)) {
    updated = rest.replace(headerRe, (m) => m + `- ${new Date().toISOString().slice(0, 10)}: ${note.trim()}\n`);
  } else {
    updated = rest.trimEnd() + `\n\n## ${section}\n- ${new Date().toISOString().slice(0, 10)}: ${note.trim()}\n`;
  }
  meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(p, _writeFrontmatter(meta, updated), 'utf8');
  return { ok: true, app: normalizeApp(app), section, bytes };
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
  bumpSession,
  buildSystemPromptAddition,
};
