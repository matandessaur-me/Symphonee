// ── Orchestrator ────────────────────────────────────────────────────────
state.orchTasks = [];
state.orchAgents = [];
async function orchRefresh() {
  // Sync the scope filter default to the current space before fetching so the
  // first render already reflects "this space" when a space is active.
  try {
    syncOrchScopeFilter();
  } catch (_) {}
  await Promise.all([orchRefreshAgents(), orchRefreshTasks()]);
}

// Keep the orchestrator scope <select> default aligned with the active space.
// When a space is active, default to 'space'; otherwise 'all'. Preserves the
// user's choice within a session (only overrides if the current value is no
// longer sensible - e.g. they had 'space' selected and then cleared the space).
function syncOrchScopeFilter() {
  const el = document.getElementById('orchScopeFilter');
  if (!el) return;
  if (!state.activeSpace && el.value === 'space') el.value = 'all';else if (state.activeSpace && !el.dataset.userTouched) el.value = 'space';
}
async function orchRefreshAgents() {
  try {
    const agents = await fetch('/api/orchestrator/agents').then(r => r.json());
    state.orchAgents = agents;
    renderOrchAgents();
  } catch (_) {}
}
async function orchRefreshTasks() {
  try {
    const filter = document.getElementById('orchTaskFilter')?.value || '';
    const scopeEl = document.getElementById('orchScopeFilter');
    const scope = scopeEl ? scopeEl.value : '';
    const params = [];
    if (filter) params.push('state=' + encodeURIComponent(filter));
    // scope: '' or 'all' = unfiltered; 'space' = only tasks tagged with the
    // currently active space.
    if (scope === 'space' && state.activeSpace) params.push('space=' + encodeURIComponent(state.activeSpace));
    const url = '/api/orchestrator/tasks' + (params.length ? '?' + params.join('&') : '');
    const tasks = await fetch(url).then(r => r.json());
    state.orchTasks = tasks;
    renderOrchTasks();
  } catch (_) {}
}
function renderOrchAgents() {
  const el = document.getElementById('orchAgentList');
  if (!el) return;
  var items = [];
  // 1. Real terminals with an AI launched (the supervisor and any visible spawns)
  state.orchAgents.forEach(function (a) {
    var aiState = typeof termAiState !== 'undefined' ? termAiState.get(a.termId) : null;
    if (!aiState || !aiState.launched) return;
    var cli = aiState.cli || null;
    var label = CLI_CONFIG[cli]?.label || cli || 'AI';
    var busyTask = state.orchTasks.find(function (t) {
      return t.state === 'running' && (t.targetTermId === a.termId || t.from === a.termId);
    });
    items.push('<div class="orch-agent" onclick="orchSelectAgent(\'' + a.termId + '\')">' + '<div class="orch-agent-dot ' + (busyTask ? 'busy' : 'ai') + '"></div>' + '<div class="orch-agent-info">' + '<div class="orch-agent-name">' + label + '</div>' + '<div class="orch-agent-sub">' + a.termId + (busyTask ? ' - orchestrating' : '') + '</div>' + '</div></div>');
  });
  // 2. Headless spawns that are currently running (these have no terminal entry)
  state.orchTasks.forEach(function (t) {
    if (t.state !== 'running' || t.type !== 'headless' || !t.cli) return;
    var label = CLI_CONFIG[t.cli]?.label || t.cli;
    var modelSuffix = t.model ? ' <span style="font-size:10px;color:var(--overlay1);font-weight:400;">' + t.model + '</span>' : '';
    var title = (t.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim().split(/[.\n]/)[0].substring(0, 60);
    items.push('<div class="orch-agent">' + '<div class="orch-agent-dot busy"></div>' + '<div class="orch-agent-info">' + '<div class="orch-agent-name">' + label + modelSuffix + '</div>' + '<div class="orch-agent-sub">' + (title || t.id) + '</div>' + '</div></div>');
  });
  if (!items.length) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--overlay0);font-size:11px;">No AI agents running</div>';
    return;
  }
  el.innerHTML = items.join('');
}
state._orchTimerInterval = null;
function formatOrchDuration(ms) {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + s % 60 + 's';
}

// Live output buffer per task (captured from headless stdout via server broadcast)
const _orchTaskOutput = new Map(); // taskId -> string

