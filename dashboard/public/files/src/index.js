// files -- the Files tab: file tree + search, the Monaco viewer/editor, the diff
// viewer (incl. the shared renderInlineDiff used by the pull-requests module),
// the git-log panel, and the repo/space/branch picker modals. esbuild IIFE; the
// ~19 helpers (Monaco glue, renderers, context menus) stay private. Reads the
// shared `state` at top level (no other load-time work), so it loads AFTER
// app.js. Function deps resolve via window (esc/toast/switchTab/selectRepo/...)
// and browser/CDN globals (monaco, hljs). See ARCHITECTURE.md.
//
// ── File Browser ────────────────────────────────────────────────────────
state.filesCurrentRepo = '';
state.filesCurrentPath = '';
state.filesCurrentFile = null;
state.filesMode = 'view'; // view, diff, edit
function populateFilesRepoSelect() {
  const select = document.getElementById('filesRepoSelect');
  const repos = state.configData.Repos || {};
  const repoNames = _repoNamesForSpace(repos, window._spacesCache || {}, state.activeSpace);
  select.innerHTML = '<option value="">Select repo...</option>';
  for (const name of repoNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === state.filesCurrentRepo) opt.selected = true;
    select.appendChild(opt);
  }
}
function refreshFilesSearchIfActive() {
  const searchInput = document.getElementById('filesSearchInput');
  if (searchInput && searchInput.value.trim()) onFilesSearchInput();
}
async function loadFileTree(subPath) {
  // Sync from dropdown if no activeRepo set
  const select = document.getElementById('filesRepoSelect');
  if (!state.filesCurrentRepo && select) state.filesCurrentRepo = select.value;
  if (subPath !== undefined) state.filesCurrentPath = subPath;
  if (!state.filesCurrentRepo) {
    document.getElementById('filesTree').innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Select a repository</div></div>';
    document.getElementById('filesGitBar').style.display = 'none';
    document.getElementById('filesBreadcrumb').innerHTML = '';
    refreshFilesSearchIfActive();
    return;
  }

  // Load git info into header
  try {
    const gitRes = await fetch(`/api/git/status?repo=${encodeURIComponent(state.filesCurrentRepo)}`);
    const git = await gitRes.json();
    if (!git.error) {
      document.getElementById('filesGitBar').style.display = '';
      document.getElementById('filesBranch').textContent = git.branch;
      const statusEl = document.getElementById('filesGitStatus');
      statusEl.textContent = git.clean ? 'clean' : `${git.files.length} changed`;
      statusEl.className = `files-git-status ${git.clean ? 'clean' : 'dirty'}`;

      // Show changed files list
      const changedBar = document.getElementById('filesChangedBar');
      const changedList = document.getElementById('filesChangedList');
      if (git.files && git.files.length > 0) {
        changedBar.style.display = '';
        changedList.innerHTML = git.files.map(f => `
          <div class="changed-file" onclick="viewChangedFile('${esc(f.file)}')" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" title="${esc(f.file)}">
            <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.file)}</span>
            <button class="cf-discard" title="Discard changes to this file" onclick="event.stopPropagation();discardFile('${esc(f.file).replace(/'/g, "\\'")}')">&#8617;</button>
          </div>
        `).join('');
        // Auto-show the Diff tab and populate it with changed files
        document.getElementById('diffviewTabBtn').style.display = '';
        populateDiffTabWithChanges(git.files, state.filesCurrentRepo);
      } else {
        changedBar.style.display = 'none';
        // Hide diff tab if no changes and no commit diff
        if (!state.diffViewCommit) document.getElementById('diffviewTabBtn').style.display = 'none';
      }
    }
  } catch (_) {}

  // Breadcrumb
  renderFilesBreadcrumb();

  // Load tree
  try {
    const res = await fetch(`/api/files/tree?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(state.filesCurrentPath)}`);
    const data = await res.json();
    if (data.error) {
      document.getElementById('filesTree').innerHTML = `<div class="empty-state" style="padding:20px;"><div class="empty-state-text">${esc(data.error)}</div></div>`;
      refreshFilesSearchIfActive();
      return;
    }
    const tree = document.getElementById('filesTree');
    if (data.entries.length === 0) {
      tree.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">Empty directory</div>';
      refreshFilesSearchIfActive();
      return;
    }
    tree.innerHTML = data.entries.map(e => `
      <div class="file-item ${e.isDir ? 'dir' : ''} ${state.filesCurrentFile && state.filesCurrentFile.path === e.path ? 'active' : ''}"
           onclick="${e.isDir ? `loadFileTree('${esc(e.path)}')` : `viewFile('${esc(e.path)}')`}"
           oncontextmenu="event.preventDefault();showFileTreeContextMenu(event,'${esc(e.path)}')">
        <i data-lucide="${e.isDir ? 'folder' : fileIcon(e.name)}"></i>
        <span>${esc(e.name)}</span>
      </div>
    `).join('');
    try {
      lucide.createIcons();
    } catch (_) {}
  } catch (e) {
    document.getElementById('filesTree').innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Failed to load</div></div>';
  }
  refreshFilesSearchIfActive();
}
function renderFilesBreadcrumb() {
  const bc = document.getElementById('filesBreadcrumb');
  if (!state.filesCurrentPath) {
    bc.innerHTML = `<span style="color:var(--text);font-weight:600;">${esc(state.filesCurrentRepo)}</span>`;
    return;
  }
  const parts = state.filesCurrentPath.split('/');
  let html = `<button class="files-breadcrumb-link" onclick="loadFileTree('')">${esc(state.filesCurrentRepo)}</button>`;
  let cumulative = '';
  for (let i = 0; i < parts.length; i++) {
    cumulative += (cumulative ? '/' : '') + parts[i];
    html += `<span class="files-breadcrumb-sep">/</span>`;
    if (i < parts.length - 1) {
      html += `<button class="files-breadcrumb-link" onclick="loadFileTree('${esc(cumulative)}')">${esc(parts[i])}</button>`;
    } else {
      html += `<span style="color:var(--text)">${esc(parts[i])}</span>`;
    }
  }
  bc.innerHTML = html;
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    js: 'file-code',
    ts: 'file-code',
    jsx: 'file-code',
    tsx: 'file-code',
    py: 'file-code',
    cs: 'file-code',
    css: 'file-code',
    html: 'file-code',
    json: 'file-json',
    md: 'file-text',
    txt: 'file-text',
    png: 'image',
    jpg: 'image',
    svg: 'image',
    gif: 'image'
  };
  return icons[ext] || 'file';
}

