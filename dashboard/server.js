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

    // ── Azure DevOps: Iterations ──────────────────────────────────────────
    if (url.pathname === '/api/iterations' && req.method === 'GET') return handleIterations(res);

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

    // ── Azure DevOps: Team Members ────────────────────────────────────────
    if (url.pathname === '/api/team-members' && req.method === 'GET') return handleTeamMembers(res);

    // ── Azure DevOps: Burndown ────────────────────────────────────────────
    if (url.pathname === '/api/burndown' && req.method === 'GET') return handleBurndown(url, res);

    // ── Repos ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/repos' && req.method === 'GET')  return handleGetRepos(res);
    if (url.pathname === '/api/repos' && req.method === 'POST') return handleSaveRepo(req, res);

    // ── Start Working ─────────────────────────────────────────────────────
    if (url.pathname === '/api/start-working' && req.method === 'POST') return handleStartWorking(req, res);

    // ── UI Actions (AI → Dashboard) ───────────────────────────────────────
    if (url.pathname === '/api/ui/tab' && req.method === 'POST')           return handleUiAction(req, res, 'switch-tab');
    if (url.pathname === '/api/ui/view-workitem' && req.method === 'POST') return handleUiAction(req, res, 'view-workitem');

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
      configWatchDebounce = setTimeout(() => broadcast({ type: 'config-changed' }), 500);
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

