// ── Git Modal ────────────────────────────────────────────────────────────
state._gitBranches = {
  local: [],
  remoteOnly: [],
  current: ''
};
function openGitModal(tab) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) {
    toast('Select a repo first', 'info');
    return;
  }
  document.getElementById('gitModalRepo').textContent = repo;
  document.getElementById('gitModal').classList.add('open');
  document.getElementById('gitBranchSearch').value = '';
  document.getElementById('gitPullResult').style.display = 'none';
  document.getElementById('gitPushResult').style.display = 'none';
  document.getElementById('gitPullBtn').disabled = false;
  document.getElementById('gitPullBtn').textContent = 'Pull';
  document.getElementById('gitPushBtn').disabled = false;
  document.getElementById('gitPushBtn').textContent = 'Push';
  // Reset commit fields
  document.getElementById('gitCommitTitle').value = '';
  document.getElementById('gitCommitBody').value = '';
  document.getElementById('gitCommitBtn').disabled = false;
  document.getElementById('gitCommitBtn').textContent = 'Commit';
  setCommitMode('custom');
  // Reset to requested tab
  const tabId = tab || 'branches';
  const btns = document.querySelectorAll('.git-nav-btn');
  const tabs = document.querySelectorAll('.git-tab');
  btns.forEach(b => b.classList.remove('active'));
  tabs.forEach(t => t.classList.remove('active'));
  document.getElementById('gitTab-' + tabId).classList.add('active');
  // Match nav button by tab keyword
  const tabKeywords = {
    branches: 'branch',
    pull: 'pull',
    push: 'push',
    commit: 'commit',
    compare: 'compare'
  };
  const kw = tabKeywords[tabId] || tabId;
  btns.forEach(b => {
    if (b.textContent.trim().toLowerCase().startsWith(kw)) b.classList.add('active');
  });
  loadGitBranches();
  // Load commit file list when opening commit tab
  if (tabId === 'commit') loadCommitFileList();
  lucide.createIcons();
}
function closeGitModal() {
  document.getElementById('gitModal').classList.remove('open');
}
function switchGitTab(tabId, btn) {
  document.querySelectorAll('.git-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.git-nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('gitTab-' + tabId).classList.add('active');
  if (btn) btn.classList.add('active');
  if (tabId === 'commit') loadCommitFileList();
}
async function loadGitBranches() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const list = document.getElementById('gitBranchList');
  list.innerHTML = '<div class="git-section-desc">Fetching branches...</div>';
  const taskId = addBackgroundTask('git-fetch-' + Date.now(), 'Fetching branches', 'git-branch');
  try {
    // Fetch from remote first to get latest branches
    const fetchRes = await fetch('/api/git/fetch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo
      })
    });
    const data = await fetchRes.json();
    if (data.error) throw new Error(data.error);
    state._gitBranches = data;
    document.getElementById('gitCurrentBranch').textContent = data.current;
    document.getElementById('gitPullBranch').textContent = data.current;
    document.getElementById('gitPushBranch').textContent = data.current;
    document.getElementById('gitCommitBranch').textContent = data.current;
    populateCompareDropdowns(data);
    renderGitBranches();
    completeBackgroundTask(taskId, true);
  } catch (e) {
    list.innerHTML = `<div class="git-section-desc" style="color:var(--red);">${e.message}</div>`;
    completeBackgroundTask(taskId, false);
  }
}
function renderGitBranches(filter) {
  const list = document.getElementById('gitBranchList');
  const f = (filter || '').toLowerCase();
  let html = '';

  // Local branches first
  const locals = state._gitBranches.local.filter(b => !f || b.toLowerCase().includes(f));
  for (const b of locals) {
    const isCurrent = b === state._gitBranches.current;
    html += `<div class="git-branch-item ${isCurrent ? 'current' : ''}" ${isCurrent ? '' : `onclick="doGitCheckout('${b.replace(/'/g, "\\'")}')"`}>
      <i data-lucide="${isCurrent ? 'check' : 'git-branch'}" style="width:13px;height:13px;flex-shrink:0;${isCurrent ? 'color:var(--green);' : 'color:var(--subtext0);'}"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${b}</span>
      ${isCurrent ? '<span class="branch-badge current-badge">current</span>' : '<span class="branch-badge local">local</span>'}
    </div>`;
  }

  // Remote-only branches
  const remotes = (state._gitBranches.remoteOnly || []).filter(b => !f || b.toLowerCase().includes(f));
  if (remotes.length > 0) {
    for (const b of remotes) {
      html += `<div class="git-branch-item" onclick="doGitCheckout('${b.replace(/'/g, "\\'")}')">
        <i data-lucide="cloud" style="width:13px;height:13px;flex-shrink:0;color:var(--subtext0);"></i>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${b}</span>
        <span class="branch-badge remote">remote</span>
      </div>`;
    }
  }
  if (!html) {
    html = '<div class="git-section-desc">No branches match your filter.</div>';
  }
  list.innerHTML = html;
  lucide.createIcons();
}
function filterGitBranches() {
  const val = document.getElementById('gitBranchSearch').value;
  renderGitBranches(val);
}
async function doGitCheckout(branch) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo || !branch) return;
  if (branch === state._gitBranches.current) return;

  // Show a switching status in the branch list
  const list = document.getElementById('gitBranchList');
  const prevHtml = list.innerHTML;
  list.innerHTML = '<div class="git-section-desc">Switching branch, fetching & pulling...</div>';
  try {
    const res = await fetch('/api/git/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo,
        branch
      })
    });
    const data = await res.json();
    if (data.error) {
      list.innerHTML = prevHtml;
      toast(data.error, 'error');
      return;
    }
    let msg = `Switched to ${data.branch}`;
    if (data.pullMessage && data.pullMessage !== 'Already up to date.') {
      msg += ' (pulled latest)';
    }
    toast(msg, 'success');
    state._gitBranches.current = data.branch;
    document.getElementById('gitCurrentBranch').textContent = data.branch;
    document.getElementById('gitPullBranch').textContent = data.branch;
    document.getElementById('gitPushBranch').textContent = data.branch;
    // Update sidebar branch display
    const sidebarBranch = document.getElementById('repoSidebarBranch');
    if (sidebarBranch) sidebarBranch.textContent = data.branch;
    renderGitBranches(document.getElementById('gitBranchSearch').value);
    // Refresh file tree if visible
    if (typeof loadFileTree === 'function') loadFileTree(repo);
  } catch (e) {
    list.innerHTML = prevHtml;
    toast('Checkout failed: ' + e.message, 'error');
  }
}
async function doGitPull() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const btn = document.getElementById('gitPullBtn');
  const result = document.getElementById('gitPullResult');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'Pulling...';
  const taskId = addBackgroundTask('git-pull-' + Date.now(), 'Pulling ' + repo, 'download');
  result.style.display = 'none';
  try {
    const res = await fetch('/api/git/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    result.textContent = data.message || 'Already up to date.';
    result.className = 'git-action-result success';
    result.style.display = 'block';
    btn.textContent = 'Done';
    toast('Pull complete', 'success');
    document.getElementById('gitPullBranch').textContent = data.branch;
    completeBackgroundTask(taskId, true);
  } catch (e) {
    result.textContent = e.message;
    result.className = 'git-action-result error';
    result.style.display = 'block';
    btn.textContent = 'Retry';
    btn.disabled = false;
    toast('Pull failed', 'error');
    completeBackgroundTask(taskId, false);
  } finally {
    btn.classList.remove('busy');
  }
}
async function doGitPush() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const btn = document.getElementById('gitPushBtn');
  const result = document.getElementById('gitPushResult');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'Pushing...';
  result.style.display = 'none';
  const taskId = addBackgroundTask('git-push-' + Date.now(), 'Pushing ' + repo, 'upload');
  try {
    const res = await fetch('/api/git/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo
      })
    });
    const data = await res.json();
    if (data.error) {
      if (data.needsPull) {
        // Behind remote - prompt user to pull first
        result.innerHTML = `${esc(data.error)}<br><button class="btn btn-sm" style="margin-top:8px;" onclick="switchGitTab('pull');doGitPull();">Pull Now</button>`;
        result.className = 'git-action-result error';
        result.style.display = 'block';
        btn.textContent = 'Push';
        btn.disabled = false;
        btn.classList.remove('busy');
        toast('Pull required before pushing', 'warning');
        return;
      }
      throw new Error(data.error);
    }
    result.textContent = data.message || 'Pushed successfully.';
    result.className = 'git-action-result success';
    result.style.display = 'block';
    btn.textContent = 'Done';
    toast('Push complete', 'success');
    document.getElementById('gitPushBranch').textContent = data.branch;
    completeBackgroundTask(taskId, true);
  } catch (e) {
    result.textContent = e.message;
    result.className = 'git-action-result error';
    result.style.display = 'block';
    btn.textContent = 'Retry';
    btn.disabled = false;
    toast('Push failed', 'error');
    completeBackgroundTask(taskId, false);
  } finally {
    btn.classList.remove('busy');
  }
}

// ── Compare & Commit (modal → AI) ───────────────────────────────────────
function populateCompareDropdowns(data) {
  const allBranches = [...data.local, ...(data.remoteOnly || [])];
  const sourceEl = document.getElementById('gitCompareSource');
  const targetEl = document.getElementById('gitCompareTarget');
  let opts = allBranches.map(b => `<option value="${b}"${b === data.current ? ' selected' : ''}>${b}</option>`).join('');
  sourceEl.innerHTML = opts;
  // Target defaults to main/master
  const defaultTarget = allBranches.includes('main') ? 'main' : allBranches.includes('master') ? 'master' : allBranches[0] || '';
  let targetOpts = allBranches.map(b => `<option value="${b}"${b === defaultTarget ? ' selected' : ''}>${b}</option>`).join('');
  targetEl.innerHTML = targetOpts;
}
function doGitCompare() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const repoPath = state.configData.Repos[repo];
  const source = document.getElementById('gitCompareSource').value;
  const target = document.getElementById('gitCompareTarget').value;
  if (!source || !target) {
    toast('Select both branches', 'info');
    return;
  }
  if (source === target) {
    toast('Select two different branches', 'info');
    return;
  }
  closeGitModal();
  askAi(`In the repo at "${repoPath}", compare branch "${source}" with "${target}". Show a summary of all differences — files changed, additions, removals, and key insights about what changed. Run: cd "${repoPath}" && git diff ${target}...${source} --stat`);
}
function setCommitMode(mode) {
  const customBtn = document.getElementById('gitCommitModeCustom');
  const aiBtn = document.getElementById('gitCommitModeAi');
  const customFields = document.getElementById('gitCommitCustomFields');
  const aiNote = document.getElementById('gitCommitAiNote');
  if (mode === 'custom') {
    customBtn.classList.add('active');
    aiBtn.classList.remove('active');
    customFields.style.display = 'block';
    aiNote.style.display = 'none';
  } else {
    customBtn.classList.remove('active');
    aiBtn.classList.add('active');
    customFields.style.display = 'none';
    aiNote.style.display = 'block';
  }
  document.getElementById('gitCommitBtn').dataset.mode = mode;
}
async function loadCommitFileList() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const container = document.getElementById('gitCommitFileList');
  container.innerHTML = '<div class="git-section-desc">Checking for changes...</div>';
  try {
    const res = await fetch(`/api/git/status?repo=${encodeURIComponent(repo)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('gitCommitBranch').textContent = data.branch;
    if (data.clean) {
      container.innerHTML = '<div class="git-section-desc">No changes to commit.</div>';
      document.getElementById('gitCommitBtn').disabled = true;
      return;
    }
    document.getElementById('gitCommitBtn').disabled = false;
    let html = '<div class="git-commit-file-list">';
    for (const f of data.files) {
      html += `<div class="git-commit-file">
        <span class="file-status ${f.statusClass}">${f.status}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${f.file}</span>
      </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="git-section-desc" style="color:var(--red);">${e.message}</div>`;
  }
}
function doGitCommit() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const repoPath = state.configData.Repos[repo];
  const user = state.configData.DefaultUser || 'the user';
  const mode = document.getElementById('gitCommitBtn').dataset.mode || 'custom';
  if (mode === 'ai') {
    closeGitModal();
    askAi(`In the repo at "${repoPath}", check git status, show me what changed, suggest a commit message, and create the commit. The commit must be signed by "${user}". Run: cd "${repoPath}" && git status`);
    return;
  }

  // Custom commit message
  const title = document.getElementById('gitCommitTitle').value.trim();
  if (!title) {
    toast('Commit title is required', 'info');
    return;
  }
  const body = document.getElementById('gitCommitBody').value.trim();
  const fullMsg = body ? `${title}\n\n${body}` : title;
  closeGitModal();
  // Escape for shell — use the AI to run the commit so it shows in terminal
  const escaped = fullMsg.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  askAi(`In the repo at "${repoPath}", stage all changes and commit with this exact message (do NOT modify it):\n\n${fullMsg}\n\nRun: cd "${repoPath}" && git add -A && git commit -m "${escaped}"`);
}

