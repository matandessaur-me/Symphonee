/**
 * Electron main process — wraps the HTTP+WS server in a desktop window.
 */
const { app, BrowserWindow, nativeImage, nativeTheme, dialog, screen, shell, webContents: webContentsNS, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const trace = require('./startup-trace');
trace.mark('main:module-eval');

process.env.ELECTRON = '1';

const PORT = 3800;
const HOST = '127.0.0.1';

let win = null;
let splashShownAt = 0;
// Brand-min: how long the splash stays up AFTER it becomes visible, so the logo
// is not a jarring flash. Was 1500ms, which (combined with an ordering bug that
// applied the full floor from server-listening rather than from splash-visible)
// kept users on the splash ~2.1s after the server was already ready. The floor
// is measured from splash-visible (ready-to-show), not from server-listening.
const SPLASH_MIN_MS = 400;

// ── In-app browser automation driver (extracted to electron/webview-driver.js) ──
const { createWebviewDriver } = require('./electron/webview-driver');
const _webviewDriver = createWebviewDriver({ getWin: () => win });
const internalWebviewDriver = _webviewDriver.driver;


// ── Display preference persistence ──────────────────────────────────────
const displayPrefPath = path.join(__dirname, '..', 'config', 'display-pref.json');

function loadDisplayPref() {
  try {
    if (fs.existsSync(displayPrefPath)) {
      return JSON.parse(fs.readFileSync(displayPrefPath, 'utf8'));
    }
  } catch (_) { /* ignore corrupt file */ }
  return null;
}

function saveDisplayPref(displayId) {
  try {
    fs.writeFileSync(displayPrefPath, JSON.stringify({ displayId }), 'utf8');
  } catch (_) { /* best effort */ }
}

const { killStaleProcesses } = require('./electron/process-guard');

// ── GPU + window-survival switches (minimal, targeted) ──────────────────────
// Earlier versions of this file flipped on every GPU-acceleration knob in
// Chromium. On Intel UHD that over-subscribed the iGPU — the terminal's
// xterm-webgl renderer would die ('unavailable' card), Canvas2D paths
// were forced through a struggling iGPU instead of the CPU, and
// background apps competed with the foreground for the same compositor.
//
// Stripped back to ONLY what the Mind 2D / 3D graph actually needs (the
// WebGL it requests is GPU-accelerated by default in Electron — no flag
// needed for that), plus the focus-return survival flags that the user
// explicitly asked for.
//
// What we KEEP:
//   - ignore-gpu-blocklist         : without this, Chromium silently
//                                    drops to software rendering on some
//                                    Intel iGPU drivers, killing the 3D
//                                    graph's WebGL path. The Mind graph
//                                    is the one place GPU is essential.
//   - disable-renderer-backgrounding +
//     disable-backgrounding-occluded-windows
//                                  : keep Symphonee's compositor active
//                                    when the window is occluded/inactive
//                                    so alt-tab back doesn't show stale
//                                    or torn-down layers.
//
// What we DROPPED (and why):
//   - enable-gpu-rasterization     : forced ALL Canvas2D through the GPU;
//                                    Chromium's auto-decision is fine.
//   - enable-accelerated-2d-canvas : same reason.
//   - enable-zero-copy             : WebGL texture upload optimization
//                                    that's only useful when the iGPU is
//                                    NOT the bottleneck. On Intel UHD it
//                                    just adds memory pressure.
//   - use-angle=gl                 : forced the OpenGL backend on Windows;
//                                    D3D11 (the default) is actually faster
//                                    on Intel iGPUs.
//   - enable-features=WebGPU,SharedArrayBuffer : nothing in Symphonee
//                                    uses WebGPU.
//   - enable-accelerated-video-decode : irrelevant.
//   - disable-background-timer-throttling : was making background tabs
//                                    fight for CPU; the renderer-bg flag
//                                    above is sufficient.
//   - disable-features=CalculateNativeWinOcclusion : same.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance holds the lock. Check if it's actually alive.
  const http = require('http');
  const req = http.get(`http://${HOST}:${PORT}/api/ui/context`, { timeout: 2000 }, (res) => {
    // Server is alive -- the real instance is running, just focus it
    console.log('Another instance is running -- focusing it.');
    res.resume();
    res.on('end', () => { app.quit(); });
  });
  req.on('error', () => {
    // Server not responding -- zombie. Kill everything and relaunch.
    console.log('Stale instance detected -- killing and relaunching...');
    killStaleProcesses(PORT);
    setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('Stale instance detected (timeout) -- killing and relaunching...');
    killStaleProcesses(PORT);
    setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
  });
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.setAlwaysOnTop(true);
      win.focus();
      win.setAlwaysOnTop(false);
    }
  });

  // Track any <webview> webContents so the browser-agent driver can find them.
  // Browser appearance is handled by the Browser tab itself; do not inject a
  // global light/dark override here or remote sites will render incorrectly.
  app.on('web-contents-created', (_event, contents) => {
    try {
      if (!contents || typeof contents.getType !== 'function') return;
      if (contents.getType() === 'webview') {
        _webviewDriver.setWebviewContents(contents);
        _webviewDriver.preferLightColorScheme(contents);
        contents.on('did-start-navigation', () => { _webviewDriver.preferLightColorScheme(contents); });
        contents.on('destroyed', () => { _webviewDriver.clearWebviewContents(contents); });
      }
    } catch (_) {}
  });

  app.whenReady().then(async () => {
    trace.mark('main:whenReady');
    // Create the main window FIRST and point it at splash.html on disk so
    // the user sees the brand mark immediately. We swap to the dashboard
    // URL once the HTTP server is listening (with a CSS fade in splash.html).
    //
    // Force DWM to paint new windows' client area dark BEFORE the renderer's
    // first frame arrives. Without this, Windows paints the unrendered
    // BrowserWindow with the system-default light background for 1-2 frames
    // on slow GPU/driver combos, producing a visible white flash before the
    // splash (#1a1a1a) takes over. BrowserWindow.backgroundColor only
    // governs the Chromium compositor, not DWM's pre-paint.
    try { nativeTheme.themeSource = 'dark'; } catch (_) {}
    {
      const displays = screen.getAllDisplays();
      const pref = loadDisplayPref();
      const preferredDisplay = pref
        ? displays.find(d => d.id === pref.displayId) || screen.getPrimaryDisplay()
        : screen.getPrimaryDisplay();
      const { x, y, width, height } = preferredDisplay.workArea;
      win = new BrowserWindow({
        x, y, width, height,
        autoHideMenuBar: true,
        title: 'Symphonee',
        backgroundColor: '#1a1a1a',
        show: false,
        icon: nativeImage.createFromPath(
          fs.existsSync(path.join(__dirname, 'public', 'icon.ico'))
            ? path.join(__dirname, 'public', 'icon.ico')
            : path.join(__dirname, 'public', 'icon.png')
        ),
        titleBarStyle: 'hidden',
        maximizable: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          // Explicit GPU paths for the 2D / 3D Mind graph views. webgl + offscreen
          // false make sure the renderer process draws to an on-screen surface
          // backed by the GPU compositor instead of a software canvas.
          webgl: true,
          offscreen: false,
          backgroundThrottling: false,
        },
      });
      // Do NOT call win.maximize() here. maximize() implicitly shows the
      // window even when it was created with show:false, exposing the
      // unpainted renderer (white) until the splash actually paints — on
      // slow renderer startup that's seconds of white, not a flash. Defer
      // both maximize and show into ready-to-show so the user only sees
      // the window once Chromium has produced its first frame.
      win.once('ready-to-show', () => {
        try {
          trace.mark('main:splash-ready-to-show');
          win.maximize();
          win.show();
          splashShownAt = Date.now();
        } catch (_) {}
      });
      win.on('closed', () => { win = null; });
      try { win.loadFile(path.join(__dirname, 'public', 'splash.html')); } catch (_) {}
      trace.mark('main:window-created');
    }

    // Wipe the renderer's HTTP cache on every launch. Electron's session
    // cache survives across app restarts and was serving stale index.html /
    // mind-ui.js even after the server had updated them, which broke the
    // dashboard repeatedly during development. Localhost-only assets so
    // the cache buys us nothing.
    trace.mark('main:clearCache:start');
    // Previously cleared the renderer HTTP cache on EVERY launch to dodge stale
    // dev assets. That forced a full cold re-fetch + re-parse of index.html /
    // mind-ui.js / xterm / the 3D graph libs every boot (~1.2s of renderer
    // time). The localhost assets only go stale while actively iterating on the
    // front-end, so this is now opt-in: set SY_CLEAR_CACHE=1 when editing
    // dashboard assets. Normal launches keep the warm cache.
    if (process.env.SY_CLEAR_CACHE === '1') {
      try {
        const { session } = require('electron');
        await session.defaultSession.clearCache();
        console.log('  Renderer cache cleared (SY_CLEAR_CACHE=1)');
      } catch (e) { console.log('  cache clear skipped:', e.message); }
    }
    trace.mark('main:clearCache:done');
    console.log('Electron ready, loading server...');
    let server, startServer, addRoute;
    try {
      trace.mark('main:server-require:start');
      ({ server, startServer, addRoute } = require('./server'));
      trace.mark('main:server-require:done');
    } catch (err) {
      dialog.showErrorBox('Symphonee - Startup Error',
        `Failed to load server modules.\n\n${err.message}\n\nTry running "npm install" in the dashboard folder.`);
      app.quit();
      return;
    }

    // Install the in-app webview driver so /api/browser/* routes drive the
    // Browser tab instead of launching a system Edge/Chrome window. Safe to
    // call even if browser-agent was skipped (setter is a no-op then).
    try {
      const { setActiveBrowserDriver } = require('./browser-agent');
      setActiveBrowserDriver(internalWebviewDriver);
      console.log('  Browser automation bound to in-app webview');
    } catch (err) {
      console.log('  Browser driver install skipped:', err.message);
    }

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} in use -- killing stale processes and relaunching...`);
        if (killStaleProcesses(PORT)) {
          setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
          return;
        }
        dialog.showErrorBox('Symphonee', `Port ${PORT} is already in use.\n\nClose any other Symphonee instances and try again.`);
      } else {
        dialog.showErrorBox('Server Error', err.message);
      }
      app.quit();
    });

    // ── Switch-screen API (Electron only) ──────────────────────────────
    addRoute('POST', '/api/switch-screen', (req, res) => {
      if (!win) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No window' }));
      }
      const displays = screen.getAllDisplays();
      if (displays.length < 2) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ switched: false, reason: 'Only one display' }));
      }
      const currentBounds = win.getBounds();
      const currentDisplay = screen.getDisplayMatching(currentBounds);
      const currentIdx = displays.findIndex(d => d.id === currentDisplay.id);
      const nextIdx = (currentIdx + 1) % displays.length;
      const next = displays[nextIdx];
      const { x, y } = next.workArea;
      // Move to the target display first, then maximize to fill it
      win.setBounds({ x, y, width: 800, height: 600 });
      win.maximize();
      saveDisplayPref(next.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ switched: true, display: nextIdx + 1, total: displays.length }));
    });

    addRoute('GET', '/api/screen-info', (req, res) => {
      const displays = screen.getAllDisplays();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: displays.length }));
    });

    // ── Check for updates (git fetch + compare) ───────────────────────
    addRoute('GET', '/api/check-updates', (req, res) => {
      const { execSync } = require('child_process');
      const repoRoot = path.resolve(__dirname, '..');
      try {
        // Fetch latest from origin (quiet, no output)
        execSync('git fetch origin', { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
        // Always compare against origin/master regardless of current branch
        const localHead = execSync('git rev-parse master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        const remoteHead = execSync('git rev-parse origin/master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        // Count commits master is behind origin/master
        const behind = execSync('git rev-list --count master..origin/master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        const behindCount = parseInt(behind, 10) || 0;
        // Get short summary of what's new
        let summary = '';
        if (behindCount > 0) {
          summary = execSync('git log --oneline master..origin/master', { cwd: repoRoot, encoding: 'utf8' }).trim();
        }
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updateAvailable: behindCount > 0, behind: behindCount, branch, summary }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updateAvailable: false, error: err.message }));
      }
    });

    // ── Apply update (stash + fetch + pull + install + relaunch) ───────
    addRoute('POST', '/api/update-app', (req, res) => {
      const { execSync } = require('child_process');
      const repoRoot = path.resolve(__dirname, '..');
      try {
        // Stash any local changes (safe to ignore if nothing to stash)
        try { execSync('git stash --include-untracked', { cwd: repoRoot, encoding: 'utf8', timeout: 15000 }); } catch (_) {}
        // Fetch, checkout master, pull, install
        execSync('git checkout master', { cwd: repoRoot, encoding: 'utf8', timeout: 10000 });
        execSync('git fetch origin', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        execSync('git pull', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        execSync('npm install', { cwd: repoRoot, encoding: 'utf8', timeout: 120000 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'updated' }));
        setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err.message || '').substring(0, 500) }));
      }
    });

    // ── Restart app (relaunch Electron) ───────────────────────────────
    addRoute('POST', '/api/restart-app', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
    });

    // ── Browse for folder (native OS dialog) ────────────────────────────
    addRoute('POST', '/api/browse-folder', async (req, res) => {
      if (!win) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No window' }));
      }
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select Repository Folder',
      });
      if (result.canceled || !result.filePaths.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ canceled: true }));
      }
      const folderPath = result.filePaths[0];
      const folderName = path.basename(folderPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ canceled: false, path: folderPath, name: folderName }));
    });

    // ── Window controls (custom title bar) ───────────────────────────
    addRoute('POST', '/api/window/minimize', (req, res) => {
      if (win) win.minimize();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    addRoute('POST', '/api/window/close', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      if (win) win.close();
    });

    // ── Browser emulation + issues (CDP-backed) ──────────────────────────
    const _reBody = (req) => new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c.toString(); });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
      req.on('error', () => resolve({}));
    });
    const _reJson = (res, code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // In-memory store of observed issues per webContents.
    const _browserIssueState = new WeakMap();
    function _getIssueState(wc) {
      let s = _browserIssueState.get(wc);
      if (!s) {
        s = { listening: false, issues: [] };
        _browserIssueState.set(wc, s);
      }
      return s;
    }

    addRoute('POST', '/api/browser/emulate/device', async (req, res) => {
      try {
        const body = await _reBody(req);
        const wc = await _webviewDriver.ensureBrowserTab();
        await _webviewDriver.ensureDebugger(wc);
        if (body.reset) {
          await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
          await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
          return _reJson(res, 200, { ok: true, reset: true });
        }
        const width = Math.max(50, Math.min(4096, Number(body.width) || 390));
        const height = Math.max(50, Math.min(4096, Number(body.height) || 844));
        const dpr = Math.max(0.5, Math.min(5, Number(body.deviceScaleFactor) || 2));
        const mobile = body.mobile !== false;
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: dpr, mobile,
        });
        await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: !!body.touch || mobile,
        });
        _reJson(res, 200, { ok: true, width, height, dpr, mobile });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/emulate/media', async (req, res) => {
      try {
        const body = await _reBody(req);
        const wc = await _webviewDriver.ensureBrowserTab();
        await _webviewDriver.ensureDebugger(wc);
        const features = [];
        if (body.colorScheme) features.push({ name: 'prefers-color-scheme', value: body.colorScheme });
        if (body.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: body.reducedMotion });
        if (body.contrast) features.push({ name: 'prefers-contrast', value: body.contrast });
        if (body.forcedColors) features.push({ name: 'forced-colors', value: body.forcedColors });
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
          media: body.media || '',
          features,
        });
        _reJson(res, 200, { ok: true, features });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/emulate/throttle', async (req, res) => {
      try {
        const body = await _reBody(req);
        const wc = await _webviewDriver.ensureBrowserTab();
        await _webviewDriver.ensureDebugger(wc);
        if (body.cpuRate != null) {
          await wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: Math.max(1, Math.min(20, Number(body.cpuRate) || 1)) });
        }
        if (body.network) {
          const presets = {
            'offline':      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
            'slow-3g':      { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
            'fast-3g':      { offline: false, latency: 150, downloadThroughput: 180 * 1024, uploadThroughput: 85 * 1024 },
            '4g':           { offline: false, latency: 40, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 1.5 * 1024 * 1024 },
            'no-throttle':  { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
          };
          const p = presets[body.network] || presets['no-throttle'];
          await wc.debugger.sendCommand('Network.enable').catch(() => {});
          await wc.debugger.sendCommand('Network.emulateNetworkConditions', p);
        }
        _reJson(res, 200, { ok: true });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/issues/start', async (req, res) => {
      try {
        const wc = await _webviewDriver.ensureBrowserTab();
        await _webviewDriver.ensureDebugger(wc);
        const state = _getIssueState(wc);
        if (!state.listening) {
          wc.debugger.on('message', (_event, method, params) => {
            if (method === 'Audits.issueAdded' && params && params.issue) {
              state.issues.push({ at: Date.now(), ...params.issue });
              if (state.issues.length > 500) state.issues.splice(0, state.issues.length - 500);
            }
          });
          state.listening = true;
        }
        await wc.debugger.sendCommand('Audits.enable').catch(() => {});
        _reJson(res, 200, { ok: true });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('GET', '/api/browser/issues', async (req, res) => {
      try {
        const wc = await _webviewDriver.ensureBrowserTab();
        const state = _getIssueState(wc);
        _reJson(res, 200, { issues: state.issues.slice(-200), count: state.issues.length });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/issues/clear', async (req, res) => {
      try {
        const wc = await _webviewDriver.ensureBrowserTab();
        const state = _getIssueState(wc);
        state.issues = [];
        _reJson(res, 200, { ok: true });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    server.on('listening', () => {
      trace.mark('main:server-listening');
      trace.flush('listening');
      console.log('Server listening, swapping splash to dashboard...');
      const appUrl = `http://${HOST}:${PORT}`;

      // The main window already exists and is showing splash.html. Wait for
      // the splash minimum, then navigate the same window to the dashboard.
      const swap = () => {
        if (!win || win.isDestroyed()) return;
        const sinceVisible = splashShownAt ? Date.now() - splashShownAt : 0;
        trace.mark('main:splash-swap', { splashFloorMs: SPLASH_MIN_MS, sinceSplashVisibleMs: sinceVisible });
        try { win.loadURL(appUrl); } catch (_) {}
      };
      // Swap once BOTH conditions hold: the server is listening (we are in that
      // handler) AND the splash has been visible for the brand-min floor. The
      // floor is measured from splash-visible (ready-to-show), not from now --
      // otherwise a server that becomes ready before the window paints would
      // restart the full floor from listening (the original bug). If the splash
      // is not visible yet, defer scheduling until ready-to-show fires; the
      // splashShownAt-setter is registered first, so it runs before this.
      const scheduleSwap = () => {
        const elapsed = splashShownAt ? Date.now() - splashShownAt : 0;
        setTimeout(swap, Math.max(0, SPLASH_MIN_MS - elapsed));
      };
      if (splashShownAt) scheduleSwap();
      else win.once('ready-to-show', scheduleSwap);

      // Re-attach the link/navigation handlers on the live window.
      if (win && !win.isDestroyed()) {
        // Mark when the dashboard (not the splash) finishes loading in the
        // renderer. This closes the end-to-end boot timeline and promotes the
        // trace to an indexed boot-<n>.json.
        win.webContents.on('did-finish-load', () => {
          try {
            const u = win.webContents.getURL() || '';
            if (u.startsWith(appUrl)) {
              trace.mark('main:dashboard-did-finish-load');
              trace.flush('dashboard-loaded');
              // Signal the server that the UI is up so it can run heavy deferred
              // boot work (Mind refresh, brain setup, quote regen) AFTER the
              // render instead of competing with it.
              try {
                const http = require('http');
                const rq = http.request({ hostname: HOST, port: PORT, path: '/api/internal/app-ready', method: 'POST', headers: { 'Content-Length': 0 } }, r => { r.on('data', () => {}); r.on('end', () => {}); });
                rq.on('error', () => {});
                rq.end();
              } catch (_) {}
            }
          } catch (_) {}
        });
        win.webContents.setWindowOpenHandler(({ url }) => {
          if (url.startsWith(appUrl)) return { action: 'allow' };
          shell.openExternal(url);
          return { action: 'deny' };
        });
        win.webContents.on('will-navigate', (event, url) => {
          // Allow internal navigations (splash -> dashboard) and our own URL.
          if (url.startsWith(appUrl) || url.startsWith('file://')) return;
          event.preventDefault();
          shell.openExternal(url);
        });

        // ── Force whole-window repaint on focus return ───────────────────
        // User-reported bug: alt-tab back into Symphonee and the sidebars
        // and header stay pure black until the user clicks something. The
        // 3D canvas / xterm both paint themselves via rAF so they show up,
        // but static HTML layers (sidebars, tab bar, top header) wait for
        // a layout invalidation that never arrives — the OS compositor
        // is still presenting the pre-blur cached layer.
        //
        // webContents.invalidate() forces Chromium to mark the entire
        // page dirty and recomposite. Wiring it to focus + show + restore
        // covers every "comes back into view" path:
        //   - focus    : alt-tab, click on the window
        //   - show     : workspace switch, app switcher
        //   - restore  : un-minimize
        const repaintWindow = () => {
          try { if (win && !win.isDestroyed()) win.webContents.invalidate(); } catch (_) {}
        };
        win.on('focus', repaintWindow);
        win.on('show', repaintWindow);
        win.on('restore', repaintWindow);
      }
    });

    // ── Apps agent panic hotkey ────────────────────────────────────────
    // Ctrl+Alt+Shift+X from anywhere on the desktop tears down every live
    // Apps session and kills any in-flight input emission. This is the
    // emergency stop for pixel-level automation.
    try {
      const ok = globalShortcut.register('CommandOrControl+Alt+Shift+X', () => {
        try {
          const http = require('http');
          const req = http.request({
            hostname: '127.0.0.1', port: PORT, path: '/api/apps/panic', method: 'POST',
            headers: { 'content-length': 0 },
          }, (r) => { r.on('data', () => {}); r.on('end', () => {}); });
          req.on('error', () => {});
          req.end();
        } catch (_) {}
        try {
          if (win && !win.isDestroyed()) {
            win.show();
            win.focus();
            win.webContents.send('apps-panic-hotkey');
          }
        } catch (_) {}
      });
      if (!ok) console.warn('  Apps panic hotkey (Ctrl+Alt+Shift+X) not registered');
      else console.log('  Apps panic hotkey registered: Ctrl+Alt+Shift+X');
    } catch (e) {
      console.warn('  Apps panic hotkey failed:', e.message);
    }

    startServer();
  }).catch((err) => {
    dialog.showErrorBox('Symphonee - Startup Error',
      `An unexpected error occurred during startup.\n\n${err.message}`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (_) {}
  });
}
