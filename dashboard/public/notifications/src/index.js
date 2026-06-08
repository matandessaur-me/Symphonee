// notifications -- the notification center/badge, sound, palette/quick-ask task
// tracking, inline replies, and follow-up prompts. esbuild IIFE; most helpers
// stay private. Registers global click/keydown/DOMContentLoaded listeners and
// loads saved notifications at load, and reads the shared `state`, so it loads
// AFTER app.js.
//
// Coupling (see ARCHITECTURE.md):
//  - OWNS `notify` (used by 6 parts) + the `_paletteNotifyTasks` Set (mutated by
//    command-palette + orchestrator) -> re-exposed on window.
//  - CONSUMES `CLI_CONFIG` (const owned by terminals.js, which exposes it on
//    window). Other deps (state, esc, toast, openCmdPalette, ...) are window-
//    resolved app globals.
//
// ── Activity stats: weekly roll-up of orchestrator runs ─────────────────
// Inspired by agent-native's usage store. Symphonee doesn't own the LLM
// billing, so we aggregate task volume + runtime - the data we actually
// have. Gives users a proxy for "how much AI work am I doing this week".
function openActivityStats() {
  const tasks = Array.isArray(state.orchTasks) ? state.orchTasks : [];
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recent = tasks.filter(t => (t.startedAt || 0) >= weekAgo);
  const byCli = new Map();
  const byState = new Map();
  const byDay = new Array(7).fill(0);
  let totalMs = 0,
    withDuration = 0;
  for (const t of recent) {
    byCli.set(t.cli || t.type, (byCli.get(t.cli || t.type) || 0) + 1);
    byState.set(t.state || 'unknown', (byState.get(t.state || 'unknown') || 0) + 1);
    const d = new Date(t.startedAt || now);
    const dayIdx = Math.floor((now - d.getTime()) / (24 * 60 * 60 * 1000));
    if (dayIdx >= 0 && dayIdx < 7) byDay[6 - dayIdx]++;
    if (t.startedAt && t.completedAt) {
      totalMs += t.completedAt - t.startedAt;
      withDuration++;
    }
  }
  const avgDur = withDuration ? formatOrchDuration(totalMs / withDuration) : '-';
  const totalMsStr = formatOrchDuration(totalMs || 0);
  const maxDay = Math.max(1, ...byDay);
  const bars = byDay.map(n => {
    const h = Math.max(3, Math.round(40 * (n / maxDay)));
    return '<div class="stat-bar" style="height:' + h + 'px;" title="' + n + ' task' + (n === 1 ? '' : 's') + '"></div>';
  }).join('');
  const cliRows = [...byCli.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const label = CLI_CONFIG[k] && CLI_CONFIG[k].label || k;
    return '<tr><td>' + esc(label) + '</td><td style="text-align:right;">' + v + '</td></tr>';
  }).join('') || '<tr><td colspan="2" style="color:var(--subtext0);">No runs in the last 7 days</td></tr>';
  const stateRows = [...byState.entries()].map(([k, v]) => '<tr><td><span class="orch-task-state ' + esc(k) + '">' + esc(k) + '</span></td><td style="text-align:right;">' + v + '</td></tr>').join('') || '<tr><td colspan="2" style="color:var(--subtext0);">-</td></tr>';
  let overlay = document.getElementById('statsOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'statsOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3250;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML = '<div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:10px;width:560px;max-width:92vw;max-height:80vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5);padding:18px 22px;">' + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' + '<i data-lucide="bar-chart-3" style="width:17px;height:17px;color:var(--accent);"></i>' + '<strong style="font-size:14px;">Activity, last 7 days</strong>' + '<div style="flex:1;"></div>' + '<button onclick="document.getElementById(\'statsOverlay\').remove()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>' + '</div>' + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px;">' + '<div class="stat-card"><div class="stat-value">' + recent.length + '</div><div class="stat-label">Tasks</div></div>' + '<div class="stat-card"><div class="stat-value">' + avgDur + '</div><div class="stat-label">Avg duration</div></div>' + '<div class="stat-card"><div class="stat-value">' + totalMsStr + '</div><div class="stat-label">Total runtime</div></div>' + '</div>' + '<div style="margin-bottom:18px;">' + '<div style="font-size:10px;color:var(--overlay1);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Tasks per day</div>' + '<div class="stat-sparkline">' + bars + '</div>' + '</div>' + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">' + '<div>' + '<div style="font-size:10px;color:var(--overlay1);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">By runner</div>' + '<table class="stat-table"><tbody>' + cliRows + '</tbody></table>' + '</div>' + '<div>' + '<div style="font-size:10px;color:var(--overlay1);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">By state</div>' + '<table class="stat-table"><tbody>' + stateRows + '</tbody></table>' + '</div>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  try {
    lucide.createIcons({
      nodes: [overlay]
    });
  } catch (_) {}
}

