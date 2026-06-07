// ── Activity Ledger ─────────────────────────────────────────────────────────
// First-class, cross-CLI action history (NOT the Azure DevOps "Activity
// Timeline", which is plugin-gated). Shows every action that flowed through the
// server -- automation, plugins, worker spawns, Mind writes, every permission
// decision incl. denials -- live via the WS 'action' broadcast, with git
// checkpoints you can undo to. This is the trust surface: what did it do, and
// can I take it back.

state.ledgerEntries = state.ledgerEntries || [];
state.ledgerCheckpoints = state.ledgerCheckpoints || [];
state.ledgerFilter = state.ledgerFilter || { category: '', outcome: '', q: '' };
state.ledgerOpenCp = state.ledgerOpenCp || null;

const LEDGER_CAT_ICON = {
  api: 'plug', git: 'git-branch', file: 'file-text', terminal: 'square-terminal',
  plugin: 'puzzle', cli: 'bot', apps: 'app-window', browser: 'globe',
  mind: 'brain', orchestrator: 'network', system: 'cpu',
};
const LEDGER_OUTCOME_CLASS = { ok: 'lg-ok', blocked: 'lg-blocked', error: 'lg-error', pending: 'lg-pending' };

function _ledgerEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _ledgerTime(ts) {
  try { const d = new Date(ts); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return ''; }
}

async function ledgerLoad() {
  try {
    const [aRes, cRes] = await Promise.all([
      fetch('/api/ledger?limit=300'),
      fetch('/api/ledger/checkpoints'),
    ]);
    const a = await aRes.json().catch(() => ({}));
    const c = await cRes.json().catch(() => ({}));
    state.ledgerEntries = Array.isArray(a.entries) ? a.entries : [];
    state.ledgerCheckpoints = Array.isArray(c.checkpoints) ? c.checkpoints : [];
  } catch (_) { /* leave whatever we have */ }
  ledgerRender();
  ledgerRenderCheckpoints();
}

function ledgerSetFilter(key, val) {
  state.ledgerFilter[key] = val || '';
  ledgerRender();
}

function _ledgerPasses(e) {
  const f = state.ledgerFilter;
  if (f.category && e.category !== f.category) return false;
  if (f.outcome && e.outcome !== f.outcome) return false;
  if (f.q) {
    const hay = (String(e.action) + ' ' + String(e.resource || '') + ' ' + String(e.detail || '') + ' ' + String(e.actor || '')).toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

function _ledgerRowHtml(e) {
  const icon = LEDGER_CAT_ICON[e.category] || 'activity';
  const oc = LEDGER_OUTCOME_CLASS[e.outcome] || 'lg-ok';
  const decision = e.decision && e.decision !== 'allow' ? '<span class="lg-decision lg-' + _ledgerEsc(e.decision) + '">' + _ledgerEsc(e.decision) + '</span>' : '';
  const resource = e.resource ? '<span class="lg-res">' + _ledgerEsc(e.resource) + '</span>' : '';
  return '<div class="lg-row" data-id="' + _ledgerEsc(e.id) + '">' +
      '<span class="lg-time">' + _ledgerTime(e.ts) + '</span>' +
      '<span class="lg-icon"><i data-lucide="' + icon + '"></i></span>' +
      '<span class="lg-actor">' + _ledgerEsc(e.actor || 'main') + '</span>' +
      '<span class="lg-main"><span class="lg-action">' + _ledgerEsc(e.action) + '</span>' + resource + '</span>' +
      decision +
      '<span class="lg-outcome ' + oc + '">' + _ledgerEsc(e.outcome) + '</span>' +
    '</div>';
}

function ledgerRender() {
  const list = document.getElementById('ledgerList');
  if (!list) return;
  const rows = state.ledgerEntries.filter(_ledgerPasses);
  if (!rows.length) {
    list.innerHTML = '<div class="lg-empty">No actions recorded yet. As the AI (any CLI) acts -- automation, plugins, worker spawns, Mind writes, permission decisions -- they appear here live.</div>';
    return;
  }
  list.innerHTML = rows.map(_ledgerRowHtml).join('');
  if (typeof lucide !== 'undefined') { try { lucide.createIcons({ el: list }); } catch (_) {} }
}

function ledgerRenderCheckpoints() {
  const el = document.getElementById('ledgerCheckpoints');
  if (!el) return;
  const cps = state.ledgerCheckpoints;
  if (!cps.length) {
    el.innerHTML = '<div class="lg-empty-sm">No checkpoints yet. Take one before risky work, then undo to it in a click.</div>';
    return;
  }
  el.innerHTML = cps.map((c) => {
    const open = state.ledgerOpenCp === c.id;
    const fileList = Array.isArray(c.files) && c.files.length
      ? '<div class="lg-cp-files">' + c.files.slice(0, 30).map((f) => '<div class="lg-cp-file"><span class="lg-cp-fst">' + _ledgerEsc(f.status || '?') + '</span>' + _ledgerEsc(f.path || '') + '</div>').join('') +
        (c.files.length > 30 ? '<div class="lg-cp-file lg-cp-more">+' + (c.files.length - 30) + ' more</div>' : '') + '</div>'
      : '<div class="lg-cp-files lg-cp-empty-sm">' + (c.changed ? c.changed + ' changed file(s) (re-checkpoint to capture the list)' : 'clean working tree at snapshot time') + '</div>';
    return '<div class="lg-cp' + (c.auto ? ' lg-cp-auto' : '') + (open ? ' lg-cp-open' : '') + '" onclick="ledgerToggleCp(\'' + _ledgerEsc(c.id) + '\')" title="Click for details">' +
      '<div class="lg-cp-head">' +
        '<i data-lucide="chevron-right" class="lg-cp-caret"></i>' +
        '<span class="lg-cp-label">' + _ledgerEsc(c.label || c.id) + '</span>' +
        '<button class="lg-cp-undo" onclick="event.stopPropagation();ledgerUndo(\'' + _ledgerEsc(c.id) + '\')" title="Revert tracked files to this snapshot">Undo</button>' +
      '</div>' +
      '<div class="lg-cp-meta">' + _ledgerTime(c.ts) + ' &middot; ' + _ledgerEsc(c.branch || '') + ' &middot; ' + (c.changed || 0) + ' changed</div>' +
      '<div class="lg-cp-details"' + (open ? '' : ' style="display:none"') + '>' +
        '<div class="lg-cp-kv"><span>id</span><code>' + _ledgerEsc(c.id) + '</code></div>' +
        '<div class="lg-cp-kv"><span>when</span>' + _ledgerEsc(new Date(c.ts).toLocaleString()) + '</div>' +
        '<div class="lg-cp-kv"><span>branch</span>' + _ledgerEsc(c.branch || '-') + '</div>' +
        '<div class="lg-cp-kv"><span>head</span><code>' + _ledgerEsc(String(c.head || '').slice(0, 9)) + '</code></div>' +
        '<div class="lg-cp-kv"><span>covers</span>' + (c.changed || 0) + ' tracked change(s)</div>' +
        fileList +
        '<div class="lg-cp-hint">Undo reverts tracked files to this snapshot. New (untracked) files are kept, and a safety checkpoint of the current state is taken first, so undo is reversible.</div>' +
      '</div>' +
    '</div>';
  }).join('');
  if (typeof lucide !== 'undefined') { try { lucide.createIcons({ el }); } catch (_) {} }
}

function ledgerToggleCp(id) {
  state.ledgerOpenCp = (state.ledgerOpenCp === id) ? null : id;
  ledgerRenderCheckpoints();
}

async function ledgerCheckpointNow() {
  try {
    const r = await fetch('/api/ledger/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Manual checkpoint' }) });
    const d = await r.json();
    if (d.error) { if (typeof toast === 'function') toast(d.error, 'error'); return; }
    if (typeof toast === 'function') toast('Checkpoint taken (' + (d.checkpoint.changed || 0) + ' changed)', 'success');
    ledgerLoad();
  } catch (e) { if (typeof toast === 'function') toast('Checkpoint failed', 'error'); }
}