function renderOrchTasks() {
  const el = document.getElementById('orchTaskList');
  const emptyEl = document.getElementById('orchEmptyState');
  const countEl = document.getElementById('orchTaskCount');
  if (!el) return;

  // Client-side filter: free-text matches across prompt / cli / model / state.
  const q = (document.getElementById('orchTaskSearch')?.value || '').trim().toLowerCase();
  const tasksAll = state.orchTasks;
  const visibleTasks = q ? tasksAll.filter(t => {
    const parts = [t.prompt, t.cli, t.model, t.state, t.type, t.from].filter(Boolean).join(' ').toLowerCase();
    return parts.includes(q);
  }) : tasksAll;
  if (countEl) {
    countEl.textContent = q ? visibleTasks.length + ' of ' + tasksAll.length : tasksAll.length + ' task' + (tasksAll.length === 1 ? '' : 's');
  }
  if (!visibleTasks.length) {
    el.innerHTML = '';
    if (q) {
      el.innerHTML = '<div style="padding:24px 12px;text-align:center;color:var(--subtext0);font-size:12px;">No tasks match "' + esc(q) + '"</div>';
      if (state._orchTimerInterval) {
        clearInterval(state._orchTimerInterval);
        state._orchTimerInterval = null;
      }
      return;
    }
    if (emptyEl) {
      emptyEl.style.display = '';
      el.appendChild(emptyEl);
    }
    if (state._orchTimerInterval) {
      clearInterval(state._orchTimerInterval);
      state._orchTimerInterval = null;
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // Preserve expanded state (running tasks default to expanded)
  const expandedIds = new Set();
  el.querySelectorAll('.orch-task.expanded').forEach(e => expandedIds.add(e.dataset.id));
  // Preserve accordion open/closed state per task: { taskId: { 'Prompt': true, 'Result': false, ... } }
  const accordionState = {};
  el.querySelectorAll('.orch-task').forEach(function (taskEl) {
    var id = taskEl.dataset.id;
    if (!id) return;
    var acc = {};
    taskEl.querySelectorAll('.orch-accordion').forEach(function (a) {
      var label = a.querySelector('.orch-accordion-head')?.textContent?.trim() || '';
      if (label) acc[label] = a.classList.contains('open');
    });
    if (Object.keys(acc).length) accordionState[id] = acc;
  });

  // Build parent/child index for threading. A task with parentTaskId whose parent
  // is in the visible set is nested; otherwise it's rendered at the top level.
  const visibleById = new Map();
  visibleTasks.forEach(t => visibleById.set(t.id, t));
  const childrenOf = new Map();
  const rootTasks = [];
  visibleTasks.forEach(t => {
    const pid = t.parentTaskId;
    if (pid && visibleById.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(t);
    } else {
      rootTasks.push(t);
    }
  });
  // Stable-sort children by creation time (ascending) so conversation reads top-down.
  childrenOf.forEach(list => list.sort((a, b) => (a.createdAt || a.startedAt || 0) - (b.createdAt || b.startedAt || 0)));
  function countThreadDescendants(id) {
    const kids = childrenOf.get(id) || [];
    return kids.reduce((acc, k) => acc + 1 + countThreadDescendants(k.id), 0);
  }
  function renderTaskCard(t, depth) {
    const isRunning = t.state === 'running';
    const isPending = t.state === 'pending';
    const elapsed = t.completedAt ? formatOrchDuration(t.completedAt - t.startedAt) : t.startedAt ? formatOrchDuration(Date.now() - t.startedAt) : '--';
    const cliLabel = t.cli ? CLI_CONFIG[t.cli]?.label || t.cli : t.type;
    const modelLabel = t.model ? '<span style="font-size:10px;color:var(--overlay1);font-weight:400;margin-left:4px;">' + String(t.model).replace(/</g, '&lt;') + '</span>' : '';
    const fromLabel = t.from ? 'from ' + t.from : '';
    const promptRaw = (t.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim();
    const promptFull = promptRaw.replace(/</g, '&lt;');
    // Extract a short title from the first sentence/line of the prompt
    const titleRaw = promptRaw.split(/[.\n]/)[0].substring(0, 80);
    const taskTitle = titleRaw.replace(/</g, '&lt;') || 'Task';
    const liveOutput = _orchTaskOutput.get(t.id) || '';
    // Helper: check saved accordion state, fallback to default
    const saved = accordionState[t.id] || {};
    const accOpen = function (label, defaultOpen) {
      return (saved[label] !== undefined ? saved[label] : defaultOpen) ? ' open' : '';
    };
    const accHead = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    const resultBlock = t.result ? '<div class="orch-task-result orch-task-md">' + renderMarkdown(t.result) + '</div>' : '';
    const errorBlock = t.error ? '<div class="orch-task-result" style="color:var(--red);">' + t.error.replace(/</g, '&lt;') + '</div>' : '';
    const outputBlock = isRunning && liveOutput ? '<div class="orch-accordion' + accOpen('Live Output', true) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Live Output</div><div class="orch-accordion-body"><div class="orch-task-output" data-output-id="' + t.id + '">' + liveOutput.substring(liveOutput.length - 2000).replace(/</g, '&lt;') + '</div></div></div>' : '';
    // Running/pending tasks expanded by default, others respect user toggle
    const expanded = isRunning || expandedIds.has(t.id) ? ' expanded' : '';

    // Action buttons for visible spawns
    const viewBtn = t.type === 'visible' && t.targetTermId ? '<button class="orch-task-btn view" onclick="event.stopPropagation();orchSelectAgent(\'' + t.targetTermId + '\')">View Terminal</button>' : '';

    // Current step: last non-empty line of the streaming output, trimmed.
    // Pulled live via the websocket feed the same way Live Output is.
    let currentStep = '';
    if (isRunning && liveOutput) {
      const lines = liveOutput.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length) currentStep = lines[lines.length - 1].slice(0, 120);
    }
    const stepLine = currentStep ? '<div class="orch-task-step" data-step-id="' + t.id + '" title="' + currentStep.replace(/"/g, '&quot;') + '">' + currentStep.replace(/</g, '&lt;') + '</div>' : isRunning ? '<div class="orch-task-step" data-step-id="' + t.id + '">Working...</div>' : '';
    const descendantCount = countThreadDescendants(t.id);
    const threadChip = descendantCount ? '<span class="orch-task-thread-count" title="Thread depth">+' + descendantCount + ' repl' + (descendantCount === 1 ? 'y' : 'ies') + '</span>' : '';
    const isReply = t.parentTaskId ? true : false;
    const replyChip = isReply ? '<span class="orch-task-thread-chip" title="Reply to ' + String(t.parentTaskId).slice(0, 8) + '">reply</span>' : '';
    const replyComposer = !isRunning && !isPending ? '<div class="orch-task-reply" onclick="event.stopPropagation()">' + '<div class="orch-task-reply-label">Reply inline</div>' + '<textarea id="inlineReply_' + t.id + '" placeholder="Continue the conversation..." onkeydown="if(event.key===\'Enter\'&&(event.metaKey||event.ctrlKey)){event.preventDefault();_inlineReplySend(\'' + t.id + '\');}"></textarea>' + '<div class="orch-task-reply-actions">' + '<span class="orch-task-reply-hint">Ctrl/Cmd+Enter to send - spawns a follow-up task with the prior Q/A as context</span>' + '<button class="orch-task-reply-send" id="inlineReplySend_' + t.id + '" onclick="_inlineReplySend(\'' + t.id + '\')">Send reply</button>' + '</div>' + '</div>' : '';
    const cardHtml = '<div class="orch-task ' + t.state + expanded + '" data-id="' + t.id + '" data-depth="' + depth + '" onclick="orchToggleTask(this)">' + '<div class="orch-task-header">' + '<div class="orch-task-left">' + '<div class="orch-task-left-top">' + '<span class="cli-name">' + cliLabel + '</span>' + modelLabel + (fromLabel ? '<span>' + fromLabel + '</span>' : '') + replyChip + threadChip + '</div>' + '<div style="font-size:12px;color:var(--text);font-weight:500;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px;">' + taskTitle + '</div>' + stepLine + '<div class="orch-task-left-bottom">' + t.type + ' / ' + t.id + '</div>' + (isRunning ? '<div class="orch-watcher-status" style="font-size:10px;color:var(--yellow);font-family:var(--font-mono);margin-top:2px;display:none;"></div>' : '') + '</div>' + '<div class="orch-task-right">' + '<span class="orch-task-state ' + t.state + '">' + t.state + '</span>' + '<span class="orch-task-timer' + (isRunning ? ' live' : '') + '" data-started="' + (t.startedAt || '') + '">' + elapsed + '</span>' + '</div>' + '</div>' + '<div class="orch-task-expand">' + '<div class="orch-accordion' + accOpen('Prompt', false) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Prompt</div><div class="orch-accordion-body"><div class="orch-task-prompt">' + promptFull + '</div></div></div>' + outputBlock + (resultBlock ? '<div class="orch-accordion' + accOpen('Result', true) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Result</div><div class="orch-accordion-body">' + resultBlock + '</div></div>' : '') + (errorBlock ? '<div class="orch-accordion' + accOpen('Error', true) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Error</div><div class="orch-accordion-body">' + errorBlock + '</div></div>' : '') + ('<div class="orch-task-actions-row">' + viewBtn + (isRunning ? '<button class="orch-task-btn cancel" onclick="event.stopPropagation();orchCancelTask(\'' + t.id + '\')">Cancel</button>' : '<button class="orch-task-btn" onclick="event.stopPropagation();_focusInlineReply(\'' + t.id + '\')" title="Jump to the reply box below">Reply</button>' + '<button class="orch-task-btn" onclick="event.stopPropagation();orchShareTask(\'' + t.id + '\')" title="Copy this task as markdown">Share</button>' + '<button class="orch-task-btn cancel" onclick="event.stopPropagation();orchDeleteTask(\'' + t.id + '\')">Delete</button>') + '</div>') + replyComposer + '</div>' + '</div>';
    const kids = childrenOf.get(t.id) || [];
    const kidsHtml = kids.map(k => renderTaskCard(k, depth + 1)).join('');
    return cardHtml + kidsHtml;
  }
  el.innerHTML = rootTasks.map(t => renderTaskCard(t, 0)).join('');

  // Pin each live-output pane to the bottom after a re-render. Without this,
  // the 5-second auto-refresh recreates the DOM and scroll resets to top.
  document.querySelectorAll('.orch-task-output').forEach(function (out) {
    out.scrollTop = out.scrollHeight;
  });

  // Start/stop live timer for running tasks
  const hasRunning = state.orchTasks.some(t => t.state === 'running');
  if (hasRunning && !state._orchTimerInterval) {
    state._orchTimerInterval = setInterval(updateOrchTimers, 1000);
  } else if (!hasRunning && state._orchTimerInterval) {
    clearInterval(state._orchTimerInterval);
    state._orchTimerInterval = null;
  }
}
state._orchRefreshCounter = 0;
function updateOrchTimers() {
  document.querySelectorAll('.orch-task-timer.live').forEach(el => {
    const started = parseInt(el.dataset.started);
    if (started) el.textContent = formatOrchDuration(Date.now() - started);
  });
  // Auto-refresh task data every 5 seconds as a safety net
  // (WebSocket events should handle most updates, but this catches missed ones)
  state._orchRefreshCounter++;
  if (state._orchRefreshCounter % 5 === 0) orchRefreshTasks();
}
function orchToggleTask(el) {
  el.classList.toggle('expanded');
}
function orchSelectAgent(termId) {
  switchTab('terminal');
  if (typeof switchTerminal === 'function') switchTerminal(termId);
}
async function orchCancelTask(taskId) {
  await fetch('/api/orchestrator/cancel', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      taskId
    })
  });
  orchRefreshTasks();
}
async function orchDeleteTask(taskId) {
  await fetch('/api/orchestrator/task', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      taskId
    })
  });
  _orchTaskOutput.delete(taskId);
  orchRefreshTasks();
}

