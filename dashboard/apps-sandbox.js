// apps-sandbox.js — "stealth mode" launches that don't disturb the host desktop.
//
// What this is:
//   Spawn an app the normal way, then immediately move its window off-screen
//   to (-32000, -32000) and strip focus-stealing. The window keeps full GPU
//   rendering (so Electron / Chromium / D3D apps still work — unlike the
//   CreateDesktop alt-desktop approach), but the user never sees it on their
//   visible desktop. The agent then drives the window via UIA (no synthetic
//   mouse/keyboard) and captures with PrintWindow (works on off-screen HWNDs).
//
// What this is NOT:
//   A security sandbox. The app shares the user's filesystem, network, and
//   registry. Use a VM if you need real isolation. The win here is "the agent
//   can work while the user works without bumping the user's mouse" plus
//   "training runs that don't paint over the user's screen".
//
// All state is in-memory; restarting the server abandons stealth windows
// (they remain off-screen until the user explicitly destroys them or peeks
// them back). `listSandbox` reflects what we know about; `restoreOnscreen`
// undoes the off-screen move.

const path = require('path');
const driver = require('./apps-driver');

// hwnd -> { pid, processName, app, originalRect, launchedAt, peeked }
const _sandbox = new Map();
const OFFSCREEN_X = -32000;
const OFFSCREEN_Y = -32000;

function _runPs(script, opts) {
  // Re-use the driver's powershell runner via its private export.
  return driver._runPs(script, opts);
}

// Move a window to off-screen coords without activating it. SWP_NOACTIVATE
// (0x0010) | SWP_NOZORDER (0x0004) — keeps the user's active window
// untouched. WS_EX_NOACTIVATE is applied SEPARATELY via applyNoActivate()
// after a delay because Chromium-based apps (Spotify, Discord, Slack)
// suspend page rendering until the window has been activated at least
// once. Setting NOACTIVATE before first paint = blank window, empty UIA
// tree, agent stuck.
async function setOffscreen(hwnd) {
  const script = `
Add-Type -Name SyStealth -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr hAfter, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr h, int c);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int left; public int top; public int right; public int bottom; }
"@ -ErrorAction SilentlyContinue
$h = [System.IntPtr]::new([int64]${hwnd})
# If minimized, restore first so the move actually applies (Windows ignores
# SetWindowPos position on iconic windows in some cases).
if ([Sy.SyStealth]::IsIconic($h)) { [void][Sy.SyStealth]::ShowWindow($h, 9) }
$r = New-Object Sy.SyStealth+RECT
[void][Sy.SyStealth]::GetWindowRect($h, [ref]$r)
$w = $r.right - $r.left
$ht = $r.bottom - $r.top
# SWP_NOACTIVATE 0x0010 | SWP_NOZORDER 0x0004
[void][Sy.SyStealth]::SetWindowPos($h, [System.IntPtr]::Zero, ${OFFSCREEN_X}, ${OFFSCREEN_Y}, $w, $ht, 0x14)
[PSCustomObject]@{ x = $r.left; y = $r.top; w = $w; h = $ht } | ConvertTo-Json -Compress
`;
  const out = await _runPs(script, { timeoutMs: 4000 });
  const line = String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
  let rect = {};
  try { rect = JSON.parse(line); } catch (_) {}
  return rect;
}

// Add the WS_EX_NOACTIVATE bit to a window's ex-style. Call this AFTER the
// app has had time to paint its UI (~8s for Chromium cold start) so it
// doesn't trip Chromium's "skip rendering until activated" guard.
async function applyNoActivate(hwnd) {
  const script = `
Add-Type -Name SyNoAct -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
public static extern int GetWindowLong(System.IntPtr h, int i);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
public static extern int SetWindowLong(System.IntPtr h, int i, int v);
"@ -ErrorAction SilentlyContinue
$h = [System.IntPtr]::new([int64]${hwnd})
$ex = [Sy.SyNoAct]::GetWindowLong($h, -20)
[void][Sy.SyNoAct]::SetWindowLong($h, -20, ($ex -bor 0x08000000))
'0x{0:X8}' -f ($ex -bor 0x08000000)
`;
  try { await _runPs(script, { timeoutMs: 3000 }); } catch (_) {}
}

