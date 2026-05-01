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
    // setEncoding('utf8') makes the readable streams emit decoded strings
    // and buffers any partial multi-byte sequence until the next chunk, so
    // a UTF-8 char split across two chunks doesn't get corrupted on '+='.
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
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

// Inline C# once; SetForegroundWindow / GetWindowRect / ShowWindow / IsIconic
// plus visibility / cloaked / tool-window checks used to filter out service
// and system windows from the Running list.
const WIN32_TYPES = `
Add-Type -Name SyWin32 -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr h, int c);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
public static extern int GetWindowLong(System.IntPtr h, int i);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr hInsertAfter, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool BringWindowToTop(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetFocus(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetFocus();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
public static extern int DwmGetWindowAttribute(System.IntPtr h, int attr, out int pvAttribute, int cb);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int left; public int top; public int right; public int bottom; }
"@ -ErrorAction SilentlyContinue
`;

// Process names that consistently surface service / shell / helper windows,
// never a real app the user would want to drive.
const SYSTEM_PROCESS_NAMES = new Set([
  'explorer',                    // Program Manager, File Explorer shell
  'dwm', 'csrss', 'winlogon', 'wininit', 'lsass', 'services', 'smss',
  'svchost', 'sihost', 'runtimebroker', 'conhost', 'taskhostw', 'ctfmon',
  'searchhost', 'searchapp', 'searchui', 'searchindexer',
  'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost',
  'applicationframehost', 'lockapp', 'systemsettings', 'widgets', 'widgetservice',
  'nvcontainer', 'nvdisplay.container', 'radeonsoftware', 'armsvc',
  'useroobebroker', 'securityhealthsystray', 'securityhealthservice',
  'fontdrvhost', 'audiodg', 'msmpeng', 'dllhost', 'backgroundtaskhost',
  'gamebar', 'gamebarftserver', 'gamingservices', 'phoneexperiencehost',
  'yourphone', 'people', 'video.ui', 'crossdeviceservice',
]);
const SYSTEM_TITLE_RE = /^(Program Manager|Settings|Windows Input Experience|Microsoft Text Input Application|Search|Cortana|Task View|Start|Action center|Notification Center|HiddenFrame)$/i;

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

  // Filter at the PS layer so we only return windows a human would call "an
  // app": visible, not DWM-cloaked, not a tool window, with a real title and
  // a reasonable on-screen footprint. Also skip known shell/service procs.
  const script = `
${WIN32_TYPES}
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$DWMWA_CLOAKED = 14
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }
$out = foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  if (-not [Sy.SyWin32]::IsWindowVisible($h)) { continue }
  $cloaked = 0
  [void][Sy.SyWin32]::DwmGetWindowAttribute($h, $DWMWA_CLOAKED, [ref]$cloaked, 4)
  if ($cloaked -ne 0) { continue }
  $ex = [Sy.SyWin32]::GetWindowLong($h, $GWL_EXSTYLE)
  if (($ex -band $WS_EX_TOOLWINDOW) -ne 0) { continue }
  $r = New-Object Sy.SyWin32+RECT
  [void][Sy.SyWin32]::GetWindowRect($h, [ref]$r)
  $w = $r.right - $r.left
  $ht = $r.bottom - $r.top
  # Discard degenerate or sliver windows (many service trays paint 0x0 or 1x1).
  if (-not [Sy.SyWin32]::IsIconic($h) -and ($w -lt 120 -or $ht -lt 80)) { continue }
  [PSCustomObject]@{
    hwnd = [int64]$h
    pid = $p.Id
    processName = $p.ProcessName
    title = $p.MainWindowTitle
    isMinimized = [Sy.SyWin32]::IsIconic($h)
    rect = @{ x = $r.left; y = $r.top; w = $w; h = $ht }
  }
}
$out | ConvertTo-Json -Depth 4 -Compress
`;
  const raw = await runPs(script);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = []; }
  let list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  list = list.filter(w => {
    const proc = String(w.processName || '').toLowerCase();
    if (SYSTEM_PROCESS_NAMES.has(proc)) return false;
    if (SYSTEM_TITLE_RE.test(w.title || '')) return false;
    return true;
  });
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
Add-Type -Name SyWinZoomF -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsZoomed(System.IntPtr h);
"@ -ErrorAction SilentlyContinue
$h = [System.IntPtr]::new([int64]${w.hwnd})
if ([Sy.SyWin32]::IsIconic($h)) { [void][Sy.SyWin32]::ShowWindow($h, 9) }
[void][Sy.SyWin32]::SetForegroundWindow($h)
# Skip the Z-order pin on maximized windows - SetWindowPos with HWND_TOPMOST
# triggers DWM windowposchanging events that Electron (Figma, VS Code, etc.)
# interprets as leaving maximize state, flipping fullscreen back to windowed
# on every single action. On non-maximized windows we use HWND_TOP (0) to
# bring-to-front without pinning always-on-top, which avoided the same side
# effect but on a smaller set of apps.
if (-not [Sy.SyWinZoomF]::IsZoomed($h)) {
  [void][Sy.SyWin32]::SetWindowPos($h, [System.IntPtr]::Zero, 0, 0, 0, 0, 0x13)
}
`;
  await runPs(script);
  // Give Windows a beat to actually move focus.
  await new Promise(r => setTimeout(r, 80));
  return { ok: true, hwnd: w.hwnd, title: w.title };
}

// Ensure a target window is still the foreground one. If it lost focus
// (click landed outside, notification stole it, user alt-tabbed) the agent
// would otherwise send keys and mouse events to whatever is on top --
// which is how Figma-style "nothing happens" loops occur.
//
// Windows actively blocks background processes from calling SetForegroundWindow
// directly (the "focus stealing prevention" rule). The reliable workaround:
// attach to the current foreground thread's input queue first, call
// SetForegroundWindow / BringWindowToTop / SetFocus while attached, then
// detach. We also simulate an ALT keystroke since that briefly lifts the
// focus-lock on some Windows versions. After all that we VERIFY with
// GetForegroundWindow and throw a typed error if the window still isn't in
// front, so input tools abort instead of mis-routing clicks into another app.
async function ensureForeground(hwnd) {
  const script = `