// Copy a completed task as clean markdown: prompt + result + metadata. Gives
// the user a one-click share surface without standing up a real share server.
async function orchShareTask(taskId) {
  const t = state.orchTasks.find(x => x.id === taskId);
  if (!t) {
    toast('Task not found', 'error');
    return;
  }
  const cliLabel = t.cli ? CLI_CONFIG[t.cli]?.label || t.cli : t.type;
  const dur = t.completedAt && t.startedAt ? formatOrchDuration(t.completedAt - t.startedAt) : '';
  const prompt = String(t.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim();
  const parts = ['# Symphonee task: ' + (prompt.split(/[.\n]/)[0] || 'untitled').slice(0, 80), '', '- Runner: ' + cliLabel + (t.model ? ' (' + t.model + ')' : ''), '- Status: ' + (t.state || 'unknown'), dur ? '- Duration: ' + dur : '', '', '## Prompt', '', prompt || '(empty)', '', '## Result', '', String(t.result || t.error || '(no output)').trim()].filter(Boolean);
  const md = parts.join('\n');
  try {
    await navigator.clipboard.writeText(md);
    toast('Copied task as markdown', 'success', {
      action: {
        label: 'Save as note',
        onClick: () => _saveTaskAsNote(t, md)
      }
    });
  } catch (err) {
    toast('Clipboard blocked: ' + err.message, 'error');
  }
}
async function _saveTaskAsNote(t, md) {
  const slug = String((t.prompt || '').split(/[.\n]/)[0] || 'task').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'task';
  const name = 'task-' + slug + '-' + String(t.id).slice(-6);
  try {
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        content: md
      })
    });
    toast('Saved note: ' + name, 'success', {
      action: {
        label: 'Open',
        onClick: () => {
          switchTab('notes');
          setTimeout(() => openNote(name), 80);
        }
      }
    });
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}
async function orchCleanup() {
  const ok = await confirmDialog('Clear all completed, failed, and timed out tasks?', {
    confirmText: 'Clear All',
    danger: true
  });
  if (!ok) return;
  // Clean up everything (maxAgeMs=0 removes all non-running tasks)
  const res = await fetch('/api/orchestrator/cleanup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      maxAgeMs: 0
    })
  }).then(r => r.json());
  _orchTaskOutput.clear();
  if (res.cleaned > 0) toast(res.cleaned + ' task(s) cleaned up', 'success');else toast('Nothing to clean up', 'info');
  orchRefreshTasks();
}
const CLI_COLORS = {
  claude: '#d97757',
  gemini: '#078efa',
  copilot: '#8534f3',
  codex: '#10a37f',
  grok: '#ef4444',
  qwen: '#615ced'
};
async function orchShowDispatchDialog() {
  // Collect running agents and all available CLIs for spawn
  const agents = state.orchAgents.filter(a => {
    const st = typeof termAiState !== 'undefined' ? termAiState.get(a.termId) : null;
    return st?.launched;
  });

  // Fetch repos for the repo selector
  let repos = {};
  let activeRepo = '';
  try {
    const [repoData, ctxData] = await Promise.all([fetch('/api/repos').then(r => r.json()), fetch('/api/ui/context').then(r => r.json())]);
    repos = repoData || {};
    activeRepo = ctxData.activeRepo || '';
  } catch (_) {}
  const noRepoSelected = !activeRepo;
  const repoOptions = '<option value=""' + (noRepoSelected ? ' selected' : '') + '>No Repo</option>' + Object.entries(repos).map(([name, repoPath]) => '<option value="' + name + '"' + (name === activeRepo ? ' selected' : '') + '>' + name + '</option>').join('');

  // Build agent option cards (running agents + spawn options)
  let agentCards = '';
  agents.forEach(a => {
    const st = termAiState.get(a.termId);
    const cli = st?.cli || 'unknown';
    const label = CLI_CONFIG[cli]?.label || cli;
    const color = CLI_COLORS[cli] || 'var(--overlay1)';
    agentCards += '<button class="orch-dispatch-agent" data-value="' + a.termId + '" data-mode="dispatch" onclick="orchSelectDispatchTarget(this)">' + '<span class="orch-dispatch-dot" style="background:' + color + '"></span>' + '<span class="orch-dispatch-label">' + label + '</span>' + '<span class="orch-dispatch-sub">' + a.termId + ' - inject into running session</span>' + '</button>';
  });
  // Spawn options (visible terminal)
  Object.entries(CLI_CONFIG).forEach(([k, v]) => {
    const color = CLI_COLORS[k] || 'var(--overlay1)';
    agentCards += '<button class="orch-dispatch-agent" data-value="spawn:' + k + '" data-mode="spawn" onclick="orchSelectDispatchTarget(this)">' + '<span class="orch-dispatch-dot" style="background:' + color + '"></span>' + '<span class="orch-dispatch-label">' + v.label + '</span>' + '<span class="orch-dispatch-sub">spawn new terminal</span>' + '</button>';
  });
  const overlay = document.createElement('div');
  overlay.id = 'orchDispatchOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
  overlay.innerHTML = '<div style="background:var(--base);border:1px solid var(--surface1);border-radius:var(--radius-lg);padding:0;width:520px;max-width:90vw;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.6);">' + '<div style="padding:16px 20px;border-bottom:1px solid var(--surface0);display:flex;align-items:center;gap:8px;">' + '<i data-lucide="send" style="width:16px;height:16px;color:var(--accent);"></i>' + '<span style="font-size:14px;font-weight:600;color:var(--text);">Dispatch Task</span>' + '</div>' + '<div style="padding:16px 20px;">' + '<div style="display:flex;gap:12px;margin-bottom:16px;">' + '<div style="flex:1;">' + '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--overlay1);margin-bottom:6px;">Repository</div>' + '<select id="orchDispatchRepo" style="width:100%;padding:8px 10px;background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:var(--radius);font:12px var(--font-ui);outline:none;transition:border-color 0.15s;" onfocus="this.style.borderColor=\'var(--accent)\'" onblur="this.style.borderColor=\'var(--surface1)\'">' + repoOptions + '</select>' + '</div>' + '</div>' + '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--overlay1);margin-bottom:8px;">Target</div>' + '<div id="orchDispatchAgentList" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;">' + agentCards + '</div>' + '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--overlay1);margin:16px 0 8px;">Prompt</div>' + '<textarea id="orchDispatchPrompt" rows="5" style="width:100%;padding:10px 12px;background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:var(--radius);font:12px/1.5 var(--font-mono);resize:vertical;outline:none;box-sizing:border-box;transition:border-color 0.15s;" onfocus="this.style.borderColor=\'var(--accent)\'" onblur="this.style.borderColor=\'var(--surface1)\'" placeholder="Describe the task for the target AI..."></textarea>' + '</div>' + '<div style="padding:12px 20px;border-top:1px solid var(--surface0);display:flex;gap:8px;justify-content:flex-end;background:var(--mantle);">' + '<button onclick="document.getElementById(\'orchDispatchOverlay\').remove()" style="padding:8px 16px;background:var(--surface1);color:var(--text);border:none;border-radius:var(--radius);font:12px var(--font-ui);cursor:pointer;transition:background 0.1s;" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'var(--surface1)\'">Cancel</button>' + '<button onclick="orchDoDispatch()" style="padding:8px 16px;background:var(--accent);color:var(--crust);border:none;border-radius:var(--radius);font:12px var(--font-ui);font-weight:600;cursor:pointer;transition:opacity 0.1s;" onmouseenter="this.style.opacity=0.9" onmouseleave="this.style.opacity=1">Dispatch</button>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });
  try {
    lucide.createIcons({
      attrs: {
        class: ''
      },
      nameAttr: 'data-lucide'
    });
  } catch (_) {}
  // Auto-select first agent
  const first = overlay.querySelector('.orch-dispatch-agent');
  if (first) first.classList.add('selected');
  setTimeout(() => document.getElementById('orchDispatchPrompt')?.focus(), 50);
}
function orchSelectDispatchTarget(el) {
  el.closest('#orchDispatchAgentList').querySelectorAll('.orch-dispatch-agent').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
}
async function orchDoDispatch() {
  const selected = document.querySelector('#orchDispatchAgentList .orch-dispatch-agent.selected');
  const target = selected?.dataset.value;
  const mode = selected?.dataset.mode;
  const rawPrompt = document.getElementById('orchDispatchPrompt')?.value?.trim();
  const repoSelect = document.getElementById('orchDispatchRepo');
  const repoName = repoSelect?.value || '';
  document.getElementById('orchDispatchOverlay')?.remove();
  if (!target || !rawPrompt) return;

  // Prepend repo context so the AI knows which repo to work on
  let prompt = rawPrompt;
  if (repoName) {
    try {
      const repos = await fetch('/api/repos').then(r => r.json());
      const repoPath = repos[repoName];
      if (repoPath) {
        prompt = `[REPO CONTEXT] Work on the "${repoName}" repository located at: ${repoPath.replace(/\\/g, '/')}\nAll file reads, searches, and edits should target that directory. Do NOT cd there - stay in your current directory but use the full path for file operations.\n\n${rawPrompt}`;
      }
    } catch (_) {}
  }
  try {
    if (mode === 'spawn') {
      const cli = target.replace('spawn:', '');
      await fetch('/api/orchestrator/spawn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cli,
          prompt,
          space: state.activeSpace || null
        })
      });
      toast('Task dispatched to ' + cli, 'success');
    } else {
      await fetch('/api/orchestrator/dispatch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          targetTermId: target,
          prompt
        })
      });
      toast('Task dispatched to ' + target, 'success');
    }
    orchRefreshTasks();
  } catch (err) {
    toast('Dispatch failed: ' + err.message, 'error');
  }
}

