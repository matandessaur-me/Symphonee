// ── Notes State ─────────────────────────────────────────────────────────
state.currentNote = null;
state.noteMode = 'edit'; // 'edit' or 'preview'
state.noteDirty = false;
async function loadNotesList() {
  try {
    const res = await notesFetch('/api/notes');
    const notes = await res.json();
    window._notesListCache = Array.isArray(notes) ? notes : [];
    const container = document.getElementById('notesList');
    container.innerHTML = notes.map(n => `
      <div class="note-item ${state.currentNote === n.name ? 'active' : ''}" onclick="openNote('${esc(n.name)}')" oncontextmenu="event.preventDefault();showNoteContextMenu(event,'${esc(n.name)}')">
        <span>${esc(n.name)}</span>
      </div>
    `).join('') || '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">No notes yet</div>';
  } catch (_) {}
}
async function openNote(name, opts) {
  try {
    markOnboarding('note');
  } catch (_) {}
  try {
    _pushFocus({
      currentNote: name
    });
  } catch (_) {}
  if (state.noteDirty && state.currentNote) await saveCurrentNote();
  try {
    const res = await notesFetch(`/api/notes/read?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    state.currentNote = name;
    state.noteDirty = false;
    document.getElementById('noteTitle').textContent = name;
    const ta = document.getElementById('noteTextarea');
    ta.value = data.content || '';
    document.getElementById('noteEmpty').style.display = 'none';
    document.getElementById('noteSaveBtn').style.display = 'none';
    // If a search query was passed, jump to the first match in edit mode so
    // the user can see WHERE the term occurs (instead of just opening the
    // note at the top).
    const term = opts && opts.jumpTo ? String(opts.jumpTo).toLowerCase() : null;
    if (term) {
      setNoteMode('edit');
      const idx = ta.value.toLowerCase().indexOf(term);
      if (idx !== -1) {
        // Use a 0-length selection at idx so all matches stay reachable via Ctrl+F.
        // Then trigger note-find with this term so the highlight bar opens too.
        ta.focus();
        ta.setSelectionRange(idx, idx + term.length);
        // Approximate scroll to the line containing the match
        const before = ta.value.substring(0, idx);
        const lines = before.split('\n').length;
        const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24;
        ta.scrollTop = Math.max(0, lines * lineHeight - ta.clientHeight / 2);
        // Also open the note find bar with this term pre-filled
        openNoteFind(term);
      }
    } else {
      setNoteMode('preview');
    }
    loadNotesList();
  } catch (_) {}
}
function setNoteMode(mode) {
  state.noteMode = mode;
  const editor = document.getElementById('noteEditor');
  const preview = document.getElementById('notePreview');
  const btn = document.getElementById('noteModeBtn');
  if (mode === 'edit') {
    editor.style.display = 'flex';
    preview.style.display = 'none';
    btn.textContent = 'Preview';
  } else {
    editor.style.display = 'none';
    preview.style.display = 'block';
    preview.innerHTML = renderMarkdown(document.getElementById('noteTextarea').value);
    preview.querySelectorAll('pre code[class*="language-"]').forEach(el => {
      try {
        hljs.highlightElement(el);
      } catch (_) {}
    });
    btn.textContent = 'Edit';
  }
}
function toggleNoteMode() {
  if (!state.currentNote) return;
  setNoteMode(state.noteMode === 'edit' ? 'preview' : 'edit');
}
function onNoteInput() {
  state.noteDirty = true;
  document.getElementById('noteSaveBtn').style.display = '';
  _maybeOpenNoteSlashMenu();
  _maybeOpenNoteMentionMenu();
}

// ── Note slash menu: typing "/" at the start of a line opens a quick menu
// of AI actions that run on the current note content. Close with Escape or
// any non-slash keypress. Inspired by agent-native's ComposeSlashMenu.
const NOTE_SLASH_ACTIONS = [{
  key: 'summarize',
  label: 'Summarize this note',
  icon: 'list',
  build: text => 'Summarize this note in 5 bullets. Keep it tight.\n\n---\n' + text
}, {
  key: 'rewrite',
  label: 'Rewrite cleanly',
  icon: 'wand-2',
  build: text => 'Rewrite the following note so it reads clearly and professionally. Preserve the meaning, fix grammar, keep the same length.\n\n---\n' + text
}, {
  key: 'todos',
  label: 'Extract action items',
  icon: 'check-square',
  build: text => 'Extract every action item from this note as a markdown checklist. Use concrete verbs.\n\n---\n' + text
}, {
  key: 'email',
  label: 'Turn into an email',
  icon: 'mail',
  build: text => 'Turn this note into a polite, concise email. Suggest a subject line. Keep it under 200 words.\n\n---\n' + text
}, {
  key: 'expand',
  label: 'Expand with details',
  icon: 'maximize-2',
  build: text => 'Expand this note with sensible detail, examples, and structure. Preserve my voice.\n\n---\n' + text
}, {
  key: 'translate-fr',
  label: 'Translate to French',
  icon: 'languages',
  build: text => 'Translate this note into natural, idiomatic French. Preserve formatting.\n\n---\n' + text
}];
function _maybeOpenNoteSlashMenu() {
  const ta = document.getElementById('noteTextarea');
  if (!ta) return;
  const caret = ta.selectionStart;
  if (caret == null) return;
  const v = ta.value;
  // Look backwards for the start of the current line.
  const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
  const lineSoFar = v.slice(lineStart, caret);
  // Only fire when the line starts with "/" and has no spaces - keep the
  // menu pattern predictable instead of surprising.
  if (lineSoFar === '/' || /^\/[a-zA-Z-]*$/.test(lineSoFar)) {
    _openNoteSlashMenu(lineSoFar, lineStart);
  } else {
    _closeNoteSlashMenu();
  }
}
function _openNoteSlashMenu(lineSoFar, lineStart) {
  let menu = document.getElementById('noteSlashMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'noteSlashMenu';
    menu.className = 'note-slash-menu';
    document.body.appendChild(menu);
  }
  const query = lineSoFar.slice(1).toLowerCase();
  const matches = NOTE_SLASH_ACTIONS.filter(a => !query || a.key.startsWith(query) || a.label.toLowerCase().includes(query));
  if (!matches.length) {
    _closeNoteSlashMenu();
    return;
  }
  menu.innerHTML = matches.map((a, i) => '<div class="note-slash-item' + (i === 0 ? ' active' : '') + '" data-key="' + a.key + '">' + '<i data-lucide="' + a.icon + '" style="width:13px;height:13px;"></i>' + '<span>' + esc(a.label) + '</span>' + '<span class="note-slash-hint">/' + a.key + '</span>' + '</div>').join('');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
  // Anchor under the textarea. We don't compute caret coordinates - pinning
  // to the editor's top-left corner is predictable and avoids line-wrap math.
  const ta = document.getElementById('noteTextarea');
  const r = ta.getBoundingClientRect();
  menu.style.top = r.top + 10 + 'px';
  menu.style.left = r.left + 24 + 'px';
  menu.style.display = 'block';
  menu.dataset.lineStart = String(lineStart);
  menu.querySelectorAll('.note-slash-item').forEach(el => {
    el.addEventListener('mousedown', ev => {
      ev.preventDefault();
      _runNoteSlashAction(el.dataset.key, parseInt(menu.dataset.lineStart, 10));
    });
  });
}
function _closeNoteSlashMenu() {
  const m = document.getElementById('noteSlashMenu');
  if (m) m.style.display = 'none';
}
function _runNoteSlashAction(key, lineStart) {
  const action = NOTE_SLASH_ACTIONS.find(a => a.key === key);
  const ta = document.getElementById('noteTextarea');
  if (!action || !ta) return;
  // Remove the slash trigger from the textarea (everything from lineStart to caret).
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, lineStart);
  const after = ta.value.slice(caret);
  ta.value = before + after;
  ta.selectionStart = ta.selectionEnd = lineStart;
  _closeNoteSlashMenu();
  const content = ta.value.trim();
  if (!content) {
    toast('Note is empty - nothing to act on', 'warning');
    return;
  }
  askAIFromPalette(action.build(content));
}

// Arrow-key + Enter support for the slash menu.
document.addEventListener('keydown', e => {
  const menu = document.getElementById('noteSlashMenu');
  if (!menu || menu.style.display === 'none') return;
  if (document.activeElement?.id !== 'noteTextarea') return;
  const items = menu.querySelectorAll('.note-slash-item');
  if (!items.length) return;
  let idx = Array.from(items).findIndex(el => el.classList.contains('active'));
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = (idx + 1) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = (idx - 1 + items.length) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const active = items[idx] || items[0];
    _runNoteSlashAction(active.dataset.key, parseInt(menu.dataset.lineStart, 10));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    _closeNoteSlashMenu();
  }
}, true);

// ── Note @-mentions: link to another note or repo ────────────────────────
// Typing "@" pops a grouped picker. Selecting an item inserts a markdown
// reference like "[Note: my-note](note:my-note)". The AI can treat these
// as explicit cross-document pointers without needing fuzzy matching.
function _gatherMentionCandidates() {
  const out = {
    notes: [],
    repos: []
  };
  try {
    if (Array.isArray(window._notesListCache)) {
      out.notes = window._notesListCache.slice(0, 30).map(n => ({
        key: 'note:' + n.name,
        label: n.name,
        category: 'Notes',
        icon: 'file-text',
        insert: '[Note: ' + n.name + '](note:' + encodeURIComponent(n.name) + ')'
      }));
    }
  } catch (_) {}
  try {
    if (state.configData && state.configData.Repos) {
      out.repos = Object.keys(state.configData.Repos).slice(0, 20).map(name => ({
        key: 'repo:' + name,
        label: name,
        category: 'Repos',
        icon: 'git-branch',
        insert: '[Repo: ' + name + '](repo:' + encodeURIComponent(name) + ')'
      }));
    }
  } catch (_) {}
  return [...out.notes, ...out.repos];
}
function _maybeOpenNoteMentionMenu() {
  const ta = document.getElementById('noteTextarea');
  if (!ta) return;
  const caret = ta.selectionStart;
  if (caret == null) return;
  const v = ta.value;
  // Look back for the nearest "@" that starts the current mention token.
  let start = caret - 1;
  while (start >= 0 && v[start] !== '@' && v[start] !== '\n' && v[start] !== ' ' && v[start] !== '\t') start--;
  if (start < 0 || v[start] !== '@') {
    _closeNoteMentionMenu();
    return;
  }
  const token = v.slice(start + 1, caret);
  if (/\s/.test(token)) {
    _closeNoteMentionMenu();
    return;
  }
  _openNoteMentionMenu(token.toLowerCase(), start);
}
function _openNoteMentionMenu(q, atIndex) {
  const candidates = _gatherMentionCandidates();
  const matches = q ? candidates.filter(c => c.label.toLowerCase().includes(q)) : candidates;
  if (!matches.length) {
    _closeNoteMentionMenu();
    return;
  }
  let menu = document.getElementById('noteMentionMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'noteMentionMenu';
    menu.className = 'note-slash-menu';
    document.body.appendChild(menu);
  }
  // Group by category, preserve first 10 per group.
  const groups = {};
  for (const m of matches) {
    (groups[m.category] = groups[m.category] || []).push(m);
  }
  let first = null;
  const html = Object.keys(groups).map(cat => {
    const rows = groups[cat].slice(0, 10).map(m => {
      if (!first) first = m;
      return '<div class="note-slash-item" data-mkey="' + esc(m.key) + '">' + '<i data-lucide="' + esc(m.icon) + '" style="width:13px;height:13px;"></i>' + '<span>' + esc(m.label) + '</span>' + '<span class="note-slash-hint">' + esc(cat) + '</span>' + '</div>';
    }).join('');
    return rows;
  }).join('');
  menu.innerHTML = html;
  menu.querySelectorAll('.note-slash-item').forEach((el, i) => {
    if (i === 0) el.classList.add('active');
    el.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const key = el.dataset.mkey;
      const m = matches.find(x => x.key === key);
      if (m) _insertNoteMention(m, atIndex);
    });
  });
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
  const ta = document.getElementById('noteTextarea');
  const r = ta.getBoundingClientRect();
  menu.style.top = r.top + 10 + 'px';
  menu.style.left = r.left + 24 + 'px';
  menu.style.display = 'block';
  menu.dataset.atIndex = String(atIndex);
}
function _closeNoteMentionMenu() {
  const m = document.getElementById('noteMentionMenu');
  if (m) m.style.display = 'none';
}
function _insertNoteMention(match, atIndex) {
  const ta = document.getElementById('noteTextarea');
  if (!ta) return;
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, atIndex);
  const after = ta.value.slice(caret);
  const inserted = match.insert + ' ';
  ta.value = before + inserted + after;
  const pos = before.length + inserted.length;
  ta.selectionStart = ta.selectionEnd = pos;
  _closeNoteMentionMenu();
  onNoteInput(); // mark dirty + update highlights
}

// Arrow/Enter/Escape handling for the mention menu.
document.addEventListener('keydown', e => {
  const menu = document.getElementById('noteMentionMenu');
  if (!menu || menu.style.display === 'none') return;
  if (document.activeElement?.id !== 'noteTextarea') return;
  const items = menu.querySelectorAll('.note-slash-item');
  if (!items.length) return;
  let idx = Array.from(items).findIndex(el => el.classList.contains('active'));
  if (idx < 0) idx = 0;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = (idx + 1) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = (idx - 1 + items.length) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const active = items[idx] || items[0];
    const key = active.dataset.mkey;
    const all = _gatherMentionCandidates();
    const match = all.find(x => x.key === key);
    if (match) _insertNoteMention(match, parseInt(menu.dataset.atIndex, 10));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    _closeNoteMentionMenu();
  }
}, true);
async function saveCurrentNote() {
  if (!state.currentNote) return;
  const content = document.getElementById('noteTextarea').value;
  try {
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: state.currentNote,
        content
      })
    });
    state.noteDirty = false;
    document.getElementById('noteSaveBtn').style.display = 'none';
    toast('Note saved', 'success');
  } catch (_) {
    toast('Failed to save', 'error');
  }
}
function showNewNoteInput() {
  const wrap = document.getElementById('newNoteInputWrap');
  const input = document.getElementById('newNoteInput');
  wrap.style.display = '';
  input.value = '';
  input.focus();
}
function hideNewNoteInput() {
  document.getElementById('newNoteInputWrap').style.display = 'none';
}
async function confirmCreateNote() {
  const input = document.getElementById('newNoteInput');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name
      })
    });
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    hideNewNoteInput();
    await loadNotesList();
    openNote(data.name);
  } catch (_) {}
}
async function deleteNote(name) {
  const ok = await customConfirm('Delete Note', `Delete "${name}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await notesFetch('/api/notes/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name
      })
    });
    if (state.currentNote === name) {
      state.currentNote = null;
      document.getElementById('noteTitle').textContent = 'No note selected';
      document.getElementById('noteEditor').style.display = 'none';
      document.getElementById('notePreview').style.display = 'none';
      document.getElementById('noteEmpty').style.display = '';
    }
    loadNotesList();
  } catch (_) {}
}
function sendNoteToAi() {
  if (!state.currentNote) return;
  const content = document.getElementById('noteTextarea').value;
  if (!content.trim()) {
    toast('Note is empty', 'info');
    return;
  }
  const name = state.currentNote;
  askAi(`Fetch the Symphonee note named "${name}" via GET /api/notes/read?name=${encodeURIComponent(name)}&ns=${encodeURIComponent(currentNotesNs())} and use its content as context for our conversation. I may ask you to expand on it, update it, or take action based on it.`);
}
function exportCurrentNote() {
  if (!state.currentNote) {
    toast('No note selected', 'info');
    return;
  }
  const a = document.createElement('a');
  a.href = '/api/notes/export?name=' + encodeURIComponent(state.currentNote) + '&ns=' + encodeURIComponent(currentNotesNs());
  a.download = state.currentNote + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function exportAllNotes() {
  const a = document.createElement('a');
  a.href = '/api/notes/export-all';
  a.download = 'symphonee-notes.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function importNotesFromFile() {
  document.getElementById('notesImportFile').click();
}
async function onNotesImportFileChosen(ev) {
  const files = Array.from(ev.target.files || []);
  ev.target.value = '';
  if (!files.length) return;
  const notes = {};
  for (const f of files) {
    const text = await f.text();
    if (f.name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(text);
        const src = parsed && parsed.notes && typeof parsed.notes === 'object' ? parsed.notes : typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        if (src) for (const [k, v] of Object.entries(src)) if (typeof v === 'string') notes[k] = v;
      } catch (_) {
        toast('Invalid JSON: ' + f.name, 'error');
      }
    } else if (f.name.endsWith('.md')) {
      notes[f.name.replace(/\.md$/i, '')] = text;
    }
  }
  if (!Object.keys(notes).length) {
    toast('No notes to import', 'info');
    return;
  }
  try {
    const r = await notesFetch('/api/notes/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        notes
      })
    });
    const d = await r.json();
    if (d.ok) {
      toast('Imported ' + d.written + ' note(s)' + (d.skipped ? ', ' + d.skipped + ' skipped' : ''), 'success');
      loadNotes();
    } else toast(d.error || 'Import failed', 'error');
  } catch (e) {
    toast('Import failed: ' + e.message, 'error');
  }
}