// ── Files Search ──────────────────────────────────────────────────────
state._filesSearchMode = 'file'; // 'file' or 'content'
state._filesSearchTimer = null;
function setFilesSearchMode(mode) {
  state._filesSearchMode = mode;
  document.getElementById('filesSearchModeFile').classList.toggle('active', mode === 'file');
  document.getElementById('filesSearchModeContent').classList.toggle('active', mode === 'content');
  document.getElementById('filesSearchInput').placeholder = mode === 'file' ? 'Search files...' : 'Search in files...';
  const q = document.getElementById('filesSearchInput').value.trim();
  if (q) onFilesSearchInput();
}
function onFilesSearchInput() {
  clearTimeout(state._filesSearchTimer);
  const q = document.getElementById('filesSearchInput').value.trim();
  const resultsEl = document.getElementById('filesSearchResults');
  const treeEl = document.getElementById('filesTree');
  const bcEl = document.getElementById('filesBreadcrumb');
  const changedBar = document.getElementById('filesChangedBar');
  const gitBar = document.getElementById('filesGitBar');
  const scriptsBar = document.getElementById('filesScriptsBar');
  if (!q) {
    resultsEl.style.display = 'none';
    resultsEl.innerHTML = '';
    treeEl.style.display = '';
    bcEl.style.display = '';
    // Restore bars only if they were populated
    if (gitBar && gitBar.dataset.wasVisible) gitBar.style.display = '';
    if (changedBar && changedBar.dataset.wasVisible) changedBar.style.display = '';
    if (scriptsBar && scriptsBar.dataset.wasVisible) scriptsBar.style.display = '';
    return;
  }

  // Remember which bars were visible before hiding
  if (gitBar && gitBar.style.display !== 'none') gitBar.dataset.wasVisible = '1';
  if (changedBar && changedBar.style.display !== 'none') changedBar.dataset.wasVisible = '1';
  if (scriptsBar && scriptsBar.style.display !== 'none') scriptsBar.dataset.wasVisible = '1';

  // Hide tree and bars, show results
  treeEl.style.display = 'none';
  bcEl.style.display = 'none';
  if (gitBar) gitBar.style.display = 'none';
  if (changedBar) changedBar.style.display = 'none';
  if (scriptsBar) scriptsBar.style.display = 'none';
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div style="padding:12px;text-align:center;"><div class="spinner" style="margin:0 auto;"></div></div>';
  const delay = state._filesSearchMode === 'content' ? 400 : 250;
  state._filesSearchTimer = setTimeout(() => runFilesSearch(q), delay);
}
async function runFilesSearch(query) {
  const resultsEl = document.getElementById('filesSearchResults');
  if (!state.filesCurrentRepo) {
    resultsEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">Select a repository first</div>';
    return;
  }
  const endpoint = state._filesSearchMode === 'file' ? '/api/files/search' : '/api/files/grep';
  const scopePath = state.filesCurrentPath || '';
  try {
    const res = await fetch(`${endpoint}?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(scopePath)}&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data.error) {
      resultsEl.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--red);">${esc(data.error)}</div>`;
      return;
    }
    if (data.results.length === 0) {
      resultsEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">No results found</div>';
      return;
    }
    if (state._filesSearchMode === 'file') {
      resultsEl.innerHTML = data.results.map(r => {
        const dir = r.path.includes('/') ? r.path.substring(0, r.path.lastIndexOf('/')) : '';
        return `<div class="search-result" onclick="viewFile('${esc(r.path)}', 1)">
          <i data-lucide="file" class="search-result-icon" style="width:14px;height:14px;"></i>
          <div style="overflow:hidden;">
            <div class="search-result-name">${esc(r.name)}</div>
            ${dir ? `<div class="search-result-path">${esc(dir)}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    } else {
      // Group by file
      const grouped = new Map();
      for (const r of data.results) {
        if (!grouped.has(r.path)) grouped.set(r.path, []);
        grouped.get(r.path).push(r);
      }
      const qLower = query.toLowerCase();
      const qEscaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      let html = '';
      for (const [filePath, matches] of grouped) {
        const name = filePath.includes('/') ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
        html += `<div style="padding:4px 10px;font-size:10px;font-weight:600;color:var(--overlay1);background:var(--surface0);border-bottom:1px solid var(--surface0);display:flex;align-items:center;gap:4px;cursor:pointer;" onclick="viewFile('${esc(filePath)}', ${matches[0].line}, '${qEscaped}')">
          <i data-lucide="file" style="width:11px;height:11px;"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(filePath)}</span>
          <span style="margin-left:auto;color:var(--subtext0);font-weight:400;">${matches.length}</span>
        </div>`;
        for (const m of matches) {
          const qWords = query.trim().split(/\s+/).filter(Boolean);
          const highlightPattern = qWords.length > 1 ? qWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const highlighted = esc(m.text.trimStart()).replace(new RegExp(highlightPattern, 'gi'), match => `<mark>${match}</mark>`);
          html += `<div class="search-result" onclick="viewFile('${esc(filePath)}', ${m.line}, '${qEscaped}')">
            <span class="search-result-line">L${m.line}</span>
            <div class="search-result-text">${highlighted}</div>
          </div>`;
        }
      }
      resultsEl.innerHTML = html;
    }
    try {
      lucide.createIcons();
    } catch (_) {}
  } catch (e) {
    resultsEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--red);">Search failed</div>';
  }
}
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'avi'];
state._pendingGoToLine = null; // { line, query } — set before file loads, consumed by Monaco
async function viewFile(filePath, goToLine, highlightQuery) {
  state._pendingGoToLine = goToLine ? {
    line: goToLine,
    query: highlightQuery || null
  } : null;
  const ext = filePath.split('.').pop().toLowerCase();

  // Handle images and videos — show preview, not code
  if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
    state.filesCurrentFile = {
      name: filePath.split('/').pop(),
      path: filePath,
      ext,
      content: '',
      isMedia: true
    };
    document.getElementById('filesViewerTitle').textContent = state.filesCurrentFile.name;
    document.getElementById('filesToggleEditBtn').style.display = 'none';
    const _revBtn = document.getElementById('filesRevealBtn');
    if (_revBtn) _revBtn.style.display = '';
    document.getElementById('monacoContainer').style.display = 'none';
    document.getElementById('monacoSaveBar').style.display = 'none';
    document.getElementById('filesEmpty').style.display = 'none';

    // Use a media preview container
    const emptyEl = document.getElementById('filesEmpty');
    const monacoEl = document.getElementById('monacoContainer');
    monacoEl.style.display = '';
    const editorDiv = document.getElementById('monacoEditor');
    const serveUrl = `/api/files/serve?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(filePath)}`;
    if (IMAGE_EXTS.includes(ext)) {
      editorDiv.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;"><img src="${serveUrl}" style="max-width:100%;max-height:100%;border-radius:var(--radius);object-fit:contain;"></div>`;
    } else {
      editorDiv.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;"><video src="${serveUrl}" controls style="max-width:100%;max-height:100%;border-radius:var(--radius);"></video></div>`;
    }
    if (state.monacoEditor) {
      state.monacoEditor.dispose();
      state.monacoEditor = null;
    }
    loadFileTree(state.filesCurrentPath);
    return;
  }
  try {
    const res = await fetch(`/api/files/read?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    state.filesCurrentFile = data;
    document.getElementById('filesViewerTitle').textContent = data.name;
    setFilesMode('view');
    loadFileTree(state.filesCurrentPath);
  } catch (e) {
    toast('Failed to load file', 'error');
  }
}

// ── File viewer mode switching (view / edit) ────────────────────────────
function setFilesMode(mode) {
  state.filesMode = mode;
  const monacoEl = document.getElementById('monacoContainer');
  const emptyEl = document.getElementById('filesEmpty');
  const saveBar = document.getElementById('monacoSaveBar');
  const toggleBtn = document.getElementById('filesToggleEditBtn');
  const revealBtn = document.getElementById('filesRevealBtn');
  monacoEl.style.display = 'none';
  emptyEl.style.display = 'none';
  saveBar.style.display = 'none';
  if (!state.filesCurrentFile) {
    emptyEl.style.display = '';
    toggleBtn.style.display = 'none';
    if (revealBtn) revealBtn.style.display = 'none';
    return;
  }
  toggleBtn.style.display = '';
  if (revealBtn) revealBtn.style.display = '';
  toggleBtn.textContent = mode === 'edit' ? 'View' : 'Edit';
  monacoEl.style.display = '';
  if (mode === 'edit') {
    saveBar.style.display = 'flex';
    openMonacoFile(state.filesCurrentFile.content, state.filesCurrentFile.ext, false);
  } else {
    openMonacoFile(state.filesCurrentFile.content, state.filesCurrentFile.ext, true);
  }
}
function openMonacoFile(content, ext, readOnly) {
  if (state.monacoReady) {
    createOrUpdateMonaco(content, ext, readOnly);
  } else {
    loadMonaco().then(() => createOrUpdateMonaco(content, ext, readOnly));
  }
}
function createOrUpdateMonaco(content, ext, readOnly) {
  const lang = getMonacoLang(ext);
  if (state.monacoEditor) {
    const model = state.monacoEditor.getModel();
    monaco.editor.setModelLanguage(model, lang);
    state.monacoEditor.setValue(content);
    state.monacoEditor.updateOptions({
      readOnly
    });
  } else {
    state.monacoEditor = monaco.editor.create(document.getElementById('monacoEditor'), {
      value: content,
      language: lang,
      theme: 'symphonee',
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      minimap: {
        enabled: true
      },
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      automaticLayout: true,
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      bracketPairColorization: {
        enabled: true
      },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: {
        top: 8
      },
      readOnly
    });
    state.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (!state.monacoEditor.getOption(monaco.editor.EditorOption.readOnly)) saveFilesEdit();
    });
  }

  // Go to line and highlight if pending
  if (state._pendingGoToLine && state.monacoEditor) {
    const {
      line,
      query
    } = state._pendingGoToLine;
    state._pendingGoToLine = null;
    setTimeout(() => {
      state.monacoEditor.revealLineInCenter(line);
      state.monacoEditor.setPosition({
        lineNumber: line,
        column: 1
      });

      // Highlight the line
      const decorations = [{
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'monaco-highlight-line',
          overviewRuler: {
            color: '#f9e2af80',
            position: monaco.editor.OverviewRulerLane.Full
          }
        }
      }];

      // Also highlight query matches on that line if we have a query
      if (query) {
        const model = state.monacoEditor.getModel();
        const lineContent = model.getLineContent(line);
        const qLower = query.toLowerCase();
        let idx = 0;
        while (idx < lineContent.length) {
          const pos = lineContent.toLowerCase().indexOf(qLower, idx);
          if (pos === -1) break;
          decorations.push({
            range: new monaco.Range(line, pos + 1, line, pos + 1 + query.length),
            options: {
              inlineClassName: 'monaco-highlight-match'
            }
          });
          idx = pos + 1;
        }
      }

      // Apply decorations (auto-clear after 5 seconds)
      const ids = state.monacoEditor.deltaDecorations([], decorations);
      setTimeout(() => {
        if (state.monacoEditor) state.monacoEditor.deltaDecorations(ids, []);
      }, 5000);
    }, 50);
  }
}
function toggleFilesEdit() {
  setFilesMode(state.filesMode === 'edit' ? 'view' : 'edit');
}
state.monacoEditor = null;
state.monacoReady = false; // Detect whether the active theme is light by reading --base's luminance.
function _isLightTheme() {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--base').trim();
    const m = bg.match(/^#([0-9a-f]{6})$/i);
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = n >> 16 & 0xff,
      g = n >> 8 & 0xff,
      b = n & 0xff;
    // Perceived luminance (Rec. 601)
    return 0.299 * r + 0.587 * g + 0.114 * b > 160;
  } catch (_) {
    return false;
  }
}
function _defineMonacoTheme() {
  if (!window.monaco) return;
  const cs = getComputedStyle(document.documentElement);
  const base = _isLightTheme() ? 'vs' : 'vs-dark';
  monaco.editor.defineTheme('symphonee', {
    base,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cs.getPropertyValue('--crust').trim(),
      'editor.lineHighlightBackground': cs.getPropertyValue('--surface0').trim(),
      'editorLineNumber.foreground': cs.getPropertyValue('--overlay0').trim()
    }
  });
  if (state.monacoEditor) monaco.editor.setTheme('symphonee');
}
function loadMonaco() {
  if (state.monacoReady) return Promise.resolve();
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs/loader.min.js';
    script.onload = () => {
      require.config({
        paths: {
          vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs'
        }
      });
      require(['vs/editor/editor.main'], () => {
        state.monacoReady = true;
        _defineMonacoTheme();

        // Configure TypeScript/JavaScript to not flag unresolved imports
        const tsDefaults = monaco.languages.typescript.typescriptDefaults;
        const jsDefaults = monaco.languages.typescript.javascriptDefaults;
        const compilerOptions = {
          target: monaco.languages.typescript.ScriptTarget.ESNext,
          module: monaco.languages.typescript.ModuleKind.ESNext,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
          allowJs: true,
          allowSyntheticDefaultImports: true,
          esModuleInterop: true,
          skipLibCheck: true,
          strict: false,
          noEmit: true,
          isolatedModules: true,
          resolveJsonModule: true,
          baseUrl: '.'
        };
        tsDefaults.setCompilerOptions(compilerOptions);
        jsDefaults.setCompilerOptions(compilerOptions);

        // Disable semantic validation (can't resolve node_modules from browser)
        tsDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: false
        });
        jsDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: false
        });
        resolve();
      });
    };
    document.head.appendChild(script);
  });
}
function getMonacoLang(ext) {
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
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    sql: 'sql',
    php: 'php',
    dockerfile: 'dockerfile',
    r: 'r',
    swift: 'swift',
    kt: 'kotlin'
  };
  return map[ext] || 'plaintext';
}
state.monacoDiffEditor = null;
let diffViewMode = 'inline';
state.diffViewCommit = null; // { hash, files: [{file, status}], selectedFile }
async function viewCommitDiff(hash) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  try {
    // Get commit diff stat (file list)
    const statRes = await fetch(`/api/git/commit-diff?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`);
    const statData = await statRes.json();
    if (statData.error) {
      toast(statData.error, 'error');
      return;
    }

    // Parse changed files from diff
    const files = [];
    const diffLines = (statData.diff || '').split('\n');
    let currentFile = null;
    for (const line of diffLines) {
      // Parse "diff --git a/path b/path" — the two paths are always identical, so split on " b/" from the middle
      const m = line.match(/^diff --git a\/(.+)/);
      if (m) {
        const rest = m[1];
        // The path appears twice separated by " b/" — find the midpoint
        const mid = rest.lastIndexOf(' b/');
        const filePath = mid > 0 ? rest.substring(mid + 3) : rest;
        if (!files.find(f => f.file === filePath)) {
          files.push({
            file: filePath,
            status: 'M'
          });
        }
      }
    }
    // Also parse from stat
    if (statData.stat) {
      const statLines = statData.stat.split('\n');
      for (const sl of statLines) {
        const sm = sl.match(/^\s*(.+?)\s+\|\s+\d+/);
        if (sm && !files.find(f => f.file === sm[1].trim())) {
          files.push({
            file: sm[1].trim(),
            status: 'M'
          });
        }
      }
    }
    state.diffViewCommit = {
      hash,
      diff: statData.diff,
      message: statData.message,
      files,
      repo
    };

    // Show the tab
    document.getElementById('diffviewTabBtn').style.display = '';
    document.getElementById('diffviewTitle').textContent = `Commit ${hash}: ${statData.message || ''}`;

    // Render file list
    const fileList = document.getElementById('diffviewFileList');
    document.getElementById('diffviewFileCount').textContent = `${files.length} files`;
    fileList.innerHTML = files.map((f, i) => `
      <div class="diffview-file ${i === 0 ? 'active' : ''}" onclick="selectDiffFile(${i})" data-idx="${i}">
        <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
        <span class="diffview-file-name" title="${esc(f.file)}">${esc(f.file.split('/').pop())}</span>
      </div>
    `).join('');
    switchTab('diffview');

    // Show first file's diff
    if (files.length > 0) renderDiffForFile(0);else renderDiffViewContent(statData.diff);
  } catch (e) {
    toast('Failed to load commit diff', 'error');
  }
}
function selectDiffFile(idx) {
  document.querySelectorAll('.diffview-file').forEach(el => el.classList.toggle('active', parseInt(el.dataset.idx) === idx));
  renderDiffForFile(idx);
}
async function renderDiffForFile(idx) {
  if (!state.diffViewCommit) return;
  const file = state.diffViewCommit.files[idx];
  if (!file) return;
  document.getElementById('diffviewTitle').textContent = file.file;
  const container = document.getElementById('diffviewContent');
  container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="spinner"></div></div>';
  const repo = state.diffViewCommit.repo;
  if (state.diffViewCommit.hash && state.diffViewCommit.hash !== 'working') {
    // Viewing a commit — extract this file's diff from the full commit diff
    const fileDiff = extractFileDiff(state.diffViewCommit.diff, file.file);
    if (fileDiff) {
      renderInlineDiff(container, fileDiff);
    } else {
      // Fallback: fetch from commit-diff endpoint for just this file
      try {
        const res = await fetch(`/api/git/commit-diff?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(state.diffViewCommit.hash)}&path=${encodeURIComponent(file.file)}`);
        const data = await res.json();
        renderInlineDiff(container, data.diff);
      } catch (_) {
        container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Failed to load diff</div></div>';
      }
    }
  } else {
    // Working tree — fetch live diff
    try {
      const res = await fetch(`/api/git/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(file.file)}`);
      const data = await res.json();
      renderInlineDiff(container, data.diff);
    } catch (_) {
      container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Failed to load diff</div></div>';
    }
  }
}

// Extract the diff chunk for a specific file from a full multi-file diff
function extractFileDiff(fullDiff, filePath) {
  if (!fullDiff) return null;
  const lines = fullDiff.split('\n');
  let capturing = false;
  let result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      if (capturing) break; // hit the next file, stop
      // Check if this is the file we want
      const m = line.match(/^diff --git a\/(.+)/);
      if (m) {
        const rest = m[1];
        const mid = rest.lastIndexOf(' b/');
        const diffFile = mid > 0 ? rest.substring(mid + 3) : rest;
        if (diffFile === filePath) capturing = true;
      }
    }
    if (capturing) result.push(line);
  }
  return result.length > 0 ? result.join('\n') : null;
}
function renderInlineDiff(container, diffText) {
  if (state.monacoDiffEditor) {
    state.monacoDiffEditor.dispose();
    state.monacoDiffEditor = null;
  }
  if (!diffText || diffText === 'No changes') {
    container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">No changes</div></div>';
    return;
  }
  const lines = diffText.split('\n');
  let added = 0,
    removed = 0;
  let html = '<table class="diff-table"><tbody>';
  for (const line of lines) {
    if (line.startsWith('@@')) {
      html += `<tr class="diff-hunk"><td colspan="3">${esc(line)}</td></tr>`;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
      html += `<tr class="diff-add"><td class="diff-marker">+</td><td class="diff-code">${esc(line.slice(1))}</td></tr>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
      html += `<tr class="diff-remove"><td class="diff-marker">-</td><td class="diff-code">${esc(line.slice(1))}</td></tr>`;
    } else if (!line.startsWith('diff ') && !line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++')) {
      html += `<tr><td class="diff-marker"></td><td class="diff-code">${esc(line.startsWith(' ') ? line.slice(1) : line)}</td></tr>`;
    }
  }
  html += '</tbody></table>';
  container.innerHTML = `<div class="diff-stats-bar"><span class="diff-stats-add">+${added}</span> <span class="diff-stats-del">-${removed}</span></div>${html}`;
}
function populateDiffTabWithChanges(files, repo) {
  if (!files || files.length === 0) return;
  state.diffViewCommit = {
    hash: 'working',
    diff: '',
    message: 'Working changes',
    files: files.map(f => ({
      file: f.file,
      status: f.status
    })),
    repo
  };
  document.getElementById('diffviewTitle').textContent = 'Working Changes';
  document.getElementById('diffviewFileCount').textContent = `${files.length} files`;
  const fileList = document.getElementById('diffviewFileList');
  fileList.innerHTML = state.diffViewCommit.files.map((f, i) => `
    <div class="diffview-file" onclick="selectDiffFile(${i})" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" data-idx="${i}">
      <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
      <span class="diffview-file-name" title="${esc(f.file)}">${esc(f.file.split('/').pop())}</span>
      <button class="cf-discard" title="Discard changes to this file" onclick="event.stopPropagation();discardFile('${esc(f.file).replace(/'/g, "\\'")}')">&#8617;</button>
    </div>
  `).join('');

  // Pre-load the full diff
  fetch(`/api/git/diff?repo=${encodeURIComponent(repo)}`).then(r => r.json()).then(data => {
    if (state.diffViewCommit && state.diffViewCommit.hash === 'working') state.diffViewCommit.diff = data.diff || '';
  }).catch(() => {});
}
function closeDiffView() {
  document.getElementById('diffviewTabBtn').style.display = 'none';
  if (state.monacoDiffEditor) {
    state.monacoDiffEditor.dispose();
    state.monacoDiffEditor = null;
  }
  state.diffViewCommit = null;
  switchTab('terminal');
}
state.contextDiffFile = null;
function showDiffFileContextMenu(e, filePath) {
  e.preventDefault();
  state.contextDiffFile = filePath;
  const menu = document.getElementById('diffFileContextMenu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('open');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
// Discard all working-tree changes to a single file. Used by both the
// right-click context menu and the inline discard button on file rows.
async function discardFile(filePath) {
  if (!filePath) return;
  const repo = state.diffViewCommit && state.diffViewCommit.repo || state.activeRepo || state.filesCurrentRepo;
  if (!repo) {
    toast('No repository selected', 'error');
    return;
  }
  const ok = await customConfirm('Discard Changes', `Discard all changes to "${filePath}"? This cannot be undone.`, 'Discard');
  if (!ok) return;
  try {
    const r = await fetch('/api/git/discard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo,
        path: filePath
      })
    });
    const data = await r.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    toast(`Discarded changes to ${filePath}`);
    // Refresh the diff viewer: drop the discarded file, show the next one, or close.
    if (state.diffViewCommit && state.diffViewCommit.hash === 'working') {
      const remaining = state.diffViewCommit.files.filter(f => f.file !== filePath);
      if (remaining.length > 0) {
        viewChangedFile(remaining[0].file);
      } else {
        closeDiffView();
      }
    }
    // Refresh the files tab changed list
    if (typeof loadGitPanel === 'function' && state.filesCurrentRepo) loadGitPanel();
  } catch (e) {
    toast('Failed to discard changes', 'error');
  }
}
async function discardFileFromContext() {
  document.getElementById('diffFileContextMenu').classList.remove('open');
  return discardFile(state.contextDiffFile);
}
// Dismiss any open context menu on an outside click or Escape.
(function wireContextMenuDismiss() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('click', e => {
    document.querySelectorAll('.context-menu.open').forEach(m => { if (!m.contains(e.target)) m.classList.remove('open'); });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.context-menu.open').forEach(m => m.classList.remove('open'));
  });
})();
async function viewChangedFile(filePath) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  try {
    // Get all changed files and the diff
    const statusRes = await fetch(`/api/git/status?repo=${encodeURIComponent(repo)}`);
    const statusData = await statusRes.json();
    const diffRes = await fetch(`/api/git/diff?repo=${encodeURIComponent(repo)}`);
    const diffData = await diffRes.json();
    const files = (statusData.files || []).map(f => ({
      file: f.file,
      status: f.status
    }));
    state.diffViewCommit = {
      hash: 'working',
      diff: diffData.diff,
      message: 'Working changes',
      files,
      repo
    };
    document.getElementById('diffviewTabBtn').style.display = '';
    document.getElementById('diffviewTitle').textContent = 'Working Changes';
    document.getElementById('diffviewFileCount').textContent = `${files.length} files`;
    const fileList = document.getElementById('diffviewFileList');
    const targetIdx = files.findIndex(f => f.file === filePath);
    fileList.innerHTML = files.map((f, i) => `
      <div class="diffview-file ${i === (targetIdx >= 0 ? targetIdx : 0) ? 'active' : ''}" onclick="selectDiffFile(${i})" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" data-idx="${i}">
        <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
        <span class="diffview-file-name" title="${esc(f.file)}">${esc(f.file.split('/').pop())}</span>
        <button class="cf-discard" title="Discard changes to this file" onclick="event.stopPropagation();discardFile('${esc(f.file).replace(/'/g, "\\'")}')">&#8617;</button>
      </div>
    `).join('');
    switchTab('diffview');
    renderDiffForFile(targetIdx >= 0 ? targetIdx : 0);
  } catch (e) {
    toast('Failed to load diff', 'error');
  }
}
function cancelFilesEdit() {
  setFilesMode('view');
}
async function saveFilesEdit() {
  const content = state.monacoEditor ? state.monacoEditor.getValue() : '';
  try {
    const res = await fetch('/api/files/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo: state.filesCurrentRepo,
        path: state.filesCurrentFile.path,
        content
      })
    });
    const data = await res.json();
    if (data.ok) {
      toast('File saved', 'success');
      state.filesCurrentFile.content = content;
      cancelFilesEdit();
      viewFile(state.filesCurrentFile.path);
    } else {
      toast(data.error || 'Failed to save', 'error');
    }
  } catch (e) {
    toast('Failed to save', 'error');
  }
}

