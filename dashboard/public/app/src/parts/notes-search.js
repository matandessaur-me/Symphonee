// ═══ Notes search (uses /api/search) ════════════════════════════════════
let _notesSearchTimer = null;
function onNotesSearchInput() {
  clearTimeout(_notesSearchTimer);
  _notesSearchTimer = setTimeout(runNotesSearch, 200);
}
// ═══ In-note find bar (Ctrl+F when focused in the notes editor) ═════════
let _noteFindMatches = [];
let _noteFindIndex = -1;

function openNoteFind(prefill) {
  const ta = document.getElementById('noteTextarea');
  if (!ta) return;
  // Find bar only makes sense in edit mode (textarea visible)
  if (noteMode !== 'edit') setNoteMode('edit');
  const bar = document.getElementById('noteFindBar');
  bar.style.display = 'flex';
  const input = document.getElementById('noteFindInput');
  if (prefill && !input.value) input.value = prefill;
  setTimeout(() => { input.focus(); input.select(); }, 0);
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  updateNoteFindMatches(true);
}

function closeNoteFind() {
  const bar = document.getElementById('noteFindBar');
  if (bar) bar.style.display = 'none';
  _noteFindMatches = [];
  _noteFindIndex = -1;
  paintNoteHighlights('', -1);
}

function updateNoteFindMatches(jumpToFirst) {
  const ta = document.getElementById('noteTextarea');
  const term = (document.getElementById('noteFindInput').value || '').toLowerCase();
  const countEl = document.getElementById('noteFindCount');
  if (!term) { _noteFindMatches = []; _noteFindIndex = -1; countEl.textContent = '0/0'; return; }
  const text = ta.value.toLowerCase();
  const matches = [];
  let i = 0;
  while ((i = text.indexOf(term, i)) !== -1) { matches.push(i); i += term.length; }
  _noteFindMatches = matches;
  if (matches.length === 0) { _noteFindIndex = -1; countEl.textContent = '0/0'; return; }
  if (jumpToFirst || _noteFindIndex < 0 || _noteFindIndex >= matches.length) _noteFindIndex = 0;
  noteFindHighlight();
}

function noteFindStep(delta) {
  if (_noteFindMatches.length === 0) return;
  _noteFindIndex = (_noteFindIndex + delta + _noteFindMatches.length) % _noteFindMatches.length;
  noteFindHighlight();
}

function noteFindHighlight() {
  const ta = document.getElementById('noteTextarea');
  const term = document.getElementById('noteFindInput').value;
  if (_noteFindIndex < 0 || !term) { paintNoteHighlights('', -1); return; }
  const start = _noteFindMatches[_noteFindIndex];
  const end = start + term.length;
  // Native textarea selection (works only while textarea is focused)
  ta.setSelectionRange(start, end);
  // Approximate scroll so the current match is centered
  const before = ta.value.substring(0, start);
  const lines = before.split('\n').length;
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24;
  ta.scrollTop = Math.max(0, lines * lineHeight - ta.clientHeight / 2);
  document.getElementById('noteFindCount').textContent = (_noteFindIndex + 1) + '/' + _noteFindMatches.length;
  // Paint the overlay so highlights stay visible regardless of which element is focused
  paintNoteHighlights(term, _noteFindIndex);
  syncNoteHighlightScroll();
}

// Render the matched-term highlights into the overlay div behind the textarea.
// Both elements share identical font / padding / wrap rules so character
// positions align. The overlay's text is transparent so only the <mark>
// backgrounds show; the textarea's text on top remains readable.
function paintNoteHighlights(term, currentIdx) {
  const layer = document.getElementById('noteHighlightLayer');
  const ta = document.getElementById('noteTextarea');
  if (!layer || !ta) return;
  const text = ta.value;
  if (!term) { layer.innerHTML = escapeHtml(text); return; }
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  let html = '';
  let i = 0;
  let occ = 0;
  while (true) {
    const next = lower.indexOf(t, i);
    if (next === -1) { html += escapeHtml(text.slice(i)); break; }
    html += escapeHtml(text.slice(i, next));
    const cls = (occ === currentIdx) ? 'note-find-current' : 'note-find';
    html += `<mark class="${cls}">${escapeHtml(text.slice(next, next + term.length))}</mark>`;
    i = next + term.length;
    occ++;
  }
  layer.innerHTML = html;
}

function syncNoteHighlightScroll() {
  const layer = document.getElementById('noteHighlightLayer');
  const ta = document.getElementById('noteTextarea');
  if (!layer || !ta) return;
  layer.scrollTop = ta.scrollTop;
  layer.scrollLeft = ta.scrollLeft;
}

// Re-render highlights as the user types in the note (so they don't drift)
function updateNoteHighlightsLive() {
  const term = document.getElementById('noteFindInput')?.value;
  const bar = document.getElementById('noteFindBar');
  if (term && bar && bar.style.display !== 'none') {
    updateNoteFindMatches(false);
  }
}

function onNoteFindKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    noteFindStep(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeNoteFind();
    document.getElementById('noteTextarea').focus();
  }
}

// Ctrl+F (find in note) is now the 'find-in-note' entry in HOTKEY_ACTIONS,
// dispatched by the central keyboard hub (viewable/rebindable in Settings).