${WIN32_TYPES}
Add-Type -Name SyWinZoomE -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsZoomed(System.IntPtr h);
"@ -ErrorAction SilentlyContinue
$target = [System.IntPtr]::new([int64]${hwnd})
$fg = [Sy.SyWin32]::GetForegroundWindow()
if ($fg -eq $target) { Write-Output 'ok'; exit 0 }

# Only restore when actually iconic. Calling SW_RESTORE on a maximized
# window un-maximizes it, which every Record/Pick/Run call would trigger.
if ([Sy.SyWin32]::IsIconic($target)) {
  [void][Sy.SyWin32]::ShowWindow($target, 9)
}

$pid = 0
$fgThread = [Sy.SyWin32]::GetWindowThreadProcessId($fg, [ref]$pid)
$myThread = [Sy.SyWin32]::GetCurrentThreadId()
$targetThread = [Sy.SyWin32]::GetWindowThreadProcessId($target, [ref]$pid)

# Quick nudge: ALT keypress briefly relaxes focus-stealing prevention.
[Sy.SyWin32]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)   # ALT down
[Sy.SyWin32]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)   # ALT up

# Attach our thread to both the foreground thread and the target thread so
# SetForegroundWindow / BringWindowToTop / SetFocus are honored cross-process.
$attachedFg = $false; $attachedTgt = $false
if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
  $attachedFg = [Sy.SyWin32]::AttachThreadInput($myThread, $fgThread, $true)
}
if ($targetThread -ne 0 -and $targetThread -ne $myThread -and $targetThread -ne $fgThread) {
  $attachedTgt = [Sy.SyWin32]::AttachThreadInput($myThread, $targetThread, $true)
}
try {
  [void][Sy.SyWin32]::BringWindowToTop($target)
  [void][Sy.SyWin32]::SetForegroundWindow($target)
  [void][Sy.SyWin32]::SetFocus($target)
  # Do NOT pin topmost on maximized windows - DWM sends a WM_WINDOWPOSCHANGING
  # that Electron-based apps (Figma, VS Code) treat as leaving maximize state.
  if (-not [Sy.SyWin32]::IsIconic($target)) {
    $isMax = $false
    try { $isMax = [Sy.SyWinZoomE]::IsZoomed($target) } catch {}
    if (-not $isMax) {
      [void][Sy.SyWin32]::SetWindowPos($target, [System.IntPtr]::Zero, 0, 0, 0, 0, 0x13)
    }
  }
} finally {
  if ($attachedFg)  { [void][Sy.SyWin32]::AttachThreadInput($myThread, $fgThread, $false) }
  if ($attachedTgt) { [void][Sy.SyWin32]::AttachThreadInput($myThread, $targetThread, $false) }
}

# Verify. Give Windows a beat to finish the WM_ACTIVATE dance.
Start-Sleep -Milliseconds 120
$fg2 = [Sy.SyWin32]::GetForegroundWindow()
if ($fg2 -eq $target) { Write-Output 'refocused' }
else { Write-Output "failed:$([int64]$fg2)" }
`;
  let out;
  try {
    out = (await runPs(script, { timeoutMs: 6000 })).trim();
  } catch (e) {
    const err = new Error(`foreground enforcement failed: ${e.message}`);
    err.code = 'focus_failed';
    throw err;
  }
  if (out === 'ok' || out === 'refocused') {
    if (out === 'refocused') await new Promise(r => setTimeout(r, 80));
    return;
  }
  if (out.startsWith('failed:')) {
    const err = new Error(`target window is not in the foreground; another window (hwnd=${out.slice(7)}) refused to release focus. Click the target window once yourself, then retry the task.`);
    err.code = 'focus_stolen';
    throw err;
  }
}

// Drop the topmost pin when a session ends so the window behaves normally
// after the agent is done. Non-fatal if it fails.
async function unpinTopmost(hwnd) {
  const script = `
