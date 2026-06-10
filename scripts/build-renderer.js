#!/usr/bin/env node
// Build the renderer bundles.
//
// The Symphonee renderer is served as static files (no runtime build step). To
// keep that property while authoring the renderer as small source files, this
// script combines the sources at AUTHOR time into the same committed output
// paths the app already serves. index.html is unchanged and the app launches/
// distributes exactly as before -- it just serves a static file.
//
// Two strategies, one per file, chosen by the source's shape:
//
//   mind-ui.js  -- esbuild ES-module BUNDLE. mind-ui was a single self-contained
//                  IIFE exposing only window.MindUI/MindSkills, so it splits
//                  cleanly into real import/export modules under mind-ui/src/.
//
//   js/app.js   -- flat CONCATENATION of ordered "parts". app.js is a classic
//                  flat-global script with ~150 mutable globals reassigned across
//                  sections; real ES modules would need an ~1700-reference rewrite
//                  (can't reassign an imported binding). Instead the parts are
//                  offset-exact slices that concatenate back BYTE-IDENTICAL to the
//                  original -- same global scope, zero semantic change. The source
//                  is navigable; the output is provably the original.
//
//   node scripts/build-renderer.js            # one-shot build
//   node scripts/build-renderer.js --watch    # rebuild on change (dev)
//
// IMPORTANT: the OUTPUT files (dashboard/public/mind-ui.js,
// dashboard/public/js/app.js) are GENERATED. Edit the sources under
// dashboard/public/<name>/src/ and rebuild -- never hand-edit the output.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'dashboard', 'public');

