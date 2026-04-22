// DesktopDriver - Windows-only thin wrapper around @nut-tree-fork/nut-js
// for input + screenshot, and powershell.exe for HWND enumeration,
// foreground activation, and window-rect queries.
//
// All coordinates the agent sees are window-relative. Translation to
// absolute screen coordinates happens inside this module.

const { spawn } = require('child_process');

let nut = null;
function loadNut() {
  if (nut) return nut;
  nut = require('@nut-tree-fork/nut-js');
  // Fast cadence; the agent is latency-bound anyway.
  nut.mouse.config.mouseSpeed = 1200;
  nut.keyboard.config.autoDelayMs = 8;
  return nut;
}

function runPs(script, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-Command', script
    ]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`powershell timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.stdout.on('data', c => out += c);
    p.stderr.on('data', c => err += c);
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `powershell exit ${code}`));
      resolve(out);
    });
  });
}

// Inline C# once; SetForegroundWindow / GetWindowRect / ShowWindow / IsIconic.
const WIN32_TYPES = `
Add-Type -Name SyWin32 -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr h, int c);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int left; public int top; public int right; public int bottom; }
"@ -ErrorAction SilentlyContinue
`;

const DENY_TITLE_RE = /password|1password|bitwarden|keychain|banking|bank of|paypal/i;

function assertAllowed(title) {
  if (title && DENY_TITLE_RE.test(title)) {
    const e = new Error('window is on the deny list');
    e.code = 'deny_listed';
    throw e;
  }
}

// Coarse cache to keep listWindows cheap when called repeatedly.
let _listCache = null;
let _listCacheAt = 0;
const LIST_CACHE_MS = 500;

async function listWindows({ force = false } = {}) {
  const now = Date.now();
  if (!force && _listCache && (now - _listCacheAt) < LIST_CACHE_MS) return _listCache;

  const script = `
${WIN32_TYPES}
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
$out = foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  $r = New-Object Sy.SyWin32+RECT
  [void][Sy.SyWin32]::GetWindowRect($h, [ref]$r)
  [PSCustomObject]@{
    hwnd = [int64]$h
    pid = $p.Id
    processName = $p.ProcessName
    title = $p.MainWindowTitle
    isMinimized = [Sy.SyWin32]::IsIconic($h)
    rect = @{ x = $r.left; y = $r.top; w = ($r.right - $r.left); h = ($r.bottom - $r.top) }
  }
}
$out | ConvertTo-Json -Depth 4 -Compress
`;
  const raw = await runPs(script);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = []; }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  _listCache = list;
  _listCacheAt = now;
  return list;
}

async function findWindow(hwnd) {
  const list = await listWindows({ force: true });
  const w = list.find(x => String(x.hwnd) === String(hwnd));
  if (!w) {
    const e = new Error(`hwnd ${hwnd} not found`);
    e.code = 'window_gone';
    throw e;
  }
  assertAllowed(w.title);
  return w;
}

async function focusWindow(hwnd) {
  const w = await findWindow(hwnd);
  const script = `