${WIN32_TYPES}
$h = [System.IntPtr]${hwnd}
# HWND_NOTOPMOST = -2
[void][Sy.SyWin32]::SetWindowPos($h, [System.IntPtr]::new(-2), 0, 0, 0, 0, 0x13)
`;
  try { await runPs(script, { timeoutMs: 4000 }); } catch (_) {}
}

async function getWindowRect(hwnd) {
  const w = await findWindow(hwnd);
  return { ...w.rect, hwnd: w.hwnd, title: w.title, isMinimized: w.isMinimized };
}

// Resize (and optionally reposition) a top-level window. Used by the recipe
// runner when a recipe declares a pinned window.{w,h} so scripted coordinates
// always land on the same layout. Flags: 0x0010 SWP_NOACTIVATE | 0x0004
// SWP_NOZORDER. If x/y omitted, keeps current origin via SWP_NOMOVE (0x0002).
async function setWindowRect(hwnd, { x, y, w, h }) {
  const width = Math.max(100, parseInt(w, 10) || 0);
  const height = Math.max(100, parseInt(h, 10) || 0);
  if (!width || !height) throw new Error('setWindowRect requires positive w,h');
  const hasOrigin = typeof x === 'number' && typeof y === 'number';
  const ox = hasOrigin ? parseInt(x, 10) : 0;
  const oy = hasOrigin ? parseInt(y, 10) : 0;
  // SWP_NOZORDER (0x0004) | SWP_NOACTIVATE (0x0010) + optionally SWP_NOMOVE (0x0002)
  const flags = 0x0014 | (hasOrigin ? 0 : 0x0002);
  const script = `
${WIN32_TYPES}
$h = [System.IntPtr]${hwnd}
# SW_RESTORE in case the window is minimized/maximized before resizing.
[void][Sy.SyWin32]::ShowWindow($h, 9)
[void][Sy.SyWin32]::SetWindowPos($h, [System.IntPtr]::Zero, ${ox}, ${oy}, ${width}, ${height}, ${flags})
`;
  await runPs(script, { timeoutMs: 4000 });
}

// UIA element lookup. Spawns scripts/uia-find.ps1 with a JSON selector and
// resolves to { x, y } (window-relative, pointing at the element's center)
// or null when the selector doesn't match any visible element.
async function findUIAElement(hwnd, selector) {
  const path = require('path').join(__dirname, 'scripts', 'uia-find.ps1');
  const payload = Buffer.from(JSON.stringify(selector || {}), 'utf8').toString('base64');
  // Pass via -EncodedCommand-style inline base64 to dodge PS quoting hell
  // when selectors contain quotes, slashes, or unicode.
  const script = `
