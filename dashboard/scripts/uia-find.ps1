# uia-find.ps1
#
# Find a UI element in a target window by semantic selector. Uses System.
# Windows.Automation (UI Automation) instead of pixel coordinates so the
# match survives window resizes, theme changes, and layout tweaks.
#
# Selector JSON shape (all fields optional; scoring picks the best match):
#   {
#     "type":       "Button",              # ControlType localized name
#     "name":       "Save",                # Name property (exact match)
#     "id":         "btn-save",            # AutomationId (preferred - unlocalized)
#     "class":      "Win32ClassName",
#     "ancestors":  [ { "type":"Pane", "name":"Toolbar" } ]
#   }
#
# Emits ONE JSON line with the result:
#   { "hit": true, "x": 123, "y": 456, "w": 80, "h": 24, "name": "...", "type": "Button", "id": "..." }
# or { "hit": false, "reason": "element not found" }

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [Parameter(Mandatory=$true)][string]$SelectorJson
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName PresentationCore
} catch {
  [Console]::Out.WriteLine((@{ hit=$false; reason='UIA assemblies failed to load: ' + $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 0
}

function Out-Json($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
}

# Parse selector.
try { $sel = $SelectorJson | ConvertFrom-Json } catch { Out-Json @{ hit=$false; reason='bad selector JSON'}; exit 0 }
if ($sel -eq $null) { Out-Json @{ hit=$false; reason='empty selector'}; exit 0 }

$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$Hwnd)) } catch {}
if ($root -eq $null) { Out-Json @{ hit=$false; reason='window not automatable (UIA returned null)'}; exit 0 }

# Build a combined AndCondition from the supplied fields so UIA filters the
# tree natively rather than us walking every descendant.
$ap = [System.Windows.Automation.AutomationElement]
$conditions = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
if ($sel.id)   { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::AutomationIdProperty, [string]$sel.id))) | Out-Null }
if ($sel.name) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::NameProperty,         [string]$sel.name))) | Out-Null }
if ($sel.class){ $conditions.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::ClassNameProperty,    [string]$sel.class))) | Out-Null }
if ($sel.type) {
  $ctField = [System.Windows.Automation.ControlType].GetField([string]$sel.type, [System.Reflection.BindingFlags]'Public,Static')
  if ($ctField) {
    $ct = $ctField.GetValue($null)
    $conditions.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::ControlTypeProperty, $ct))) | Out-Null
  }
}

if ($conditions.Count -eq 0) { Out-Json @{ hit=$false; reason='selector has no usable fields' }; exit 0 }

$combined = if ($conditions.Count -eq 1) { $conditions[0] } else {
  [System.Windows.Automation.Condition]([System.Windows.Automation.AndCondition]::new($conditions.ToArray()))
}

# FindAll (not FindFirst) so we can rank by ancestor matches when provided.
# Progressive relaxation: if the full selector misses, drop the most-
# restrictive fields in turn (class -> name -> id -> type) and try again.
# Each relaxation is reported so the runtime can surface degraded matches.
function Try-FindAll($root, $conds) {
  if ($conds.Count -eq 0) { return @() }
  $combined = if ($conds.Count -eq 1) { $conds[0] } else {
    [System.Windows.Automation.Condition]([System.Windows.Automation.AndCondition]::new($conds.ToArray()))
  }
  try { return $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $combined) }
  catch { return @() }
}

$hits = Try-FindAll $root $conditions
$degradedFrom = $null

if ($hits.Count -eq 0) {
  # Relaxation ladder: reduce specificity one step at a time. Each removal is
  # reported back as "degraded:<field>" so the runtime can log that the match
  # isn't pixel-perfect.
  $dropOrder = @('class', 'name', 'id')
  foreach ($drop in $dropOrder) {
    $relaxed = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
    foreach ($c in $conditions) {
      # PropertyCondition.Property holds the AutomationProperty; compare by Id.
      $prop = $c.Property
      if ($drop -eq 'class' -and $prop -eq $ap::ClassNameProperty) { continue }
      if ($drop -eq 'name'  -and $prop -eq $ap::NameProperty)      { continue }
      if ($drop -eq 'id'    -and $prop -eq $ap::AutomationIdProperty) { continue }
      $relaxed.Add($c) | Out-Null
    }
    if ($relaxed.Count -eq $conditions.Count) { continue }  # nothing dropped - skip
    $hits = Try-FindAll $root $relaxed
    if ($hits.Count -gt 0) { $degradedFrom = $drop; break }
  }
}

if ($hits.Count -eq 0) { Out-Json @{ hit=$false; reason='no element matched selector (even with relaxation)' }; exit 0 }

# Rank by ancestor-chain match. Walk parents up to 6 levels and count the
# requested ancestor fragments that appear (in any order). Highest count wins;
# tiebreak by smallest bounding rect (most specific).
function Score-Ancestors($element, $wanted) {
  if ($wanted -eq $null -or $wanted.Count -eq 0) { return 0 }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $current = $walker.GetParent($element)
  $path = @()
  $depth = 0
  while ($current -ne $null -and $depth -lt 6) {
    # Compare ancestors on the programmatic enum name so matches work against
    # selectors written with "Pane", "Toolbar", etc. rather than localized
    # labels like "pane" / "Barre d'outils".
    $pathType = ''
    try {
      $curPn = [string]$current.Current.ControlType.ProgrammaticName
      if ($curPn -match '^ControlType\.(.+)$') { $pathType = $Matches[1] }
    } catch {}
    $path += @{ type = $pathType; name = $current.Current.Name }
    $current = $walker.GetParent($current)
    $depth++
  }
  $score = 0
  foreach ($w in $wanted) {
    foreach ($p in $path) {
      $typeOk = (-not $w.type) -or ($p.type -eq $w.type)
      $nameOk = (-not $w.name) -or ($p.name -eq $w.name)
      if ($typeOk -and $nameOk) { $score++; break }
    }
  }
  return $score
}

$best = $null
$bestScore = -1
foreach ($h in $hits) {
  $score = Score-Ancestors $h $sel.ancestors
  if ($score -gt $bestScore) { $best = $h; $bestScore = $score }
}
if ($best -eq $null) { Out-Json @{ hit=$false; reason='ranking returned null'}; exit 0 }

$rect = $best.Current.BoundingRectangle
# BoundingRectangle can be empty (off-screen or invisible). Prefer the first
# on-screen match if the best-ranked one is invisible.
if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) {
  foreach ($h in $hits) {
    $r = $h.Current.BoundingRectangle
    if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) { $best = $h; $rect = $r; break }
  }
}
if ($rect.IsEmpty) { Out-Json @{ hit=$false; reason='match has no bounding rect (off-screen or not rendered)' }; exit 0 }

# Translate screen-absolute bounding rect to window-relative.
Add-Type -Name SyUiaW32 -Namespace Sy -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int L; public int T; public int R; public int B; }
"@
$wr = New-Object Sy.SyUiaW32+RECT
[void][Sy.SyUiaW32]::GetWindowRect([IntPtr]::new([int64]$Hwnd), [ref]$wr)

$cx = [int]($rect.Left + ($rect.Width / 2))
$cy = [int]($rect.Top + ($rect.Height / 2))

$result = @{
  hit = $true
  x = $cx - $wr.L
  y = $cy - $wr.T
  w = [int]$rect.Width
  h = [int]$rect.Height
  name = [string]$best.Current.Name
  type = [string]$best.Current.LocalizedControlType
  id   = [string]$best.Current.AutomationId
}
if ($degradedFrom) { $result.degraded = $degradedFrom }
Out-Json $result