${WIN32_TYPES}
$h = [System.IntPtr]${w.hwnd}
# 9 = SW_RESTORE
[void][Sy.SyWin32]::ShowWindow($h, 9)
[void][Sy.SyWin32]::SetForegroundWindow($h)
`;
  await runPs(script);
  // Give Windows a beat to actually move focus.
  await new Promise(r => setTimeout(r, 80));
  return { ok: true, hwnd: w.hwnd, title: w.title };
}

async function getWindowRect(hwnd) {
  const w = await findWindow(hwnd);
  return { ...w.rect, hwnd: w.hwnd, title: w.title, isMinimized: w.isMinimized };
}

function translate({ x, y, rect }) {
  return { x: rect.x + Math.round(x), y: rect.y + Math.round(y) };
}

async function screenshotWindow(hwnd, { format = 'jpeg', quality = 60 } = {}) {
  const w = await findWindow(hwnd);
  if (w.isMinimized) {
    return { error: 'window_minimized', hwnd: w.hwnd };
  }
  if (w.rect.w <= 0 || w.rect.h <= 0) {
    return { error: 'window_degenerate_rect', hwnd: w.hwnd, rect: w.rect };
  }
  const n = loadNut();
  const region = new n.Region(w.rect.x, w.rect.y, w.rect.w, w.rect.h);
  const img = await n.screen.grabRegion(region);
  // img.data is raw BGRA. Swizzle into RGBA and hand to jimp (a nut-js dep).
  const Jimp = require('jimp');
  const src = img.data;
  const jimg = new Jimp(img.width, img.height);
  const dst = jimg.bitmap.data;
  for (let i = 0; i < src.length; i += 4) {
    dst[i]     = src[i + 2];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i];
    dst[i + 3] = src[i + 3];
  }
  const mime = format === 'png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG;
  if (format !== 'png') jimg.quality(Math.max(1, Math.min(100, quality | 0)));
  const buf = await jimg.getBufferAsync(mime);
  return {
    base64: buf.toString('base64'),
    mimeType: mime,
    width: img.width,
    height: img.height,
    rect: w.rect,
    capturedAt: Date.now()
  };
}

async function verifyStableRect(hwnd, originalRect) {
  const current = await getWindowRect(hwnd);
  const dx = Math.abs(current.x - originalRect.x);
  const dy = Math.abs(current.y - originalRect.y);
  if (dx > 50 || dy > 50) {
    const e = new Error('window moved since last screenshot');
    e.code = 'window_moved';
    e.currentRect = current;
    throw e;
  }
  return current;
}

async function click(xOrOpts, y, opts = {}) {
  // Two call shapes:
  //   click({ x, y, hwnd, button, double })
  //   click(x, y, { hwnd, button, double })
  let x, hwnd, button, dbl;
  if (typeof xOrOpts === 'object' && xOrOpts !== null) {
    ({ x, y, hwnd, button = 'left', double: dbl = false } = xOrOpts);
  } else {
    x = xOrOpts;
    ({ hwnd, button = 'left', double: dbl = false } = opts);
  }
  const n = loadNut();
  let abs = { x, y };
  if (hwnd != null) {
    const w = await findWindow(hwnd);
    await focusWindow(hwnd);
    abs = translate({ x, y, rect: w.rect });
  }
  await n.mouse.setPosition(new n.Point(abs.x, abs.y));
  const btn = button === 'right' ? n.Button.RIGHT : button === 'middle' ? n.Button.MIDDLE : n.Button.LEFT;
  if (dbl) await n.mouse.doubleClick(btn);
  else await n.mouse.click(btn);
  return { ok: true, at: abs };
}

async function mouseMove(xOrOpts, y, opts = {}) {
  let x, hwnd, smooth;
  if (typeof xOrOpts === 'object' && xOrOpts !== null) {
    ({ x, y, hwnd, smooth = false } = xOrOpts);
  } else {
    x = xOrOpts;
    ({ hwnd, smooth = false } = opts);
  }
  const n = loadNut();
  let abs = { x, y };
  if (hwnd != null) {
    const w = await findWindow(hwnd);
    await focusWindow(hwnd);
    abs = translate({ x, y, rect: w.rect });
  }
  if (smooth) {
    await n.mouse.move(n.straightTo(new n.Point(abs.x, abs.y)));
  } else {
    await n.mouse.setPosition(new n.Point(abs.x, abs.y));
  }
  return { ok: true, at: abs };
}

async function drag(fromX, fromY, toX, toY, { hwnd } = {}) {
  const n = loadNut();
  let from = { x: fromX, y: fromY };
  let to = { x: toX, y: toY };
  if (hwnd != null) {
    const w = await findWindow(hwnd);
    await focusWindow(hwnd);
    from = translate({ x: fromX, y: fromY, rect: w.rect });
    to = translate({ x: toX, y: toY, rect: w.rect });
  }
  await n.mouse.setPosition(new n.Point(from.x, from.y));
  await n.mouse.pressButton(n.Button.LEFT);
  await n.mouse.move(n.straightTo(new n.Point(to.x, to.y)));
  await n.mouse.releaseButton(n.Button.LEFT);
  return { ok: true, from, to };
}

async function scroll(dx, dy, { hwnd } = {}) {
  const n = loadNut();
  if (hwnd != null) await focusWindow(hwnd);
  if (dy) {
    if (dy > 0) await n.mouse.scrollDown(dy);
    else await n.mouse.scrollUp(-dy);
  }
  if (dx) {
    if (dx > 0) await n.mouse.scrollRight(dx);
    else await n.mouse.scrollLeft(-dx);
  }
  return { ok: true, dx, dy };
}

async function type(text, { hwnd } = {}) {
  const n = loadNut();
  if (hwnd != null) await focusWindow(hwnd);
  await n.keyboard.type(String(text));
  return { ok: true };
}

// Map strings like "Ctrl+Shift+S" to nut.js Key enum plus modifiers.
function parseKeyCombo(combo) {
  const n = loadNut();
  const parts = String(combo).split('+').map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key combo');
  const keyName = parts.pop();
  const modMap = {
    ctrl: n.Key.LeftControl, control: n.Key.LeftControl,
    shift: n.Key.LeftShift,
    alt: n.Key.LeftAlt,
    win: n.Key.LeftSuper, windows: n.Key.LeftSuper, super: n.Key.LeftSuper, meta: n.Key.LeftSuper
  };
  const mods = parts.map(p => {
    const k = modMap[p.toLowerCase()];
    if (k == null) throw new Error(`unknown modifier: ${p}`);
    return k;
  });
  // Key normalization.
  const specialMap = {
    enter: 'Return', return: 'Return',
    esc: 'Escape', escape: 'Escape',
    space: 'Space', spacebar: 'Space',
    tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    insert: 'Insert', ins: 'Insert'
  };
  const lowered = keyName.toLowerCase();
  let resolved;
  if (specialMap[lowered] && n.Key[specialMap[lowered]] != null) {
    resolved = n.Key[specialMap[lowered]];
  } else if (/^f\d{1,2}$/i.test(keyName)) {
    resolved = n.Key[keyName.toUpperCase()];
  } else if (keyName.length === 1) {
    const ch = keyName.toUpperCase();
    resolved = n.Key[ch] != null ? n.Key[ch] : n.Key[`Num${ch}`];
  } else {
    resolved = n.Key[keyName];
  }
  if (resolved == null) throw new Error(`unknown key: ${keyName}`);
  return { mods, key: resolved };
}

async function key(combo, { hwnd } = {}) {
  const n = loadNut();
  if (hwnd != null) await focusWindow(hwnd);
  const { mods, key: k } = parseKeyCombo(combo);
  await n.keyboard.pressKey(...mods, k);
  await n.keyboard.releaseKey(...mods, k);
  return { ok: true, combo };
}

async function waitMs(ms) {
  const n = Math.max(0, Math.min(60000, ms | 0));
  await new Promise(r => setTimeout(r, n));
  return { ok: true, ms: n };
}

async function calibrateMouseLook({ hwnd, testDeltaPx = 200 }) {
  const before = await screenshotWindow(hwnd);
  const n = loadNut();
  await focusWindow(hwnd);
  const pos = await n.mouse.getPosition();
  await n.mouse.setPosition(new n.Point(pos.x + testDeltaPx, pos.y));
  await waitMs(150);
  const after = await screenshotWindow(hwnd);
  return { before, after, deltaPx: testDeltaPx };
}

let _stopped = false;
function stop() {
  _stopped = true;
  // nut-js has no in-flight abort; best effort is to drop the cache so the
  // next call re-enumerates before acting.
  _listCache = null;
}

function isStopped() { return _stopped; }
function resetStopped() { _stopped = false; }

module.exports = {
  listWindows,
  focusWindow,
  getWindowRect,
  screenshotWindow,
  verifyStableRect,
  click,
  mouseMove,
  drag,
  scroll,
  type,
  key,
  waitMs,
  calibrateMouseLook,
  stop,
  isStopped,
  resetStopped,
  // Exposed for tests / advanced callers:
  _runPs: runPs,
  _parseKeyCombo: parseKeyCombo
};