// ── Files Sidebar Tabs ──────────────────────────────────────────────────
function switchFilesTab(tab) {
  document.querySelectorAll('.files-stab').forEach(el => el.classList.toggle('active', el.dataset.fstab === tab));
  document.querySelectorAll('.files-stab-panel').forEach(el => el.classList.toggle('active', el.id === `fstab-${tab}`));
  if (tab === 'git' && state.filesCurrentRepo) loadGitPanel();
  if (tab === 'log' && state.filesCurrentRepo) loadGitLogPanel(); // was loadGitLog() -- a non-existent fn (pre-existing typo found by the cross-module audit)
}
async function loadGitPanel() {
  if (!state.filesCurrentRepo) return;

  // Load branches
  try {
    const res = await fetch(`/api/git/branches?repo=${encodeURIComponent(state.filesCurrentRepo)}`);
    const data = await res.json();
    if (!data.error) {
      const select = document.getElementById('filesBranchSelect');
      select.innerHTML = data.branches.map(b => `<option value="${esc(b)}" ${b === data.current ? 'selected' : ''}>${esc(b)}</option>`).join('');
    }
  } catch (_) {}

  // Load changed files
  try {
    const res = await fetch(`/api/git/status?repo=${encodeURIComponent(state.filesCurrentRepo)}`);
    const git = await res.json();
    const container = document.getElementById('filesChangedList');
    if (git.files && git.files.length > 0) {
      container.innerHTML = git.files.map(f => `
        <div class="changed-file" onclick="viewFile('${esc(f.file)}')" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" title="${esc(f.file)}">
          <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
          <span>${esc(f.file.split('/').pop())}</span>
          <button class="cf-discard" title="Discard changes to this file" onclick="event.stopPropagation();discardFile('${esc(f.file).replace(/'/g, "\\'")}')">&#8617;</button>
        </div>
      `).join('');
    } else {
      container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);">No changes</div>';
    }
  } catch (_) {}
}
async function loadGitLogPanel() {
  // Use the active repo, falling back to the Files-tab repo. On load only
  // activeRepo is restored (from localStorage); filesCurrentRepo starts empty
  // until a Files-tab interaction, which left this panel stuck on its
  // "Select a repo" placeholder even with a repo selected on the left.
  const repo = state.filesCurrentRepo || state.activeRepo;
  const container = document.getElementById('gitLogList');
  if (!repo) {
    if (container) container.innerHTML = '<div style="color:var(--subtext0);font-size:12px;padding:4px;">Select a repository</div>';
    return;
  }
  try {
    const res = await fetch(`/api/git/log?repo=${encodeURIComponent(repo)}&count=30`);
    const data = await res.json();
    if (data.commits && data.commits.length > 0) {
      container.innerHTML = data.commits.map(c => `
        <div class="commit-item" onclick="viewCommitDiff('${esc(c.hash)}')" style="cursor:pointer;" title="View changes in this commit">
          <span class="commit-hash">${esc(c.hash)}</span>
          <div class="commit-msg">${esc(c.subject)}</div>
          <div class="commit-meta">${esc(c.author)} - ${esc(c.date)}</div>
        </div>
      `).join('');
    } else {
      container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:10px;text-align:center;">No commits</div>';
    }
  } catch (_) {
    container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:10px;text-align:center;">Failed to load</div>';
  }
}
function switchBranch(branch) {
  if (!state.filesCurrentRepo || !branch) return;
  // This is a write action — send to terminal for the user/AI to confirm
  switchTab('terminal');
  sendCommand(`cd "${state.configData.Repos[state.filesCurrentRepo]}"; git checkout ${branch}`);
  toast(`Switching to ${branch}...`, 'info');
}
function aiGit(action) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) {
    toast('Select a repo first', 'info');
    return;
  }
  const repoPath = state.configData.Repos[repo];
  const user = state.configData.DefaultUser || 'the user';
  const prompts = {
    pull: `In the repo at "${repoPath}", pull the latest changes from the remote. Run: cd "${repoPath}" && git pull`,
    push: `In the repo at "${repoPath}", push the current branch to the remote. Run: cd "${repoPath}" && git push`,
    checkout: `In the repo at "${repoPath}", list all branches and ask me which one I want to switch to. Run: cd "${repoPath}" && git branch -a`,
    commit: `In the repo at "${repoPath}", check git status, show me what changed, suggest a commit message, and create the commit. The commit must be signed by "${user}". Run: cd "${repoPath}" && git status`,
    compare: `In the repo at "${repoPath}", compare the current branch with main. Show a summary of all differences. Run: cd "${repoPath}" && git diff main...HEAD --stat`
  };
  askAi(prompts[action]);
}