// ── Custom Confirm / Prompt Dialogs ─────────────────────────────────────
state.confirmResolve = null;
state.promptResolve = null;
function customConfirm(title, message, okLabel = 'Confirm') {
  return new Promise(resolve => {
    state.confirmResolve = resolve;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmOkBtn').textContent = okLabel;
    document.getElementById('confirmDialog').classList.add('open');
  });
}
function closeConfirm(result) {
  document.getElementById('confirmDialog').classList.remove('open');
  if (state.confirmResolve) {
    state.confirmResolve(result);
    state.confirmResolve = null;
  }
}
function customPrompt(title, defaultValue = '') {
  return new Promise(resolve => {
    state.promptResolve = resolve;
    document.getElementById('promptTitle').textContent = title;
    const input = document.getElementById('promptInput');
    input.value = defaultValue;
    document.getElementById('promptDialog').classList.add('open');
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  });
}
function closePrompt(ok) {
  document.getElementById('promptDialog').classList.remove('open');
  if (state.promptResolve) {
    state.promptResolve(ok ? document.getElementById('promptInput').value.trim() : null);
    state.promptResolve = null;
  }
}

// ── Note Context Menu ───────────────────────────────────────────────────
state.contextNoteName = null;
function showNoteContextMenu(e, name) {
  state.contextNoteName = name;
  const menu = document.getElementById('noteContextMenu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('open');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
document.addEventListener('click', () => {
  document.getElementById('noteContextMenu').classList.remove('open');
  document.getElementById('diffFileContextMenu').classList.remove('open');
  const ftc = document.getElementById('fileTreeContextMenu');
  if (ftc) ftc.classList.remove('open');
});

// ── File tree context menu (Open in Explorer) ───────────────────────────
state.contextFileTreePath = null;
function showFileTreeContextMenu(e, filePath) {
  state.contextFileTreePath = filePath;
  const menu = document.getElementById('fileTreeContextMenu');
  if (!menu) return;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('open');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
async function revealPath(type, payload) {
  try {
    const res = await fetch('/api/ui/reveal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(Object.assign({
        type
      }, payload))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      toast(data.error || 'Could not reveal', 'error');
      return false;
    }
    return true;
  } catch (_) {
    toast('Could not reveal', 'error');
    return false;
  }
}
async function revealFileFromContext() {
  document.getElementById('fileTreeContextMenu').classList.remove('open');
  if (!state.filesCurrentRepo || !state.contextFileTreePath) return;
  await revealPath('file', {
    repo: state.filesCurrentRepo,
    path: state.contextFileTreePath
  });
}
async function revealCurrentFileInExplorer() {
  if (!state.filesCurrentRepo || !state.filesCurrentFile) return;
  await revealPath('file', {
    repo: state.filesCurrentRepo,
    path: state.filesCurrentFile.path
  });
}
async function revealCurrentNoteInExplorer() {
  if (!state.currentNote) {
    toast('Select a note first', 'error');
    return;
  }
  await revealPath('note', {
    name: state.currentNote
  });
}
async function revealNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  await revealPath('note', {
    name: state.contextNoteName
  });
}
async function deleteNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  const ok = await customConfirm('Delete Note', `Delete "${state.contextNoteName}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await notesFetch('/api/notes/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: state.contextNoteName
      })
    });
    if (state.currentNote === state.contextNoteName) {
      state.currentNote = null;
      document.getElementById('noteTitle').textContent = 'No note selected';
      document.getElementById('noteEditor').style.display = 'none';
      document.getElementById('notePreview').style.display = 'none';
      document.getElementById('noteEmpty').style.display = '';
    }
    loadNotesList();
  } catch (_) {}
}
async function renameNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  const newName = await customPrompt('Rename Note', state.contextNoteName);
  if (!newName || newName === state.contextNoteName) return;
  try {
    // Read old, create new, delete old
    const res = await notesFetch(`/api/notes/read?name=${encodeURIComponent(state.contextNoteName)}`);
    const data = await res.json();
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName,
        content: data.content
      })
    });
    await notesFetch('/api/notes/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: state.contextNoteName
      })
    });
    if (state.currentNote === state.contextNoteName) state.currentNote = newName;
    loadNotesList();
    if (state.currentNote === newName) document.getElementById('noteTitle').textContent = newName;
  } catch (_) {
    toast('Failed to rename', 'error');
  }
}
async function duplicateNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  const newName = await customPrompt('Duplicate Note', state.contextNoteName + ' (copy)');
  if (!newName) return;
  try {
    const res = await notesFetch(`/api/notes/read?name=${encodeURIComponent(state.contextNoteName)}`);
    const data = await res.json();
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName,
        content: data.content
      })
    });
    loadNotesList();
    toast(`Duplicated as "${newName}"`, 'success');
  } catch (_) {
    toast('Failed to duplicate', 'error');
  }
}