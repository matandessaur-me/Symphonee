# Record-input.ps1
#
# Low-latency mouse + keyboard recorder for the Automations recorder. Polls
# GetAsyncKeyState + GetCursorPos at ~60Hz and emits JSON-lines on stdout.
#
# Only input that falls inside the target window's rect is emitted. Coordinates
# are window-relative, matching the recipe DSL's convention.
#
# Exit: the parent process kills us; we also self-exit if the target hwnd is
# gone or if the user presses Ctrl+Shift+Esc.

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [int]$PollHz = 60
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -Name SyRec -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern short GetAsyncKeyState(int vKey);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetCursorPos(out POINT p);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetKeyboardState(byte[] lpKeyState);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint MapVirtualKey(uint uCode, uint uMapType);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int ToUnicode(uint wVirtKey, uint wScanCode, byte[] lpKeyState, System.Text.StringBuilder pwszBuff, int cchBuff, uint wFlags);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int L; public int T; public int R; public int B; }
"@

$hPtr = [System.IntPtr]::new([int64]$Hwnd)

function Emit-Event($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# UIA element-at-point probe. Best-effort: if UIA assemblies load and the
# lookup succeeds in under 150ms we stamp a minimal selector on the click
# event. Otherwise we silently fall through to raw coords. Keeps the recorder
# pipeline fast and non-blocking.
$script:UIA_OK = $false
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  Add-Type -AssemblyName WindowsBase -ErrorAction Stop
  Add-Type -AssemblyName PresentationCore -ErrorAction Stop
  $script:UIA_OK = $true
} catch {}

function Probe-UiaAtPoint([int]$absX, [int]$absY) {
  if (-not $script:UIA_OK) { return $null }
  try {
    $p = New-Object System.Windows.Point($absX, $absY)
    $elem = [System.Windows.Automation.AutomationElement]::FromPoint($p)
    if ($elem -eq $null) { return $null }
    # Skip generic container matches - if the hit element covers more than
    # 40% of the target window it's a viewport/scroll-pane/root wrapper,
    # not a useful target. Raw coords work better for those clicks.
    try {
      $winRect = New-Object Sy.SyRec+RECT
      if ([Sy.SyRec]::GetWindowRect($hPtr, [ref]$winRect)) {
        $elemRect = $elem.Current.BoundingRectangle
        $winW = $winRect.R - $winRect.L
        $winH = $winRect.B - $winRect.T
        if ($winW -gt 0 -and $winH -gt 0 -and -not $elemRect.IsEmpty) {
          $ratio = ($elemRect.Width * $elemRect.Height) / ($winW * $winH)
          if ($ratio -gt 0.4) { return $null }
        }
      }
    } catch {}
    $sel = @{}
    $id = [string]$elem.Current.AutomationId
    $name = [string]$elem.Current.Name
    # Emit the enum field name ("Button") not the localized string so the
    # find/invoke scripts can build a PropertyCondition on ControlType.
    $type = ''
    try {
      $pn = [string]$elem.Current.ControlType.ProgrammaticName
      if ($pn -match '^ControlType\.(.+)$') { $type = $Matches[1] }
    } catch {}
    $cls = [string]$elem.Current.ClassName
    $looksVolatile = ($id -match '^[0-9a-fA-F\-]{8,}$') -or ($id -match '^\d{3,}$') -or ($id -eq '')
    if (-not $looksVolatile) {
      $sel.id = $id
      if ($type) { $sel.type = $type }
    } else {
      if ($name) { $sel.name = $name }
      if ($type) { $sel.type = $type }
      if ($cls -and -not $name) { $sel.class = $cls }
    }
    if ($sel.Count -eq 0) { return $null }
    # One-level ancestor chain for disambiguation; keeps selector small.
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $parent = $walker.GetParent($elem)
    if ($parent -ne $null) {
      $pt2 = ''
      try {
        $ppn = [string]$parent.Current.ControlType.ProgrammaticName
        if ($ppn -match '^ControlType\.(.+)$') { $pt2 = $Matches[1] }
      } catch {}
      $pn2 = [string]$parent.Current.Name
      if ($pt2 -or $pn2) {
        $a = @{}
        if ($pt2) { $a.type = $pt2 }
        if ($pn2) { $a.name = $pn2 }
        $sel.ancestors = @($a)
      }
    }
    return @{ selector = $sel; name = $name; controlType = $type }
  } catch { return $null }
}

