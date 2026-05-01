# uia-hit-test.ps1
#
# Reverse coordinate -> element lookup. Given a window handle and a
# window-relative (x, y), return the UIA element under that point so we can
# heal a pixel-coordinate recipe step into a stable selector-based one.
#
# Emits ONE JSON line:
#   { "hit": true, "name": "...", "type": "Button", "automationId": "...",
#     "class": "...", "x": 100, "y": 60, "w": 80, "h": 24, "ancestors": [...] }
#   { "hit": false, "reason": "..." }

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName PresentationCore
} catch {
  [Console]::Out.WriteLine((@{ hit=$false; reason='UIA assemblies failed: ' + $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 0
}

# Translate window-relative coords to screen-absolute for FromPoint.
Add-Type -Name SyHitW32 -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int L; public int T; public int R; public int B; }
"@

$wr = New-Object Sy.SyHitW32+RECT
[void][Sy.SyHitW32]::GetWindowRect([IntPtr]::new([int64]$Hwnd), [ref]$wr)
$absX = $wr.L + $X
$absY = $wr.T + $Y

$pt = New-Object System.Windows.Point($absX, $absY)
$elem = $null
try { $elem = [System.Windows.Automation.AutomationElement]::FromPoint($pt) } catch {}
if ($elem -eq $null) {
  [Console]::Out.WriteLine((@{ hit=$false; reason='no UIA element at point' } | ConvertTo-Json -Compress))
  exit 0
}

function Get-TypeName($el) {
  try {
    $pn = [string]$el.Current.ControlType.ProgrammaticName
    if ($pn -match '^ControlType\.(.+)$') { return $Matches[1] }
  } catch {}
  return ''
}

# Walk up to 4 ancestors so the heal can reproduce the element with
# context (parent toolbar, parent dialog, etc.).
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$ancestors = @()
$current = $walker.GetParent($elem)
$depth = 0
while ($current -ne $null -and $depth -lt 4) {
  $ancestors += @{ type = (Get-TypeName $current); name = [string]$current.Current.Name }
  $current = $walker.GetParent($current)
  $depth++
}

$rect = $elem.Current.BoundingRectangle
$result = @{
  hit = $true
  name = [string]$elem.Current.Name
  type = (Get-TypeName $elem)
  automationId = [string]$elem.Current.AutomationId
  class = [string]$elem.Current.ClassName
  x = if (-not $rect.IsEmpty) { [int]($rect.Left - $wr.L) } else { 0 }
  y = if (-not $rect.IsEmpty) { [int]($rect.Top - $wr.T) } else { 0 }
  w = if (-not $rect.IsEmpty) { [int]$rect.Width } else { 0 }
  h = if (-not $rect.IsEmpty) { [int]$rect.Height } else { 0 }
  ancestors = $ancestors
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
