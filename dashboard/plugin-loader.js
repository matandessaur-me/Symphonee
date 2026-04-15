/**
 * Symphonee -- Plugin Loader
 * Scans dashboard/plugins/ on startup, validates manifests,
 * registers API routes + static file serving for each plugin.
 */
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2',
  '.md': 'text/markdown',
};

// Known contribution types. v1 is what plugins shipped with today.
// v2 adds the surfaces needed to extract Azure DevOps and GitHub into plugins.
const KNOWN_CONTRIBUTIONS_V1 = new Set([
  'settingsHtml', 'centerTabs', 'routes', 'mcp',
]);
const KNOWN_CONTRIBUTIONS_V2 = new Set([
  'leftQuickActions',   // [{id,label,icon,command}] injected into left rail
  'rightTabs',          // [{id,label,icon,html,pinned?,position?}] right-column tabs
  'repoSources',        // declare a repo provider (name, clone handler, list handler)
  'commitLinkers',      // {pattern, resolver} for auto-linking commit refs (e.g. AB#123)
  'workItemProvider',   // implements {list,get,update,create,iterations,teams,activity}
  'prProvider',         // implements {list,get,create,merge}
  'aiActions',          // [{id,label,icon,prompt}] AI quick actions (standup, retro, etc.)
  'nativeSettings',     // {targetId, hideNavSelector?} claim an existing settings DOM block
  'sensitiveKeys',      // string[] -- config keys that must be stripped from exports and preserved across imports
  'imageAuth',          // [{hostnamePattern,authType,authConfigKey}] -- register URL-pattern auth injectors for the core image proxy
  'configKeys',         // string[] -- config keys owned by this plugin and persisted in plugin config.json
]);
const ALL_KNOWN_CONTRIBUTIONS = new Set([
  ...KNOWN_CONTRIBUTIONS_V1, ...KNOWN_CONTRIBUTIONS_V2,
]);

// Normalize the legacy `legacyNativeTabs` / `legacyNativeRightTabs` shape into
// the current `centerTabs` / `rightTabs` + `pinned: true` + `claims` shape.
// The old plugin manifests shipped before the SDK exposed pinned tabs publicly;
// we rewrite them in place so the rest of the loader and the client code see one model.
function normalizeLegacyShapes(manifest) {
  const c = manifest.contributions;
  if (!c) return;
  const migrate = (legacyKey, modernKey) => {
    const list = c[legacyKey];
    if (!Array.isArray(list) || list.length === 0) return;
    if (!Array.isArray(c[modernKey])) c[modernKey] = [];
    list.forEach((t, idx) => {
      if (!t || !t.tabBtnId) return;
      const id = t.id
        || (t.tabBtnId.replace(/TabBtn$/, '').replace(/^intelTab-/, '') || `tab${idx}`);
      // Legacy semantics: openable:false meant "hidden until plugin code reveals
      // it" (Work Item, Activity Timeline). That is now `popup: true`. Anything
      // else stays a `pinned` always-visible tab.
      const isPopup = t.openable === false;
      c[modernKey].push({
        id,
        label: t.label || '',
        icon: t.icon || null,
        pinned: !isPopup,
        popup: isPopup,
        position: typeof t.position === 'number' ? t.position : (idx + 2),
        claims: { tabBtnId: t.tabBtnId, panelId: t.panelId || '' },
      });
    });
    delete c[legacyKey];
  };
  migrate('legacyNativeTabs', 'centerTabs');
  migrate('legacyNativeRightTabs', 'rightTabs');
}

function validateContributions(manifest) {
  const warnings = [];
  const c = manifest.contributions || {};
  const sdk = manifest.sdkVersion || 1;
  for (const key of Object.keys(c)) {
    if (!ALL_KNOWN_CONTRIBUTIONS.has(key)) {
      warnings.push(`unknown contribution '${key}'`);
      continue;
    }
    if (KNOWN_CONTRIBUTIONS_V2.has(key) && sdk < 2) {
      warnings.push(`contribution '${key}' requires sdkVersion >= 2 (manifest declares ${sdk})`);
    }
  }
  // Pinned/popup tabs must declare either claims (existing core DOM) or html
  // (iframe). Pinned and popup are mutually exclusive.
  ['centerTabs', 'rightTabs'].forEach(k => {
    if (!Array.isArray(c[k])) return;
    c[k].forEach(t => {
      if (!t) return;
      if (t.pinned && t.popup) {
        warnings.push(`${k} entry '${t.id}' declares both 'pinned' and 'popup' (mutually exclusive)`);
      }
      if ((t.pinned || t.popup) && !t.claims && !t.html) {
        warnings.push(`${k} entry '${t.id}' is ${t.popup ? 'popup' : 'pinned'} but has neither 'claims' nor 'html'`);
      }
    });
  });
  return warnings;
}

