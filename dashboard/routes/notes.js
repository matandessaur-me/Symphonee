'use strict';
// Notes routes - extracted from server.js (behavior-preserving).
// Notes live under <repoRoot>/notes/<namespace>/<name>.md, namespace derived
// from the active space (see lib/notes-ns).
//
// ctx: { repoRoot, broadcast, hybridSearch, getUiContext }

const fs = require('fs');
const path = require('path');
const { atomicWriteSync } = require('../utils/atomic-write');
const { namespaceFromName } = require('../lib/notes-ns');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function mountNotes(addRoute, json, ctx) {
  const { repoRoot, broadcast, hybridSearch, getUiContext } = ctx;
  const notesDir = path.join(repoRoot, 'notes');

  function _resolveNotesNs(raw) {
    const ns = namespaceFromName(raw);
    const dir = path.join(notesDir, ns);
    fs.mkdirSync(dir, { recursive: true });
    return { ns, dir };
  }
  function _pickNotesNsFromReq(source) {
    // Preference order: explicit ns param -> active space -> '_global'
    const explicit = source && (source.ns || source.namespace);
    if (explicit) return _resolveNotesNs(explicit);
    const uictx = getUiContext ? getUiContext() : {};
    return _resolveNotesNs((uictx && uictx.notesNamespace) || '_global');
  }

  // Migration: move flat notes/*.md into notes/_global/. Runs at mount AND before
  // every list/create/save so manually-dropped flat files get picked up without a
  // restart. Idempotent: a second call is a no-op when there are no flat files.
  function _migrateLegacyNotes() {
    try {
      if (!fs.existsSync(notesDir)) return;
      const flat = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
      if (!flat.length) return;
      const { dir: globalDir } = _resolveNotesNs('_global');
      let moved = false;
      for (const f of flat) {
        const src = path.join(notesDir, f);
        const dst = path.join(globalDir, f);
        try {
          if (!fs.existsSync(dst)) { fs.renameSync(src, dst); moved = true; }
          else fs.unlinkSync(src); // global already has a same-named note
        } catch (_) {}
      }
      if (moved && hybridSearch) {
        try { hybridSearch.reindex().catch(() => {}); } catch (_) {}
      }
    } catch (_) {}
  }
  _migrateLegacyNotes();

  function handleListNotes(url, res) {
    try {
      _migrateLegacyNotes();
      const { dir } = _pickNotesNsFromReq({ ns: url.searchParams.get('ns') });
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f.replace('.md', ''), mtime: st.mtime };
        })
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
      json(res, files);
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  function handleReadNote(url, res) {
    const name = url.searchParams.get('name');
    if (!name) return json(res, { error: 'name required' }, 400);
    const { dir } = _pickNotesNsFromReq({ ns: url.searchParams.get('ns') });
    const filePath = path.join(dir, name + '.md');
    const resolved = path.resolve(filePath);
    if (resolved !== path.resolve(dir) && !resolved.startsWith(path.resolve(dir) + path.sep)) return json(res, { error: 'Invalid path' }, 403);
    try {
      const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
      json(res, { name, content });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  async function handleSaveNote(req, res) {
    const body = await readBody(req);
    const { name, content } = body || {};
    if (!name) return json(res, { error: 'name required' }, 400);
    const { dir } = _pickNotesNsFromReq(body);
    const filePath = path.join(dir, name + '.md');
    const resolved = path.resolve(filePath);
    if (resolved !== path.resolve(dir) && !resolved.startsWith(path.resolve(dir) + path.sep)) return json(res, { error: 'Invalid path' }, 403);
    atomicWriteSync(resolved, content || '');
    broadcast({ type: 'ui-action', action: 'refresh-notes' });
    if (hybridSearch) hybridSearch.indexNote(resolved).catch(() => {});
    json(res, { ok: true });
  }

  async function handleCreateNote(req, res) {
    const body = await readBody(req);
    const { name } = body || {};
    if (!name) return json(res, { error: 'name required' }, 400);
    const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    if (!safeName) return json(res, { error: 'Invalid name' }, 400);
    _migrateLegacyNotes();
    const { dir } = _pickNotesNsFromReq(body);
    const filePath = path.join(dir, safeName + '.md');
    if (fs.existsSync(filePath)) return json(res, { error: 'Note already exists' }, 409);
    atomicWriteSync(filePath, `# ${safeName}\n\n`);
    broadcast({ type: 'ui-action', action: 'refresh-notes' });
    json(res, { ok: true, name: safeName });
  }

  function handleExportNote(url, res) {
    const name = url.searchParams.get('name');
    if (!name) return json(res, { error: 'name required' }, 400);
    const { ns, dir } = _pickNotesNsFromReq({ ns: url.searchParams.get('ns') });
    const filePath = path.join(dir, name + '.md');
    const resolved = path.resolve(filePath);
    if (resolved !== path.resolve(dir) && !resolved.startsWith(path.resolve(dir) + path.sep)) return json(res, { error: 'Invalid path' }, 403);
    if (!fs.existsSync(resolved)) return json(res, { error: 'Not found' }, 404);
    const bodyTxt = fs.readFileSync(resolved, 'utf8');
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    // Prefix the filename with the namespace so same-named notes in different
    // spaces don't collide when downloaded into one folder.
    const safeNs = String(ns || '_global').replace(/[\\/:*?"<>|]/g, '_');
    const downloadName = (safeNs === '_global' ? safeName : safeNs + '__' + safeName) + '.md';
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + downloadName + '"',
    });
    res.end(bodyTxt);
  }

  function handleExportAllNotes(res) {
    // Export every namespace in a single payload so round-tripping via import
    // preserves per-space organization.
    const payload = { _exportedAt: new Date().toISOString(), _exportedFrom: 'Symphonee', namespaces: {} };
    try {
      if (fs.existsSync(notesDir)) {
        for (const ns of fs.readdirSync(notesDir)) {
          const nsDir = path.join(notesDir, ns);
          if (!fs.statSync(nsDir).isDirectory()) continue;
          const nsMap = {};
          for (const f of fs.readdirSync(nsDir)) {
            if (!f.endsWith('.md')) continue;
            try { nsMap[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(nsDir, f), 'utf8'); } catch (_) {}
          }
          if (Object.keys(nsMap).length) payload.namespaces[ns] = nsMap;
        }
      }
    } catch (_) {}
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="symphonee-notes.json"',
    });
    res.end(JSON.stringify(payload, null, 2));
  }

  async function handleImportNotes(req, res) {
    const body = await readBody(req);
    // Accepted shapes:
    //   { namespaces: { nsName: { noteName: content, ... }, ... } } (new export-all)
    //   { notes: { noteName: content, ... } } (legacy export-all -> active ns)
    //   { name, content, ns? }                 (single note)
    //   { noteName: content, ... }             (flat map -> active ns)
    let byNs = {};
    if (body && body.namespaces && typeof body.namespaces === 'object') {
      byNs = body.namespaces;
    } else if (body && body.notes && typeof body.notes === 'object') {
      const ns = namespaceFromName(body.ns);
      byNs[ns] = body.notes;
    } else if (body && body.name && typeof body.content === 'string') {
      const ns = namespaceFromName(body.ns);
      byNs[ns] = { [body.name]: body.content };
    } else if (body && typeof body === 'object' && !Array.isArray(body)) {
      const ns = namespaceFromName(body.ns);
      const map = { ...body }; delete map.ns;
      byNs[ns] = map;
    }
    if (!Object.keys(byNs).length) return json(res, { error: 'Invalid payload' }, 400);
    let written = 0, skipped = 0;
    for (const [nsRaw, map] of Object.entries(byNs)) {
      const { dir } = _resolveNotesNs(nsRaw);
      for (const [name, content] of Object.entries(map || {})) {
        if (typeof content !== 'string') { skipped++; continue; }
        const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
        const dest = path.join(dir, safe + '.md');
        if (!path.resolve(dest).startsWith(path.resolve(dir))) { skipped++; continue; }
        try { fs.writeFileSync(dest, content, 'utf8'); written++; } catch (_) { skipped++; }
      }
    }
    broadcast({ type: 'ui-action', action: 'refresh-notes' });
    json(res, { ok: true, written, skipped });
  }

  async function handleDeleteNote(req, res) {
    const body = await readBody(req);
    const { name } = body || {};
    if (!name) return json(res, { error: 'name required' }, 400);
    const { dir } = _pickNotesNsFromReq(body);
    const filePath = path.join(dir, name + '.md');
    const resolved = path.resolve(filePath);
    if (resolved !== path.resolve(dir) && !resolved.startsWith(path.resolve(dir) + path.sep)) return json(res, { error: 'Invalid path' }, 403);
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    broadcast({ type: 'ui-action', action: 'refresh-notes' });
    json(res, { ok: true });
  }

  // ── Route registrations ─────────────────────────────────────────────────
  addRoute('GET',    '/api/notes',            (req, res, url) => handleListNotes(url, res));
  addRoute('GET',    '/api/notes/read',       (req, res, url) => handleReadNote(url, res));
  addRoute('POST',   '/api/notes/save',       (req, res) => handleSaveNote(req, res));
  addRoute('DELETE', '/api/notes/delete',     (req, res) => handleDeleteNote(req, res));
  addRoute('POST',   '/api/notes/create',     (req, res) => handleCreateNote(req, res));
  addRoute('GET',    '/api/notes/export',     (req, res, url) => handleExportNote(url, res));
  addRoute('GET',    '/api/notes/export-all', (req, res) => handleExportAllNotes(res));
  addRoute('POST',   '/api/notes/import',     (req, res) => handleImportNotes(req, res));
}

module.exports = { mountNotes };