// ── Notification sounds ─────────────────────────────────────────────────
// Tiny synthesized beeps so the user hears when something finishes or
// errors without adding audio-file assets. Separate tones per severity
// keep successes and failures distinguishable from across the room.
// Muted by default respecting document.visibilityState could be added
// later; for now we just honor a localStorage toggle.
const NOTIF_SOUND_KEY = 'symphonee-notif-sound-v1';
state._notifAudioCtx = null;
function _notifSoundEnabled() {
  try {
    return localStorage.getItem(NOTIF_SOUND_KEY) !== '0';
  } catch (_) {
    return true;
  }
}
function setNotifSoundEnabled(on) {
  try {
    localStorage.setItem(NOTIF_SOUND_KEY, on ? '1' : '0');
  } catch (_) {}
}
function _notifToggleSound() {
  setNotifSoundEnabled(!_notifSoundEnabled());
  _renderNotifSoundToggle();
  if (_notifSoundEnabled()) playNotifSound('info');
}
function _renderNotifSoundToggle() {
  const btn = document.getElementById('notifSoundToggle');
  if (!btn) return;
  btn.textContent = _notifSoundEnabled() ? 'Sound on' : 'Sound off';
}
function playNotifSound(kind) {
  if (!_notifSoundEnabled()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!state._notifAudioCtx) state._notifAudioCtx = new Ctx();
    const ctx = state._notifAudioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    // Distinct envelope + tone per kind. Keep max volume quiet (~0.08)
    // so it is informative, not alarming.
    const tones = {
      success: [[880, 0.00, 0.08], [1320, 0.10, 0.08]],
      error: [[220, 0.00, 0.14], [160, 0.16, 0.16]],
      warning: [[660, 0.00, 0.10], [660, 0.14, 0.10]],
      info: [[520, 0.00, 0.09]]
    };
    const seq = tones[kind] || tones.info;
    for (const [freq, start, dur] of seq) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = kind === 'error' ? 'square' : 'sine';
      osc.frequency.value = freq;
      const t0 = now + start;
      const t1 = t0 + dur;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
  } catch (_) {/* best-effort; never crash on audio issues */}
}

