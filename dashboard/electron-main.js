/**
 * Electron main process — wraps the HTTP+WS server in a desktop window.
 */
const { app, BrowserWindow, nativeImage, dialog, screen } = require('electron');
const path = require('path');

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
        backgroundColor: '#0a0f1a',
        title: 'DevOps Pilot',
        icon: nativeImage.createFromPath(path.join(__dirname, 'public', 'icon.ico')),
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#0c1220',
          symbolColor: '#c8d6e5',
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
    });

    startServer();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