// Listen for orchestrator WebSocket events
function handleOrchestratorEvent(msg) {
  if (msg.event === 'provider-failover') {
    const fromLabel = CLI_CONFIG[msg.from] && CLI_CONFIG[msg.from].label || msg.from;
    const toLabel = msg.to ? CLI_CONFIG[msg.to] && CLI_CONFIG[msg.to].label || msg.to : 'next available AI';
    const chain = Array.isArray(msg.chain) ? msg.chain.map(c => CLI_CONFIG[c] && CLI_CONFIG[c].label || c).join(' -> ') : '';
    const reason = msg.reason || 'provider error';
    const body = `${fromLabel} was skipped: ${reason}. Falling back to ${toLabel}.${chain ? ' Remaining chain: ' + chain + '.' : ''}`;
    if (msg.taskId) {
      _orchTaskOutput.delete(msg.taskId);
      const outputEl = document.querySelector(`.orch-task-output[data-output-id="${msg.taskId}"]`);
      if (outputEl) outputEl.textContent = '';
      const stepEl = document.querySelector(`.orch-task-step[data-step-id="${msg.taskId}"]`);
      if (stepEl) {
        stepEl.textContent = 'Working...';
        stepEl.removeAttribute('title');
      }
    }
    if (typeof notify === 'function') {
      notify('AI provider skipped', body, {
        icon: 'alert-triangle',
        source: 'orchestrator',
        taskId: msg.taskId || null,
        severity: 'warning'
      });
    }
    if (msg.taskId) {
      _clearPaletteDispatchToast(msg.taskId);
      _showPaletteDispatchToast(msg.taskId, msg.to, `${fromLabel} skipped: ${reason}. Sent to ${toLabel}.`);
    } else {
      toast(`${fromLabel}: ${reason} - falling back to ${toLabel}`, 'warning', {
        rich: true,
        duration: 6500
      });
    }
    return;
  }
  if (msg.event === 'provider-exhausted') {
    const lastLabel = CLI_CONFIG[msg.lastCli] && CLI_CONFIG[msg.lastCli].label || msg.lastCli;
    if (typeof notify === 'function') {
      notify('All AI providers failed', `The waterfall stopped after ${lastLabel}: ${msg.reason || 'failed'}. Add credits, log in, or configure another provider in Settings.`, {
        icon: 'alert-circle',
        source: 'orchestrator',
        taskId: msg.taskId || null,
        severity: 'error'
      });
    }
    if (msg.taskId) _clearPaletteDispatchToast(msg.taskId);
    toast(`All AI providers exhausted (last: ${lastLabel} - ${msg.reason || 'failed'}). Add credits or another API key in Settings.`, 'error', {
      rich: true,
      duration: 8000
    });
    return;
  }
  if (msg.event === 'task-update') {
    orchRefreshTasks();
    orchRefreshAgents();

    // Update orchestrated terminal indicators on task completion
    const task = msg.task;
    if (task && task.targetTermId && task.type === 'visible') {
      const st = termAiState.get(task.targetTermId);
      if (st && st.orchestrated && task.state !== 'running' && task.state !== 'pending') {
        const dot = document.querySelector(`.term-tab[data-term="${task.targetTermId}"] .orch-dot`);
        if (dot) {
          dot.classList.add('done');
          setTimeout(() => dot.remove(), 3000);
        }
        st.orchestrated = false;
      }
    }

    // Generic completion toast + success chime for ANY orchestrator task
    // (so the user gets feedback even when a worker finishes off-screen).
    // Skipped if the task surfaces through the richer palette/quick-ask
    // notification path below (which already plays the success sound via
    // notify()) so we don't double-notify.
    if (task && task.state === 'completed' && !_paletteNotifyTasks.has(task.id) && task.from !== 'palette' && task.from !== 'quick-ask') {
      if (typeof toast === 'function') {
        const cli = task.cli || 'AI';
        const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli;
        const promptSnippet = String(task.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim().split(/[.\n]/)[0].slice(0, 80);
        toast(`${cliLabel} task done${promptSnippet ? ': ' + promptSnippet : ''}`, 'success', {
          duration: 5000
        });
      }
    }

    // Palette / quick-ask tasks: push the final answer to the notification
    // center when they complete. Matches by taskId captured at spawn time,
    // or falls back to the task's `from` tag for cases where the spawn
    // response wasn't tracked (e.g. reloads mid-flight).
    if (task && task.state === 'completed') {
      const tracked = _paletteNotifyTasks.has(task.id);
      const fromTag = task.from === 'palette' || task.from === 'quick-ask';
      if (tracked || fromTag) {
        _paletteNotifyTasks.delete(task.id);
        _clearPaletteDispatchToast(task.id);
        const cli = task.cli || 'AI';
        const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli;
        const promptSnippet = (task.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim().split(/[.\n]/)[0].slice(0, 90);
        const answer = (task.result || task.error || '(no output captured)').toString();
        notify(cliLabel + ' answered: ' + (promptSnippet || 'your question'), answer, {
          icon: 'sparkles',
          source: task.from,
          taskId: task.id
        });
      } else if (task.state === 'failed' && _paletteNotifyTasks.has(task.id)) {
        _paletteNotifyTasks.delete(task.id);
        _clearPaletteDispatchToast(task.id);
        notify('AI task failed', (task.error || 'Unknown error').toString(), {
          icon: 'alert-circle'
        });
      }
    }
  }
  // Live output streaming for headless tasks
  if (msg.event === 'task-output' && msg.taskId) {
    const prev = _orchTaskOutput.get(msg.taskId) || '';
    _orchTaskOutput.set(msg.taskId, prev + (msg.chunk || ''));
    // Keep the in-card "current step" line in sync without a full re-render.
    const stepEl = document.querySelector(`.orch-task-step[data-step-id="${msg.taskId}"]`);
    if (stepEl) {
      const full = _orchTaskOutput.get(msg.taskId);
      const lines = full.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length) {
        const last = lines[lines.length - 1].slice(0, 120);
        stepEl.textContent = last;
        stepEl.title = last;
      }
    }
    const outputEl = document.querySelector(`.orch-task-output[data-output-id="${msg.taskId}"]`);
    if (outputEl) {
      const full = _orchTaskOutput.get(msg.taskId);
      outputEl.textContent = full.substring(full.length - 2000);
      outputEl.scrollTop = outputEl.scrollHeight;
    } else {
      renderOrchTasks();
    }
  }
  // Watcher events: show what the orchestrator agent is doing
  if (msg.event === 'watcher' && msg.taskId) {
    const statusEl = document.querySelector(`.orch-task[data-id="${msg.taskId}"] .orch-watcher-status`);
    if (statusEl) {
      statusEl.textContent = msg.action;
      statusEl.style.display = '';
      clearTimeout(statusEl._fadeTimer);
      statusEl._fadeTimer = setTimeout(() => {
        statusEl.style.display = 'none';
      }, 5000);
    }
  }
  // Orchestration mode change
  if (msg.event === 'mode-change') {
    setOrchestrationMode(msg.orchestrating);
  }
}
function setOrchestrationMode(active) {
  const mainTab = document.getElementById('mainTermTab');
  const orchBtn = document.getElementById('orchestratorTabBtn');
  if (active) {
    // Add orchestrator badge to main terminal tab
    if (mainTab && !mainTab.querySelector('.orch-mode-badge')) {
      const badge = document.createElement('span');
      badge.className = 'orch-mode-badge';
      badge.textContent = 'Orchestrating';
      mainTab.appendChild(badge);
    }
    // Add pulsating dot to orchestrator tab
    if (orchBtn && !orchBtn.querySelector('.orch-pulse-dot')) {
      const dot = document.createElement('span');
      dot.className = 'orch-pulse-dot';
      orchBtn.appendChild(dot);
    }
  } else {
    // Remove orchestrator badge
    if (mainTab) {
      const badge = mainTab.querySelector('.orch-mode-badge');
      if (badge) badge.remove();
    }
    // Remove pulsating dot
    if (orchBtn) {
      const dot = orchBtn.querySelector('.orch-pulse-dot');
      if (dot) dot.remove();
    }
  }
}