# Virtual-key table: only the subset we care about surfacing as named keys.
# Anything else collapses into printable character runs handled via WM_CHAR-
# style sampling (we reconstruct printable text from successive key presses).
$NAMED_KEYS = @{
  0x08 = 'Backspace'; 0x09 = 'Tab'; 0x0D = 'Enter'; 0x10 = 'Shift'; 0x11 = 'Ctrl';
  0x12 = 'Alt'; 0x14 = 'CapsLock'; 0x1B = 'Escape'; 0x20 = 'Space'; 0x21 = 'PageUp';
  0x22 = 'PageDown'; 0x23 = 'End'; 0x24 = 'Home'; 0x25 = 'Left'; 0x26 = 'Up';
  0x27 = 'Right'; 0x28 = 'Down'; 0x2D = 'Insert'; 0x2E = 'Delete';
  0x70 = 'F1'; 0x71 = 'F2'; 0x72 = 'F3'; 0x73 = 'F4'; 0x74 = 'F5'; 0x75 = 'F6';
  0x76 = 'F7'; 0x77 = 'F8'; 0x78 = 'F9'; 0x79 = 'F10'; 0x7A = 'F11'; 0x7B = 'F12';
  0x5B = 'Meta'; 0x5C = 'Meta';
}

# Modifier vkeys surface as held flags on every non-modifier key event so
# the DSL can emit "Ctrl+S" style combos.
$MOD_VKEYS = @{ 0x10 = 'shift'; 0x11 = 'ctrl'; 0x12 = 'alt'; 0x5B = 'meta'; 0x5C = 'meta' }

# Narrow the per-frame scan to keys we can translate into DSL. Includes named
# keys, digits, letters, and OEM punctuation (0xBA-0xE2) so typed punctuation
# survives; ToUnicode below resolves the correct char for the active layout.
$SCAN_VKEYS = @()
foreach ($k in $NAMED_KEYS.Keys) { $SCAN_VKEYS += $k }
for ($v = 0x30; $v -le 0x39; $v++) { $SCAN_VKEYS += $v }  # 0-9
for ($v = 0x41; $v -le 0x5A; $v++) { $SCAN_VKEYS += $v }  # A-Z
for ($v = 0xBA; $v -le 0xC0; $v++) { $SCAN_VKEYS += $v }  # OEM_1..OEM_3 (; = , - . / `)
for ($v = 0xDB; $v -le 0xDF; $v++) { $SCAN_VKEYS += $v }  # OEM_4..OEM_8 ([ \ ] ')
$SCAN_VKEYS = $SCAN_VKEYS | Sort-Object -Unique

# Resolve a VK to a layout-aware printable char using ToUnicode. Returns $null
# for dead keys / non-printable input. Feeds the real keyboard state so Shift/
# CapsLock/AltGr all produce the right glyph without hand-rolled rules.
$UNICODE_BUF = New-Object System.Text.StringBuilder 8
$KEY_STATE_BUF = New-Object byte[] 256
function Resolve-Char([int]$vk) {
  $UNICODE_BUF.Length = 0
  [void][Sy.SyRec]::GetKeyboardState($KEY_STATE_BUF)
  $scan = [Sy.SyRec]::MapVirtualKey([uint32]$vk, 0)
  $n = [Sy.SyRec]::ToUnicode([uint32]$vk, $scan, $KEY_STATE_BUF, $UNICODE_BUF, $UNICODE_BUF.Capacity, 0)
  if ($n -le 0) { return $null }
  $ch = $UNICODE_BUF.ToString()
  if ([string]::IsNullOrEmpty($ch)) { return $null }
  $c = $ch[0]
  if ([int]$c -lt 0x20) { return $null }
  return $c
}