// ── Project Scripts ──────────────────────────────────────────────────────
async function loadProjectScripts() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const bar = document.getElementById('filesScriptsBar');
  const btns = document.getElementById('filesScriptBtns');
  try {
    const res = await fetch(`/api/project/scripts?repo=${encodeURIComponent(repo)}`);
    const data = await res.json();
    if (data.error || !data.scripts) {
      bar.style.display = 'none';
      return;
    }
    const scripts = data.scripts;
    let html = '';

    // Install button if no node_modules
    if (!data.hasNodeModules) {
      html += `<button class="script-btn install" onclick="runNpmScript('install', '${esc(repo)}')">npm install</button>`;
    }

    // Priority scripts first
    const priority = ['dev', 'start', 'build', 'test', 'lint'];
    const shown = new Set();
    for (const key of priority) {
      if (scripts[key]) {
        const isPrimary = key === 'dev' || key === 'start';
        html += `<button class="script-btn ${isPrimary ? 'primary' : ''}" onclick="runNpmScript('${esc(key)}', '${esc(repo)}')">${key}</button>`;
        shown.add(key);
      }
    }

    // Remaining scripts
    const remaining = Object.keys(scripts).filter(k => !shown.has(k));
    if (remaining.length > 0) {
      html += `<select class="script-btn" onchange="if(this.value){runNpmScript(this.value,'${esc(repo)}');this.value=''}" style="padding:3px 6px;">`;
      html += `<option value="">more...</option>`;
      for (const key of remaining) {
        html += `<option value="${esc(key)}">${esc(key)}</option>`;
      }
      html += `</select>`;
    }
    btns.innerHTML = html;
    bar.style.display = html ? '' : 'none';
  } catch (_) {
    bar.style.display = 'none';
  }
}
function runNpmScript(script, repoName) {
  const repoPath = state.configData.Repos[repoName];
  if (!repoPath) return;
  switchTab('terminal');

  // Create a new terminal for the script so it doesn't interrupt the AI
  const termId = addTerminal(`${script}`, repoPath);

  // Wait for PTY to be ready, then run the command
  setTimeout(() => {
    if (script === 'install') {
      sendCommand(`cd "${repoPath}"; npm install`, termId);
    } else {
      sendCommand(`cd "${repoPath}"; npm run ${script}`, termId);
    }
  }, 500);
}

