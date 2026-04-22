# uia-tree.ps1
#
# Snapshot the target window's UI Automation tree and emit a flat list the
# UI can render. Bounded to keep perf sane on big apps (think VS Code, a
# Chrome window). Entries are in document order; `depth` drives indent.
#
# Each row:
#   { "id": "123", "depth": 2, "name": "Save", "type": "Button",
#     "automationId": "btn-save", "class": "Win32",
#     "rect": { "x": 100, "y": 60, "w": 80, "h": 24 },
#     "invokable": true }
#
# Elements without a bounding rect or with empty name+id are skipped. Keeps
# the tree focused on useful targets.

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [int]$MaxNodes = 400
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName PresentationCore
} catch {
  [Console]::Out.WriteLine((@{ ok=$false; reason='UIA assemblies failed' } | ConvertTo-Json -Compress))
  exit 0
}

$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$Hwnd)) } catch {}
if (-not $root) {
  [Console]::Out.WriteLine((@{ ok=$false; reason='window not automatable' } | ConvertTo-Json -Compress))
  exit 0
}

$nodes = New-Object System.Collections.ArrayList
$count = 0
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

function Walk($elem, $depth) {
  if ($script:count -ge $MaxNodes) { return }
  try {
    $cur = $elem.Current
    $rect = $cur.BoundingRectangle
    $name = [string]$cur.Name
    $aid  = [string]$cur.AutomationId
    $cls = [string]$cur.ClassName
    # Use ProgrammaticName ("ControlType.Button") -> "Button" so the emitted
    # type matches the enum field names that uia-find.ps1 uses to build a
    # PropertyCondition on ControlTypeProperty.
    $type = ''
    try {
      $pn = [string]$cur.ControlType.ProgrammaticName
      if ($pn -match '^ControlType\.(.+)$') { $type = $Matches[1] }
    } catch {}
    $hasLabel = ($name -ne '') -or ($aid -ne '') -or ($cls -ne '') -or ($type -ne '')
    if ((-not $rect.IsEmpty) -and ($rect.Width -gt 1) -and ($rect.Height -gt 1) -and $hasLabel) {
      $invokable = $false
      try { $obj = $null; if ($elem.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj)) { $invokable = $true } } catch {}
      $null = $script:nodes.Add(@{
        id = [string]$script:count
        depth = $depth
        name = $name
        type = $type
        automationId = $aid
        class = $cls
        rect = @{ x=[int]$rect.Left; y=[int]$rect.Top; w=[int]$rect.Width; h=[int]$rect.Height }
        invokable = $invokable
      })
      $script:count++
    }
  } catch {}
  try {
    $child = $walker.GetFirstChild($elem)
    while ($child -ne $null -and $script:count -lt $MaxNodes) {
      Walk $child ($depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  } catch {}
}

Walk $root 0

[Console]::Out.WriteLine((@{ ok=$true; nodes=$nodes; truncated=($count -ge $MaxNodes) } | ConvertTo-Json -Compress -Depth 6))
