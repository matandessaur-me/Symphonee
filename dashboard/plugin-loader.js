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

function loadPlugins(pluginsDir, { addRoute, getConfig, broadcast, json }) {
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
          const registerRoutes = require(routesFile);
          const prefix = `/api/plugins/${manifest.id}`;
          registerRoutes({
            addRoute: (method, subpath, handler) => {
              addRoute(method, `${prefix}${subpath}`, handler);
            },
            // Register a prefix handler -- matches any path under the plugin's API prefix.
            // The handler receives (req, res, url, subpath) where subpath is the part after the prefix.
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
          });
          console.log(`    Routes registered for ${manifest.id}`);
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

  return plugins;
}

module.exports = { loadPlugins };