$sel = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
& '${path.replace(/'/g, "''")}' -Hwnd ${Number(hwnd)} -SelectorJson $sel
`;
  const raw = await runPs(script, { timeoutMs: 10000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { throw new Error('uia-find returned non-JSON: ' + line.slice(0, 200)); }
  if (!parsed.hit) return null;
  return { x: parsed.x, y: parsed.y, meta: { name: parsed.name, type: parsed.type, id: parsed.id, w: parsed.w, h: parsed.h, degraded: parsed.degraded || null } };
}

// Snapshot the target window's UIA tree. Returns { nodes, truncated } or
// throws if UIA is unavailable. Nodes are flat, each carrying a depth for
// indent rendering.
async function uiaTree(hwnd, { maxNodes = 400 } = {}) {
  const path = require('path').join(__dirname, 'scripts', 'uia-tree.ps1');
  const script = `& '${path.replace(/'/g, "''")}' -Hwnd ${Number(hwnd)} -MaxNodes ${Number(maxNodes)}`;
  const raw = await runPs(script, { timeoutMs: 20000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { throw new Error('uia-tree returned non-JSON: ' + line.slice(0, 200)); }
  if (!parsed.ok) throw new Error(parsed.reason || 'uia-tree failed');
  return { nodes: parsed.nodes || [], truncated: !!parsed.truncated };
}

// Reverse coordinate -> element lookup. Used by the self-healer: when a
// pixel-coordinate click succeeds, we resolve the element under that point
// so the recipe step can be rewritten as a stable selector for next time.
async function findUIAElementAt(hwnd, x, y) {
  const path = require('path').join(__dirname, 'scripts', 'uia-hit-test.ps1');
  const script = `& '${path.replace(/'/g, "''")}' -Hwnd ${Number(hwnd)} -X ${Number(x)} -Y ${Number(y)}`;
  const raw = await runPs(script, { timeoutMs: 8000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { return null; }
  if (!parsed.hit) return null;
  return parsed;
}

// Read the value/text of a UIA element. Lets the agent verify state without
// taking a screenshot (button label, input contents, status bar text).
async function readUIAElement(hwnd, selector) {
  const path = require('path').join(__dirname, 'scripts', 'uia-read.ps1');
  const payload = Buffer.from(JSON.stringify(selector || {}), 'utf8').toString('base64');
  const script = `
$sel = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
& '${path.replace(/'/g, "''")}' -Hwnd ${Number(hwnd)} -SelectorJson $sel
`;
  const raw = await runPs(script, { timeoutMs: 8000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { return { hit: false, reason: 'non-JSON' }; }
  return parsed;
}

// Wait until a UIA selector resolves (or timeout). Polls the tree at 250ms
// cadence. Returns { hit, element } once found, or { hit: false } on timeout.
async function waitForUIAElement(hwnd, selector, { timeoutMs = 5000, pollMs = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const hit = await findUIAElement(hwnd, selector);
      if (hit) return { hit: true, element: hit, waitedMs: Date.now() - start };
    } catch (_) {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { hit: false, waitedMs: Date.now() - start };
}

// Invoke-pattern shortcut: run the element's default action directly via
// UIA instead of simulating a click. Returns { ok, pattern } on success or
// { ok: false } so the caller can fall back to findUIAElement + click.
async function invokeUIAElement(hwnd, selector) {
  const path = require('path').join(__dirname, 'scripts', 'uia-invoke.ps1');
  const payload = Buffer.from(JSON.stringify(selector || {}), 'utf8').toString('base64');
  const script = `
$sel = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
& '${path.replace(/'/g, "''")}' -Hwnd ${Number(hwnd)} -SelectorJson $sel
`;
  const raw = await runPs(script, { timeoutMs: 10000 });
  const line = String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try { parsed = JSON.parse(line); } catch (_) { return { ok: false, reason: 'non-JSON' }; }
  if (!parsed.hit) return { ok: false, reason: parsed.reason };
  return { ok: true, pattern: parsed.pattern, name: parsed.name, type: parsed.type };
}

// Launches the interactive element picker in a child process. The caller
// (apps-agent.js) streams the events so the UI can show hover feedback.
function spawnUIAPicker(hwnd, { timeoutSeconds = 120 } = {}) {
  const path = require('path').join(__dirname, 'scripts', 'uia-pick.ps1');
  return spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-File', path,
    '-Hwnd', String(hwnd),
    '-TimeoutSeconds', String(timeoutSeconds),
  ], { windowsHide: true });
}

// Maximize a top-level window. SW_MAXIMIZE = 3.
async function maximizeWindow(hwnd) {
  // IsZoomed returns true when the window is already maximized. Calling
  // ShowWindow(SW_MAXIMIZE=3) again is a no-op at the Win32 API level, but
  // some apps (Figma/Electron, a handful of Win32 titles) translate a
  // second SC_MAXIMIZE into a TOGGLE and restore to windowed. Guarded so
  // callers can safely invoke "ensure maximized" without flickering.
  const script = `
${WIN32_TYPES}
Add-Type -Name SyWinZoom -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsZoomed(System.IntPtr h);
"@ -ErrorAction SilentlyContinue
$h = [System.IntPtr]::new([int64]${hwnd})
if (-not [Sy.SyWinZoom]::IsZoomed($h)) {
  [void][Sy.SyWin32]::ShowWindow($h, 3)
  Write-Output 'maximized'
} else {
  Write-Output 'already-maximized'
}
`;
  const out = await runPs(script, { timeoutMs: 4000 });
  return { alreadyMaximized: String(out || '').trim() === 'already-maximized' };
}

function translate({ x, y, rect }) {
  return { x: rect.x + Math.round(x), y: rect.y + Math.round(y) };
}

// Capture the specified window directly via PrintWindow (PW_RENDERFULLCONTENT),
// so overlapping windows and the desktop around the target are NOT included.
// Falls back to a screen-region grab only if PrintWindow returns an empty frame
// (some DirectX / protected-content windows refuse PrintWindow).
async function screenshotWindowViaPrintWindow(hwnd, { format, quality }) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SyCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@ -ErrorAction SilentlyContinue
$h = [IntPtr]${hwnd}
$r = New-Object SyCap+RECT
[void][SyCap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Output 'EMPTY'; exit 0 }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 2, required for DWM-composed / chromium content.
$ok = [SyCap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { Write-Output 'EMPTY'; exit 0 }
$ms = New-Object System.IO.MemoryStream
if ('${format}' -eq 'png') {
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
} else {
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $qp = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]${quality})
  $ep.Param[0] = $qp
  $bmp.Save($ms, $enc, $ep)
}
$bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`;
  const out = (await runPs(script, { timeoutMs: 15000 })).trim();
  if (!out || out === 'EMPTY') return null;
  return {
    base64: out,
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
  };
}

async function screenshotWindow(hwnd, { format = 'jpeg', quality = 60 } = {}) {
  let w = await findWindow(hwnd);
  if (w.isMinimized) {
    // Auto-restore the window so the agent can keep working instead of
    // bailing. Users are told up-front that the Apps tab drives the real
    // desktop, so un-minimizing an already-chosen target is expected.
    try { await focusWindow(hwnd); } catch (_) {}
    w = await findWindow(hwnd);
    if (w.isMinimized) return { error: 'window_minimized', hwnd: w.hwnd };
  }
  if (w.rect.w <= 0 || w.rect.h <= 0) {
    return { error: 'window_degenerate_rect', hwnd: w.hwnd, rect: w.rect };
  }

  const q = Math.max(1, Math.min(100, quality | 0));
  try {
    const shot = await screenshotWindowViaPrintWindow(hwnd, { format, quality: q });
    if (shot) {
      return {
        base64: shot.base64,
        mimeType: shot.mimeType,
        width: w.rect.w,
        height: w.rect.h,
        rect: w.rect,
        capturedAt: Date.now(),
      };
    }
  } catch (_) {
    // Fall through to screen-region fallback.
  }

  // Fallback for windows where PrintWindow refuses (some DRM / DirectX paths).
  // This captures screen pixels at the window's rect, which may include
  // whatever is overlapping, but is better than failing.
  const n = loadNut();
  const region = new n.Region(w.rect.x, w.rect.y, w.rect.w, w.rect.h);
  const img = await n.screen.grabRegion(region);
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
  if (format !== 'png') jimg.quality(q);
  const buf = await jimg.getBufferAsync(mime);
  return {
    base64: buf.toString('base64'),
    mimeType: mime,
    width: img.width,
    height: img.height,
    rect: w.rect,
    capturedAt: Date.now(),
    fallback: 'screen_region',
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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Canvas-heavy apps (Figma, Illustrator, game editors) need the cursor to
  // physically move through intermediate positions while the button is held.
  // A plain setPosition -> press -> jump -> release gets consumed as a
  // single CLICK, which is how a drag-to-draw becomes "shape dumped at click
  // point". Fix: drive the mouse through ~24 interpolated waypoints with
  // settle pauses on both edges so the target app's drag handler ticks.
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(10, Math.min(40, Math.round(distance / 20)));
  const totalMs = Math.max(250, Math.min(900, Math.round(distance * 0.6)));
  const stepDelay = Math.max(8, Math.round(totalMs / steps));
  await n.mouse.setPosition(new n.Point(from.x, from.y));
  await sleep(80);
  await n.mouse.pressButton(n.Button.LEFT);
  await sleep(70);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-out cubic so movement starts fast and decelerates into the end
    // position - feels natural and gives the app more samples near the drop.
    const e = 1 - Math.pow(1 - t, 3);
    const x = Math.round(from.x + (to.x - from.x) * e);
    const y = Math.round(from.y + (to.y - from.y) * e);
    await n.mouse.setPosition(new n.Point(x, y));
    await sleep(stepDelay);
  }
  await sleep(60);
  await n.mouse.releaseButton(n.Button.LEFT);
  await sleep(40);
  return { ok: true, from, to, steps };
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

// ── Installed-app discovery and launching ─────────────────────────────
// We merge three sources:
//   1. UWP / modern apps via Get-StartApps (fast, gives AppUserModelID).
//   2. Win32 shortcuts in the Start Menu (both users + current user).
// Manually-added apps are stored client-side (localStorage) and come in via
// the launch endpoint's { path } parameter.
let _installedCache = null;
let _installedCacheAt = 0;
const INSTALLED_CACHE_MS = 60000;

// Install roots where user-installed apps actually live. Anything outside
// these is almost certainly a system tool we don't want in the launcher.
// We DO accept WindowsApps now (Microsoft Store installs like Spotify land
// there), and filter system/Microsoft-published packages by name + publisher
// in _isSystemShortcut instead of by path. SystemApps stays rejected — those
// are Windows shell components only.
function _isUserInstalledPath(p) {
  if (!p) return false;
  const s = String(p).toLowerCase().replace(/\//g, '\\');
  const pf  = (process.env['ProgramFiles']        || 'C:\\Program Files').toLowerCase();
  const pf86 = (process.env['ProgramFiles(x86)']  || 'C:\\Program Files (x86)').toLowerCase();
  const local = (process.env['LOCALAPPDATA']      || '').toLowerCase();
  const roaming = (process.env['APPDATA']         || '').toLowerCase();
  const sysroot = (process.env['SystemRoot']      || 'C:\\Windows').toLowerCase();
  // Reject only the deepest-system locations; allow WindowsApps so Store
  // apps appear (Spotify, Netflix, Notion Store, etc).
  if (s.includes('\\systemapps\\')) return false;
  // System32, SysWOW64, WinSxS, Drivers — these are never user apps.
  if (s.startsWith(sysroot + '\\system32\\')) return false;
  if (s.startsWith(sysroot + '\\syswow64\\')) return false;
  if (s.startsWith(sysroot + '\\winsxs\\')) return false;
  return (pf && s.startsWith(pf + '\\'))
    || (pf86 && s.startsWith(pf86 + '\\'))
    || (local && s.startsWith(local + '\\'))
    || (roaming && s.startsWith(roaming + '\\'))
    || /^[a-z]:\\(games|tools|apps)\\/i.test(s)
    || s.includes('\\windowsapps\\');
}

// Shortcut-name and folder filters so we don't list "Notepad", "Calculator",
// "Edge", "Command Prompt", "PowerShell ISE", etc.
function _isSystemShortcut(name, lnkPath) {
  const n = String(name || '').toLowerCase();
  const lp = String(lnkPath || '').toLowerCase();
  if (!n) return true;
  // Folder-based rejects: anything Windows ships under these Start-menu groups.
  if (/\\(accessories|administrative tools|windows powershell|windows system|accessibility|maintenance|windows kits|startup|microsoft edge)\\/i.test(lp)) return true;
  // Name-based rejects: OS accessories and component helpers that slip through.
  const SYSTEM_NAMES = new Set([
    'calculator', 'notepad', 'wordpad', 'paint', 'snipping tool', 'snip & sketch',
    'character map', 'math input panel', 'remote desktop connection', 'steps recorder',
    'windows media player', 'windows media player legacy', 'command prompt', 'file explorer',
    'run', 'task manager', 'settings', 'control panel', 'windows security',
    'microsoft edge', 'internet explorer', 'xbox', 'xbox game bar',
    'powershell', 'powershell ise', 'powershell 7', 'powershell (x86)',
    'windows terminal', 'clock', 'weather', 'mail', 'calendar', 'maps', 'people',
    'photos', 'movies & tv', 'groove music', 'voice recorder', 'alarms & clock',
    'camera', 'phone link', 'your phone', 'tips', 'get help', 'feedback hub',
    'microsoft store', 'game bar', 'print management', 'oobe', 'sticky notes',
    'cortana', 'paint 3d', 'view 3d', '3d viewer', 'mixed reality portal',
  ]);
  if (SYSTEM_NAMES.has(n)) return true;
  // Common non-app shortcut patterns.
  if (/^unins|^uninstall|^update|^repair|^readme|^manual|^license|^release notes|^changelog|^help$/i.test(name)) return true;
  if (/ uninstall$| readme$| help$| documentation$| manual$/i.test(name)) return true;
  return false;
}

// Publisher prefixes that mark a UWP package as "system" — the Microsoft
// shell, OS components, OEM bloat. Anything in this list is filtered out
// even though it shows up in Get-StartApps.
const SYSTEM_PUBLISHER_PREFIXES = [
  'microsoft.windows.',
  'microsoft.win32',
  'microsoft.xboxgameoverlay',
  'microsoft.xboxgamingoverlay',
  'microsoft.xbox.tcui',
  'microsoft.xboxidentityprovider',
  'microsoft.xboxspeechtotextoverlay',
  'microsoft.gethelp',
  'microsoft.getstarted',
  'microsoft.bingweather',
  'microsoft.bingnews',
  'microsoft.windowsalarms',
  'microsoft.windowscamera',
  'microsoft.windowscalculator',
  'microsoft.windowsfeedbackhub',
  'microsoft.windowsmaps',
  'microsoft.windowssoundrecorder',
  'microsoft.windowsstore',
  'microsoft.zunemusic',
  'microsoft.zunevideo',
  'microsoft.yourphone',
  'microsoft.people',
  'microsoft.microsoftsolitairecollection',
  'microsoft.mixedreality.portal',
  'microsoft.mspaint',
  'microsoft.screensketch',
  'microsoft.stickynotes',
  'microsoft.outlookforwindows',
  'microsoft.todos',
  'microsoftcorporationii.',
  'windows.',
  'windowsterminal',
];

function _isSystemPackage(packageFamilyName, publisher) {
  const pfn = String(packageFamilyName || '').toLowerCase();
  const pub = String(publisher || '').toLowerCase();
  for (const prefix of SYSTEM_PUBLISHER_PREFIXES) {
    if (pfn.startsWith(prefix)) return true;
  }
  // Treat Microsoft-signed packages as system unless they have an explicit
  // app-style name we recognize (Office, Edge Dev, To Do — but those start
  // with their own prefixes above already).
  if (pub.includes('cn=microsoft corporation')) {
    // Allow Office/Teams/Edge/etc that ship under a non-system prefix.
    const allowedMS = [
      'microsoft.office.', 'microsoft.teams', 'microsoft.skydrive',
      'microsoftedge.', 'microsoft.visualstudio',
    ];
    if (!allowedMS.some(p => pfn.startsWith(p))) return true;
  }
  return false;
}

async function listInstalledApps({ force = false } = {}) {
  const now = Date.now();
  if (!force && _installedCache && (now - _installedCacheAt) < INSTALLED_CACHE_MS) {
    return _installedCache;
  }
  // Three sources merged:
  //   (1) Get-StartApps           — every Start-menu-visible app, including
  //                                 UWP / Microsoft Store installs (Spotify
  //                                 Store install lives here — that's why
  //                                 the old .lnk-only path missed it).
  //   (2) .lnk shortcuts          — Win32 apps with discoverable target exe.
  //   (3) Get-AppxPackage         — publisher metadata so we can filter out
  //                                 Microsoft / system UWP apps by signer.
  // Each result has { source, name, path, appUserModelId?, packageFamilyName?,
  // publisher? }. We dedupe by appUserModelId then by exe path.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$out = New-Object System.Collections.ArrayList

# (1) Get-StartApps — UWP + Win32, every app the Start menu can launch.
try {
  Get-StartApps | ForEach-Object {
    $item = [PSCustomObject]@{
      Source = 'startapps'
      Name = $_.Name
      AppUserModelId = $_.AppID
      Path = $null
      Arguments = $null
      Lnk = $null
      PackageFamilyName = $null
      Publisher = $null
    }
    [void]$out.Add($item)
  }
} catch {}

# (2) Win32 .lnk shortcuts — fallback for apps without a Start tile, plus
#     gives us a real exe path for launching when AppID lookup fails.
$recurse = @(
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('StartMenu')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$flat = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$shell = New-Object -ComObject WScript.Shell
$processLnk = {
  param($file)
  try {
    $sc = $shell.CreateShortcut($file.FullName)
    $t = $sc.TargetPath
    if ($t -and ($t -like '*.exe') -and (Test-Path $t)) {
      [PSCustomObject]@{
        Source = 'lnk'
        Name = [IO.Path]::GetFileNameWithoutExtension($file.Name)
        AppUserModelId = $null
        Path = $t
        Arguments = $sc.Arguments
        Lnk = $file.FullName
        PackageFamilyName = $null
        Publisher = $null
      }
    }
  } catch {}
}
foreach ($p in $recurse) {
  Get-ChildItem -LiteralPath $p -Recurse -Filter *.lnk -Force -ErrorAction SilentlyContinue |
    ForEach-Object { $r = & $processLnk $_; if ($r) { [void]$out.Add($r) } }
}
foreach ($p in $flat) {
  Get-ChildItem -LiteralPath $p -Filter *.lnk -Force -ErrorAction SilentlyContinue |
    ForEach-Object { $r = & $processLnk $_; if ($r) { [void]$out.Add($r) } }
}

# (3) Get-AppxPackage — publisher info for UWP packages so we can filter
#     Microsoft / system signers without keeping a static name list.
try {
  Get-AppxPackage | ForEach-Object {
    $pkg = $_
    if (-not $pkg.PackageFamilyName) { return }
    [void]$out.Add([PSCustomObject]@{
      Source = 'appx'
      Name = $pkg.Name
      AppUserModelId = $null
      Path = $pkg.InstallLocation
      Arguments = $null
      Lnk = $null
      PackageFamilyName = $pkg.PackageFamilyName
      Publisher = $pkg.Publisher
    })
  }
} catch {}

ConvertTo-Json -InputObject $out -Depth 3 -Compress
`;
  const raw = await runPs(script, { timeoutMs: 30000 });
  let entries = [];
  try { const p = JSON.parse((raw || '').trim()); entries = Array.isArray(p) ? p : p ? [p] : []; } catch (_) {}

  // Index Appx publishers by both PackageFamilyName and the leading prefix
  // (the part before '_'). UWP apps surfaced by Get-StartApps carry an AppID
  // like "Spotify.Spotify_zpdnekdrzrea0!Spotify" — split on '_' to match.
  const appxByPfn = new Map();
  for (const e of entries) {
    if (e && e.Source === 'appx' && e.PackageFamilyName) {
      appxByPfn.set(String(e.PackageFamilyName).toLowerCase(), e);
    }
  }

  function appxLookup(appUserModelId) {
    if (!appUserModelId) return null;
    const id = String(appUserModelId).toLowerCase();
    // AppUserModelId for UWP: "<PackageFamilyName>!<AppId>". Strip after '!'.
    const pfn = id.includes('!') ? id.split('!')[0] : id;
    return appxByPfn.get(pfn) || null;
  }

  const byKey = new Map();

  // Pass A: Start-menu apps (UWP + Win32). These give us AppUserModelId.
  for (const e of entries) {
    if (!e || e.Source !== 'startapps' || !e.Name) continue;
    if (_isSystemShortcut(e.Name, '')) continue;
    const appx = appxLookup(e.AppUserModelId);
    const isUwp = !!(e.AppUserModelId && (e.AppUserModelId.includes('!') || appx));
    if (isUwp) {
      const pfn = appx ? appx.PackageFamilyName : (e.AppUserModelId || '').split('!')[0];
      if (_isSystemPackage(pfn, appx ? appx.Publisher : '')) continue;
      const dedupe = 'aumid:' + e.AppUserModelId.toLowerCase();
      if (byKey.has(dedupe)) continue;
      byKey.set(dedupe, {
        id: e.AppUserModelId,
        name: e.Name,
        path: appx && appx.Path ? appx.Path : null,
        appUserModelId: e.AppUserModelId,
        packageFamilyName: pfn,
        publisher: appx ? appx.Publisher : null,
        args: null,
        lnk: null,
        kind: 'uwp',
      });
    } else {
      // Win32 entry from Get-StartApps — has AppID but no path. The .lnk
      // pass below will fill in the exe path; if it doesn't, we still keep
      // the entry so launchApp can fall back to shell:AppsFolder\<id>.
      const dedupe = 'aumid:' + (e.AppUserModelId || e.Name).toLowerCase();
      if (byKey.has(dedupe)) continue;
      byKey.set(dedupe, {
        id: e.AppUserModelId || e.Name,
        name: e.Name,
        path: null,
        appUserModelId: e.AppUserModelId || null,
        args: null,
        lnk: null,
        kind: 'win32',
      });
    }
  }

  // Pass B: .lnk shortcuts. Add unseen apps and back-fill exe paths for
  // Win32 entries surfaced by Get-StartApps that didn't have one.
  for (const e of entries) {
    if (!e || e.Source !== 'lnk' || !e.Name || !e.Path) continue;
    if (_isSystemShortcut(e.Name, e.Lnk)) continue;
    if (!_isUserInstalledPath(e.Path)) continue;
    // Try to back-fill an existing entry by name match first.
    let backfilled = false;
    for (const v of byKey.values()) {
      if (v.kind === 'win32' && !v.path && v.name.toLowerCase() === e.Name.toLowerCase()) {
        v.path = e.Path;
        v.lnk = e.Lnk;
        v.args = e.Arguments || null;
        backfilled = true;
        break;
      }
    }
    if (backfilled) continue;
    const dedupe = 'exe:' + e.Path.toLowerCase();
    if (byKey.has(dedupe)) continue;
    byKey.set(dedupe, {
      id: e.Path,
      name: e.Name,
      path: e.Path,
      args: e.Arguments || null,
      lnk: e.Lnk || null,
      kind: 'win32',
    });
  }

  // Pass C: pure Appx packages with no Start-menu surface (rare, but covers
  // background apps and subordinate package entries you can still launch).
  for (const e of entries) {
    if (!e || e.Source !== 'appx' || !e.PackageFamilyName) continue;
    if (_isSystemPackage(e.PackageFamilyName, e.Publisher)) continue;
    const dedupe = 'pkg:' + e.PackageFamilyName.toLowerCase();
    // Already covered by a UWP Start-menu entry?
    if ([...byKey.values()].some(v => v.packageFamilyName === e.PackageFamilyName)) continue;
    if (byKey.has(dedupe)) continue;
    byKey.set(dedupe, {
      id: e.PackageFamilyName,
      name: e.Name || e.PackageFamilyName,
      path: e.Path || null,
      packageFamilyName: e.PackageFamilyName,
      publisher: e.Publisher || null,
      args: null,
      lnk: null,
      kind: 'uwp',
    });
  }

  const out = Array.from(byKey.values())
    .filter(a => a.name && a.name.length >= 2)
    .sort((a, b) => a.name.localeCompare(b.name));
  _installedCache = out;
  _installedCacheAt = now;
  return out;
}

async function launchApp({ id, path, name } = {}) {
  // Snapshot existing HWNDs so we can tell which window is NEW. Matching by
  // process name alone is unreliable (many apps ship a launcher that exits,
  // and display names rarely match the exe basename).
  const before = new Set(
    (await listWindows({ force: true })).map(w => String(w.hwnd))
  );

  // Prefer `path` (real exe) — fall back to `shell:AppsFolder\<id>` for
  // Start-menu / UWP entries. Start-Process spawns detached and returns
  // immediately; we don't wait on the child here.
  let psCmd;
  if (path) {
    psCmd = `Start-Process -FilePath '${path.replace(/'/g, "''")}'`;
  } else if (id) {
    psCmd = `Start-Process -FilePath 'shell:AppsFolder\\${String(id).replace(/'/g, "''")}'`;
  } else {
    throw new Error('launchApp requires id or path');
  }
  try {
    await runPs(psCmd, { timeoutMs: 8000 });
  } catch (e) {
    throw new Error('Start-Process failed: ' + e.message);
  }

  // Poll for up to 30s. Cold launches of Steam / Electron apps / big IDEs
  // routinely take 5-15s to paint a window; 10s was too tight.
  const exeBase = path
    ? path.toLowerCase().replace(/\\/g, '/').split('/').pop().replace(/\.exe$/, '')
    : '';
  const nameLc = (name || '').toLowerCase();
  const deadline = Date.now() + 30000;
  let anyNewWindow = null;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const ws = await listWindows({ force: true });

    // Build candidates: NEW windows that weren't present before launch.
    const newOnes = ws.filter(w =>
      w.title && !w.isMinimized && !before.has(String(w.hwnd))
    );
    if (!newOnes.length) continue;

    // Prefer a name/exe match; otherwise take any brand-new window.
    let match = newOnes.find(w => {
      const proc = (w.processName || '').toLowerCase();
      const title = (w.title || '').toLowerCase();
      if (exeBase && (proc === exeBase || title.includes(exeBase) || proc.includes(exeBase))) return true;
      if (nameLc && (proc.includes(nameLc) || nameLc.includes(proc) || title.includes(nameLc))) return true;
      return false;
    });
    if (!match) {
      // Hold onto "any new window" as a fallback but keep polling briefly
      // in case the real window paints after a launcher window.
      anyNewWindow = anyNewWindow || newOnes[0];
      if (Date.now() + 3000 >= deadline) match = anyNewWindow;
    }
    if (match) return { hwnd: match.hwnd, title: match.title, processName: match.processName };
  }
  if (anyNewWindow) {
    return { hwnd: anyNewWindow.hwnd, title: anyNewWindow.title, processName: anyNewWindow.processName };
  }
  throw new Error('Launched, but no window appeared within 30s. Open it yourself, then pick it from the Running list.');
}

// Icon extraction via System.Drawing.Icon.ExtractAssociatedIcon. We return a
// small PNG base64. For UWP (AppID with '!'), we currently just return null
// because their icons come from their package manifest and aren't reachable
// via ExtractAssociatedIcon — the frontend falls back to a letter avatar.
const _iconCache = new Map();
async function extractAppIcon(idOrPath) {
  if (_iconCache.has(idOrPath)) return _iconCache.get(idOrPath);
  // UWP/shell entries have '!' in the id and no filesystem path.
  if (String(idOrPath).includes('!')) {
    _iconCache.set(idOrPath, { base64: null });
    return { base64: null };
  }
  const target = String(idOrPath).replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${target}')
  if (-not $icon) { Write-Output 'EMPTY'; exit 0 }
  $bmp = $icon.ToBitmap()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($ms.ToArray())
} catch { Write-Output 'EMPTY' }
`;
  try {
    const out = (await runPs(script, { timeoutMs: 10000 })).trim();
    const result = (!out || out === 'EMPTY') ? { base64: null } : { base64: out, mimeType: 'image/png' };
    _iconCache.set(idOrPath, result);
    return result;
  } catch (_) {
    _iconCache.set(idOrPath, { base64: null });
    return { base64: null };
  }
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
  listInstalledApps,
  launchApp,
  extractAppIcon,
  focusWindow,
  ensureForeground,
  unpinTopmost,
  getWindowRect,
  setWindowRect,
  maximizeWindow,
  findUIAElement,
  findUIAElementAt,
  readUIAElement,
  waitForUIAElement,
  invokeUIAElement,
  uiaTree,
  spawnUIAPicker,
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