// ── Terminal Panel npm Script Shortcuts ──────────────────────────────────
async function loadTerminalScripts() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  const bar = document.getElementById('termScriptsBar');
  const btns = document.getElementById('termScriptBtns');
  if (!bar || !btns) return;
  if (!repo) {
    bar.style.display = 'none';
    return;
  }
  try {
    const res = await fetch(`/api/project/scripts?repo=${encodeURIComponent(repo)}`);
    const data = await res.json();
    if (data.error || !data.scripts) {
      bar.style.display = 'none';
      return;
    }
    const scripts = data.scripts;
    let html = '';
    const priority = ['dev', 'start', 'build', 'test', 'lint', 'preview'];
    for (const key of priority) {
      if (scripts[key]) {
        const isPrimary = key === 'dev' || key === 'start';
        html += `<button class="script-btn ${isPrimary ? 'primary' : ''}" onclick="runNpmScript('${esc(key)}', '${esc(repo)}')">${key}</button>`;
      }
    }
    btns.innerHTML = html;
    bar.style.display = html ? '' : 'none';
  } catch (_) {
    bar.style.display = 'none';
  }
}

// ── Syntax Highlighting Language Map ─────────────────────────────────────
function hlExtMap(ext) {
  const map = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    less: 'less',
    sass: 'scss',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    r: 'r',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    php: 'php',
    lua: 'lua',
    perl: 'perl',
    pl: 'perl',
    tf: 'hcl',
    hcl: 'hcl',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    csproj: 'xml',
    sln: 'plaintext',
    gitignore: 'plaintext'
  };
  return map[ext] || '';
}

