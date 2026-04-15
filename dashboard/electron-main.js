/**
 * Electron main process — wraps the HTTP+WS server in a desktop window.
 */
const { app, BrowserWindow, nativeImage, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.ELECTRON = '1';

const PORT = 3800;
const HOST = '127.0.0.1';

let win = null;

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

/**
 * Kill anything holding port 3800 and/or any stale Electron instances.
 * Returns true if something was killed.
 */
function killStaleProcesses() {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  const myPid = process.pid;
  const pidsToKill = new Set();

  // Strategy 1: find PIDs holding port 3800 via netstat
  try {
    const out = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/\s(\d+)$/);
      if (m && Number(m[1]) !== myPid) pidsToKill.add(m[1]);
    }
  } catch (_) { /* no listeners on port -- fine */ }

  // Strategy 2: find other Electron instances by exe name
  try {
    const exeName = path.basename(process.execPath);
    const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/^"[^"]+","(\d+)"/);
      if (m && Number(m[1]) !== myPid) pidsToKill.add(m[1]);
    }
  } catch (_) {}

  if (pidsToKill.size) {
    try {
      execSync(`taskkill /F ${[...pidsToKill].map(p => '/PID ' + p).join(' ')}`, { encoding: 'utf8', timeout: 5000 });
      console.log('Killed stale process(es):', [...pidsToKill].join(', '));
      return true;
    } catch (_) {}
  }
  return false;
}

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
    killStaleProcesses();
    setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('Stale instance detected (timeout) -- killing and relaunching...');
    killStaleProcesses();
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

  app.whenReady().then(() => {
    console.log('Electron ready, loading server...');
    let server, startServer, addRoute;
    try {
      ({ server, startServer, addRoute } = require('./server'));
    } catch (err) {
      dialog.showErrorBox('Symphonee - Startup Error',
        `Failed to load server modules.\n\n${err.message}\n\nTry running "npm install" in the dashboard folder.`);
      app.quit();
      return;
    }

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} in use -- killing stale processes and relaunching...`);
        if (killStaleProcesses()) {
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

    server.on('listening', () => {
      console.log('Server listening, creating window...');

      // Pick the preferred display, fall back to primary if disconnected
      const displays = screen.getAllDisplays();
      const pref = loadDisplayPref();
      const preferredDisplay = pref
        ? displays.find(d => d.id === pref.displayId) || screen.getPrimaryDisplay()
        : screen.getPrimaryDisplay();
      const { x, y, width, height } = preferredDisplay.workArea;

      win = new BrowserWindow({
        x,
        y,
        width,
        height,
        autoHideMenuBar: true,
        title: 'Symphonee',
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
        },
      });
      win.maximize();
      win.loadURL(`http://${HOST}:${PORT}`);
      win.on('closed', () => { win = null; });

      // Open ALL links in system browser except our own app
      const appUrl = `http://${HOST}:${PORT}`;

      win.webContents.setWindowOpenHandler(({ url }) => {
        // Only allow our own app URL to open internally
        if (url.startsWith(appUrl)) {
          return { action: 'allow' };
        }
        // Everything else (including localhost dev servers) opens in system browser
        shell.openExternal(url);
        return { action: 'deny' };
      });

      win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(appUrl)) {
          event.preventDefault();
          shell.openExternal(url);
        }
      });
    });

    startServer();
  }).catch((err) => {
    dialog.showErrorBox('Symphonee - Startup Error',
      `An unexpected error occurred during startup.\n\n${err.message}`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
