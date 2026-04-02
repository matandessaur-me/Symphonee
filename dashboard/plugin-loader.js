/**
 * DevOps Pilot -- Plugin Loader
 * Scans dashboard/plugins/ on startup, validates manifests,
 * registers API routes + static file serving for each plugin.
 */
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2',
};

function checkActivation(manifest, getConfig) {
  const cond = manifest.activationConditions;
  if (!cond || cond.always) return true;
  if (cond.configKeys) {
    const config = getConfig();
    return cond.configKeys.every(key => !!config[key]);
  }
  return true;
}

function loadPlugins(pluginsDir, { addRoute, getConfig, broadcast, json, writePluginHints, swrCache }) {
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

      // Register plugin API routes from routes.js
      if (manifest.contributions && manifest.contributions.routes) {
        const routesFile = path.join(pluginDir, manifest.contributions.routes);
        if (fs.existsSync(routesFile)) {
          const prefix = `/api/plugins/${manifest.id}`;
          const pluginCtx = {
            addRoute: (method, subpath, handler) => {
              addRoute(method, `${prefix}${subpath}`, handler);
            },
            addPrefixRoute: (handler) => {
              addRoute('__PREFIX__', prefix, handler);
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

  // GET /api/plugins -- return active plugin manifests (strip internal fields)
  addRoute('GET', '/api/plugins', (req, res) => {
    const active = plugins
      .filter(p => checkActivation(p, getConfig))
      .map(p => {
        const { _dir, ...safe } = p;
        // Include scripts from the plugin's scripts/ directory
        const scriptsDir = path.join(_dir, 'scripts');
        if (fs.existsSync(scriptsDir)) {
          try {
            safe._scripts = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ps1') || f.endsWith('.js') || f.endsWith('.sh'));
          } catch (_) {}
        }
        return safe;
      });
    json(res, active);
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
      if (fs.existsSync(destDir)) { json(res, { error: 'Plugin "' + manifest.id + '" already installed' }, 409); return; }

      // Copy the folder recursively
      copyDirSync(sourcePath, destDir);
      if (writePluginHints) writePluginHints();
      json(res, { ok: true, id: manifest.id, name: manifest.name, message: 'Installed. Restart app to activate.' });
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  // DELETE /api/plugins/uninstall -- remove a plugin by id
  addRoute('POST', '/api/plugins/uninstall', async (req, res) => {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => { d += c; });
        req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
      const pluginId = body.id;
      if (!pluginId) { json(res, { error: 'id required' }, 400); return; }
      if (pluginId === 'sdk') { json(res, { error: 'Cannot uninstall SDK' }, 400); return; }
      const pluginDir = path.join(pluginsDir, pluginId);
      if (!fs.existsSync(pluginDir)) { json(res, { error: 'Plugin not found' }, 404); return; }

      fs.rmSync(pluginDir, { recursive: true, force: true });
      if (writePluginHints) writePluginHints();
      json(res, { ok: true, message: 'Uninstalled. Restart app to apply.' });
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  // GET /api/plugins/registry -- fetch available plugins from the online registry
  const REGISTRY_API_URL = 'https://api.github.com/repos/matandessaur-me/devops-pilot-plugins/contents/registry.json';
  addRoute('GET', '/api/plugins/registry', async (req, res) => {
    try {
      const https = require('https');
      const raw = await new Promise((resolve, reject) => {
        https.get(REGISTRY_API_URL, { headers: { 'User-Agent': 'DevOps-Pilot', 'Accept': 'application/vnd.github.v3+json' } }, (resp) => {
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
      if (writePluginHints) writePluginHints();
      json(res, { ok: true, id: id, message: 'Installed. Restart app to activate.' });
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

module.exports = { loadPlugins };