// --- esbuild module bundles ---------------------------------------------------
const ESBUILD_BUNDLES = [
  {
    // Shared renderer helpers (window.escapeHtml, ...). Loaded before app.js so
    // the still-flat parts resolve them as globals. Source: util/src/.
    name: 'util',
    entry: path.join(PUB, 'util', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'util.js'),
  },
  {
    name: 'mind-ui',
    entry: path.join(PUB, 'mind-ui', 'src', 'index.js'),
    outfile: path.join(PUB, 'mind-ui.js'),
  },
  {
    // First real ES-module slice carved off the flat app.js. Source:
    // dashboard/public/pinned-tabs/src/. Bundled IIFE keeps everything private
    // except the two functions it re-exposes on window (see that file's footer).
    name: 'pinned-tabs',
    entry: path.join(PUB, 'pinned-tabs', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'pinned-tabs.js'),
  },
  {
    // Second ES-module slice. Source: dashboard/public/local-model-prompt/src/.
    // Exposes only window.symphEnsureLocalModel (called by apps.js).
    name: 'local-model-prompt',
    entry: path.join(PUB, 'local-model-prompt', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'local-model-prompt.js'),
  },
  {
    // Third extracted leaf. Source: dashboard/public/mcp/src/. Depends on the
    // shared util (window.escapeHtml) so it must load after js/util.js.
    name: 'mcp',
    entry: path.join(PUB, 'mcp', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'mcp.js'),
  },
  {
    // Fourth extracted leaf. Source: dashboard/public/notes-search/src/. Reads
    // the shared `state` at top level, so its <script> loads AFTER app.js.
    name: 'notes-search',
    entry: path.join(PUB, 'notes-search', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'notes-search.js'),
  },
  {
    // Fifth extracted leaf. Source: dashboard/public/permissions/src/. Reads the
    // shared `state` at top level + registers a poller, so it loads AFTER app.js.
    name: 'permissions',
    entry: path.join(PUB, 'permissions', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'permissions.js'),
  },
  {
    // Reads the shared `state` at top level -> its <script> loads AFTER app.js.
    name: 'activity-timeline',
    entry: path.join(PUB, 'activity-timeline', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'activity-timeline.js'),
  },
  {
    // Reads the shared `state` at top level -> its <script> loads AFTER app.js.
    name: 'activity-ledger',
    entry: path.join(PUB, 'activity-ledger', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'activity-ledger.js'),
  },
  {
    // Split out of the old browser-credentials part (which mixed two features).
    name: 'browser-credentials',
    entry: path.join(PUB, 'browser-credentials', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'browser-credentials.js'),
  },
  {
    // The other half of the old browser-credentials part. Reads `state` at top
    // level -> loads AFTER app.js.
    name: 'plugin-registry',
    entry: path.join(PUB, 'plugin-registry', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'plugin-registry.js'),
  },
  {
    // Owns BUILTIN_THEMES/ALL_CSS_KEYS/ACTIVE_THEME_KEY (re-exposed on window for
    // onboarding/settings). Reads `state` + restores the theme at load -> after app.js.
    name: 'themes',
    entry: path.join(PUB, 'themes', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'themes.js'),
  },
  {
    // Owns `notify` + `_paletteNotifyTasks` (re-exposed on window); consumes
    // CLI_CONFIG (terminals). Registers global listeners + reads state at load
    // -> after app.js.
    name: 'notifications',
    entry: path.join(PUB, 'notifications', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'notifications.js'),
  },
  {
    // Provider-driven PR tab. Reads `state` at top level -> after app.js.
    name: 'pull-requests',
    entry: path.join(PUB, 'pull-requests', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'pull-requests.js'),
  },
  {
    // Git modal + scripts + the shared renderMarkdown. Reads `state` at top
    // level -> after app.js. Several parts + pull-requests use window.renderMarkdown.
    name: 'git',
    entry: path.join(PUB, 'git', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'git.js'),
  },
  {
    // Files tab: tree/search/Monaco/diff/git-log/pickers + the shared
    // renderInlineDiff (used by pull-requests). Reads `state` at top level -> after app.js.
    name: 'files',
    entry: path.join(PUB, 'files', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'files.js'),
  },
  {
    // Notes tab + shared customConfirm/customPrompt dialogs + context menus.
    // Global listeners + reads `state` at top level -> after app.js.
    name: 'notes',
    entry: path.join(PUB, 'notes', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'notes.js'),
  },
  {
    // Spaces + repo management (selectRepo is core). Global listeners + git-status
    // polling + reads `state` at load -> after app.js. Owns CORE_SPACE_PLUGIN_IDS.
    name: 'spaces-repos',
    entry: path.join(PUB, 'spaces-repos', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'spaces-repos.js'),
  },
  {
    // Work-items (backlog/board) + app-wide config plumbing (loadConfig/
    // pushUiContext/currentNotesNs/notesFetch). Reads `state` + listeners at
    // load -> after app.js; loaded early in the post-app.js group.
    name: 'work-items',
    entry: path.join(PUB, 'work-items', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'work-items.js'),
  },
  {
    // Command palette + quick-ask + repo-map modal. Reads `state` at load ->
    // after app.js. Consumes HOTKEY_ACTIONS (keyboard) + CLI_CONFIG (terminals).
    name: 'command-palette',
    entry: path.join(PUB, 'command-palette', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'command-palette.js'),
  },
  {
    // Ambient whisper: the proactive Stage-6 nudge line. Self-contained; reads
    // only global toast/openCmdPalette -> load after app.js. Checks
    // /api/symphonee/ambient/nudge on boot + window focus (no timer).
    name: 'ambient-whisper',
    entry: path.join(PUB, 'ambient-whisper', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'ambient-whisper.js'),
  },
  {
    // Symphonee Voice: speak() via ElevenLabs (server) or browser speechSynthesis
    // fallback, + the top-bar toggle. Self-contained; load after app.js.
    name: 'symphonee-voice',
    entry: path.join(PUB, 'symphonee-voice', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'symphonee-voice.js'),
  },
  {
    // Plugin host/shell surface. Source public/plugins/ (distinct from the
    // dashboard/plugins/ install dir). Reads `state` + listeners at load -> after app.js.
    name: 'plugins',
    entry: path.join(PUB, 'plugins', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'plugins.js'),
  },
  {
    // Settings panel + create-work-item modal. Reads `state` + DOMContentLoaded
    // at load -> after app.js. Owns the _aiInstalling Set (onboarding mutates it).
    name: 'settings',
    entry: path.join(PUB, 'settings', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'settings.js'),
  },
  {
    // In-app browser automation subsystem -- bundled from former parts/browser.js
    // + browser-tools.js + browser-views.js (one tightly-coupled unit). Reads
    // `state` + listeners at load -> after app.js.
    name: 'browser',
    entry: path.join(PUB, 'browser', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'browser.js'),
  },
  {
    // Desktop-app automation subsystem -- bundled from former parts/apps.js +
    // apps-step-builder.js (one tightly-coupled unit). Reads `state` + listeners
    // at load -> after app.js.
    name: 'apps-tab',
    entry: path.join(PUB, 'apps-tab', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'apps-tab.js'),
  },
  {
    // Orchestrator tab (cross-AI tasks/agents/dispatch). Reads `state` at load -> after app.js.
    name: 'orchestrator',
    entry: path.join(PUB, 'orchestrator', 'src', 'index.js'),
    outfile: path.join(PUB, 'js', 'orchestrator.js'),
  },
];