// ── Context picker modals ─────────────────────────────────────────────────

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// Space picker
async function openSpaceModal() {
  const modal = document.getElementById('spaceModal');
  const list = document.getElementById('spacePickList');
  if (!modal || !list) return;
  modal.classList.add('open');
  list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">Loading...</div>';
  let spaces = {},
    repos = {};
  try {
    [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
  } catch (_) {}
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  const allActive = !state.activeSpace ? ' active' : '';
  html += `<div class="ctx-pick-item${allActive}" role="button" tabindex="0" data-pick-space="__all__">
    <i data-lucide="layers" style="width:15px;height:15px;"></i>
    <span class="cpi-name">All spaces</span>
  </div>`;
  for (const [name, sv] of Object.entries(spaces)) {
    const icon = sv && sv.icon || 'layers';
    const count = sv && Array.isArray(sv.repos) ? sv.repos.filter(r => repos[r]).length : 0;
    const active = name === state.activeSpace ? ' active' : '';
    html += `<div class="ctx-pick-item${active}" role="button" tabindex="0" data-pick-space="${escAttr(name)}">
      <i data-lucide="${esc(icon)}" style="width:15px;height:15px;"></i>
      <span class="cpi-name">${esc(name)}</span>
      ${count ? `<span class="cpi-sub">${count} repo${count !== 1 ? 's' : ''}</span>` : ''}
      <button type="button" class="cpi-action" data-pick-action="edit-space" data-space-name="${escAttr(name)}" title="Edit space settings" aria-label="Edit space settings">
        <i data-lucide="settings"></i>
      </button>
    </div>`;
  }
  if (!Object.keys(spaces).length) {
    html += '<div style="padding:12px 14px;font-size:11px;color:var(--subtext0);">No spaces yet. Create one below.</div>';
  }
  list.innerHTML = html;
  list.onclick = function (ev) {
    const action = ev.target && ev.target.closest && ev.target.closest('[data-pick-action]');
    if (action) {
      ev.preventDefault();
      ev.stopPropagation();
      const kind = action.getAttribute('data-pick-action');
      if (kind === 'edit-space') {
        const n = action.getAttribute('data-space-name') || '';
        closeModal('spaceModal');
        try {
          openEditSpaceDialog(n);
        } catch (e) {
          console.error('openEditSpaceDialog failed', e);
        }
      }
      return;
    }
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-pick-space]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const raw = btn.getAttribute('data-pick-space') || '';
    const n = raw === '__all__' ? '' : raw;
    try {
      selectSpace(n);
    } catch (e) {
      console.error('selectSpace failed', e);
    }
    closeModal('spaceModal');
  };
  try {
    lucide.createIcons({
      nodes: [list]
    });
  } catch (_) {}
}

