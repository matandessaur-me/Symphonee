/**
 * DevOps Pilot — Node.js server
 * Serves the web UI, manages a persistent PTY terminal via WebSocket,
 * and provides Azure DevOps REST API proxy.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { exec, execSync } = require('child_process');

const PORT = 3800;
const HOST = '127.0.0.1';
const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(__dirname, 'public');
const nodeModules = path.join(repoRoot, 'node_modules');
const configPath = path.join(repoRoot, 'config', 'config.json');
const templatePath = path.join(repoRoot, 'config', 'config.template.json');

// ── Static file routes ─────────────────────────────────────────────────────
const ROUTES = {
  '/':                        { file: path.join(publicDir, 'index.html'),                                          type: 'text/html' },
  '/xterm.css':               { file: path.join(nodeModules, 'xterm/css/xterm.css'),                               type: 'text/css' },
  '/xterm.js':                { file: path.join(nodeModules, 'xterm/lib/xterm.js'),                                type: 'application/javascript' },
  '/xterm-addon-fit.js':      { file: path.join(nodeModules, 'xterm-addon-fit/lib/xterm-addon-fit.js'),            type: 'application/javascript' },
  '/xterm-addon-webgl.js':    { file: path.join(nodeModules, 'xterm-addon-webgl/lib/xterm-addon-webgl.js'),        type: 'application/javascript' },
  '/xterm-addon-web-links.js':{ file: path.join(nodeModules, 'xterm-addon-web-links/lib/xterm-addon-web-links.js'),type: 'application/javascript' },
  '/xterm-addon-unicode11.js':{ file: path.join(nodeModules, 'xterm-addon-unicode11/lib/xterm-addon-unicode11.js'),type: 'application/javascript' },
  '/icon.svg':                { file: path.join(publicDir, 'icon.svg'),                                            type: 'image/svg+xml' },
};

// ── Pluggable route handlers (Electron adds its own via addRoute) ────────────
const extraRoutes = [];
function addRoute(method, pathname, handler) {
  extraRoutes.push({ method: method.toUpperCase(), pathname, handler });
}

// ── Helper: read JSON body ────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Helper: JSON response ─────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Pluggable routes first
  for (const r of extraRoutes) {
    if (url.pathname === r.pathname && req.method === r.method) {
      return r.handler(req, res, url);
    }
  }

  try {
    // ── Config ────────────────────────────────────────────────────────────
    if (url.pathname === '/api/config' && req.method === 'GET')  return handleGetConfig(res);
    if (url.pathname === '/api/config' && req.method === 'POST') return handleSaveConfig(req, res);
    if (url.pathname === '/api/prerequisites')                   return handlePrerequisites(res);
    if (url.pathname === '/api/cli/install' && req.method === 'POST') return handleCliInstall(req, res);

    // ── Azure DevOps: Iterations ──────────────────────────────────────────
    if (url.pathname === '/api/iterations' && req.method === 'GET') return handleIterations(res, url);

    // ── Azure DevOps: Work Items ──────────────────────────────────────────
    if (url.pathname === '/api/workitems' && req.method === 'GET') return handleWorkItems(url, res);
    if (url.pathname === '/api/workitems/create' && req.method === 'POST') return handleCreateWorkItem(req, res);

    const wiMatch = url.pathname.match(/^\/api\/workitems\/(\d+)$/);
    if (wiMatch && req.method === 'GET')   return handleWorkItemDetail(wiMatch[1], res);
    if (wiMatch && req.method === 'PATCH') return handleUpdateWorkItem(wiMatch[1], req, res);

    const wiStateMatch = url.pathname.match(/^\/api\/workitems\/(\d+)\/state$/);
    if (wiStateMatch && req.method === 'PATCH') return handleWorkItemState(wiStateMatch[1], req, res);

    // ── Azure DevOps: Velocity ────────────────────────────────────────────
    if (url.pathname === '/api/velocity' && req.method === 'GET') return handleVelocity(res);

    // ── Azure DevOps: Teams & Members ─────────────────────────────────────
    if (url.pathname === '/api/teams' && req.method === 'GET') return handleTeams(res);
    if (url.pathname === '/api/team-members' && req.method === 'GET') return handleTeamMembers(res);

    // ── Azure DevOps: Burndown ────────────────────────────────────────────
    if (url.pathname === '/api/burndown' && req.method === 'GET') return handleBurndown(url, res);

    // ── Repos ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/repos' && req.method === 'GET')  return handleGetRepos(res);
    if (url.pathname === '/api/repos' && req.method === 'POST') return handleSaveRepo(req, res);

    // ── Start Working ─────────────────────────────────────────────────────
    if (url.pathname === '/api/start-working' && req.method === 'POST') return handleStartWorking(req, res);

    // ── Pull Requests ─────────────────────────────────────────────────────
    if (url.pathname === '/api/pull-request' && req.method === 'POST') return handleCreatePullRequest(req, res);

    // ── Notes ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/notes' && req.method === 'GET')    return handleListNotes(res);
    if (url.pathname === '/api/notes/read' && req.method === 'GET') return handleReadNote(url, res);
    if (url.pathname === '/api/notes/save' && req.method === 'POST') return handleSaveNote(req, res);
    if (url.pathname === '/api/notes/delete' && req.method === 'DELETE') return handleDeleteNote(req, res);
    if (url.pathname === '/api/notes/create' && req.method === 'POST') return handleCreateNote(req, res);

    // ── File Browser & Git ─────────────────────────────────────────────────
    if (url.pathname === '/api/files/tree' && req.method === 'GET')    return handleFileTree(url, res);
    if (url.pathname === '/api/files/read' && req.method === 'GET')    return handleFileRead(url, res);
    if (url.pathname === '/api/files/save' && req.method === 'POST')   return handleFileSave(req, res);
    if (url.pathname === '/api/git/status' && req.method === 'GET')    return handleGitStatus(url, res);
    if (url.pathname === '/api/git/diff' && req.method === 'GET')      return handleGitDiff(url, res);
    if (url.pathname === '/api/git/branches' && req.method === 'GET')  return handleGitBranches(url, res);
    if (url.pathname === '/api/git/log' && req.method === 'GET')       return handleGitLog(url, res);
    if (url.pathname === '/api/git/commit-diff' && req.method === 'GET') return handleCommitDiff(url, res);

    // ── Split Diff ────────────────────────────────────────────────────────
    if (url.pathname === '/api/git/split-diff' && req.method === 'GET') return handleSplitDiff(url, res);

    // ── Project Scripts (package.json) ──────────────────────────────────────
    if (url.pathname === '/api/project/scripts' && req.method === 'GET') return handleProjectScripts(url, res);

    // ── File Search ────────────────────────────────────────────────────────
    if (url.pathname === '/api/files/search' && req.method === 'GET') return handleFileSearch(url, res);
    if (url.pathname === '/api/files/grep' && req.method === 'GET')   return handleFileGrep(url, res);

    // ── Serve repo files (images, etc.) ────────────────────────────────────
    if (url.pathname === '/api/files/serve' && req.method === 'GET') return handleServeFile(url, res);

    // ── Voice-to-Text (Wispr Flow) ─────────────────────────────────────────
    if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') return handleVoiceTranscribe(req, res);

    // ── Image Proxy (ADO images need auth) ─────────────────────────────────
    if (url.pathname === '/api/image-proxy' && req.method === 'GET') return handleImageProxy(url, res);

    // ── Open External URL ─────────────────────────────────────────────────
    if (url.pathname === '/api/open-external' && req.method === 'POST') return handleOpenExternal(req, res);

    // ── UI Actions (AI → Dashboard) ───────────────────────────────────────
    if (url.pathname === '/api/ui/tab' && req.method === 'POST')              return handleUiAction(req, res, 'switch-tab');
    if (url.pathname === '/api/ui/view-workitem' && req.method === 'POST')  return handleUiAction(req, res, 'view-workitem');
    if (url.pathname === '/api/ui/view-note' && req.method === 'POST')      return handleUiAction(req, res, 'view-note');
    if (url.pathname === '/api/ui/refresh-workitems' && req.method === 'POST') return handleUiAction(req, res, 'refresh-workitems');
    if (url.pathname === '/api/ui/view-file' && req.method === 'POST')       return handleUiAction(req, res, 'view-file');
    if (url.pathname === '/api/ui/view-diff' && req.method === 'POST')       return handleUiAction(req, res, 'view-diff');

    // ── Static files ──────────────────────────────────────────────────────
    const route = ROUTES[url.pathname];
    if (route && fs.existsSync(route.file)) {
      res.writeHead(200, { 'Content-Type': route.type });
      fs.createReadStream(route.file).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// ── Config API ──────────────────────────────────────────────────────────────
function getConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  try { return JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch (_) {}
  return {};
}

function handleGetConfig(res) {
  json(res, getConfig());
}

async function handleSaveConfig(req, res) {
  const incoming = await readBody(req);
  let template = {};
  try { template = JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch (_) {}
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  const config = { ...template, ...existing, ...incoming };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  json(res, { ok: true });
}

// ── Watch config for external changes ─────────────────────────────────────
let configWatchDebounce = null;
try {
  fs.watch(path.dirname(configPath), (eventType, filename) => {
    if (filename === 'config.json') {
      if (configWatchDebounce) clearTimeout(configWatchDebounce);
      configWatchDebounce = setTimeout(() => {
        teamAreasCache = { data: null, team: null, ts: 0 };
        iterationsCache = { data: null, ts: 0 };
        workItemsCache = { data: null, key: null, ts: 0 };
        broadcast({ type: 'config-changed' });
      }, 500);
    }
  });
} catch (_) {}

// ── Prerequisites API ────────────────────────────────────────────────────
function handlePrerequisites(res) {
  const result = {
    cliTools: {},
    nodeJs: { installed: true, version: process.version },
    config: { exists: false, complete: false },
  };

  const cliChecks = [
    { id: 'claude',  cmd: 'where claude.cmd 2>nul || where claude 2>nul' },
    { id: 'gemini',  cmd: 'where gemini.cmd 2>nul || where gemini 2>nul' },
    { id: 'copilot', cmd: 'where copilot.cmd 2>nul || where copilot 2>nul' },
    { id: 'codex',   cmd: 'where codex.cmd 2>nul || where codex 2>nul' },
  ];
  for (const cli of cliChecks) {
    result.cliTools[cli.id] = { installed: false, path: '' };
    try {
      const where = execSync(cli.cmd, { encoding: 'utf8', timeout: 5000 }).trim();
      if (where) {
        result.cliTools[cli.id].installed = true;
        result.cliTools[cli.id].path = where.split('\n')[0].trim();
      }
    } catch (_) {}
  }

  result.pwsh = { installed: false, path: '' };
  try {
    const pwshPath = execSync('where pwsh.exe 2>nul', { encoding: 'utf8', timeout: 5000 }).trim();
    if (pwshPath) { result.pwsh.installed = true; result.pwsh.path = pwshPath.split('\n')[0].trim(); }
  } catch (_) {}

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    result.config.exists = true;
    result.config.complete = !!(cfg.AzureDevOpsOrg && cfg.AzureDevOpsProject && cfg.AzureDevOpsPAT);
  } catch (_) {}

  const anyCliInstalled = Object.values(result.cliTools).some(c => c.installed);
  result.ready = anyCliInstalled && result.config.complete;

  json(res, result);
}

// ── CLI Install Handler ──────────────────────────────────────────────────────
const CLI_INSTALL_COMMANDS = {
  claude:  'npm install -g @anthropic-ai/claude-code',
  gemini:  'npm install -g @google/gemini-cli',
  copilot: 'npm install -g @githubnext/github-copilot-cli',
  codex:   'npm install -g @openai/codex',
};

function handleCliInstall(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { cli } = JSON.parse(body);
      const installCmd = CLI_INSTALL_COMMANDS[cli];
      if (!installCmd) return json(res, { error: `Unknown CLI: ${cli}` }, 400);

      // Run install asynchronously
      const { exec } = require('child_process');
      exec(installCmd, { timeout: 120000, encoding: 'utf8' }, (err, stdout, stderr) => {
        // After install, re-check if it's actually available
        const checkCmd = `where ${cli}.cmd 2>nul || where ${cli} 2>nul`;
        let installed = false;
        let installPath = '';
        try {
          const where = execSync(checkCmd, { encoding: 'utf8', timeout: 5000 }).trim();
          if (where) { installed = true; installPath = where.split('\n')[0].trim(); }
        } catch (_) {}

        if (installed) {
          json(res, { ok: true, cli, installed: true, path: installPath });
        } else {
          json(res, { ok: false, cli, installed: false, error: err ? err.message : 'Install completed but CLI not found in PATH' });
        }
      });
    } catch (e) {
      json(res, { error: 'Invalid request' }, 400);
    }
  });
}

// ── Azure DevOps API Helper ─────────────────────────────────────────────────
function adoRequest(method, apiPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const project = cfg.AzureDevOpsProject;
    const pat = cfg.AzureDevOpsPAT;
    const team = cfg.DefaultTeam;
    if (!org || !project || !pat) {
      return reject(new Error('Azure DevOps not configured. Set Org, Project, and PAT in Settings.'));
    }

    // Only /work/ endpoints are team-scoped in ADO. /wit/ endpoints are project-scoped.
    const teamSegment = team && apiPath.startsWith('/work/') ? `/${encodeURIComponent(team)}` : '';
    const url = new URL(`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}${teamSegment}/_apis${apiPath}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(':' + pat).toString('base64'),
        'Content-Type': contentType || 'application/json',
        'Accept': 'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
        } else {
          const msg = resp.statusCode === 401
            ? 'Authentication failed — PAT may be expired or invalid'
            : `Azure DevOps API error (${resp.statusCode}): ${data.slice(0, 200)}`;
          reject(new Error(msg));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ADO request to org-level APIs (no project in path)
function adoOrgRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const pat = cfg.AzureDevOpsPAT;
    if (!org || !pat) return reject(new Error('Azure DevOps not configured.'));

    const url = new URL(`https://dev.azure.com/${encodeURIComponent(org)}/_apis${apiPath}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(':' + pat).toString('base64'),
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
        } else {
          reject(new Error(`ADO org API error (${resp.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Caches ──────────────────────────────────────────────────────────────────
let iterationsCache = { data: null, ts: 0 };
let workItemsCache = { data: null, key: null, ts: 0 };
let teamAreasCache = { data: null, team: null, ts: 0 };
const ITER_CACHE_TTL = 300000;
const WI_CACHE_TTL = 30000;
const TEAM_AREAS_TTL = 600000; // 10 min

// ── Get team area paths (for scoping work items to a team) ──────────────────
async function getTeamAreaPaths() {
  const cfg = getConfig();
  const team = cfg.DefaultTeam;
  if (!team) return null; // no team configured, don't filter

  if (teamAreasCache.data && teamAreasCache.team === team && Date.now() - teamAreasCache.ts < TEAM_AREAS_TTL) {
    return teamAreasCache.data;
  }

  try {
    const data = await adoRequest('GET',
      `/work/teamsettings/teamfieldvalues?api-version=7.1`
    );
    // The team field values contain the area paths assigned to this team
    const areas = (data.values || []).map(v => v.value).filter(Boolean);
    teamAreasCache = { data: areas, team, ts: Date.now() };
    return areas;
  } catch (_) {
    return null;
  }
}

// ── Iterations ──────────────────────────────────────────────────────────────
async function handleIterations(res, url) {
  try {
    const forceRefresh = url && url.searchParams.get('refresh') === '1';
    if (!forceRefresh && iterationsCache.data && Date.now() - iterationsCache.ts < ITER_CACHE_TTL) {
      return json(res, iterationsCache.data);
    }

    const data = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
    const now = new Date();
    const iterations = (data.value || []).map(it => {
      const startDate = it.attributes?.startDate ? new Date(it.attributes.startDate) : null;
      const finishDate = it.attributes?.finishDate ? new Date(it.attributes.finishDate) : null;
      const isCurrent = startDate && finishDate && now >= startDate && now <= finishDate;
      return {
        id: it.id,
        name: it.name,
        path: it.path,
        startDate: it.attributes?.startDate || null,
        finishDate: it.attributes?.finishDate || null,
        timeFrame: it.attributes?.timeFrame || null,
        isCurrent,
      };
    });

    iterations.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      const da = a.startDate ? new Date(a.startDate) : new Date(0);
      const db = b.startDate ? new Date(b.startDate) : new Date(0);
      return db - da;
    });

    iterationsCache = { data: iterations, ts: Date.now() };
    json(res, iterations);
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
  }
}

// ── Work Items List ─────────────────────────────────────────────────────────
async function handleWorkItems(url, res) {
  const refresh = url.searchParams.get('refresh') === '1';
  const iterationPath = url.searchParams.get('iteration') || '';
  const state = url.searchParams.get('state') || '';
  const type = url.searchParams.get('type') || '';
  const assignedTo = url.searchParams.get('assignedTo') || '';
  const cacheKey = `${iterationPath}|${state}|${type}|${assignedTo}`;

  try {
    if (!refresh && workItemsCache.data && workItemsCache.key === cacheKey && Date.now() - workItemsCache.ts < WI_CACHE_TTL) {
      return json(res, workItemsCache.data);
    }

    // Get team area paths to scope work items
    const teamAreas = await getTeamAreaPaths();

    let wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] NOT IN ('Removed')`;
    // Without an iteration filter, exclude Closed to avoid 20k+ results
    if (!iterationPath && !state) wiqlQuery += ` AND [System.State] NOT IN ('Closed', 'Done')`;
    // Scope to team's area paths
    if (teamAreas && teamAreas.length > 0) {
      const areaConditions = teamAreas.map(a => `[System.AreaPath] UNDER '${a}'`).join(' OR ');
      wiqlQuery += ` AND (${areaConditions})`;
    }
    if (iterationPath) wiqlQuery += ` AND [System.IterationPath] = '${iterationPath}'`;
    if (state)         wiqlQuery += ` AND [System.State] = '${state}'`;
    if (type)          wiqlQuery += ` AND [System.WorkItemType] = '${type}'`;
    if (assignedTo)    wiqlQuery += ` AND [System.AssignedTo] = '${assignedTo}'`;
    wiqlQuery += ` ORDER BY [System.ChangedDate] DESC`;

    const wiql = await adoRequest('POST', '/wit/wiql?$top=200&api-version=7.1', { query: wiqlQuery });
    const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);

    if (ids.length === 0) {
      workItemsCache = { data: [], key: cacheKey, ts: Date.now() };
      return json(res, []);
    }

    const details = await adoRequest('GET',
      `/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.Tags,System.CreatedDate,System.ChangedDate,Microsoft.VSTS.Common.Priority,System.IterationPath,Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort,System.Parent&api-version=7.1`
    );

    const result = (details.value || []).map(wi => {
      const f = wi.fields;
      return {
        id: wi.id,
        title: f['System.Title'],
        state: f['System.State'],
        type: f['System.WorkItemType'],
        assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : '',
        tags: f['System.Tags'] || '',
        changedDate: f['System.ChangedDate'],
        priority: f['Microsoft.VSTS.Common.Priority'] || 0,
        iterationPath: f['System.IterationPath'] || '',
        storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] || f['Microsoft.VSTS.Scheduling.Effort'] || '',
        createdDate: f['System.CreatedDate'] || '',
        parentId: f['System.Parent'] || null,
      };
    });

    workItemsCache = { data: result, key: cacheKey, ts: Date.now() };
    json(res, result);
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
  }
}

// ── Work Item Detail ────────────────────────────────────────────────────────
async function handleWorkItemDetail(id, res) {
  try {
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const project = cfg.AzureDevOpsProject;

    const [wi, commentsData] = await Promise.all([
      adoRequest('GET', `/wit/workitems/${id}?$expand=all&api-version=7.1`),
      adoRequest('GET', `/wit/workitems/${id}/comments?api-version=7.1-preview.4`).catch(() => ({ comments: [] })),
    ]);

    const f = wi.fields;

    const attachments = [];
    const linkedItems = [];
    (wi.relations || []).forEach(rel => {
      if (rel.rel === 'AttachedFile') {
        attachments.push({
          name: rel.attributes?.name || 'attachment',
          url: rel.url,
          comment: rel.attributes?.comment || '',
        });
      } else {
        const idMatch = rel.url?.match(/workItems\/(\d+)/i);
        linkedItems.push({
          rel: rel.rel,
          title: rel.attributes?.name || '',
          comment: rel.attributes?.comment || '',
          id: idMatch ? parseInt(idMatch[1]) : null,
          url: rel.url,
        });
      }
    });

    const comments = (commentsData.comments || []).map(c => ({
      id: c.id,
      text: proxyHtmlImages(c.text || ''),
      author: c.createdBy ? c.createdBy.displayName : '',
      date: c.createdDate || '',
    }));

    json(res, {
      id: wi.id,
      title: f['System.Title'],
      state: f['System.State'],
      type: f['System.WorkItemType'],
      assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : '',
      createdBy: f['System.CreatedBy'] ? f['System.CreatedBy'].displayName : '',
      tags: f['System.Tags'] || '',
      createdDate: f['System.CreatedDate'] || '',
      changedDate: f['System.ChangedDate'],
      priority: f['Microsoft.VSTS.Common.Priority'] || 0,
      severity: f['Microsoft.VSTS.Common.Severity'] || '',
      storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] || '',
      effort: f['Microsoft.VSTS.Scheduling.Effort'] || '',
      reason: f['System.Reason'] || '',
      description: proxyHtmlImages(f['System.Description'] || ''),
      acceptanceCriteria: proxyHtmlImages(f['Microsoft.VSTS.Common.AcceptanceCriteria'] || ''),
      reproSteps: proxyHtmlImages(f['Microsoft.VSTS.TCM.ReproSteps'] || ''),
      areaPath: f['System.AreaPath'] || '',
      iterationPath: f['System.IterationPath'] || '',
      attachments,
      linkedItems,
      comments,
      webUrl: org && project ? `https://dev.azure.com/${org}/${project}/_workitems/edit/${wi.id}` : '',
    });
  } catch (e) {
    json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
  }
}

// ── Update Work Item ────────────────────────────────────────────────────────
async function handleUpdateWorkItem(id, req, res) {
  try {
    const body = await readBody(req);
    const patchDoc = [];

    const fieldMap = {
      title: '/fields/System.Title',
      description: '/fields/System.Description',
      state: '/fields/System.State',
      assignedTo: '/fields/System.AssignedTo',
      priority: '/fields/Microsoft.VSTS.Common.Priority',
      tags: '/fields/System.Tags',
      iterationPath: '/fields/System.IterationPath',
      areaPath: '/fields/System.AreaPath',
      storyPoints: '/fields/Microsoft.VSTS.Scheduling.StoryPoints',
      acceptanceCriteria: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
    };

    for (const [key, path] of Object.entries(fieldMap)) {
      if (body[key] !== undefined) {
        patchDoc.push({ op: 'replace', path, value: body[key] });
      }
    }

    if (patchDoc.length === 0) return json(res, { error: 'No fields to update' }, 400);

    const result = await adoRequest('PATCH', `/wit/workitems/${id}?api-version=7.1`, patchDoc, 'application/json-patch+json');
    workItemsCache = { data: null, ts: 0 };
    broadcast({ type: 'ui-action', action: 'refresh-workitems' });
    json(res, { ok: true, id: result.id });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Change Work Item State ──────────────────────────────────────────────────
async function handleWorkItemState(id, req, res) {
  try {
    const { state } = await readBody(req);
    if (!state) return json(res, { error: 'state is required' }, 400);

    const result = await adoRequest('PATCH',
      `/wit/workitems/${id}?api-version=7.1`,
      [{ op: 'replace', path: '/fields/System.State', value: state }],
      'application/json-patch+json'
    );
    workItemsCache = { data: null, ts: 0 };
    broadcast({ type: 'ui-action', action: 'refresh-workitems' });
    json(res, { ok: true, id: result.id, state: result.fields['System.State'] });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Create Work Item ────────────────────────────────────────────────────────
async function handleCreateWorkItem(req, res) {
  try {
    const { type, title, description, priority, tags, assignedTo, iterationPath, storyPoints, acceptanceCriteria } = await readBody(req);
    if (!type || !title) return json(res, { error: 'type and title are required' }, 400);

    const patchDoc = [
      { op: 'add', path: '/fields/System.Title', value: title },
    ];
    if (description)       patchDoc.push({ op: 'add', path: '/fields/System.Description', value: description });
    if (priority)          patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: parseInt(priority, 10) || 2 });
    if (tags)              patchDoc.push({ op: 'add', path: '/fields/System.Tags', value: tags });
    if (assignedTo)        patchDoc.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignedTo });
    if (iterationPath)     patchDoc.push({ op: 'add', path: '/fields/System.IterationPath', value: iterationPath });
    if (storyPoints)       patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: parseFloat(storyPoints) });
    if (acceptanceCriteria) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acceptanceCriteria });

    const wiType = encodeURIComponent(type);
    const result = await adoRequest('POST', `/wit/workitems/$${wiType}?api-version=7.1`, patchDoc, 'application/json-patch+json');
    workItemsCache = { data: null, ts: 0 };
    broadcast({ type: 'ui-action', action: 'refresh-workitems' });

    const cfg = getConfig();
    json(res, {
      ok: true,
      id: result.id,
      title: result.fields['System.Title'],
      url: cfg.AzureDevOpsOrg && cfg.AzureDevOpsProject
        ? `https://dev.azure.com/${cfg.AzureDevOpsOrg}/${cfg.AzureDevOpsProject}/_workitems/edit/${result.id}`
        : null,
    });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Velocity (story points per completed sprint) ────────────────────────────
async function handleVelocity(res) {
  try {
    // Get all iterations
    const iterData = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
    const now = new Date();
    // Only past (finished) sprints — last 10
    const pastIterations = (iterData.value || [])
      .filter(it => {
        const finish = it.attributes?.finishDate ? new Date(it.attributes.finishDate) : null;
        return finish && finish < now;
      })
      .sort((a, b) => new Date(a.attributes.startDate) - new Date(b.attributes.startDate))
      .slice(-10);

    const velocity = [];
    for (const it of pastIterations) {
      // Get completed items in this iteration
      const wiql = await adoRequest('POST', '/wit/wiql?api-version=7.1', {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${it.path}' AND [System.State] IN ('Closed', 'Resolved', 'Done') ORDER BY [System.Id]`,
      });
      const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);
      let totalPoints = 0;
      let completedCount = 0;

      if (ids.length > 0) {
        const details = await adoRequest('GET',
          `/wit/workitems?ids=${ids.join(',')}&fields=Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort&api-version=7.1`
        );
        for (const wi of (details.value || [])) {
          const pts = wi.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || wi.fields['Microsoft.VSTS.Scheduling.Effort'] || 0;
          totalPoints += pts;
          completedCount++;
        }
      }

      velocity.push({
        iteration: it.name,
        path: it.path,
        startDate: it.attributes?.startDate,
        finishDate: it.attributes?.finishDate,
        completedPoints: totalPoints,
        completedCount,
      });
    }

    const avg = velocity.length > 0
      ? velocity.reduce((sum, v) => sum + v.completedPoints, 0) / velocity.length
      : 0;

    json(res, { velocity, averageVelocity: Math.round(avg * 10) / 10 });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Burndown ────────────────────────────────────────────────────────────────
async function handleBurndown(url, res) {
  const iterationPath = url.searchParams.get('iteration') || '';
  if (!iterationPath) return json(res, { error: 'iteration parameter required' }, 400);

  try {
    // Get iteration dates
    const iterData = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
    const iteration = (iterData.value || []).find(it => it.path === iterationPath);
    if (!iteration) return json(res, { error: 'Iteration not found' }, 404);

    const startDate = new Date(iteration.attributes?.startDate);
    const finishDate = new Date(iteration.attributes?.finishDate);

    // Get all items in this iteration with points
    const wiql = await adoRequest('POST', '/wit/wiql?api-version=7.1', {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${iterationPath}' AND [System.State] NOT IN ('Removed') ORDER BY [System.Id]`,
    });
    const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);

    let totalPoints = 0;
    let completedPoints = 0;
    let items = [];

    if (ids.length > 0) {
      const details = await adoRequest('GET',
        `/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort,System.ChangedDate&api-version=7.1`
      );
      items = (details.value || []).map(wi => {
        const pts = wi.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || wi.fields['Microsoft.VSTS.Scheduling.Effort'] || 0;
        const state = wi.fields['System.State'];
        const isDone = ['Closed', 'Resolved', 'Done'].includes(state);
        totalPoints += pts;
        if (isDone) completedPoints += pts;
        return { id: wi.id, title: wi.fields['System.Title'], state, points: pts, isDone, changedDate: wi.fields['System.ChangedDate'] };
      });
    }

    json(res, {
      iteration: iteration.name,
      startDate: iteration.attributes?.startDate,
      finishDate: iteration.attributes?.finishDate,
      totalPoints,
      completedPoints,
      remainingPoints: totalPoints - completedPoints,
      totalItems: items.length,
      completedItems: items.filter(i => i.isDone).length,
      items,
    });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Team Members ────────────────────────────────────────────────────────────
// List all teams in the project
async function handleTeams(res) {
  try {
    const cfg = getConfig();
    const project = cfg.AzureDevOpsProject;
    const data = await adoOrgRequest('GET',
      `/projects/${encodeURIComponent(project)}/teams?api-version=7.1`
    );
    const teams = (data.value || []).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description || '',
    }));
    json(res, teams);
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// List members — collect from ALL teams to get full picture
async function handleTeamMembers(res) {
  try {
    const cfg = getConfig();
    const project = cfg.AzureDevOpsProject;

    // Get all teams first
    const teamsData = await adoOrgRequest('GET',
      `/projects/${encodeURIComponent(project)}/teams?api-version=7.1`
    );

    // Fetch members from all teams in parallel
    const memberMap = new Map();
    const fetches = (teamsData.value || []).map(t =>
      adoOrgRequest('GET',
        `/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(t.name)}/members?api-version=7.1`
      ).catch(() => ({ value: [] }))
    );
    const results = await Promise.all(fetches);

    for (const data of results) {
      for (const m of (data.value || [])) {
        const id = m.identity?.id;
        if (id && !memberMap.has(id)) {
          memberMap.set(id, {
            id,
            displayName: m.identity?.displayName || '',
            uniqueName: m.identity?.uniqueName || '',
            imageUrl: m.identity?.imageUrl || '',
          });
        }
      }
    }

    const members = [...memberMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    json(res, members);
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Repos Management ────────────────────────────────────────────────────────
function handleGetRepos(res) {
  const cfg = getConfig();
  json(res, cfg.Repos || {});
}

async function handleSaveRepo(req, res) {
  const { name, path: repoPath } = await readBody(req);
  if (!name || !repoPath) return json(res, { error: 'name and path are required' }, 400);
  const cfg = getConfig();
  cfg.Repos = cfg.Repos || {};
  cfg.Repos[name] = repoPath;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  broadcast({ type: 'config-changed' });
  json(res, { ok: true });
}

// ── Start Working on a Work Item ────────────────────────────────────────────
async function handleStartWorking(req, res) {
  try {
    const { workItemId, repoName } = await readBody(req);
    const cfg = getConfig();
    const repoPath = cfg.Repos?.[repoName];
    if (!repoPath) return json(res, { error: `Repo "${repoName}" not found in config` }, 400);
    if (!fs.existsSync(repoPath)) return json(res, { error: `Path does not exist: ${repoPath}` }, 400);

    // Fetch work item for branch name
    const wi = await adoRequest('GET', `/wit/workitems/${workItemId}?fields=System.Title,System.WorkItemType,System.Description&api-version=7.1`);
    const title = wi.fields['System.Title'] || 'work';
    const description = (wi.fields['System.Description'] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const wiType = wi.fields['System.WorkItemType'] || 'feature';
    const prefix = wiType.toLowerCase() === 'bug' ? 'bugfix' : 'feature';

    // Use AI to generate a concise branch slug from the work item context
    let slug;
    try {
      const prompt = `Generate a short git branch slug (2-5 words, lowercase, hyphen-separated, no special chars) that clearly describes this work item. Reply with ONLY the slug, nothing else.\n\nTitle: ${title}\nType: ${wiType}${description ? `\nDescription: ${description}` : ''}`;
      slug = execSync(`claude --print "${prompt.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      }).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    } catch (_) {
      // Fallback to simple slugification if AI is unavailable
      slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    }
    if (!slug) slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const branchName = `${prefix}/AB#${workItemId}-${slug}`;

    // Move work item to Active
    try {
      await adoRequest('PATCH',
        `/wit/workitems/${workItemId}?api-version=7.1`,
        [{ op: 'replace', path: '/fields/System.State', value: 'Active' }],
        'application/json-patch+json'
      );
      workItemsCache = { data: null, ts: 0 };
    } catch (_) { /* may already be active */ }

    // Proper branch creation: checkout main, fetch, then create branch
    const commands = [
      `cd "${repoPath.replace(/\\/g, '/')}"`,
      `git checkout main 2>/dev/null || git checkout master`,
      `git fetch origin`,
      `git pull`,
      `git checkout -b ${branchName}`,
    ];

    const mainTerm = terminals.get('main');
    for (const cmd of commands) {
      if (mainTerm) mainTerm.pty.write(cmd + '\r');
    }

    json(res, { ok: true, branchName, repoPath });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Pull Request Creation ────────────────────────────────────────────────────