const banner = {
  js:
    '/* GENERATED by scripts/build-renderer.js -- do NOT edit.\n' +
    '   Source lives under dashboard/public/<name>/src/. Run `node scripts/build-renderer.js`. */',
};

/** @type {import('esbuild').BuildOptions} */
const baseOpts = {
  bundle: true,
  format: 'iife',        // classic <script> global scope, same as today
  platform: 'browser',
  target: 'es2020',
  minify: false,         // readability over size: reviewed + debugged in DevTools
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner,
};

// --- flat concatenation bundles ----------------------------------------------
// Parts join with '' (they are offset-exact slices), so the output is identical
// to the original. No IIFE wrap, no banner injected into the body: the served
// file must stay byte-faithful so the flat global scope is preserved exactly.
const CONCAT_BUNDLES = [
  {
    name: 'app',
    shellDir: path.join(PUB, 'app', 'src', 'shell'),
    outfile: path.join(PUB, 'js', 'app.js'),
  },
];

function buildConcat(b) {
  const manifest = JSON.parse(fs.readFileSync(path.join(b.shellDir, 'manifest.json'), 'utf8'));
  const out = manifest.map((p) => fs.readFileSync(path.join(b.shellDir, p), 'utf8')).join('');
  fs.writeFileSync(b.outfile, out);
  console.log(`[build-renderer] ${b.name} (concat ${manifest.length} shell modules) -> ${path.relative(ROOT, b.outfile)}`);
}

async function buildOnce() {
  for (const b of ESBUILD_BUNDLES) {
    await esbuild.build({ ...baseOpts, entryPoints: [b.entry], outfile: b.outfile });
    console.log(`[build-renderer] ${b.name} -> ${path.relative(ROOT, b.outfile)}`);
  }
  for (const b of CONCAT_BUNDLES) buildConcat(b);
}

async function watch() {
  for (const b of ESBUILD_BUNDLES) {
    const ctx = await esbuild.context({ ...baseOpts, entryPoints: [b.entry], outfile: b.outfile });
    await ctx.watch();
    console.log(`[build-renderer] watching ${b.name}`);
  }
  for (const b of CONCAT_BUNDLES) {
    fs.watch(b.shellDir, { persistent: true }, () => { try { buildConcat(b); } catch (e) { console.error(e.message); } });
    buildConcat(b);
    console.log(`[build-renderer] watching ${b.name} parts`);
  }
  console.log('[build-renderer] watch mode -- Ctrl+C to stop');
}

const isWatch = process.argv.includes('--watch');
(isWatch ? watch() : buildOnce()).catch((err) => {
  console.error('[build-renderer] FAILED:', err.message || err);
  process.exit(1);
});