// Repo picker (filtered to current space)
state._repoPickNames = [];
async function openRepoModal() {
  const modal = document.getElementById('repoModal');
  const list = document.getElementById('repoPickList');
  const title = document.getElementById('repoModalTitle');
  const search = document.getElementById('repoPickSearch');
  if (!modal || !list) return;
  modal.classList.add('open');
  if (search) search.value = '';
  list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">Loading...</div>';
  if (title) title.textContent = state.activeSpace ? `Repos in "${state.activeSpace}"` : 'Select Repo';
  let repos = {},
    spaces = {};
  try {
    [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
  } catch (_) {}
  // Filter repos to current space if one is selected
  let repoNames = Object.keys(repos);
  if (state.activeSpace && spaces[state.activeSpace] && Array.isArray(spaces[state.activeSpace].repos)) {
    repoNames = spaces[state.activeSpace].repos.filter(r => repos[r]);
  }
  state._repoPickNames = repoNames;
  renderRepoPicker('');
  list.onclick = function (ev) {
    const action = ev.target && ev.target.closest && ev.target.closest('[data-pick-action]');
    if (action) {
      ev.preventDefault();
      ev.stopPropagation();
      const kind = action.getAttribute('data-pick-action');
      if (kind === 'reveal-repo') {
        const n = action.getAttribute('data-repo-name') || '';
        if (!n) return;
        fetch('/api/ui/reveal', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'file',
            repo: n,
            path: ''
          })
        }).then(r => r.json().catch(() => ({}))).then(d => {
          if (d && d.error) toast(d.error, 'error');
        }).catch(() => toast('Could not open folder', 'error'));
      }
      return;
    }
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-pick-repo]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const n = btn.getAttribute('data-pick-repo') || '';
    try {
      selectRepo(n);
    } catch (e) {
      console.error('selectRepo failed', e);
    }
    closeModal('repoModal');
  };
  if (search) setTimeout(() => search.focus(), 50);
}
function renderRepoPicker(filter) {
  const list = document.getElementById('repoPickList');
  if (!list) return;
  const f = (filter || '').toLowerCase();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const filtered = state._repoPickNames.filter(n => !f || n.toLowerCase().includes(f));

  // "No repo" row always present (unless filtering hides it) so user can clear the selection
  const noRepoMatches = !f || 'no repo'.includes(f);
  let html = '';
  if (noRepoMatches) {
    const active = !state.activeRepo ? ' active' : '';
    html += `<div class="ctx-pick-item${active}" role="button" tabindex="0" data-pick-repo="">
      <i data-lucide="folder-x" style="width:15px;height:15px;"></i>
      <span class="cpi-name" style="color:var(--subtext0);font-style:italic;">No repo</span>
    </div>`;
  }
  for (const name of filtered) {
    const active = name === state.activeRepo ? ' active' : '';
    html += `<div class="ctx-pick-item${active}" role="button" tabindex="0" data-pick-repo="${escAttr(name)}">
      <i data-lucide="folder-git-2" style="width:15px;height:15px;"></i>
      <span class="cpi-name">${esc(name)}</span>
      <button type="button" class="cpi-action" data-pick-action="reveal-repo" data-repo-name="${escAttr(name)}" title="Open folder in Explorer" aria-label="Open folder in Explorer">
        <i data-lucide="folder-open"></i>
      </button>
    </div>`;
  }
  if (!filtered.length && !noRepoMatches) {
    html = `<div style="padding:12px 14px;font-size:11px;color:var(--subtext0);">No repos match "${esc(filter)}".</div>`;
  } else if (!state._repoPickNames.length && !f) {
    html += `<div style="padding:12px 14px 4px;font-size:11px;color:var(--subtext0);">${state.activeSpace ? 'No repos in this space.' : 'No repos added yet.'}</div>`;
    html += `<div style="padding:4px 14px 12px;"><button type="button" onclick="document.getElementById('repoModal').classList.remove('open'); if(typeof openSettings==='function') openSettings('repos');" style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius);color:var(--text);font:600 11px var(--font-ui);cursor:pointer;"><i data-lucide="plus" style="width:13px;height:13px;"></i> Add a repo</button></div>`;
  }
  list.innerHTML = html;
  try {
    lucide.createIcons({
      nodes: [list]
    });
  } catch (_) {}
}
function filterRepoPicker() {
  const search = document.getElementById('repoPickSearch');
  renderRepoPicker(search ? search.value : '');
}