async function handleCreatePullRequest(req, res) {
  try {
    const { repoName, title, description, sourceBranch, targetBranch, workItemId } = await readBody(req);
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const project = cfg.AzureDevOpsProject;

    if (!repoName) return json(res, { error: 'repoName is required' }, 400);
    if (!title) return json(res, { error: 'title is required' }, 400);

    // Look up the ADO repo ID by name
    const repos = await adoRequest('GET', `/git/repositories?api-version=7.1`);
    const adoRepo = (repos.value || []).find(r => r.name.toLowerCase() === repoName.toLowerCase());
    if (!adoRepo) return json(res, { error: `Repository "${repoName}" not found in Azure DevOps project` }, 404);

    // Determine source branch — use provided or detect from local git
    let source = sourceBranch;
    if (!source) {
      const repoPath = cfg.Repos?.[repoName];
      if (repoPath) source = gitExec(repoPath, 'rev-parse --abbrev-ref HEAD');
    }
    if (!source) return json(res, { error: 'Could not determine source branch' }, 400);

    const target = targetBranch || 'main';

    const prBody = {
      sourceRefName: `refs/heads/${source}`,
      targetRefName: `refs/heads/${target}`,
      title,
      description: description || '',
    };

    // Link work item if provided
    if (workItemId) {
      prBody.workItemRefs = [{ id: String(workItemId) }];
    }

    const pr = await adoRequest('POST', `/git/repositories/${adoRepo.id}/pullrequests?api-version=7.1`, prBody);

    const prUrl = `https://dev.azure.com/${org}/${project}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`;
    json(res, { ok: true, pullRequestId: pr.pullRequestId, url: prUrl, title: pr.title });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── UI Actions (AI → Dashboard) ─────────────────────────────────────────────
// ── File Browser ────────────────────────────────────────────────────────────
function getRepoPath(repoName) {
  const cfg = getConfig();
  const repos = cfg.Repos || {};
  return repos[repoName] || null;
}

function handleFileTree(url, res) {
  const repoName = url.searchParams.get('repo');
  const subPath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const fullPath = path.join(repoPath, subPath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__' && e.name !== 'dist' && e.name !== 'build' && e.name !== '.git')
      .map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        path: subPath ? `${subPath}/${e.name}` : e.name,
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    json(res, { entries, currentPath: subPath, repoName });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── File name search (recursive, returns matching paths) ──────────────────
function handleFileSearch(url, res) {
  const repoName = url.searchParams.get('repo');
  const query = (url.searchParams.get('q') || '').toLowerCase();
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!query) return json(res, { results: [] });

  const SKIP = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', 'bin', 'obj']);
  const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock']);
  const results = [];
  const MAX = 80;

  function walk(dir, rel) {
    if (results.length >= MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (results.length >= MAX) return;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), childRel);
      } else {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (e.name.toLowerCase().includes(query)) {
          results.push({ path: childRel, name: e.name, isDir: false });
        }
      }
    }
  }
  walk(repoPath, '');
  json(res, { results });
}

