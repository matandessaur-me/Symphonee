// ═══ Permission Mode + Approval Modal ══════════════════════════════════════
const PERM_MODE_COLORS = {
  review: '#4a9eff',
  edit: '#9acd32',
  trusted: '#f5b800',
  bypass: '#ff6b6b'
};
state.permModeCache = {
  mode: 'edit'
};
async function refreshPermMode() {
  try {
    const r = await fetch('/api/permissions');
    const data = await r.json();
    const mode = data.settings && data.settings.mode || 'edit';
    state.permModeCache = {
      mode,
      settings: data.settings
    };
    const chip = document.getElementById('permModeChip');
    const label = document.getElementById('permModeLabel');
    if (label) label.textContent = mode.toUpperCase();
    if (chip) chip.style.borderColor = PERM_MODE_COLORS[mode] || 'var(--subtext0)';
    document.querySelectorAll('.perm-opt').forEach(el => {
      el.style.background = el.dataset.mode === mode ? 'var(--surface2)' : 'transparent';
    });
  } catch (_) {}
}
function openPermModeMenu(ev) {
  ev.stopPropagation();
  const m = document.getElementById('permModeMenu');
  if (!m) return;
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
  if (m.style.display === 'block') {
    setTimeout(() => document.addEventListener('click', closePermModeMenuOnce, {
      once: true
    }), 0);
  }
}
function closePermModeMenuOnce() {
  const m = document.getElementById('permModeMenu');
  if (m) m.style.display = 'none';
}
async function setPermMode(mode) {
  try {
    await fetch('/api/permissions/mode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mode
      })
    });
    closePermModeMenuOnce();
    refreshPermMode();
  } catch (e) {
    console.error('setPermMode failed', e);
  }
}

// The Symphonee brain is always on and intentionally has no UI surface
// in the header. The live intent surfaces where it actually matters:
// bootstrap.brain.intent for CLIs, wakeup banner L0, .symphonee/intent.json
// on disk, and /api/symphonee/intent on demand. The symphonee-intent
// WebSocket event is still dispatched on `window` so any future feature
// (or in-app inspector) can subscribe without re-adding chip code.