// Branch picker
state._branchPickData = {
  local: [],
  remoteOnly: [],
  current: ''
};
state._branchFilter = 'all';
function setBranchFilter(f) {
  state._branchFilter = f;
  ['all', 'local', 'remote'].forEach(k => {
    const el = document.getElementById('branchFilter' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.classList.toggle('active', k === f);
  });
  filterBranchPicker();
}
async function openBranchModal() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) {
    toast('Select a repo first', 'info');
    return;
  }
  const modal = document.getElementById('branchModal');
  const repoEl = document.getElementById('branchModalRepo');
  const list = document.getElementById('branchPickList');
  const search = document.getElementById('branchPickSearch');
  if (!modal || !list) return;
  if (repoEl) repoEl.textContent = repo;
  if (search) search.value = '';
  state._branchFilter = 'all';
  ['All', 'Local', 'Remote'].forEach(k => {
    const el = document.getElementById('branchFilter' + k);
    if (el) el.classList.toggle('active', k === 'All');
  });
  modal.classList.add('open');
  list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">Loading branches...</div>';
  try {
    const r = await fetch('/api/git/branches?repo=' + encodeURIComponent(repo));
    const data = await r.json();
    // API returns either { local, remoteOnly, current } or legacy { branches, current }
    state._branchPickData = {
      local: data.local || data.branches || [],
      remoteOnly: data.remoteOnly || [],
      current: data.current || ''
    };
    renderBranchPicker('');
  } catch (e) {
    list.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--red);">${e.message}</div>`;
  }
}
function renderBranchPicker(filter) {
  const list = document.getElementById('branchPickList');
  if (!list) return;
  const f = (filter || '').toLowerCase();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';

  // ensure current branch is always in the local list
  const allLocals = state._branchPickData.local.slice();
  if (state._branchPickData.current && !allLocals.includes(state._branchPickData.current)) {
    allLocals.unshift(state._branchPickData.current);
  }
  if (state._branchFilter !== 'remote') {
    const locals = allLocals.filter(b => !f || b.toLowerCase().includes(f));
    for (const b of locals) {
      const isCurrent = b === state._branchPickData.current;
      const icon = isCurrent ? 'check' : 'git-branch';
      const onclick = isCurrent ? '' : `onclick="doGitCheckoutFromModal(${JSON.stringify(b)});"`;
      html += `<button class="branch-pick-item${isCurrent ? ' current' : ''}" ${onclick}>
        <i data-lucide="${icon}" style="width:14px;height:14px;"></i>
        <span class="bp-name">${esc(b)}</span>
        <span class="branch-badge ${isCurrent ? 'current-badge' : 'local'}">${isCurrent ? 'current' : 'local'}</span>
      </button>`;
    }
  }
  if (state._branchFilter !== 'local') {
    const remotes = (state._branchPickData.remoteOnly || []).filter(b => !f || b.toLowerCase().includes(f));
    for (const b of remotes) {
      html += `<button class="branch-pick-item" onclick="doGitCheckoutFromModal(${JSON.stringify(b)});">
        <i data-lucide="cloud" style="width:14px;height:14px;"></i>
        <span class="bp-name">${esc(b)}</span>
        <span class="branch-badge remote">remote</span>
      </button>`;
    }
  }
  if (!html) html = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">No branches match.</div>';
  list.innerHTML = html;
  try {
    lucide.createIcons({
      nodes: [list]
    });
  } catch (_) {}
}
async function doGitCheckoutFromModal(branch) {
  closeModal('branchModal');
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo || !branch) return;
  toast('Switching to ' + branch + '...', 'info');
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
      toast(data.error, 'error');
      return;
    }
    let msg = 'Switched to ' + data.branch;
    if (data.pullMessage && data.pullMessage !== 'Already up to date.') msg += ' — pulled latest';
    toast(msg, 'success');
    // update all branch displays
    state._gitBranches.current = data.branch;
    refreshBranchChip(repo);
    const cur = document.getElementById('gitCurrentBranch');
    const pull = document.getElementById('gitPullBranch');
    const push = document.getElementById('gitPushBranch');
    if (cur) cur.textContent = data.branch;
    if (pull) pull.textContent = data.branch;
    if (push) push.textContent = data.branch;
    const sidebarBranch = document.getElementById('repoSidebarBranch');
    if (sidebarBranch) sidebarBranch.textContent = data.branch;
    const searchEl = document.getElementById('gitBranchSearch');
    renderGitBranches(searchEl ? searchEl.value : '');
    if (typeof loadFileTree === 'function') loadFileTree(repo);
  } catch (e) {
    toast('Checkout failed: ' + e.message, 'error');
  }
}
function filterBranchPicker() {
  const el = document.getElementById('branchPickSearch');
  renderBranchPicker(el ? el.value : '');
}

