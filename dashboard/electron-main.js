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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('Another instance is running — focusing it.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
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