function Get-RelCoord {
  param([int]$AbsX, [int]$AbsY, [ref]$Rect)
  $r = New-Object Sy.SyRec+RECT
  $ok = [Sy.SyRec]::GetWindowRect($hPtr, [ref]$r)
  if (-not $ok) { return $null }
  $Rect.Value = $r
  $x = $AbsX - $r.L
  $y = $AbsY - $r.T
  if ($x -lt 0 -or $y -lt 0 -or $x -gt ($r.R - $r.L) -or $y -gt ($r.B - $r.T)) { return $null }
  return @{ x = $x; y = $y; w = ($r.R - $r.L); h = ($r.B - $r.T) }
}

# Emit the capture rect as the very first event so the receiver knows which
# window size the coordinates were recorded against.
$initialRect = New-Object Sy.SyRec+RECT
$initialOk = [Sy.SyRec]::GetWindowRect($hPtr, [ref]$initialRect)
if ($initialOk) {
  Emit-Event @{
    type = 'start'
    rect = @{ w = ($initialRect.R - $initialRect.L); h = ($initialRect.B - $initialRect.T) }
    ts = [int64]([DateTime]::UtcNow.Subtract([DateTime]'1970-01-01').TotalMilliseconds)
  }
} else {
  Emit-Event @{ type = 'error'; message = 'target window not found' }
  exit 1
}

# Per-vkey last-down state so we detect edges (press / release) rather than
# streaming the same "held" signal every frame.
$lastDown = @{}
for ($vk = 1; $vk -lt 256; $vk++) { $lastDown[$vk] = $false }

$lastMouseDown = @{ 0x01 = $false; 0x02 = $false; 0x04 = $false }
$dragStart = @{ 0x01 = $null; 0x02 = $null; 0x04 = $null }
$DRAG_PIXEL_THRESHOLD = 6

$pollMs = [int](1000 / [Math]::Max(10, $PollHz))