// ── Public surface ──────────────────────────────────────────────────────────
// Reached from other parts, index.html, the extracted git/pull-requests modules
// (loadFileTree / renderInlineDiff), and this file's generated onclick
// (viewFile / viewChangedFile / viewCommitDiff / selectDiffFile /
// doGitCheckoutFromModal). The ~19 helpers stay private.
window.populateFilesRepoSelect = populateFilesRepoSelect;
window.loadFileTree = loadFileTree;
window.setFilesSearchMode = setFilesSearchMode;
window.onFilesSearchInput = onFilesSearchInput;
window.viewFile = viewFile;
window.toggleFilesEdit = toggleFilesEdit;
window._defineMonacoTheme = _defineMonacoTheme;
window.loadMonaco = loadMonaco;
window.viewCommitDiff = viewCommitDiff;
window.selectDiffFile = selectDiffFile;
window.renderInlineDiff = renderInlineDiff;
window.populateDiffTabWithChanges = populateDiffTabWithChanges;
window.closeDiffView = closeDiffView;
window.discardFileFromContext = discardFileFromContext;
window.discardFile = discardFile;
window.showDiffFileContextMenu = showDiffFileContextMenu;
window.viewChangedFile = viewChangedFile;
window.cancelFilesEdit = cancelFilesEdit;
window.saveFilesEdit = saveFilesEdit;
window.loadGitLogPanel = loadGitLogPanel;
window.closeModal = closeModal;
window.openSpaceModal = openSpaceModal;
window.openRepoModal = openRepoModal;
window.filterRepoPicker = filterRepoPicker;
window.setBranchFilter = setBranchFilter;
window.filterBranchPicker = filterBranchPicker;
window.doGitCheckoutFromModal = doGitCheckoutFromModal;