// ── Notification center ─────────────────────────────────────────────────
// Persistent, dismissable messages. Different from toasts (auto-dismiss).
// Stored in localStorage so they survive reloads. Capped at 50 entries.
const NOTIF_KEY = 'symphonee-notifications';
const NOTIF_MAX = 50;
state._notifs = []; // Tracks tasks dispatched from the palette / quick-ask so the orchestrator
// WebSocket handler knows to surface their completion in the notif center.
const _paletteNotifyTasks = new Set();
const _paletteDispatchToasts = new Map();
function _showPaletteDispatchToast(taskId, cli, message) {
  if (!taskId) return;
  const existing = _paletteDispatchToasts.get(taskId);
  if (existing && existing.timer) clearTimeout(existing.timer);
  if (existing && existing.toast && existing.toast.close) existing.toast.close();
  const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli || 'AI';
  const orchBtn = document.getElementById('orchestratorTabBtn');
  const canShow = orchBtn && orchBtn.style.display !== 'none';
  const toastRef = toast(message || 'Sent to ' + cliLabel + ' - you will be notified when it answers', 'success', {
    rich: true,
    duration: 7000,
    action: canShow ? {
      label: 'View',
      onClick: () => switchTab('orchestrator')
    } : undefined
  });
  _paletteDispatchToasts.set(taskId, {
    cli,
    toast: toastRef
  });
}
function _schedulePaletteDispatchToast(taskId, cli) {
  if (!taskId) return;
  const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli || 'AI';
  const timer = setTimeout(() => {
    const current = _paletteDispatchToasts.get(taskId);
    if (!current || current.timer !== timer) return;
    _showPaletteDispatchToast(taskId, cli, 'Sent to ' + cliLabel + ' - you will be notified when it answers');
  }, 900);
  _paletteDispatchToasts.set(taskId, {
    cli,
    timer
  });
}
function _clearPaletteDispatchToast(taskId) {
  const existing = taskId && _paletteDispatchToasts.get(taskId);
  if (!existing) return;
  if (existing.timer) clearTimeout(existing.timer);
  if (existing.toast && existing.toast.close) existing.toast.close();
  _paletteDispatchToasts.delete(taskId);
}
function _loadNotifs() {
  try {
    state._notifs = JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]');
  } catch (_) {
    state._notifs = [];
  }
}
function _saveNotifs() {
  try {
    localStorage.setItem(NOTIF_KEY, JSON.stringify(state._notifs.slice(0, NOTIF_MAX)));
  } catch (_) {}
}
function notify(title, body, opts) {
  opts = opts || {};
  state._notifs.unshift({
    id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    title: String(title || '').slice(0, 160),
    body: String(body || ''),
    icon: opts.icon || 'sparkles',
    source: opts.source || null,
    taskId: opts.taskId || null,
    severity: opts.severity || 'info',
    createdAt: Date.now(),
    read: false
  });
  state._notifs = state._notifs.slice(0, NOTIF_MAX);
  _saveNotifs();
  renderNotifBadge();
  // If the panel is open, re-render to show the new one at top.
  const panel = document.getElementById('notifPanel');
  if (panel && panel.classList.contains('open')) renderNotifList();
  // Audible cue - silent when opts.silent is truthy so bulk seeders /
  // restore-from-storage paths don't spam the speaker.
  if (!opts.silent) playNotifSound(opts.severity || 'info');
}
function notifClearAll() {
  state._notifs = [];
  _saveNotifs();
  renderNotifBadge();
  renderNotifList();
}
function notifDelete(id) {
  if (!id) return;
  const before = state._notifs.length;
  state._notifs = state._notifs.filter(n => n.id !== id);
  if (state._notifs.length === before) return;
  _saveNotifs();
  renderNotifBadge();
  renderNotifList();
}
function renderNotifBadge() {
  const bell = document.getElementById('notifBell');
  const badge = document.getElementById('notifBadge');
  if (!bell || !badge) return;
  const unread = state._notifs.filter(n => !n.read).length;
  if (unread > 0) {
    bell.classList.add('has-unread');
    badge.textContent = unread > 99 ? '99+' : String(unread);
  } else {
    bell.classList.remove('has-unread');
  }
}
function _relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function renderNotifList() {
  _renderNotifSoundToggle();
  const el = document.getElementById('notifList');
  if (!el) return;
  if (!state._notifs.length) {
    el.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
    return;
  }
  el.innerHTML = state._notifs.map(n => {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const hasTask = !!n.taskId;
    const actions = hasTask ? '<div class="notif-item-actions">' + '<button class="notif-item-btn" data-act="open" data-task="' + esc(n.taskId) + '"><i data-lucide="external-link" style="width:11px;height:11px;"></i>Open</button>' + '<button class="notif-item-btn primary" data-act="reply" data-task="' + esc(n.taskId) + '"><i data-lucide="corner-down-left" style="width:11px;height:11px;"></i>Reply</button>' + '</div>' : '';
    return '<div class="notif-item ' + (n.read ? '' : 'unread') + '" data-id="' + n.id + '">' + '<div class="notif-item-head">' + '<span class="notif-item-icon"><i data-lucide="' + esc(n.icon || 'bell') + '"></i></span>' + '<span class="notif-item-title" title="' + esc(n.title) + '">' + esc(n.title) + '</span>' + '<span class="notif-item-time">' + _relTime(n.createdAt) + '</span>' + '<button class="notif-item-del" data-act="delete" title="Dismiss" aria-label="Dismiss notification">' + '<i data-lucide="x"></i>' + '</button>' + '</div>' + '<div class="notif-item-body">' + esc(n.body) + '</div>' + actions + '</div>';
  }).join('');
  el.querySelectorAll('.notif-item').forEach(row => {
    row.addEventListener('click', e => {
      const delBtn = e.target.closest('.notif-item-del');
      const btn = e.target.closest('.notif-item-btn');
      const id = row.dataset.id;
      if (delBtn) {
        e.stopPropagation();
        notifDelete(id);
        return;
      }
      const n = state._notifs.find(x => x.id === id);
      if (!n) return;
      n.read = true;
      row.classList.remove('unread');
      _saveNotifs();
      renderNotifBadge();
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        const tid = btn.dataset.task;
        if (act === 'open' && tid) _openOrchestratorTask(tid);else if (act === 'reply' && tid) _replyToTask(tid);
        document.getElementById('notifPanel')?.classList.remove('open');
        return;
      }
      // Default: clicking the row toggles expanded body; if there's a task,
      // also jump to the orchestrator so the user can see the full thread.
      if (n.taskId) {
        _openOrchestratorTask(n.taskId);
        document.getElementById('notifPanel')?.classList.remove('open');
      } else row.classList.toggle('expanded');
    });
  });
  try {
    lucide.createIcons({
      nodes: [el]
    });
  } catch (_) {}
}
// Click a task notification -> switch to the orchestrator tab and scroll the
// task card into view, flashing it so the user can spot it.
function _openOrchestratorTask(taskId) {
  try {
    const orchBtn = document.getElementById('orchestratorTabBtn');
    if (orchBtn && orchBtn.style.display !== 'none' && typeof switchTab === 'function') {
      switchTab('orchestrator');
    }
  } catch (_) {}
  // Give the tab a tick to render, then scroll + flash.
  setTimeout(() => {
    const card = document.querySelector('.orch-task[data-id="' + taskId + '"]');
    if (!card) return;
    card.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    card.style.transition = 'box-shadow 0.2s, border-color 0.2s';
    const prevShadow = card.style.boxShadow;
    card.style.boxShadow = '0 0 0 2px var(--accent)';
    setTimeout(() => {
      card.style.boxShadow = prevShadow;
    }, 1400);
  }, 80);
}
// Scroll a completed task card into view and focus its inline reply textarea.
function _focusInlineReply(taskId) {
  const card = document.querySelector('.orch-task[data-id="' + taskId + '"]');
  if (card && !card.classList.contains('expanded')) card.classList.add('expanded');
  const ta = document.getElementById('inlineReply_' + taskId);
  if (!ta) return;
  ta.scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });
  setTimeout(() => ta.focus(), 120);
}
// Send an inline reply from the task card (no palette hop). Uses /followup
// so the new task inherits the prior Q/A as context and appears threaded.
async function _inlineReplySend(taskId) {
  const ta = document.getElementById('inlineReply_' + taskId);
  const btn = document.getElementById('inlineReplySend_' + taskId);
  if (!ta) return;
  const text = (ta.value || '').trim();
  if (!text) {
    toast('Type a reply first', 'info', {
      duration: 1200
    });
    ta.focus();
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sending...';
  }
  try {
    const r = await fetch('/api/orchestrator/followup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parentTaskId: taskId,
        prompt: text,
        space: state.activeSpace || null
      })
    });
    if (!r.ok) throw new Error(await r.text().catch(() => 'HTTP ' + r.status));
    const body = await r.json().catch(() => ({}));
    const tid = body && (body.taskId || body.id);
    if (tid) _paletteNotifyTasks.add(tid);
    ta.value = '';
    toast('Reply sent', 'success', {
      duration: 1400
    });
    try {
      orchRefreshTasks();
    } catch (_) {}
  } catch (err) {
    toast('Reply failed: ' + (err.message || err), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Send reply';
    }
  }
}
// Open the command palette in reply mode so a follow-up is routed through
// /api/orchestrator/followup and the worker sees the prior Q/A as context
// (tasks themselves are one-shot).
state._pendingFollowupParentId = null;
state._pendingFollowupPriorPrompt = '';
async function _replyToTask(taskId) {
  state._pendingFollowupParentId = taskId;
  state._pendingFollowupPriorPrompt = '';
  try {
    const r = await fetch('/api/orchestrator/task?id=' + encodeURIComponent(taskId));
    if (r.ok) {
      const t = await r.json();
      state._pendingFollowupPriorPrompt = (t && (t.prompt || '')).replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim();
    }
  } catch (_) {}
  if (typeof openCmdPalette === 'function') openCmdPalette();
  setTimeout(() => {
    try {
      renderReplyChip();
    } catch (_) {}
    const input = document.getElementById('cmdPaletteInput');
    if (input) {
      input.placeholder = state._pendingFollowupPriorPrompt ? 'Reply to: "' + state._pendingFollowupPriorPrompt.slice(0, 80) + '"...' : 'Type your reply...';
      input.focus();
    }
  }, 80);
}
// Renders (or clears) the "replying to task" chip inside the cmd palette.
function renderReplyChip() {
  const palette = document.querySelector('.cmd-palette');
  if (!palette) return;
  let chip = document.getElementById('cmdPaletteReplyChip');
  if (!state._pendingFollowupParentId) {
    if (chip) chip.remove();
    const input = document.getElementById('cmdPaletteInput');
    if (input) input.placeholder = 'Ask AI, or type a command...';
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'cmdPaletteReplyChip';
    chip.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 14px;border-bottom:1px solid var(--surface1);background:color-mix(in srgb, var(--accent) 8%, transparent);font-size:11px;color:var(--accent);';
    const input = document.getElementById('cmdPaletteInput');
    if (input && input.nextSibling) palette.insertBefore(chip, input.nextSibling);else palette.appendChild(chip);
  }
  const prior = state._pendingFollowupPriorPrompt ? ' &mdash; "' + esc(state._pendingFollowupPriorPrompt.slice(0, 60)) + (state._pendingFollowupPriorPrompt.length > 60 ? '...' : '') + '"' : '';
  chip.innerHTML = '<i data-lucide="corner-down-right" style="width:11px;height:11px;"></i>' + '<span style="background:color-mix(in srgb, var(--accent) 22%, var(--surface0));border:1px solid var(--accent);color:var(--accent);font-weight:600;border-radius:11px;padding:1px 9px;font-size:11px;">Reply</span>' + '<span style="color:var(--subtext0);">to task ' + esc(String(state._pendingFollowupParentId).slice(0, 8)) + prior + '</span>' + '<span style="flex:1;"></span>' + '<button onclick="_cancelFollowup()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:2px;" title="Cancel reply"><i data-lucide="x" style="width:11px;height:11px;"></i></button>';
  try {
    lucide.createIcons({
      nodes: [chip]
    });
  } catch (_) {}
}
function _cancelFollowup() {
  state._pendingFollowupParentId = null;
  state._pendingFollowupPriorPrompt = '';
  renderReplyChip();
}
function toggleNotifPanel(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (isOpen) {
    renderNotifList();
    // Mark all as read on open (they stay visible; badge clears)
    state._notifs.forEach(n => {
      n.read = true;
    });
    _saveNotifs();
    renderNotifBadge();
  }
}
// Click outside closes the panel.
document.addEventListener('click', e => {
  const panel = document.getElementById('notifPanel');
  const bell = document.getElementById('notifBell');
  if (!panel || !panel.classList.contains('open')) return;
  if (bell && bell.contains(e.target)) return;
  if (panel.contains(e.target)) return;
  panel.classList.remove('open');
});
_loadNotifs();
// Render initial state after DOM ready (deferred; header may not exist yet).
document.addEventListener('DOMContentLoaded', renderNotifBadge);
document.addEventListener('keydown', e => {
  // Ctrl+J opens the command palette (same entry point as Ctrl+K).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'j') {
    e.preventDefault();
    if (typeof openCmdPalette === 'function') openCmdPalette();
    return;
  }
}, true);

// ── Public surface ──────────────────────────────────────────────────────────
// notify is the core entry point (app-state/apps-step-builder/browser-tools/
// command-palette/orchestrator/terminals all call it). The rest are reached from
// index.html, those parts, or this module's generated onclick (_cancelFollowup).
window.notify = notify;
window.openActivityStats = openActivityStats;
window._notifToggleSound = _notifToggleSound;
window.playNotifSound = playNotifSound;
window._showPaletteDispatchToast = _showPaletteDispatchToast;
window._schedulePaletteDispatchToast = _schedulePaletteDispatchToast;
window._clearPaletteDispatchToast = _clearPaletteDispatchToast;
window.notifClearAll = notifClearAll;
window._focusInlineReply = _focusInlineReply;
window._inlineReplySend = _inlineReplySend;
window.renderReplyChip = renderReplyChip;
window.toggleNotifPanel = toggleNotifPanel;
window._cancelFollowup = _cancelFollowup;
// Shared task-tracking Set, mutated by command-palette + orchestrator at runtime.
window._paletteNotifyTasks = _paletteNotifyTasks;