function checkActivation(manifest, getConfig) {
  const cond = manifest.activationConditions;
  if (!cond || cond.always) return true;
  if (cond.configKeys) {
    const config = getConfig();
    return cond.configKeys.every(key => !!config[key]);
  }
  return true;
}

function loadPlugins(pluginsDir, { addRoute, getConfig, broadcast, json, writePluginHints, swrCache, shellDeps }) {
  const plugins = [];
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    return plugins;
  }

  let entries;
  try { entries = fs.readdirSync(pluginsDir); } catch (_) { return plugins; }

  for (const dir of entries) {
    if (dir === 'sdk') continue; // sdk is not a plugin
    const pluginDir = path.join(pluginsDir, dir);
    try {
      if (!fs.statSync(pluginDir).isDirectory()) continue;
    } catch (_) { continue; }

    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest.id || !manifest.name || !manifest.version) {
        console.warn(`  Plugin ${dir}: missing required fields (id, name, version), skipping`);
        continue;
      }
      manifest._dir = pluginDir;
      normalizeLegacyShapes(manifest);

      const contribWarnings = validateContributions(manifest);
      if (contribWarnings.length) {
        for (const w of contribWarnings) console.warn(`  Plugin ${manifest.id}: ${w}`);
      }

      const isActive = checkActivation(manifest, getConfig);

      // Register plugin API routes from routes.js. Installed-but-inactive
      // plugins still load as manifests, but must not claim shell/API routes
      // until their activationConditions are satisfied.
      if (isActive && manifest.contributions && manifest.contributions.routes) {
        const routesFile = path.join(pluginDir, manifest.contributions.routes);
        if (fs.existsSync(routesFile)) {
          const prefix = `/api/plugins/${manifest.id}`;
          const pluginCtx = {
            // Register under /api/plugins/<id>/<subpath> -- the canonical, namespaced home.
            addRoute: (method, subpath, handler) => {
              addRoute(method, `${prefix}${subpath}`, handler);
            },
            addPrefixRoute: (handler) => {
              addRoute('__PREFIX__', prefix, handler);
            },
            // Register at an arbitrary absolute path (e.g. /api/workitems, /api/github/pulls).
            // Used during migration so plugins can own the legacy URL contracts the frontend
            // and AI already rely on. Plugin-loader does not sandbox these; be cautious and
            // only register under /api/ paths that are clearly plugin-owned.
            addAbsoluteRoute: (method, absolutePath, handler) => {
              addRoute(method, absolutePath, handler);
            },
            addAbsolutePrefixRoute: (absolutePath, handler) => {
              addRoute('__PREFIX__', absolutePath, handler);
            },
            getConfig,
            broadcast,
            json: (response, data, status) => {
              response.writeHead(status || 200, { 'Content-Type': 'application/json' });
              response.end(JSON.stringify(data));
            },
            readBody: (req) => new Promise((resolve, reject) => {
              let body = '';
              req.on('data', chunk => { body += chunk; });
              req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
              req.on('error', reject);
            }),
            // SWR cache for plugins -- use to cache expensive API calls
            // Usage: ctx.cache.get('myKey', async () => fetchData(), { forceRefresh })
            cache: swrCache || null,
            // Shell helpers shared with core (gitExec, sanitizeText, permGate, incognitoGuard,
            // repoRoot, getRepoPath, https). Populated by server.js at startup so plugins
            // never need to reach into core modules.
            shell: shellDeps || {},
          };

          // Lazy loading: if manifest declares lazyRoutes, defer route registration until first request
          if (manifest.lazyRoutes) {
            let loaded = false;
            addRoute('__PREFIX__', prefix, (req, res, url, subpath) => {
              if (!loaded) {
                const startMs = Date.now();
                try {
                  const registerRoutes = require(routesFile);
                  registerRoutes(pluginCtx);
                  loaded = true;
                  console.log(`    Lazy-loaded routes for ${manifest.id} (${Date.now() - startMs}ms)`);
                } catch (e) {
                  console.warn(`    Lazy-load failed for ${manifest.id}: ${e.message}`);
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Plugin failed to load: ' + e.message }));
                  return;
                }
              }
              // Handle requests to the exact prefix (no trailing slash) by redirecting
              if (!subpath || subpath === '') {
                res.writeHead(302, { Location: prefix + '/' });
                res.end();
                return true;
              }
              return false; // Fall through to newly registered routes
            });
          } else {
            // Eager loading (default -- backward compatible)
            const registerRoutes = require(routesFile);
            registerRoutes(pluginCtx);
          }
          console.log(`    Routes ${manifest.lazyRoutes ? 'deferred' : 'registered'} for ${manifest.id}`);
        }
      }

      plugins.push(manifest);
      console.log(`  Plugin loaded: ${manifest.name} v${manifest.version}`);
    } catch (e) {
      console.warn(`  Plugin ${dir}: failed to load -- ${e.message}`);
    }
  }

  // Serve plugin static files: GET /plugins/<id>/<filepath>
  addRoute('GET', '/__plugin_static__', (req, res, url) => {
    const match = url.pathname.match(/^\/plugins\/([^/]+)\/(.+)$/);
    if (!match) return false;
    const [, pluginId, filePath] = match;
    const plugin = plugins.find(p => p.id === pluginId);
    // Also allow serving from sdk/
    const baseDir = pluginId === 'sdk'
      ? path.join(pluginsDir, 'sdk')
      : (plugin ? plugin._dir : null);
    if (!baseDir) { res.writeHead(404); res.end('Plugin not found'); return; }

    const resolved = path.resolve(baseDir, filePath);
    // Prevent path traversal
    if (!resolved.startsWith(baseDir)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!fs.existsSync(resolved)) { res.writeHead(404); res.end('Not found'); return; }

    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(resolved).pipe(res);
  });

  function activePluginManifests() {
    return plugins
      .filter(p => checkActivation(p, getConfig))
      .map(p => {
        const { _dir, ...safe } = p;
        const scriptsDir = path.join(_dir, 'scripts');
        if (fs.existsSync(scriptsDir)) {
          try {
            safe._scripts = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ps1') || f.endsWith('.js') || f.endsWith('.sh'));
          } catch (_) {}
        }
        return safe;
      });
  }

  function aggregateContributions(activeManifests) {
    const out = {
      centerTabs: [], rightTabs: [], leftQuickActions: [], aiActions: [],
      repoSources: [], commitLinkers: [], workItemProviders: [], prProviders: [],
      settingsPanels: [],
    };
    for (const p of activeManifests) {
      const c = p.contributions || {};
      const origin = { pluginId: p.id, pluginName: p.name, tint: p.tint || null, icon: p.icon || null };
      const tag = (item) => Object.assign({}, item, { _origin: origin });
      if (Array.isArray(c.centerTabs)) out.centerTabs.push(...c.centerTabs.map(tag));
      if (Array.isArray(c.rightTabs)) out.rightTabs.push(...c.rightTabs.map(tag));
      if (Array.isArray(c.leftQuickActions)) out.leftQuickActions.push(...c.leftQuickActions.map(tag));
      if (Array.isArray(c.aiActions)) out.aiActions.push(...c.aiActions.map(tag));
      if (Array.isArray(c.repoSources)) out.repoSources.push(...c.repoSources.map(tag));
      if (Array.isArray(c.commitLinkers)) out.commitLinkers.push(...c.commitLinkers.map(tag));
      if (c.workItemProvider) out.workItemProviders.push(tag(c.workItemProvider));
      if (c.prProvider) out.prProviders.push(tag(c.prProvider));
      if (c.settingsHtml) out.settingsPanels.push(Object.assign(tag({ html: c.settingsHtml }), origin));
    }
    return out;
  }

  // GET /api/plugins -- canonical active plugin manifest list.
  addRoute('GET', '/api/plugins', (req, res) => {
    json(res, activePluginManifests());
  });

  // GET /api/plugins/installed -- every installed plugin (active + inactive),
  // with an `active` flag. Used by Settings > Plugins so users can configure
  // an installed-but-unconfigured plugin without activation being a precondition.
  addRoute('GET', '/api/plugins/installed', (req, res) => {
    const out = plugins.map(p => {
      const active = checkActivation(p, getConfig);
      const { _dir, ...safe } = p;
      const scriptsDir = path.join(_dir, 'scripts');
      if (fs.existsSync(scriptsDir)) {
        try {
          safe._scripts = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ps1') || f.endsWith('.js') || f.endsWith('.sh'));
        } catch (_) {}
      }
      safe.active = active;
      return safe;
    });
    json(res, out);
  });

  // Generic per-plugin config endpoints. Plugins can still implement their own
  // /config route via routes.js; this is the fallback for manifest-only and
  // native-settings plugins such as the first-party ADO/GitHub extractions.
  addRoute('__PREFIX__', '/api/plugins', async (req, res, url, subpath) => {
    const m = String(subpath || '').match(/^\/([^/]+)\/config$/);
    if (!m) return false;
    const pluginId = m[1];
    const plugin = plugins.find(p => p.id === pluginId);
    if (!plugin) { json(res, { error: 'Plugin not found' }, 404); return true; }
    const cfgFile = path.join(plugin._dir, 'config.json');

    if (req.method === 'GET') {
      let cfg = {};
      try { if (fs.existsSync(cfgFile)) cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
      cfg.configured = checkActivation(plugin, getConfig);
      json(res, cfg);
      return true;
    }

    if (req.method === 'POST') {
      try {
        const body = await new Promise((resolve, reject) => {
          let d = '';
          req.on('data', c => { d += c; });
          req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
          req.on('error', reject);
        });
        let existing = {};
        try { if (fs.existsSync(cfgFile)) existing = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
        fs.writeFileSync(cfgFile, JSON.stringify({ ...existing, ...body }, null, 2), 'utf8');
        if (writePluginHints) writePluginHints();
        json(res, { ok: true, configured: checkActivation(plugin, getConfig) });
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
      return true;
    }

    return false;
  });

  // GET /api/plugins/instructions -- return concatenated AI instructions from all active plugins
  addRoute('GET', '/api/plugins/instructions', (req, res) => {
    const sections = [];
    for (const p of plugins) {
      if (!checkActivation(p, getConfig)) continue;
      const instrFile = p.instructions
        ? path.join(p._dir, p.instructions)
        : path.join(p._dir, 'instructions.md');
      if (fs.existsSync(instrFile)) {
        try {
          const content = fs.readFileSync(instrFile, 'utf8');
          sections.push(`# Plugin: ${p.name}\n\n${content}`);
        } catch (_) {}
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(sections.join('\n\n---\n\n'));
  });

  // GET /api/plugins/contributions -- aggregated contributions across active plugins, grouped by type.
  //
  // Canonical source is /api/plugins (the filtered plugin manifest list). This endpoint is a
  // derived VIEW of the same data, reshaped for convenient lookup (activeWorkItemProvider,
  // resolveCommitRef, etc). Both endpoints apply the same checkActivation filter so they can
  // never disagree on "plugin X is active".
  //
  // Consumers:
  //   /api/plugins           -> initPlugins IIFE (iterates full manifests, injects contributions)
  //   /api/plugins/contributions -> contributions-client.js (typed lookups)
  addRoute('GET', '/api/plugins/contributions', (req, res) => {
    json(res, aggregateContributions(activePluginManifests()));
  });

  // POST /api/plugins/install -- install a plugin from a local folder path
  addRoute('POST', '/api/plugins/install', async (req, res) => {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => { d += c; });
        req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
      const sourcePath = body.path;
      if (!sourcePath) { json(res, { error: 'path required' }, 400); return; }
      if (!fs.existsSync(sourcePath)) { json(res, { error: 'Folder not found: ' + sourcePath }, 404); return; }
      const manifestPath = path.join(sourcePath, 'plugin.json');
      if (!fs.existsSync(manifestPath)) { json(res, { error: 'No plugin.json found in that folder' }, 400); return; }

      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
      catch (_) { json(res, { error: 'Invalid plugin.json' }, 400); return; }

      if (!manifest.id || !manifest.name) { json(res, { error: 'plugin.json missing id or name' }, 400); return; }

      const destDir = path.join(pluginsDir, manifest.id);
      const isUpdate = fs.existsSync(destDir);
      if (isUpdate) fs.rmSync(destDir, { recursive: true, force: true });

      // Copy the folder recursively
      copyDirSync(sourcePath, destDir);
      if (writePluginHints) writePluginHints();
      const verb = isUpdate ? 'Updated' : 'Installed';
      json(res, { ok: true, id: manifest.id, name: manifest.name, updated: isUpdate, message: verb + '. Restart app to activate.' });
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  // POST /api/plugins/uninstall -- remove a plugin by id. Body accepts
  //   { id, keepConfig }. When keepConfig is true we back up the plugin's
  //   config.json into config/plugin-configs-preserved/<id>.json so the next
  //   install-from-registry can restore it. A tombstone entry is also written
  //   to config/uninstalled-plugins.json so the legacy auto-install migration
  //   on startup does not silently re-clone what the user removed on purpose.
  const configDir = path.join(pluginsDir, '..', '..', 'config');
  const preservedDir = path.join(configDir, 'plugin-configs-preserved');
  const tombstonePath = path.join(configDir, 'uninstalled-plugins.json');
  function readTombstones() {
    try { return JSON.parse(fs.readFileSync(tombstonePath, 'utf8')); } catch (_) { return []; }
  }
  function writeTombstones(list) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(tombstonePath, JSON.stringify(Array.from(new Set(list)), null, 2), 'utf8');
    } catch (_) {}
  }
  addRoute('POST', '/api/plugins/uninstall', async (req, res) => {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => { d += c; });
        req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
      const pluginId = body.id;
      const keepConfig = !!body.keepConfig;
      if (!pluginId) { json(res, { error: 'id required' }, 400); return; }
      if (pluginId === 'sdk') { json(res, { error: 'Cannot uninstall SDK' }, 400); return; }
      const pluginDir = path.join(pluginsDir, pluginId);
      if (!fs.existsSync(pluginDir)) { json(res, { error: 'Plugin not found' }, 404); return; }

      const preservedFile = path.join(preservedDir, pluginId + '.json');
      if (keepConfig) {
        const cfgFile = path.join(pluginDir, 'config.json');
        if (fs.existsSync(cfgFile)) {
          try {
            fs.mkdirSync(preservedDir, { recursive: true });
            fs.copyFileSync(cfgFile, preservedFile);
          } catch (_) {}
        }
      } else if (fs.existsSync(preservedFile)) {
        try { fs.unlinkSync(preservedFile); } catch (_) {}
      }

      fs.rmSync(pluginDir, { recursive: true, force: true });

      // Remember that the user removed this plugin so we do not re-install it
      // from the legacy PAT-in-root-config migration on the next startup.
      const tomb = readTombstones();
      if (!tomb.includes(pluginId)) tomb.push(pluginId);
      writeTombstones(tomb);

      if (writePluginHints) writePluginHints();
      json(res, {
        ok: true,
        keepConfig,
        preservedConfig: keepConfig && fs.existsSync(preservedFile),
        message: 'Uninstalled. Restart app to apply.',
      });
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  // GET /api/plugins/registry -- fetch available plugins from the online registry
  const REGISTRY_API_URL = 'https://api.github.com/repos/matandessaur-me/Symphonee-plugins/contents/registry.json';
  addRoute('GET', '/api/plugins/registry', async (req, res) => {
    try {
      const https = require('https');
      const raw = await new Promise((resolve, reject) => {
        https.get(REGISTRY_API_URL, { headers: { 'User-Agent': 'Symphonee', 'Accept': 'application/vnd.github.v3+json' } }, (resp) => {
          let d = '';
          resp.on('data', c => { d += c; });
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      if (!raw.content) throw new Error(raw.message || 'Failed to fetch registry');
      const data = JSON.parse(Buffer.from(raw.content, 'base64').toString());
      // Read installed versions fresh from disk (not the in-memory array)
      const installedMap = {};
      try {
        const dirs = fs.readdirSync(pluginsDir);
        for (const dir of dirs) {
          if (dir === 'sdk') continue;
          const mf = path.join(pluginsDir, dir, 'plugin.json');
          if (fs.existsSync(mf)) {
            try {
              const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
              if (m.id) installedMap[m.id] = m.version || '0.0.0';
            } catch (_) {}
          }
        }
      } catch (_) {}
      (data.plugins || []).forEach(p => {
        p.installed = !!installedMap[p.id];
        if (p.installed) {
          p.installedVersion = installedMap[p.id];
          p.updateAvailable = p.version !== installedMap[p.id];
        }
      });
      json(res, data);
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  // POST /api/plugins/install-from-registry -- clone a plugin repo into dashboard/plugins/
  addRoute('POST', '/api/plugins/install-from-registry', async (req, res) => {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => { d += c; });
        req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
      const { id, repo } = body;
      if (!id || !repo) { json(res, { error: 'id and repo required' }, 400); return; }
      const destDir = path.join(pluginsDir, id);
      if (fs.existsSync(destDir)) { json(res, { error: 'Plugin "' + id + '" already installed' }, 409); return; }
      // Clone the repo
      const { execSync } = require('child_process');
      execSync('git clone "' + repo + '.git" "' + destDir + '"', { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      // Verify plugin.json exists
      if (!fs.existsSync(path.join(destDir, 'plugin.json'))) {
        fs.rmSync(destDir, { recursive: true, force: true });
        json(res, { error: 'Cloned repo has no plugin.json' }, 400);
        return;
      }
      // Restore preserved config if the user previously chose "keep settings".
      let restoredConfig = false;
      try {
        const preservedFile = path.join(preservedDir, id + '.json');
        if (fs.existsSync(preservedFile)) {
          fs.copyFileSync(preservedFile, path.join(destDir, 'config.json'));
          fs.unlinkSync(preservedFile);
          restoredConfig = true;
        }
      } catch (_) {}
      // Clear tombstone so the migration auto-installer is free to act again.
      try {
        const tomb = readTombstones().filter(t => t !== id);
        writeTombstones(tomb);
      } catch (_) {}
      if (writePluginHints) writePluginHints();
      json(res, { ok: true, id: id, restoredConfig, message: 'Installed. Restart app to activate.' });
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  // POST /api/plugins/update -- re-clone a plugin while preserving its config.json
  addRoute('POST', '/api/plugins/update', async (req, res) => {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => { d += c; });
        req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
      const { id, repo } = body;
      if (!id || !repo) { json(res, { error: 'id and repo required' }, 400); return; }
      const destDir = path.join(pluginsDir, id);
      if (!fs.existsSync(destDir)) { json(res, { error: 'Plugin "' + id + '" is not installed' }, 404); return; }
      // Backup config.json if it exists
      const configFile = path.join(destDir, 'config.json');
      let configBackup = null;
      if (fs.existsSync(configFile)) {
        try { configBackup = fs.readFileSync(configFile, 'utf8'); } catch (_) {}
      }
      // Remove old version and re-clone
      fs.rmSync(destDir, { recursive: true, force: true });
      const { execSync } = require('child_process');
      execSync('git clone "' + repo + '.git" "' + destDir + '"', { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      if (!fs.existsSync(path.join(destDir, 'plugin.json'))) {
        fs.rmSync(destDir, { recursive: true, force: true });
        json(res, { error: 'Cloned repo has no plugin.json' }, 400);
        return;
      }
      // Restore config.json
      if (configBackup) {
        try { fs.writeFileSync(configFile, configBackup, 'utf8'); } catch (_) {}
      }
      if (writePluginHints) writePluginHints();
      json(res, { ok: true, id: id, message: 'Updated. Restart app to activate.' });
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  return plugins;
}

// Recursive directory copy
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) { copyDirSync(srcPath, destPath); }
    else { fs.copyFileSync(srcPath, destPath); }
  }
}

module.exports = { loadPlugins, checkActivation };