// ── Content grep (search inside files, returns matches with line numbers) ──
function handleFileGrep(url, res) {
  const repoName = url.searchParams.get('repo');
  const query = url.searchParams.get('q') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!query || query.length < 2) return json(res, { results: [] });

  const SKIP = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', 'bin', 'obj']);
  const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock','map']);
  const results = [];
  const MAX_FILES = 50;
  const MAX_MATCHES = 150;
  let fileCount = 0;
  const queryLower = query.toLowerCase();

  function walk(dir, rel) {
    if (results.length >= MAX_MATCHES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (results.length >= MAX_MATCHES) return;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), childRel);
      } else {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (fileCount >= MAX_FILES && results.length > 0) return;
        try {
          const fullPath = path.join(dir, e.name);
          const stat = fs.statSync(fullPath);
          if (stat.size > 512 * 1024) continue; // skip files > 512KB
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          fileCount++;
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_MATCHES) break;
            if (lines[i].toLowerCase().includes(queryLower)) {
              results.push({ path: childRel, name: e.name, line: i + 1, text: lines[i].substring(0, 200) });
            }
          }
        } catch (_) {}
      }
    }
  }
  walk(repoPath, '');
  json(res, { results });
}

function handleFileRead(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const fullPath = path.join(repoPath, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

  try {
    const st = fs.statSync(resolved);
    const ext = path.extname(resolved).slice(1).toLowerCase();

    // Check for binary files
    const binaryExts = ['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf'];
    if (binaryExts.includes(ext)) {
      return json(res, { content: `[Binary file: ${path.basename(resolved)} - ${st.size} bytes]`, name: path.basename(resolved), path: filePath, size: st.size, lines: 1, ext, isBinary: true });
    }

    const content = fs.readFileSync(resolved, 'utf8');
    json(res, {
      content,
      name: path.basename(resolved),
      path: filePath,
      size: st.size,
      lines: content.split('\n').length,
      ext,
    });
  } catch (e) {
    json(res, { error: e.message }, 404);
  }
}

async function handleFileSave(req, res) {
  const { repo, path: filePath, content } = await readBody(req);
  const repoPath = getRepoPath(repo);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const fullPath = path.join(repoPath, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

  try {
    fs.writeFileSync(resolved, content, 'utf8');
    broadcast({ type: 'ui-action', action: 'file-changed', repo, path: filePath });
    json(res, { ok: true });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Git Integration ─────────────────────────────────────────────────────────
function gitExec(repoPath, cmd) {
  try {
    return execSync(`git -C "${repoPath}" ${cmd}`, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) {
    return e.stdout || e.stderr || e.message;
  }
}

function handleGitStatus(url, res) {
  const repoName = url.searchParams.get('repo');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const branch = gitExec(repoPath, 'rev-parse --abbrev-ref HEAD');
  const status = gitExec(repoPath, 'status --porcelain');
  const statusMap = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', '?': 'new', 'U': 'conflict' };
  const statusLabel = { 'modified': 'M', 'added': 'A', 'deleted': 'D', 'renamed': 'R', 'new': 'N', 'conflict': 'U' };
  const files = status ? status.split('\n').filter(Boolean).map(line => {
    // Git porcelain: XY filename — X=index status, Y=worktree status
    const x = line.charAt(0);
    const y = line.charAt(1);
    let file;
    if (line.charAt(2) === ' ') {
      file = line.substring(3); // standard: XY<space>filename
    } else {
      file = line.substring(2); // no separator: XYfilename
    }
    // Handle renamed files: "R  old-name -> new-name"
    if (file.includes(' -> ')) {
      file = file.split(' -> ').pop();
    }
    // Strip any trailing \r from Windows line endings
    file = file.replace(/\r$/, '').trim();
    const raw = (x + y).trim() || '?';
    const statusChar = raw.charAt(0);
    const cls = statusMap[statusChar] || 'modified';
    return { status: statusLabel[cls], statusClass: cls, file };
  }).filter(f => f.file) : [];

  json(res, { branch, files, clean: files.length === 0 });
}

function handleGitDiff(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path') || '';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  let diff = '';
  if (filePath) {
    // Try staged + unstaged diff against HEAD
    diff = gitExec(repoPath, `diff HEAD -- "${filePath}"`);
    // Try unstaged only
    if (!diff) diff = gitExec(repoPath, `diff -- "${filePath}"`);
    // Try staged only
    if (!diff) diff = gitExec(repoPath, `diff --cached -- "${filePath}"`);
    // For untracked/new files, show entire content as additions
    if (!diff) {
      const fullPath = path.join(repoPath, filePath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          diff = `diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map(l => `+${l}`).join('\n');
        } catch (_) {}
      }
    }
  } else {
    diff = gitExec(repoPath, 'diff HEAD');
    if (!diff) diff = gitExec(repoPath, 'diff');
  }

  json(res, { diff: diff || 'No changes', filePath });
}

function handleGitBranches(url, res) {
  const repoName = url.searchParams.get('repo');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const current = gitExec(repoPath, 'rev-parse --abbrev-ref HEAD');
  const output = gitExec(repoPath, 'branch --format="%(refname:short)"');
  const branches = output ? output.split('\n').filter(Boolean) : [];

  json(res, { current, branches });
}

function handleGitLog(url, res) {
  const repoName = url.searchParams.get('repo');
  const count = url.searchParams.get('count') || '20';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const output = gitExec(repoPath, `log -${count} --pretty=format:"%h|%s|%an|%ar"`);
  const commits = output ? output.split('\n').filter(Boolean).map(line => {
    const [hash, subject, author, date] = line.replace(/^"|"$/g, '').split('|');
    return { hash, subject, author, date };
  }) : [];

  json(res, { commits });
}

function handleCommitDiff(url, res) {
  const repoName = url.searchParams.get('repo');
  const hash = url.searchParams.get('hash');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
  if (!hash) return json(res, { error: 'hash required' }, 400);

  const diff = gitExec(repoPath, `diff ${hash}~1 ${hash}`);
  const stat = gitExec(repoPath, `diff --stat ${hash}~1 ${hash}`);
  const msg = gitExec(repoPath, `log -1 --pretty=format:"%s" ${hash}`);

  json(res, { diff: diff || 'No changes', stat, message: msg, hash });
}

// ── Split Diff ──────────────────────────────────────────────────────────────
function handleSplitDiff(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path') || '';
  const base = url.searchParams.get('base') || 'HEAD';
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  try {
    // Get the original version from git
    let original = '';
    try {
      original = execSync(`git -C "${repoPath}" show ${base}:"${filePath}"`, { encoding: 'utf8', timeout: 10000 });
    } catch (_) { original = ''; }

    // Get the current version from disk
    const fullPath = path.join(repoPath, filePath);
    let modified = '';
    try { modified = fs.readFileSync(fullPath, 'utf8'); } catch (_) {}

    // Normalize line endings to LF so diff doesn't flag every line
    original = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    modified = modified.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    json(res, { original, modified, filePath, base });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Project Scripts ──────────────────────────────────────────────────────────
function handleProjectScripts(url, res) {
  const repoName = url.searchParams.get('repo');
  const repoPath = getRepoPath(repoName);
  if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

  const pkgPath = path.join(repoPath, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) return json(res, { scripts: {}, type: 'none' });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasNodeModules = fs.existsSync(path.join(repoPath, 'node_modules'));

    // Detect project type
    let type = 'node';
    if (deps['next']) type = 'nextjs';
    else if (deps['react-scripts']) type = 'cra';
    else if (deps['vite']) type = 'vite';
    else if (deps['gatsby']) type = 'gatsby';
    else if (deps['nuxt']) type = 'nuxt';

    json(res, { scripts, type, name: pkg.name || '', hasNodeModules });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── Serve repo file (for images/media) ──────────────────────────────────────
function handleServeFile(url, res) {
  const repoName = url.searchParams.get('repo');
  const filePath = url.searchParams.get('path');
  const repoPath = getRepoPath(repoName);
  if (!repoPath || !filePath) { res.writeHead(400); return res.end('Missing params'); }

  const fullPath = path.join(repoPath, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(repoPath))) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(resolved)) { res.writeHead(404); return res.end('Not found'); }

  const ext = path.extname(resolved).slice(1).toLowerCase();
  const mimeTypes = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'max-age=60' });
  fs.createReadStream(resolved).pipe(res);
}

// ── Voice-to-Text (Wispr Flow) ──────────────────────────────────────────────
async function handleVoiceTranscribe(req, res) {
  try {
    const { audio } = await readBody(req);
    if (!audio) return json(res, { error: 'audio (base64 WAV) required' }, 400);

    const cfg = getConfig();
    const apiKey = cfg.WisprFlowKey || '';
    if (!apiKey) return json(res, { error: 'Wispr Flow API key not configured. Add it in Settings.' }, 400);

    const payload = JSON.stringify({
      audio,
      language: ['en', 'fr'],
      context: {
        app: { name: 'DevOps Pilot', type: 'ai' },
      },
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'platform-api.wisprflow.ai',
        path: '/api/v1/dash/api',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const apiReq = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => { data += chunk; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (_) { resolve({ text: data }); }
          } else {
            reject(new Error(`Wispr API error (${resp.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      });
      apiReq.on('error', reject);
      apiReq.write(payload);
      apiReq.end();
    });

    json(res, { text: result.text || '', language: result.detected_language || '' });
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
}

// ── Open External URL ───────────────────────────────────────────────────────
async function handleOpenExternal(req, res) {
  const { url: extUrl } = await readBody(req);
  if (!extUrl) return json(res, { error: 'url required' }, 400);
  try { new URL(extUrl); } catch (_) { return json(res, { error: 'Invalid URL' }, 400); }
  // Use rundll32 which reliably opens URLs in the default browser on Windows
  exec(`rundll32 url.dll,FileProtocolHandler "${extUrl}"`);
  json(res, { ok: true });
}

// ── Image Proxy ─────────────────────────────────────────────────────────────
function handleImageProxy(url, res) {
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) { res.writeHead(400); return res.end('Missing url param'); }

  const cfg = getConfig();
  const pat = cfg.AzureDevOpsPAT;
  const parsedUrl = new URL(imageUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: { 'Accept': '*/*' },
  };
  if (pat && parsedUrl.hostname.includes('dev.azure.com')) {
    options.headers['Authorization'] = 'Basic ' + Buffer.from(':' + pat).toString('base64');
  }

  const proto = parsedUrl.protocol === 'https:' ? https : http;
  const proxyReq = proto.request(options, (proxyRes) => {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      // Follow redirect
      const redirectUrl = new URL(proxyRes.headers.location, imageUrl);
      const newUrl = new URL(`http://${HOST}:${PORT}/api/image-proxy`);
      newUrl.searchParams.set('url', redirectUrl.href);
      return handleImageProxy(newUrl, res);
    }
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'image/png',
      'Cache-Control': 'max-age=3600',
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  proxyReq.end();
}

async function handleUiAction(req, res, action) {
  const data = await readBody(req);
  broadcast({ type: 'ui-action', action, ...data });
  json(res, { ok: true, action });
}

// ── Utilities ───────────────────────────────────────────────────────────────
// ── Notes Management ────────────────────────────────────────────────────────
const notesDir = path.join(repoRoot, 'notes');

function handleListNotes(res) {
  try {
    fs.mkdirSync(notesDir, { recursive: true });
    const files = fs.readdirSync(notesDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const st = fs.statSync(path.join(notesDir, f));
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
  const filePath = path.join(notesDir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(notesDir))) return json(res, { error: 'Invalid path' }, 403);
  try {
    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    json(res, { name, content });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function handleSaveNote(req, res) {
  const { name, content } = await readBody(req);
  if (!name) return json(res, { error: 'name required' }, 400);
  const filePath = path.join(notesDir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(notesDir))) return json(res, { error: 'Invalid path' }, 403);
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(resolved, content || '', 'utf8');
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true });
}

async function handleCreateNote(req, res) {
  const { name } = await readBody(req);
  if (!name) return json(res, { error: 'name required' }, 400);
  const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  if (!safeName) return json(res, { error: 'Invalid name' }, 400);
  const filePath = path.join(notesDir, safeName + '.md');
  if (fs.existsSync(filePath)) return json(res, { error: 'Note already exists' }, 409);
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(filePath, `# ${safeName}\n\n`, 'utf8');
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true, name: safeName });
}

async function handleDeleteNote(req, res) {
  const { name } = await readBody(req);
  if (!name) return json(res, { error: 'name required' }, 400);
  const filePath = path.join(notesDir, name + '.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(notesDir))) return json(res, { error: 'Invalid path' }, 403);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  broadcast({ type: 'ui-action', action: 'refresh-notes' });
  json(res, { ok: true });
}

// Rewrite ADO-hosted image src URLs to go through our proxy
function proxyHtmlImages(html) {
  if (!html) return html;
  return html.replace(/<img([^>]+)src=["']([^"']+)["']/gi, (match, before, url) => {
    if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) {
      return `<img${before}src="/api/image-proxy?url=${encodeURIComponent(url)}"`;
    }
    return match;
  });
}

function formatAge(date) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = ms / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${hrs.toFixed(1)}h ago`;
  return `${(hrs / 24).toFixed(1)}d ago`;
}

// ── Multi-PTY management ────────────────────────────────────────────────────
const terminals = new Map(); // termId -> { pty, cols, rows }
let defaultCols = 120, defaultRows = 30;

function findShell() {
  try { execSync('where pwsh.exe 2>nul', { encoding: 'utf8', timeout: 3000 }).trim(); return 'pwsh.exe'; } catch (_) {
    try { execSync('where powershell.exe 2>nul', { encoding: 'utf8', timeout: 3000 }).trim(); return 'powershell.exe'; } catch (_2) {
      const candidates = [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      ];
      for (const c of candidates) { if (fs.existsSync(c)) return c; }
      return 'powershell.exe';
    }
  }
}
const shellPath = findShell();

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function createTerminal(termId, cols = 120, rows = 30, cwd = repoRoot) {
  // Kill existing if same ID
  if (terminals.has(termId)) {
    try { terminals.get(termId).pty.kill(); } catch (_) {}
    terminals.delete(termId);
  }

  const ptyProcess = pty.spawn(shellPath, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NoLogo', '-NoExit'], {
    name: 'xterm-256color',
    cols, rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    },
  });

  terminals.set(termId, { pty: ptyProcess, cols, rows });

  ptyProcess.onData(data => broadcast({ type: 'output', termId, data }));
  ptyProcess.onExit(() => {
    terminals.delete(termId);
    broadcast({ type: 'term-exited', termId });
  });

  broadcast({ type: 'term-started', termId, cwd, isNew: true });
  return ptyProcess;
}

function killTerminal(termId) {
  const t = terminals.get(termId);
  if (t) {
    try { t.pty.kill(); } catch (_) {}
    terminals.delete(termId);
  }
}

// Backward compat: currentPty getter for start-working feature
Object.defineProperty(global, 'currentPty', {
  get() { return terminals.has('main') ? terminals.get('main').pty : null; },
});

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // Send list of active terminals
  const active = [];
  for (const [id] of terminals) active.push(id);
  ws.send(JSON.stringify({ type: 'term-list', terminals: active }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const termId = msg.termId || 'main';

      switch (msg.type) {
        case 'input': {
          const t = terminals.get(termId);
          if (t) t.pty.write(msg.data || '');
          break;
        }
        case 'resize': {
          if (msg.cols && msg.rows) {
            const cols = Math.max(msg.cols, 20);
            const rows = Math.max(msg.rows, 5);
            defaultCols = cols;
            defaultRows = rows;
            const t = terminals.get(termId);
            if (!t) {
              createTerminal(termId, cols, rows);
            } else if (cols !== t.cols || rows !== t.rows) {
              t.cols = cols;
              t.rows = rows;
              t.pty.resize(cols, rows);
            }
          }
          break;
        }
        case 'create-term': {
          createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows, msg.cwd || repoRoot);
          break;
        }
        case 'kill-term': {
          if (termId !== 'main') killTerminal(termId);
          break;
        }
        case 'restart': {
          createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows);
          break;
        }
      }
    } catch (_) {}
  });
});

// ── Start ───────────────────────────────────────────────────────────────────
function startServer() {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ERROR: Port ${PORT} is already in use.\n`);
      if (!process.env.ELECTRON) process.exit(1);
      return;
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`\n  DevOps Pilot running at ${url}\n`);
    if (!process.env.ELECTRON) exec(`start ${url}`);
  });
}

if (!process.env.ELECTRON) startServer();

process.on('SIGINT', () => {
  for (const [, t] of terminals) { try { t.pty.kill(); } catch (_) {} }
  server.close();
  process.exit(0);
});

module.exports = { server, startServer, addRoute };