async function runNotesSearch() {
  const q = document.getElementById('notesSearchInput').value.trim();
  const host = document.getElementById('notesSearchResults');
  if (!q) { host.style.display = 'none'; host.innerHTML = ''; return; }
  try {
    // Notes tab search is scoped to notes in the active space's namespace;
    // cross-corpus/cross-space search lives in the command palette.
    const ns = currentNotesNs();
    const r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&kinds=note&ns=' + encodeURIComponent(ns) + '&limit=15');
    const data = await r.json();
    if (!data.results || !data.results.length) {
      host.style.display = '';
      host.innerHTML = '<div style="padding:10px 14px;font-size:11px;color:var(--subtext0);">No matches.</div>';
      return;
    }
    host.style.display = '';
    host.innerHTML = data.results.map((x, i) => {
      // Build a human label that explains WHERE the match is, since users
      // were confused by '0 matches' on results that scored only via title.
      let matchLabel;
      if (x.bodyMatches > 0) {
        matchLabel = `${x.bodyMatches} in note`;
      } else if (x.titleMatches > 0) {
        matchLabel = 'match in title';
      } else if (x.matches > 0) {
        matchLabel = `${x.matches} match${x.matches===1?'':'es'}`;
      } else {
        matchLabel = 'related';
      }
      const meta = `${matchLabel} · score ${x.score}`;
      return `<div data-note-result-idx="${i}" style="padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--surface0);overflow:hidden;min-width:0;" onmouseenter="this.style.background='var(--surface0)'" onmouseleave="this.style.background='transparent'">
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text);font-weight:500;min-width:0;"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(x.title)}</span><span title="Where matches occur. 'in note' = found in the body. 'match in title' = only in the filename. 'related' = ranked by relevance but no exact substring (rare for whole-word queries). Score: BM25 relevance, higher is better." style="font-size:10px;color:var(--subtext0);cursor:help;flex-shrink:0;white-space:nowrap;">${meta}</span></div>
        <div style="font-size:11px;color:var(--subtext0);margin-top:3px;line-height:1.3;word-break:break-word;overflow-wrap:break-word;">${escapeHtml(x.snippet || '')}</div>
      </div>`;
    }).join('');
    // Bind click handlers via addEventListener so filenames with spaces / quotes work cleanly
    host.querySelectorAll('[data-note-result-idx]').forEach(el => {
      const idx = parseInt(el.getAttribute('data-note-result-idx'), 10);
      const result = data.results[idx];
      if (!result) return;
      el.addEventListener('click', () => {
        const name = result.id.replace(/^note:/, '');
        const term = result.terms && result.terms[0] ? result.terms[0] : q;
        // Only ask openNote to jump (and switch to edit mode) when the term
        // actually appears in the body. Otherwise just open in preview --
        // the title matched, the user wants to read the note normally.
        const jumpTo = (result.bodyMatches > 0) ? term : null;
        openNote(name, jumpTo ? { jumpTo } : null);
        if (!jumpTo && (result.titleMatches > 0 || result.matches === 0)) {
          // Toast a hint so they know why no highlight appeared
          toast(result.titleMatches > 0
            ? `"${term}" appears in the title only, not in the body.`
            : `"${term}" is related but not literally in this note.`, 'success');
        }
      });
    });
  } catch (_) {
    host.style.display = '';
    host.innerHTML = '<div style="padding:10px 14px;font-size:11px;color:var(--red);">Search failed.</div>';
  }
}


// Each variable: human-readable label first, then the {{ token }} as secondary text.
const RE_CONTEXT_VARS = [
  { label: 'Selected Repo', token: 'context.activeRepo', desc: 'Name of the repo currently selected in the sidebar' },
  { label: 'Selected Repo Path', token: 'context.activeRepoPath', desc: 'Full on-disk path of the selected repo' },
  { label: 'Selected Iteration', token: 'context.selectedIterationName', desc: 'Name of the active Azure DevOps iteration' },
  { label: 'Selected Area', token: 'context.selectedAreaName', desc: 'Active Azure DevOps area path' },
  { label: 'OS Username', token: 'env.USERNAME', desc: 'Operating system username' },
];
const RE_SNIPPETS = [
  { label: 'Run a script', desc: 'Bash-friendly invocation of a PowerShell script', text: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/<Name>.ps1"' },
  { label: 'Save a note', desc: 'Persist markdown to the Notes tab', text: 'node scripts/save-note.js "Title here" --file .ai-workspace/output.md' },
  { label: 'Show diff viewer', desc: 'Open the built-in side-by-side diff for the active repo', text: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Show-Diff.ps1 -Repo \'{{ context.activeRepo }}\'"' },
  { label: 'List work items', desc: 'Active items in the current iteration', text: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Find-WorkItems.ps1 -State Active"' },
  { label: 'Pick best model for a task', desc: 'Ask the model router for the right CLI/model', text: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Get-ModelRecommendation.ps1 -Intent quick-summary"' },
  { label: 'Start a graph run', desc: 'Launch a multi-step durable workflow from a JSON definition', text: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/Start-GraphRun.ps1" -File ".ai-workspace/my-graph.json"' },
];




















