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

function killZombiesAndRelaunch() {
  if (process.platform !== 'win32') {
    // Non-Windows: can't reliably detect/kill zombie processes, just quit
    dialog.showErrorBox('DevOps Pilot', 'Another instance appears to be running but is unresponsive.\nPlease close it manually and try again.');
    app.exit(1);
    return;
  }
  const { execSync } = require('child_process');
  const myPid = process.pid;
  const exeName = path.basename(process.execPath);
  let killed = false;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /FO CSV /NH`, { encoding: 'utf8' });
    const pids = [];
    for (const line of out.trim().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^"[^"]+","(\d+)"/);
      if (m) {
        const pid = Number(m[1]);
        if (pid && pid !== myPid) pids.push(String(pid));
      }
    }
    if (pids.length) {
      execSync(`taskkill /F ${pids.map(p => '/PID ' + p).join(' ')}`, { encoding: 'utf8' });
      killed = true;
    }
  } catch (_) { /* best effort */ }
  if (killed) {
    setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
  } else {
    dialog.showErrorBox('DevOps Pilot', 'Could not recover from a stale instance.\nPlease close any remaining DevOps Pilot processes and try again.');
    app.exit(1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  const http = require('http');
  const req = http.get(`http://${HOST}:${PORT}/api/ui/context`, { timeout: 2000 }, (res) => {
    // Server is alive -- the real instance is running, just focus it
    console.log('Another instance is running -- focusing it.');
    res.resume();
    res.on('end', () => { app.quit(); });
  });
  req.on('error', () => {
    // Server not responding -- zombie processes, kill and relaunch
    console.log('Stale instance detected -- killing zombies and relaunching...');
    killZombiesAndRelaunch();
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('Stale instance detected -- killing zombies and relaunching...');
    killZombiesAndRelaunch();
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
    const { server, startServer, addRoute } = require('./server');

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        dialog.showErrorBox('DevOps Pilot', `Port ${PORT} is already in use.\n\nAnother instance may be running.`);
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
      const { x, y, width, height } = next.workArea;
      win.setBounds({ x, y, width, height });
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
        // Get current branch
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
        // Check if remote tracking branch exists
        let remoteBranch;
        try {
          remoteBranch = execSync(`git rev-parse --abbrev-ref ${branch}@{upstream}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
        } catch (_) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ updateAvailable: false, reason: 'no-upstream' }));
        }
        // Count commits behind
        const behind = execSync(`git rev-list --count HEAD..${remoteBranch}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
        const behindCount = parseInt(behind, 10) || 0;
        // Get short summary of what's new
        let summary = '';
        if (behindCount > 0) {
          summary = execSync(`git log --oneline HEAD..${remoteBranch}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updateAvailable: behindCount > 0, behind: behindCount, branch, summary }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updateAvailable: false, error: err.message }));
      }
    });

    // ── Apply update (pull + install + relaunch) ─────────────────────
    addRoute('POST', '/api/update-app', (req, res) => {
      const { exec } = require('child_process');
      const repoRoot = path.resolve(__dirname, '..');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'updating' }));
      // Run pull + install, then relaunch
      exec('git pull && npm install', { cwd: repoRoot, timeout: 120000 }, (err) => {
        // Relaunch regardless -- if npm install fails the old code is still fine
        setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
      });
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

    server.on('listening', () => {
      console.log('Server listening, creating window...');
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;

      win = new BrowserWindow({
        width,
        height,
        resizable: false,
        movable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        backgroundColor: '#1a1a18',
        title: 'DevOps Pilot',
        icon: nativeImage.createFromPath(
          fs.existsSync(path.join(__dirname, 'public', 'icon.ico'))
            ? path.join(__dirname, 'public', 'icon.ico')
            : path.join(__dirname, 'public', 'icon.png')
        ),
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#1a1a18',
          symbolColor: '#e8e4dc',
          height: 32,
        },
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      win.setPosition(0, 0);
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
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