// Briefly bring the (still off-screen) sandboxed window to foreground so
// Chromium / Electron renderers bind their input context. The window
// remains at (-32000,-32000) the entire time — user sees nothing — but
// Windows considers it the foreground window for ~120ms, which is enough
// for Chromium's "first activation" guard to release the input pipeline.
// We restore the previous foreground after, so the user's active window
// is unchanged.
async function focusSeed(hwnd) {
  const script = `
Add-Type -Name SyFocSeed -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SendMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
"@ -ErrorAction SilentlyContinue
$h = [System.IntPtr]::new([int64]${hwnd})
$prev = [Sy.SyFocSeed]::GetForegroundWindow()
$pid = 0
$prevThread = [Sy.SyFocSeed]::GetWindowThreadProcessId($prev, [ref]$pid)
$myThread   = [Sy.SyFocSeed]::GetCurrentThreadId()
$tgtThread  = [Sy.SyFocSeed]::GetWindowThreadProcessId($h, [ref]$pid)
# Attach so the cross-process SetForegroundWindow is honored.
$ok1 = $false; $ok2 = $false
if ($prevThread -ne 0 -and $prevThread -ne $myThread) { $ok1 = [Sy.SyFocSeed]::AttachThreadInput($myThread, $prevThread, $true) }
if ($tgtThread  -ne 0 -and $tgtThread  -ne $myThread -and $tgtThread -ne $prevThread) { $ok2 = [Sy.SyFocSeed]::AttachThreadInput($myThread, $tgtThread, $true) }
try {
  [void][Sy.SyFocSeed]::BringWindowToTop($h)
  [void][Sy.SyFocSeed]::SetForegroundWindow($h)
  # WM_ACTIVATE = 0x0006. wParam: 1 = WA_ACTIVE.
  [void][Sy.SyFocSeed]::SendMessage($h, 0x0006, [System.IntPtr]::new(1), [System.IntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  # Hand foreground back to whatever was active before so user is undisturbed.
  if ($prev -ne [System.IntPtr]::Zero) { [void][Sy.SyFocSeed]::SetForegroundWindow($prev) }
} finally {
  if ($ok1) { [void][Sy.SyFocSeed]::AttachThreadInput($myThread, $prevThread, $false) }
  if ($ok2) { [void][Sy.SyFocSeed]::AttachThreadInput($myThread, $tgtThread,  $false) }
}
'seeded'
`;
  try { await _runPs(script, { timeoutMs: 4000 }); } catch (_) {}
}

async function clearNoActivate(hwnd) {
  const script = `
Add-Type -Name SyClrNA -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
public static extern int GetWindowLong(System.IntPtr h, int i);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
public static extern int SetWindowLong(System.IntPtr h, int i, int v);
"@ -ErrorAction SilentlyContinue
$h = [System.IntPtr]::new([int64]${hwnd})
$ex = [Sy.SyClrNA]::GetWindowLong($h, -20)
[void][Sy.SyClrNA]::SetWindowLong($h, -20, ($ex -band (-bnot 0x08000000)))
`;
  try { await _runPs(script, { timeoutMs: 3000 }); } catch (_) {}
}

// Move a window back to its remembered on-screen rect. If no rect is
// provided, centers on the primary monitor at a sensible default size.
// Caller is responsible for clearNoActivate() if the window had it applied.
async function restoreOnscreen(hwnd, rect) {
  const r = rect || { x: 100, y: 100, w: 1280, h: 800 };
  const script = `
Add-Type -Name SyStealthR -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr hAfter, int x, int y, int cx, int cy, uint flags);
"@ -ErrorAction SilentlyContinue
$h = [System.IntPtr]::new([int64]${hwnd})
# SWP_NOACTIVATE 0x0010 | SWP_NOZORDER 0x0004 — keep user's foreground window.
[void][Sy.SyStealthR]::SetWindowPos($h, [System.IntPtr]::Zero, ${r.x | 0}, ${r.y | 0}, ${r.w | 0}, ${r.h | 0}, 0x14)
`;
  await _runPs(script, { timeoutMs: 4000 });
}