// ── Simple Markdown Parser ──────────────────────────────────────────────
function renderMarkdown(md) {
  if (!md) return '';

  // Step 1: Extract code blocks to protect them
  const codeBlocks = [];
  let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${esc(code.trim())}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // Step 2: Process tables (before other line-level transforms)
  text = text.replace(/^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)*)/gm, (_, headerRow, sepRow, bodyRows) => {
    const headers = headerRow.split('|').filter(c => c.trim());
    // Parse alignment from separator
    const aligns = sepRow.split('|').filter(c => c.trim()).map(c => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    let html = '<table><thead><tr>';
    headers.forEach((h, i) => {
      html += `<th style="text-align:${aligns[i] || 'left'}">${h.trim()}</th>`;
    });
    html += '</tr></thead><tbody>';
    const rows = bodyRows.trim().split('\n').filter(r => r.trim());
    for (const row of rows) {
      const cells = row.split('|').filter(c => c.trim() !== '' || c.includes(' '));
      // Handle leading/trailing empty from split
      const cleaned = row.replace(/^\||\|$/g, '').split('|');
      html += '<tr>';
      cleaned.forEach((c, i) => {
        html += `<td style="text-align:${aligns[i] || 'left'}">${c.trim()}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  });

  // Step 3: Inline transforms
  let html = text.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^#### (.+)$/gm, '<h4>$1</h4>').replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>').replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>').replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>').replace(/^---+$/gm, '<hr>').replace(/^[\-\*] (.+)$/gm, '<li>$1</li>').replace(/^\d+\. (.+)$/gm, '<li>$1</li>').replace(/^(?!<[hluobdprit\x00]|<\/|<li|<hr|<pre|<block|<img|<a |<strong|<em|<code|<table|<thead|<tbody|<tr|<td|<th)(.+)$/gm, '<p>$1</p>');

  // Wrap lists
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, m => `<ul>${m}</ul>`);
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  html = html.replace(/<\/blockquote>\s*<blockquote>/g, '<br>');

  // Step 4: Restore code blocks
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  return html;
}