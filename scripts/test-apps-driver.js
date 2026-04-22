// Phase 1 integration test for DesktopDriver.
// Launches Notepad, focuses it, types a string, clicks where the File
// menu should be, and writes a JPEG of the Notepad window to disk.
//
// Run: node scripts/test-apps-driver.js
//
// Success = exit 0 with "OK" on the last line. Run five times in a row.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const driver = require(path.join(__dirname, '..', 'dashboard', 'apps-driver.js'));

const OUT_DIR = path.join(__dirname, '..', '.ai-workspace', 'phase1-out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...a) { console.log('[test-apps-driver]', ...a); }

async function launchNotepad() {
  log('launching notepad');
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
  // Wait up to 5s for the window to appear.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await driver.waitMs(150);
    const list = await driver.listWindows({ force: true });
    const np = list.find(w =>
      w.processName.toLowerCase() === 'notepad' && !w.isMinimized
    );
    if (np) return np;
  }
  throw new Error('notepad did not appear within 5s');
}

async function closeNotepad(hwnd) {
  // Alt+F4 on the focused Notepad; accept the discard dialog with Alt+N.
  try {
    await driver.focusWindow(hwnd);
    await driver.key('Alt+F4', { hwnd });
    await driver.waitMs(300);
    // Notepad's "Don't save" dialog: send Alt+N.
    await driver.key('Alt+N');
  } catch (_) { /* ignore */ }
}

(async () => {
  let np;
  try {
    np = await launchNotepad();
    log('notepad hwnd', np.hwnd, 'title', np.title, 'rect', np.rect);

    log('focusing');
    await driver.focusWindow(np.hwnd);

    log('typing');
    await driver.type('hello from symphonee apps driver\n', { hwnd: np.hwnd });
    await driver.waitMs(250);

    log('taking first screenshot');
    const shot1 = await driver.screenshotWindow(np.hwnd, { format: 'jpeg', quality: 70 });
    if (shot1.error) throw new Error('screenshot failed: ' + shot1.error);
    const p1 = path.join(OUT_DIR, `notepad-typed-${Date.now()}.jpg`);
    fs.writeFileSync(p1, Buffer.from(shot1.base64, 'base64'));
    log('wrote', p1, `${shot1.width}x${shot1.height}`);

    log('opening File menu via Alt+F');
    await driver.key('Alt+F', { hwnd: np.hwnd });
    await driver.waitMs(400);

    log('taking second screenshot (menu should be open)');
    const shot2 = await driver.screenshotWindow(np.hwnd, { format: 'jpeg', quality: 70 });
    if (shot2.error) throw new Error('screenshot 2 failed: ' + shot2.error);
    const p2 = path.join(OUT_DIR, `notepad-menu-${Date.now()}.jpg`);
    fs.writeFileSync(p2, Buffer.from(shot2.base64, 'base64'));
    log('wrote', p2);

    log('closing menu with Escape');
    await driver.key('Escape', { hwnd: np.hwnd });
    await driver.waitMs(150);

    log('listWindows sample:');
    const list = await driver.listWindows({ force: true });
    log('total windows:', list.length);

    log('cleaning up');
    await closeNotepad(np.hwnd);

    console.log('OK');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message, e.stack);
    try { if (np) await closeNotepad(np.hwnd); } catch (_) {}
    process.exit(1);
  }
})();