// Launch an app and immediately stash it off-screen. Returns the same shape
// as driver.launchApp ({ hwnd, title, processName }) plus { sandbox: true }
// and the original rect (for restore / peek).
async function stealthLaunch({ id, path: appPath, name }) {
  // Reuse the driver's launchApp — it polls for the new HWND, applies the
  // existing process-name allowlist, and handles UWP shell:AppsFolder paths.
  const launched = await driver.launchApp({ id, path: appPath, name });

  // Race: the app's window has just appeared on the visible desktop. Move it
  // off-screen ASAP. Most apps paint within ~50ms; we add a tiny pause so the
  // first paint completes (otherwise some apps re-center themselves AFTER our
  // SetWindowPos and undo the stealth move).
  await new Promise(r => setTimeout(r, 120));
  const originalRect = await setOffscreen(launched.hwnd);

  const entry = {
    pid: null, // best-effort: launchApp doesn't return pid; fill from listWindows
    processName: launched.processName,
    app: name || launched.processName,
    originalRect,
    launchedAt: Date.now(),
    peeked: false,
    _reapplyTimer: null,
    _keepAliveTimer: null,
  };
  _sandbox.set(String(launched.hwnd), entry);

  // Phase 1 (0-4s): aggressive reapply. Some apps (Spotify, Discord) paint a
  // splash then the real window — keep yanking it off-screen at 500ms cadence
  // until we observe 6 consecutive ticks where it stayed put.
  let stays = 0;
  entry._reapplyTimer = setInterval(async () => {
    const live = _sandbox.get(String(launched.hwnd));
    if (!live || live.peeked) { clearInterval(entry._reapplyTimer); entry._reapplyTimer = null; return; }
    try {
      const w = await driver.getWindowRect(launched.hwnd).catch(() => null);
      if (!w) { clearInterval(entry._reapplyTimer); entry._reapplyTimer = null; return; }
      if (w.x > OFFSCREEN_X + 1000 || w.y > OFFSCREEN_Y + 1000) {
        await setOffscreen(launched.hwnd);
      } else {
        stays++;
        if (stays >= 6) { clearInterval(entry._reapplyTimer); entry._reapplyTimer = null; }
      }
    } catch (_) { clearInterval(entry._reapplyTimer); entry._reapplyTimer = null; }
  }, 500);
  setTimeout(() => {
    if (entry._reapplyTimer) { clearInterval(entry._reapplyTimer); entry._reapplyTimer = null; }
  }, 4000);

  // Phase 3 (~7s post-launch): focus-seed for Chromium-class apps. We
  // briefly bring the off-screen window to foreground (it's still at
  // -32000,-32000 so the user sees nothing), pump WM_ACTIVATE, then move
  // the foreground back. This forces Chromium to bind its render context
  // to the window's input thread — without it, Spotify's search input
  // is unreachable even after first paint. Native apps don't need this
  // and aren't harmed by it.
  setTimeout(async () => {
    if (!_sandbox.has(String(launched.hwnd))) return;
    try { await focusSeed(launched.hwnd); entry.focusSeeded = true; } catch (_) {}
  }, 7000);

  // Deferred WS_EX_NOACTIVATE — kills user-keystroke leak when the agent's
  // UIA SetFocus() makes the off-screen window foreground-able. Fires
  // AFTER first paint AND focus-seed; native apps don't care.
  entry._noActivateTimer = setTimeout(async () => {
    if (!_sandbox.has(String(launched.hwnd))) return;
    try { await applyNoActivate(launched.hwnd); entry.noActivateApplied = true; } catch (_) {}
  }, 8000);

  // Phase 2 (lifetime of entry): keep-alive un-minimizer. Some apps (Spotify
  // with its tray-icon, Teams, Discord) auto-minimize when they never get
  // foreground attention. UIA queries against an iconic window come back
  // empty, stalling the agent. This 1500ms ticker catches iconic transitions
  // and immediately restores via SW_SHOWNOACTIVATE then re-stashes off-screen.
  // Skipped while peeked so the user can see the window normally.
  entry._keepAliveTimer = setInterval(async () => {
    const live = _sandbox.get(String(launched.hwnd));
    if (!live) { clearInterval(entry._keepAliveTimer); entry._keepAliveTimer = null; return; }
    if (live.peeked) return;
    try {
      const w = await driver.getWindowRect(launched.hwnd).catch(() => null);
      if (!w) { clearInterval(entry._keepAliveTimer); entry._keepAliveTimer = null; return; }
      const wentIconic = w.isMinimized || (w.w > 0 && w.w < 200 && w.h < 60);
      const drifted = w.x > OFFSCREEN_X + 1000 || w.y > OFFSCREEN_Y + 1000;
      if (wentIconic) {
        // SW_SHOWNOACTIVATE = 4, then push off-screen at the original size.
        try {
          await driver._runPs(`Add-Type -Name SyKA -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr h, int c);
"@ -ErrorAction SilentlyContinue
[void][Sy.SyKA]::ShowWindow([System.IntPtr]::new([int64]${launched.hwnd}), 4)`, { timeoutMs: 2000 });
        } catch (_) {}
        await setOffscreen(launched.hwnd);
      } else if (drifted) {
        await setOffscreen(launched.hwnd);
      }
    } catch (_) {}
  }, 1500);


  return { ...launched, sandbox: true, originalRect };
}

