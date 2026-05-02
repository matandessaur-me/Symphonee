# post-click.ps1
#
# Synthesize a left-mouse click on a window via PostMessage WM_LBUTTONDOWN/UP.
# Unlike SendInput, this works regardless of whether the target window is
# foreground or visible — so it can drive a sandboxed (off-screen) window
# without yanking it back into focus or routing the click into whatever the
# user is actually doing.
#
# Coords are screen-relative. The script:
#   1. Walks down via ChildWindowFromPointEx / RealChildWindowFromPoint to
#      find the deepest hwnd at that screen point (Chromium / WebView controls
#      have layered child windows; the top-level hwnd often won't accept
#      WM_LBUTTONDOWN itself).
#   2. Translates screen -> that child's client coords via ScreenToClient.
#   3. Posts WM_MOUSEMOVE, then WM_LBUTTONDOWN, then WM_LBUTTONUP, with
#      MAKELPARAM(x, y) and the wParam set to MK_LBUTTON during DOWN.
#
# Output JSON: { ok, hwnd_top, hwnd_target, client_x, client_y } or
# { ok: false, reason }.

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [switch]$Double
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -Name SyPostClick -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ScreenToClient(System.IntPtr h, ref POINT p);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr ChildWindowFromPointEx(System.IntPtr parent, POINT p, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr RealChildWindowFromPoint(System.IntPtr parent, POINT p);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr WindowFromPoint(POINT p);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct POINT { public int x; public int y; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int L; public int T; public int R; public int B; }
"@ -ErrorAction SilentlyContinue

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }

$top = [System.IntPtr]::new([int64]$Hwnd)
# Window is at -32000,-32000; the requested screen coords (X,Y) are window-
# relative coordinates handed to us by the caller. Translate to absolute
# screen by adding the window's screen-rect origin.
$rect = New-Object Sy.SyPostClick+RECT
[void][Sy.SyPostClick]::GetWindowRect($top, [ref]$rect)
$absX = $rect.L + $X
$absY = $rect.T + $Y
$pt = New-Object Sy.SyPostClick+POINT
$pt.x = $absX; $pt.y = $absY

# Walk children to the deepest window at that point. Chromium uses a tower
# of child hwnds; without descending we'd post into the outer frame which
# silently drops it.
$target = $top
$flags = 0x0001 # CWP_SKIPINVISIBLE = 0x0001 — but our target window IS
# off-screen / "invisible-by-coords"; do NOT pass that flag for our case.
$cur = $top
while ($true) {
  $local = $pt
  [void][Sy.SyPostClick]::ScreenToClient($cur, [ref]$local)
  $child = [Sy.SyPostClick]::ChildWindowFromPointEx($cur, $local, 0)
  if ($child -eq [System.IntPtr]::Zero -or $child -eq $cur) { break }
  $cur = $child
}
$target = $cur

$client = New-Object Sy.SyPostClick+POINT
$client.x = $absX; $client.y = $absY
[void][Sy.SyPostClick]::ScreenToClient($target, [ref]$client)

# MAKELPARAM(low, high) = (high << 16) | (low & 0xFFFF). We must keep this in
# 32-bit signed range for IntPtr.
$lparam = (($client.y -band 0xFFFF) -shl 16) -bor ($client.x -band 0xFFFF)
$lp = [System.IntPtr]::new($lparam)
$mkLBUTTON = [System.IntPtr]::new(0x0001)

$WM_MOUSEMOVE   = 0x0200
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP   = 0x0202

[void][Sy.SyPostClick]::PostMessage($target, $WM_MOUSEMOVE,   [System.IntPtr]::Zero, $lp)
[void][Sy.SyPostClick]::PostMessage($target, $WM_LBUTTONDOWN, $mkLBUTTON, $lp)
Start-Sleep -Milliseconds 30
[void][Sy.SyPostClick]::PostMessage($target, $WM_LBUTTONUP,   [System.IntPtr]::Zero, $lp)

if ($Double) {
  Start-Sleep -Milliseconds 60
  [void][Sy.SyPostClick]::PostMessage($target, $WM_LBUTTONDOWN, $mkLBUTTON, $lp)
  Start-Sleep -Milliseconds 30
  [void][Sy.SyPostClick]::PostMessage($target, $WM_LBUTTONUP,   [System.IntPtr]::Zero, $lp)
}

Out-Json @{ ok=$true; hwnd_top=[int64]$Hwnd; hwnd_target=[int64]$target; client_x=$client.x; client_y=$client.y }
