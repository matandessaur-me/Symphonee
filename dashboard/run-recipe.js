#!/usr/bin/env node
/**
 * CLI runner for Apps automations.
 *
 * Usage:
 *   node dashboard/run-recipe.js --app "Figma" --recipe <id-or-name> [--inputs k=v,k=v]
 *
 * Dispatches POST /api/apps/session/start against a locally running Symphonee
 * dashboard. Prints WebSocket step events, exits 0 on success, non-zero on
 * recipe failure or transport error. Lets you run recipes from cron, hotkey
 * launchers, or CI without the UI.
 */

const http = require('http');

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 3800, inputs: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') out.app = argv[++i];
    else if (a === '--recipe') out.recipe = argv[++i];
    else if (a === '--hwnd') out.hwnd = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--inputs') {
      for (const kv of String(argv[++i] || '').split(',')) {
        const m = kv.match(/^([^=]+)=(.*)$/);
        if (m) out.inputs[m[1].trim()] = m[2];
      }
    } else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

async function httpJson(opts, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      method: opts.method || 'GET', hostname: opts.host, port: opts.port, path: opts.path,
      headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}, payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
        } else {
          reject(new Error(`${opts.path} ${res.statusCode}: ${data.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function usage() {
  console.log('Usage: node run-recipe.js --app <name> --recipe <id-or-name> [--hwnd N] [--inputs k=v,k=v] [--provider anthropic|openai|gemini]');
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.help || !args.app || !args.recipe) { usage(); process.exit(args.help ? 0 : 2); }

  try {
    const list = await httpJson({ host: args.host, port: args.port, path: '/api/apps/recipes?app=' + encodeURIComponent(args.app) });
    const recipes = (list && list.recipes) || [];
    const recipe = recipes.find(r => r.id === args.recipe) || recipes.find(r => r.name === args.recipe);
    if (!recipe) throw new Error('recipe "' + args.recipe + '" not found in app "' + args.app + '"');

    let hwnd = args.hwnd;
    if (hwnd == null) {
      const wins = await httpJson({ host: args.host, port: args.port, path: '/api/apps/windows', method: 'POST' }, {});
      const appKey = args.app.toLowerCase();
      const match = (wins.windows || []).find(w => (w.processName || '').toLowerCase().startsWith(appKey))
        || (wins.windows || []).find(w => (w.title || '').toLowerCase().includes(appKey));
      if (!match) throw new Error('no running window matches "' + args.app + '" (launch it, or pass --hwnd)');
      hwnd = match.hwnd;
      console.log('Using hwnd=' + hwnd + ' (' + (match.title || '?') + ')');
    }

    const started = await httpJson(
      { host: args.host, port: args.port, path: '/api/apps/session/start', method: 'POST' },
      { recipeId: recipe.id, hwnd, app: args.app, inputs: args.inputs, provider: args.provider }
    );
    if (!started.ok) throw new Error('start failed: ' + (started.error || 'unknown'));
    console.log('Running "' + recipe.name + '" - session ' + started.sessionId);
    console.log('(Stream step events via WebSocket if you want live output; this CLI exits once the session is kicked off.)');
    process.exit(0);
  } catch (e) {
    console.error('ERROR: ' + (e && e.message || e));
    process.exit(1);
  }
})();