// Take an existing on-screen window and stash it off-screen (e.g. user opens
// Spotify themselves, then asks Symphonee to drive it without disrupting).
async function adoptIntoSandbox(hwnd, { app } = {}) {
  const w = await driver.getWindowRect(hwnd);
  const originalRect = await setOffscreen(hwnd);
  // Adopted windows are already painted, so we can apply NOACTIVATE
  // immediately.
  await applyNoActivate(hwnd);
  _sandbox.set(String(hwnd), {
    pid: null,
    processName: w.processName || null,
    app: app || w.title || null,
    originalRect: originalRect.w ? originalRect : { x: w.x, y: w.y, w: w.w, h: w.h },
    launchedAt: Date.now(),
    peeked: false,
    adopted: true,
    noActivateApplied: true,
  });
  return { hwnd, sandboxed: true, originalRect };
}

// Briefly show a sandboxed window so the user can glance at it. Caller is
// responsible for `unpeek` once they're done — we don't auto-restore on a
// timer because the user might want to keep watching.
async function peek(hwnd) {
  const entry = _sandbox.get(String(hwnd));
  if (!entry) throw new Error(`hwnd ${hwnd} is not a sandboxed window`);
  // Stop the reapply timer FIRST so it doesn't yank the window back.
  if (entry._reapplyTimer) { clearInterval(entry._reapplyTimer); entry._reapplyTimer = null; }
  entry.peeked = true;
  // Clear NOACTIVATE during peek so the user can interact with the window
  // normally if they want. We re-apply on unpeek.
  if (entry.noActivateApplied) await clearNoActivate(hwnd);
  await restoreOnscreen(hwnd, entry.originalRect);
  return { ok: true, rect: entry.originalRect };
}

async function unpeek(hwnd) {
  const entry = _sandbox.get(String(hwnd));
  if (!entry) throw new Error(`hwnd ${hwnd} is not a sandboxed window`);
  entry.peeked = false;
  await setOffscreen(hwnd);
  if (entry.noActivateApplied) await applyNoActivate(hwnd);
  return { ok: true };
}

// Stop tracking a sandboxed window. Optionally restore it on-screen so the
// user can keep using it. Does NOT kill the process — caller can use the
// existing apps panic / process-kill if they want a hard teardown.
async function release(hwnd, { restore = true } = {}) {
  const entry = _sandbox.get(String(hwnd));
  if (!entry) return { ok: false, reason: 'not_sandboxed' };
  if (entry._reapplyTimer) { clearInterval(entry._reapplyTimer); entry._reapplyTimer = null; }
  if (entry._keepAliveTimer) { clearInterval(entry._keepAliveTimer); entry._keepAliveTimer = null; }
  if (entry._noActivateTimer) { clearTimeout(entry._noActivateTimer); entry._noActivateTimer = null; }
  if (entry.noActivateApplied) {
    try { await clearNoActivate(hwnd); } catch (_) {}
  }
  if (restore) {
    try { await restoreOnscreen(hwnd, entry.originalRect); } catch (_) {}
  }
  _sandbox.delete(String(hwnd));
  return { ok: true, restored: restore };
}

function list() {
  return Array.from(_sandbox.entries()).map(([hwnd, v]) => ({
    hwnd: Number(hwnd),
    app: v.app,
    processName: v.processName,
    originalRect: v.originalRect,
    launchedAt: v.launchedAt,
    peeked: v.peeked,
    adopted: !!v.adopted,
  }));
}

function isSandboxed(hwnd) {
  return _sandbox.has(String(hwnd));
}

function getEntry(hwnd) {
  return _sandbox.get(String(hwnd)) || null;
}

// Wire the driver's focus / foreground short-circuit. The driver imports
// nothing from us (cycle-safe); we tell IT about us at load time.
if (typeof driver.setSandboxedHwndCheck === 'function') {
  driver.setSandboxedHwndCheck(isSandboxed);
}

module.exports = {
  stealthLaunch,
  adoptIntoSandbox,
  setOffscreen,
  restoreOnscreen,
  peek,
  unpeek,
  release,
  list,
  isSandboxed,
  getEntry,
  OFFSCREEN_X,
  OFFSCREEN_Y,
};
