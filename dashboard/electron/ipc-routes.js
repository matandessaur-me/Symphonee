'use strict';
// Electron-only HTTP API, registered after the server is ready: display
// switching, update check/apply, restart, native folder dialog, window controls,
// and CDP-backed browser emulation + issues. Extracted from electron-main.js
// (behavior-preserving). win is read live via getWin(); repoRoot, app, dialog,
// screen, the webview driver, and saveDisplayPref are injected.

const path = require('path');

function registerIpcRoutes(addRoute, { getWin, app, dialog, screen, repoRoot, webviewDriver, saveDisplayPref }) {
    // ── Switch-screen API (Electron only) ──────────────────────────────
    addRoute('POST', '/api/switch-screen', (req, res) => {
      const win = getWin();
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
        // `branch --show-current` works even on a no-commits repo, where
        // `rev-parse --abbrev-ref HEAD` errors ("ambiguous argument 'HEAD'").
        let branch = '';
        try { branch = execSync('git branch --show-current', { cwd: repoRoot, encoding: 'utf8' }).trim(); } catch (_) {}
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
      const win = getWin();
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
      const win = getWin();
      if (win) win.minimize();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    addRoute('POST', '/api/window/close', (req, res) => {
      const win = getWin();
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
        const wc = await webviewDriver.ensureBrowserTab();
        await webviewDriver.ensureDebugger(wc);
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
        const wc = await webviewDriver.ensureBrowserTab();
        await webviewDriver.ensureDebugger(wc);
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
        const wc = await webviewDriver.ensureBrowserTab();
        await webviewDriver.ensureDebugger(wc);
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
        const wc = await webviewDriver.ensureBrowserTab();
        await webviewDriver.ensureDebugger(wc);
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
        const wc = await webviewDriver.ensureBrowserTab();
        const state = _getIssueState(wc);
        _reJson(res, 200, { issues: state.issues.slice(-200), count: state.issues.length });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });

    addRoute('POST', '/api/browser/issues/clear', async (req, res) => {
      try {
        const wc = await webviewDriver.ensureBrowserTab();
        const state = _getIssueState(wc);
        state.issues = [];
        _reJson(res, 200, { ok: true });
      } catch (e) { _reJson(res, 500, { error: e.message || String(e) }); }
    });
}

module.exports = { registerIpcRoutes };