// ── Approval modal: polls both permission + graph-run approval queues ──
state._approvalShown = null;
async function pollApprovals() {
  try {
    const all = [];
    try {
      const r1 = await fetch('/api/permissions/pending');
      const list1 = await r1.json();
      if (Array.isArray(list1)) for (const p of list1) all.push({
        kind: 'permission',
        key: p.id,
        data: p
      });
    } catch (_) {}
    try {
      const r2 = await fetch('/api/graph-runs/pending-approvals');
      if (r2.ok) {
        const list2 = await r2.json();
        if (Array.isArray(list2)) for (const g of list2) all.push({
          kind: 'graph-run',
          key: g.runId + ':' + g.nodeId,
          data: g
        });
      }
    } catch (_) {}
    if (all.length === 0) {
      if (state._approvalShown) {
        hideApprovalModal();
        state._approvalShown = null;
      }
      return;
    }
    const next = all[0];
    if (state._approvalShown && state._approvalShown.key === next.key) return;
    showApprovalModal(next);
    state._approvalShown = next;
  } catch (_) {}
}
function showApprovalModal(entry) {
  let overlay = document.getElementById('approvalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'approvalOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:3000;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
    overlay.innerHTML = `
      <div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:var(--radius);padding:20px;min-width:420px;max-width:640px;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
        <div id="approvalHeader" style="display:flex;align-items:center;gap:8px;margin-bottom:12px;color:var(--accent);font-weight:600;font-size:13px;"></div>
        <div id="approvalBody" style="font-size:12px;color:var(--text);margin-bottom:16px;line-height:1.5;max-height:320px;overflow:auto;"></div>
        <div id="approvalButtons" style="display:flex;gap:8px;justify-content:flex-end;"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  const header = document.getElementById('approvalHeader');
  const body = document.getElementById('approvalBody');
  const buttons = document.getElementById('approvalButtons');
  if (entry.kind === 'permission') {
    const p = entry.data;
    const a = p.action || {};
    header.innerHTML = `<i data-lucide="shield-alert" style="width:16px;height:16px;"></i><span>Permission approval</span>`;
    body.innerHTML = `
      <div><strong>Type:</strong> <code style="background:var(--surface1);padding:1px 5px;border-radius:3px;">${escapeHtml(a.type || '?')}</code></div>
      <div style="margin-top:4px;"><strong>Action:</strong> <code style="background:var(--surface1);padding:1px 5px;border-radius:3px;word-break:break-all;">${escapeHtml(a.value || '')}</code></div>
      ${a.op ? `<div style="margin-top:4px;"><strong>Op:</strong> ${escapeHtml(a.op)}</div>` : ''}
      <div style="margin-top:8px;color:var(--subtext0);">Promoting to "always allow" saves the rule in your settings.</div>`;
    buttons.innerHTML = `
      <button onclick="resolveApproval('deny',false)" style="padding:6px 14px;background:var(--surface1);border:1px solid var(--surface2);border-radius:4px;color:var(--text);cursor:pointer;font-size:11px;">Reject</button>
      <button onclick="resolveApproval('allow',false)" style="padding:6px 14px;background:var(--surface1);border:1px solid var(--surface2);border-radius:4px;color:var(--text);cursor:pointer;font-size:11px;">Allow once</button>
      <button onclick="resolveApproval('allow',true)" style="padding:6px 14px;background:var(--accent);border:none;border-radius:4px;color:#000;cursor:pointer;font-size:11px;font-weight:600;">Always allow this pattern</button>`;
  } else if (entry.kind === 'graph-run') {
    const g = entry.data;
    header.innerHTML = `<i data-lucide="workflow" style="width:16px;height:16px;"></i><span>Graph run approval</span>`;
    const stateSnippet = JSON.stringify(g.state || {}, null, 2);
    body.innerHTML = `
      <div><strong>Run:</strong> ${escapeHtml(g.runName || g.runId)} <code style="color:var(--subtext0);font-size:10px;">${escapeHtml(g.runId)}</code></div>
      <div style="margin-top:4px;"><strong>Node:</strong> <code style="background:var(--surface1);padding:1px 5px;border-radius:3px;">${escapeHtml(g.nodeId)}</code></div>
      <div style="margin-top:4px;"><strong>Title:</strong> ${escapeHtml(g.title || '(no title)')}</div>
      <div style="margin-top:8px;"><strong>State snapshot:</strong></div>
      <pre style="background:var(--surface1);padding:8px;border-radius:4px;font-size:10px;margin-top:4px;overflow:auto;max-height:180px;">${escapeHtml(stateSnippet)}</pre>`;
    buttons.innerHTML = `
      <button onclick="resolveGraphApproval(false)" style="padding:6px 14px;background:var(--surface1);border:1px solid var(--surface2);border-radius:4px;color:var(--text);cursor:pointer;font-size:11px;">Reject</button>
      <button onclick="resolveGraphApproval(true)" style="padding:6px 14px;background:var(--accent);border:none;border-radius:4px;color:#000;cursor:pointer;font-size:11px;font-weight:600;">Approve</button>`;
  }
  overlay.style.display = 'flex';
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}
function hideApprovalModal() {
  const o = document.getElementById('approvalOverlay');
  if (o) o.style.display = 'none';
}
async function resolveApproval(decision, promote) {
  if (!state._approvalShown || state._approvalShown.kind !== 'permission') return;
  try {
    await fetch('/api/permissions/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: state._approvalShown.data.id,
        decision,
        promote
      })
    });
  } catch (_) {}
  hideApprovalModal();
  state._approvalShown = null;
}
async function resolveGraphApproval(approved) {
  if (!state._approvalShown || state._approvalShown.kind !== 'graph-run') return;
  const g = state._approvalShown.data;
  try {
    await fetch(`/api/graph-runs/${encodeURIComponent(g.runId)}/approve/${encodeURIComponent(g.nodeId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        approved,
        note: ''
      })
    });
  } catch (_) {}
  hideApprovalModal();
  state._approvalShown = null;
}
document.addEventListener('DOMContentLoaded', () => {
  refreshPermMode();
  setInterval(pollApprovals, 3000);
});