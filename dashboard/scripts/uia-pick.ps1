# uia-pick.ps1
#
# Interactive element picker. The Automations editor calls this when the user
# clicks "Pick UI element": we hover over the target window, Ctrl+Click on
# whatever we want to capture, and this script dumps a minimal persistent
# selector for that element. Escape cancels.
#
# Emits JSON-lines to stdout so the Node side can stream status to the UI.
#   { "type": "hover", "name":"...", "controlType":"...", "rect":{...} }   (while holding)
#   { "type": "picked", "selector": {...}, "rect":{...} }                   (on Ctrl+Click)
#   { "type": "cancelled" }                                                 (on Escape or timeout)

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName PresentationCore
} catch {
  [Console]::Out.WriteLine((@{ type='error'; message='UIA assemblies failed: ' + $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}

Add-Type -Name SyPick -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern short GetAsyncKeyState(int vKey);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetCursorPos(out POINT p);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
"@

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

function Get-ControlTypeName($elem) {
  # uia-find/invoke look up ControlType via [ControlType].GetField(name) which
  # expects the ENUM field name ("Button", "MenuItem"), not the localized
  # display label ("button", "menu item"). ProgrammaticName returns
  # "ControlType.Button" - strip the prefix to get the matchable name.
  try {
    $pn = [string]$elem.Current.ControlType.ProgrammaticName
    if ($pn -match '^ControlType\.(.+)$') { return $Matches[1] }
  } catch {}
  return ''
}

function Make-MinimalSelector($elem) {
  # Build a selector that is as identifying as possible but not over-specific.
  # Priority order:
  #   1. AutomationId alone if it is non-empty and not a volatile pattern.
  #   2. Name + ControlType.
  #   3. Name + ControlType + 2 ancestors for tiebreaking.
  $sel = @{}
  $id = [string]$elem.Current.AutomationId
  $name = [string]$elem.Current.Name
  $type = Get-ControlTypeName $elem
  $cls = [string]$elem.Current.ClassName
  # AutomationId is volatile when it looks like a runtime-generated guid or
  # when it's a digit run - both get re-minted on every app start.
  $looksVolatile = ($id -match '^[0-9a-fA-F\-]{8,}$') -or ($id -match '^\d{3,}$') -or ($id -eq '')
  if (-not $looksVolatile) {
    $sel.id = $id
    if ($type) { $sel.type = $type }
    return $sel
  }
  if ($name) { $sel.name = $name }
  if ($type) { $sel.type = $type }
  if ($cls -and -not $name) { $sel.class = $cls }
  if (-not $sel.name -and -not $sel.class) {
    # Last-ditch: use ClassName so at least *something* pins the element.
    if ($cls) { $sel.class = $cls }
  }
  # 2 ancestor chain - helps disambiguate duplicates (e.g. multiple "Close"
  # buttons, one per tab).
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $parent = $walker.GetParent($elem)
  $ancestors = @()
  $depth = 0
  while ($parent -ne $null -and $depth -lt 2) {
    $pt = Get-ControlTypeName $parent
    $pn = [string]$parent.Current.Name
    $a = @{}
    if ($pt) { $a.type = $pt }
    if ($pn) { $a.name = $pn }
    if ($a.Count -gt 0) { $ancestors += $a }
    $parent = $walker.GetParent($parent)
    $depth++
  }
  if ($ancestors.Count -gt 0) { $sel.ancestors = $ancestors }
  return $sel
}

$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$Hwnd)) }
catch { Emit @{ type='error'; message='UIA FromHandle threw: ' + $_.Exception.Message }; exit 1 }
if ($root -eq $null) { Emit @{ type='error'; message='target window not automatable (UIA FromHandle returned null - try a different app or ensure Windows Accessibility is enabled)' }; exit 1 }

Emit @{ type='ready'; hint='Move to the target element and press Ctrl+Click. Escape to cancel.' }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$lastEmitAt = 0
$prevLDown = $false

while ((Get-Date) -lt $deadline) {
  # Escape cancels.
  if (([Sy.SyPick]::GetAsyncKeyState(0x1B) -band 0x8000) -ne 0) {
    Emit @{ type='cancelled'; reason='escape' }
    exit 0
  }

  $ctrlDown = ([Sy.SyPick]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0
  $lDown    = ([Sy.SyPick]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
  $clickEdge = $ctrlDown -and $lDown -and (-not $prevLDown)
  $prevLDown = $lDown

  $pt = New-Object Sy.SyPick+POINT
  [void][Sy.SyPick]::GetCursorPos([ref]$pt)
  $p = New-Object System.Windows.Point($pt.X, $pt.Y)

  $elem = $null
  try { $elem = [System.Windows.Automation.AutomationElement]::FromPoint($p) } catch {}
  if ($elem -ne $null) {
    # Emit a lightweight hover notice ~4x per second so the UI can surface
    # what's under the cursor in real time.
    $nowMs = [int64]([DateTime]::UtcNow.Subtract([DateTime]'1970-01-01').TotalMilliseconds)
    if ($nowMs - $lastEmitAt -gt 250) {
      $lastEmitAt = $nowMs
      $rect = $elem.Current.BoundingRectangle
      Emit @{
        type='hover'
        name=[string]$elem.Current.Name
        controlType=[string]$elem.Current.LocalizedControlType
        id=[string]$elem.Current.AutomationId
        rect=@{ x=[int]$rect.Left; y=[int]$rect.Top; w=[int]$rect.Width; h=[int]$rect.Height }
      }
    }
    if ($clickEdge) {
      $sel = Make-MinimalSelector $elem
      $rect = $elem.Current.BoundingRectangle
      Emit @{
        type='picked'
        selector=$sel
        rect=@{ x=[int]$rect.Left; y=[int]$rect.Top; w=[int]$rect.Width; h=[int]$rect.Height }
        name=[string]$elem.Current.Name
        controlType=[string]$elem.Current.LocalizedControlType
      }
      exit 0
    }
  }

  Start-Sleep -Milliseconds 50
}

Emit @{ type='cancelled'; reason='timeout' }