while ($true) {
  if (-not [Sy.SyRec]::IsWindow($hPtr)) {
    Emit-Event @{ type = 'end'; reason = 'window closed' }
    break
  }

  # Ctrl+Shift+Esc is a reserved system combo. Use Ctrl+Shift+Q as the stop
  # hotkey instead (rare enough not to clobber app shortcuts).
  $ctrlDown  = ([Sy.SyRec]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0
  $shiftDown = ([Sy.SyRec]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0
  $altDown   = ([Sy.SyRec]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0
  $metaDown  = (([Sy.SyRec]::GetAsyncKeyState(0x5B) -band 0x8000) -ne 0) -or (([Sy.SyRec]::GetAsyncKeyState(0x5C) -band 0x8000) -ne 0)
  $qDown     = ([Sy.SyRec]::GetAsyncKeyState(0x51) -band 0x8000) -ne 0
  if ($ctrlDown -and $shiftDown -and $qDown) {
    Emit-Event @{ type = 'end'; reason = 'user hotkey' }
    break
  }

  # Mouse emission is gated on the target being the FOREGROUND window; a
  # click inside the target's rect that actually lands on an overlapping
  # window (picker, popup, different app) would otherwise be misrecorded.
  $mouseFg = [Sy.SyRec]::GetForegroundWindow() -eq $hPtr
  # Mouse buttons: LBUTTON=0x01, RBUTTON=0x02, MBUTTON=0x04.
  foreach ($btn in 0x01, 0x02, 0x04) {
    $down = ([Sy.SyRec]::GetAsyncKeyState($btn) -band 0x8000) -ne 0
    if ($down -ne $lastMouseDown[$btn]) {
      $pt = New-Object Sy.SyRec+POINT
      [void][Sy.SyRec]::GetCursorPos([ref]$pt)
      $r = New-Object Sy.SyRec+RECT
      $rel = Get-RelCoord -AbsX $pt.X -AbsY $pt.Y -Rect ([ref]$r)
      if ($rel -ne $null -and $mouseFg) {
        if ($down) {
          $dragStart[$btn] = @{ x = $rel.x; y = $rel.y; absX = $pt.X; absY = $pt.Y; ts = [int64]([DateTime]::UtcNow.Subtract([DateTime]'1970-01-01').TotalMilliseconds) }
        } else {
          $start = $dragStart[$btn]
          $dragStart[$btn] = $null
          if ($start -ne $null) {
            $dx = $rel.x - $start.x
            $dy = $rel.y - $start.y
            $dist = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
            $btnName = @{0x01='left';0x02='right';0x04='middle'}[$btn]
            if ($dist -ge $DRAG_PIXEL_THRESHOLD) {
              # Probe both endpoints - DRAG from a menu handle to a drop zone
              # wants selectors on both sides when possible.
              $uiaFrom = if ($start.absX -ne $null) { Probe-UiaAtPoint $start.absX $start.absY } else { $null }
              $uiaTo = Probe-UiaAtPoint $pt.X $pt.Y
              $evDrag = @{
                type = 'drag'; button = $btnName
                fromX = $start.x; fromY = $start.y
                toX = $rel.x; toY = $rel.y
                ts = [int64]([DateTime]::UtcNow.Subtract([DateTime]'1970-01-01').TotalMilliseconds)
              }
              if ($uiaFrom) { $evDrag.uiaFrom = $uiaFrom.selector; $evDrag.uiaFromName = $uiaFrom.name; $evDrag.uiaFromType = $uiaFrom.controlType }
              if ($uiaTo)   { $evDrag.uiaTo   = $uiaTo.selector;   $evDrag.uiaToName   = $uiaTo.name;   $evDrag.uiaToType   = $uiaTo.controlType }
              Emit-Event $evDrag
            } else {
              $uia = Probe-UiaAtPoint $pt.X $pt.Y
              $evClick = @{
                type = 'click'; button = $btnName
                x = $rel.x; y = $rel.y
                ts = [int64]([DateTime]::UtcNow.Subtract([DateTime]'1970-01-01').TotalMilliseconds)
              }
              if ($uia) { $evClick.uia = $uia.selector; $evClick.uiaName = $uia.name; $evClick.uiaType = $uia.controlType }
              Emit-Event $evClick
            }
          }
        }
      }
      $lastMouseDown[$btn] = $down
    }
  }

  # Keys: focus only on press edges of NAMED_KEYS and any key that produces
  # a printable glyph. Only count them when the target window is foreground,
  # so typing into another window doesn't leak into the recording.
  $fg = [Sy.SyRec]::GetForegroundWindow()
  if ($fg -eq $hPtr) {
    foreach ($vk in $SCAN_VKEYS) {
      $down = ([Sy.SyRec]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
      if ($down -and -not $lastDown[$vk]) {
        # Stop-hotkey (Ctrl+Shift+Q) doesn't leak into the event stream.
        if ($ctrlDown -and $shiftDown -and $vk -eq 0x51) { $lastDown[$vk] = $down; continue }
        if ($MOD_VKEYS.ContainsKey($vk)) { $lastDown[$vk] = $down; continue }
        $named = $NAMED_KEYS[$vk]
        $ev = @{
          type = 'key'
          vk = $vk
          ctrl = $ctrlDown; shift = $shiftDown; alt = $altDown; meta = $metaDown
          ts = [int64]([DateTime]::UtcNow.Subtract([DateTime]'1970-01-01').TotalMilliseconds)
        }
        if ($named) {
          $ev.name = $named
        } else {
          $ch = Resolve-Char $vk
          if ($ch -ne $null) { $ev.char = $ch } else { $ev.raw = $vk }
        }
        Emit-Event $ev
      }
      $lastDown[$vk] = $down
    }
  }

  Start-Sleep -Milliseconds $pollMs
}