async function ledgerUndo(cpId) {
  const cp = state.ledgerCheckpoints.find((c) => c.id === cpId);
  const label = cp ? (cp.label || cp.id) : cpId;
  if (!confirm('Undo to "' + label + '"?\n\nTracked files revert to this snapshot. New (untracked) files are kept, and a safety checkpoint of the current state is taken first, so this is reversible.')) return;
  try {
    const r = await fetch('/api/ledger/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkpointId: cpId }) });
    const d = await r.json();
    if (d.error) { if (typeof toast === 'function') toast(d.error, 'error'); return; }
    if (typeof toast === 'function') toast('Reverted to "' + label + '"', 'success');
    ledgerLoad();
  } catch (e) { if (typeof toast === 'function') toast('Undo failed', 'error'); }
}

// ── Live updates from the WS 'action' broadcast (wired in terminals.js) ──────
function ledgerOnAction(entry) {
  if (!entry || !entry.id) return;
  state.ledgerEntries.unshift(entry);
  if (state.ledgerEntries.length > 1000) state.ledgerEntries.length = 1000;
  // Only touch the DOM if the panel is active (cheap guard).
  const panel = document.getElementById('panel-ledger');
  if (panel && panel.classList.contains('active') && _ledgerPasses(entry)) {
    const list = document.getElementById('ledgerList');
    if (list) {
      const empty = list.querySelector('.lg-empty');
      if (empty) { ledgerRender(); return; }
      list.insertAdjacentHTML('afterbegin', _ledgerRowHtml(entry));
      if (typeof lucide !== 'undefined') { try { lucide.createIcons({ el: list.firstElementChild }); } catch (_) {} }
    }
  }
  // Reflect checkpoint creates/undos in the side list without a full reload.
  if (entry.category === 'git' && (entry.action === 'checkpoint.create' || entry.action === 'checkpoint.undo')) {
    const panel2 = document.getElementById('panel-ledger');
    if (panel2 && panel2.classList.contains('active')) {
      fetch('/api/ledger/checkpoints').then((r) => r.json()).then((c) => { state.ledgerCheckpoints = c.checkpoints || []; ledgerRenderCheckpoints(); }).catch(() => {});
    }
  }
}

function ledgerOnActionPatch(id, fields) {
  if (!id) return;
  const e = state.ledgerEntries.find((x) => x.id === id);
  if (e) Object.assign(e, fields || {});
  const panel = document.getElementById('panel-ledger');
  if (panel && panel.classList.contains('active')) ledgerRender();
}