// ── Azure DevOps API Helper ─────────────────────────────────────────────────
function adoRequest(method, apiPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const org = cfg.AzureDevOpsOrg;
    const project = cfg.AzureDevOpsProject;
    const pat = cfg.AzureDevOpsPAT;
    if (!org || !project || !pat) {
      return reject(new Error('Azure DevOps not configured. Set Org, Project, and PAT in Settings.'));
    }

    const url = new URL(`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis${apiPath}`);
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
const ITER_CACHE_TTL = 300000;
const WI_CACHE_TTL = 30000;

// ── Iterations ──────────────────────────────────────────────────────────────
async function handleIterations(res) {
  try {
    if (iterationsCache.data && Date.now() - iterationsCache.ts < ITER_CACHE_TTL) {
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

    let wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] NOT IN ('Removed')`;
    if (iterationPath) wiqlQuery += ` AND [System.IterationPath] = '${iterationPath}'`;
    if (state)         wiqlQuery += ` AND [System.State] = '${state}'`;
    if (type)          wiqlQuery += ` AND [System.WorkItemType] = '${type}'`;
    if (assignedTo)    wiqlQuery += ` AND [System.AssignedTo] = '${assignedTo}'`;
    wiqlQuery += ` ORDER BY [System.ChangedDate] DESC`;

    const wiql = await adoRequest('POST', '/wit/wiql?api-version=7.1', { query: wiqlQuery });
    const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);

    if (ids.length === 0) {
      workItemsCache = { data: [], key: cacheKey, ts: Date.now() };
      return json(res, []);
    }

    const details = await adoRequest('GET',
      `/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.Tags,System.ChangedDate,Microsoft.VSTS.Common.Priority,System.IterationPath,Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort&api-version=7.1`
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
      text: c.text || '',
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
      description: f['System.Description'] || '',
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
      reproSteps: f['Microsoft.VSTS.TCM.ReproSteps'] || '',
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
async function handleTeamMembers(res) {
  try {
    const cfg = getConfig();
    const team = cfg.DefaultTeam || `${cfg.AzureDevOpsProject} Team`;
    const data = await adoRequest('GET',
      `/../_apis/projects/${encodeURIComponent(cfg.AzureDevOpsProject)}/teams/${encodeURIComponent(team)}/members?api-version=7.1`
    );
    const members = (data.value || []).map(m => ({
      id: m.identity?.id || '',
      displayName: m.identity?.displayName || '',
      uniqueName: m.identity?.uniqueName || '',
      imageUrl: m.identity?.imageUrl || '',
    }));
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
    const wi = await adoRequest('GET', `/wit/workitems/${workItemId}?fields=System.Title,System.WorkItemType&api-version=7.1`);
    const title = wi.fields['System.Title'] || 'work';
    const wiType = wi.fields['System.WorkItemType'] || 'feature';
    const prefix = wiType.toLowerCase() === 'bug' ? 'bugfix' : 'feature';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const branchName = `${prefix}/${workItemId}-${slug}`;

    // Move work item to Active
    try {
      await adoRequest('PATCH',
        `/wit/workitems/${workItemId}?api-version=7.1`,
        [{ op: 'replace', path: '/fields/System.State', value: 'Active' }],
        'application/json-patch+json'
      );
      workItemsCache = { data: null, ts: 0 };
    } catch (_) { /* may already be active */ }

    // Send commands to the terminal
    const commands = [
      `cd "${repoPath.replace(/\\/g, '/')}"`,
      `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName}`,
    ];

    for (const cmd of commands) {
      if (currentPty) currentPty.write(cmd + '\r');
    }

    json(res, { ok: true, branchName, repoPath });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

// ── UI Actions (AI → Dashboard) ─────────────────────────────────────────────
async function handleUiAction(req, res, action) {
  const data = await readBody(req);
  broadcast({ type: 'ui-action', action, ...data });
  json(res, { ok: true, action });
}

// ── Utilities ───────────────────────────────────────────────────────────────
function formatAge(date) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = ms / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${hrs.toFixed(1)}h ago`;
  return `${(hrs / 24).toFixed(1)}d ago`;
}

// ── PTY management ──────────────────────────────────────────────────────────
let currentPty = null;
let lastKnownCols = 120, lastKnownRows = 30;

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function createPty(cols = 120, rows = 30) {
  lastKnownCols = cols;
  lastKnownRows = rows;

  if (currentPty) { try { currentPty.kill(); } catch (_) {} }

  let shell = 'powershell.exe';
  try { execSync('where pwsh.exe 2>nul', { encoding: 'utf8', timeout: 3000 }).trim(); shell = 'pwsh.exe'; } catch (_) {
    try { execSync('where powershell.exe 2>nul', { encoding: 'utf8', timeout: 3000 }).trim(); } catch (_2) {
      const candidates = [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      ];
      for (const c of candidates) { if (fs.existsSync(c)) { shell = c; break; } }
    }
  }

  currentPty = pty.spawn(shell, ['-ExecutionPolicy', 'Bypass', '-NoLogo', '-NoExit'], {
    name: 'xterm-256color',
    cols, rows,
    cwd: repoRoot,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    },
  });

  const ptyProcess = currentPty;
  ptyProcess.onData(data => broadcast({ type: 'output', data }));
  ptyProcess.onExit(() => {
    if (currentPty === ptyProcess) {
      currentPty = null;
      setTimeout(() => {
        if (!currentPty && wss.clients.size > 0) createPty(lastKnownCols, lastKnownRows);
      }, 500);
    }
  });

  broadcast({ type: 'started', cwd: repoRoot, isNewPty: true });
}

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  if (currentPty) {
    ws.send(JSON.stringify({ type: 'started', cwd: repoRoot, isNewPty: false }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'input':
          if (currentPty) currentPty.write(msg.data || '');
          break;
        case 'resize':
          if (msg.cols && msg.rows) {
            const cols = Math.max(msg.cols, 20);
            const rows = Math.max(msg.rows, 5);
            if (!currentPty) {
              createPty(cols, rows);
            } else if (cols !== lastKnownCols || rows !== lastKnownRows) {
              lastKnownCols = cols;
              lastKnownRows = rows;
              currentPty.resize(cols, rows);
            }
          }
          break;
        case 'restart':
          createPty(msg.cols || lastKnownCols, msg.rows || lastKnownRows);
          break;
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
  if (currentPty) try { currentPty.kill(); } catch (_) {}
  server.close();
  process.exit(0);
});

module.exports = { server, startServer, addRoute };
