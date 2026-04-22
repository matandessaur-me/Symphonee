# uia-invoke.ps1
#
# Like uia-find, but executes the element's default action directly via
# UIA patterns instead of returning coordinates. Invoke > Toggle > Select >
# Expand/Collapse, whichever the element supports. Faster than a simulated
# click and doesn't steal focus.
#
# Falls through with {"hit":false} if the matched element doesn't support
# any of these patterns; the runner then does a coordinate click.

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
  [Console]::Out.WriteLine((@{ hit=$false; reason='UIA assemblies failed to load' } | ConvertTo-Json -Compress))
  exit 0
}

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }

try { $sel = $SelectorJson | ConvertFrom-Json } catch { Out-Json @{ hit=$false; reason='bad JSON' }; exit 0 }
$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$Hwnd)) } catch {}
if (-not $root) { Out-Json @{ hit=$false; reason='window not automatable' }; exit 0 }

$ap = [System.Windows.Automation.AutomationElement]
$conds = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
if ($sel.id)   { $conds.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::AutomationIdProperty, [string]$sel.id))) | Out-Null }
if ($sel.name) { $conds.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::NameProperty,         [string]$sel.name))) | Out-Null }
if ($sel.class){ $conds.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::ClassNameProperty,    [string]$sel.class))) | Out-Null }
if ($sel.type) {
  $f = [System.Windows.Automation.ControlType].GetField([string]$sel.type, [System.Reflection.BindingFlags]'Public,Static')
  if ($f) { $conds.Add((New-Object System.Windows.Automation.PropertyCondition ($ap::ControlTypeProperty, $f.GetValue($null)))) | Out-Null }
}
if ($conds.Count -eq 0) { Out-Json @{ hit=$false; reason='no usable selector fields' }; exit 0 }

$combined = if ($conds.Count -eq 1) { $conds[0] } else {
  [System.Windows.Automation.Condition]([System.Windows.Automation.AndCondition]::new($conds.ToArray()))
}
$hit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $combined)
if (-not $hit) { Out-Json @{ hit=$false; reason='no match' }; exit 0 }

$patterns = @(
  [System.Windows.Automation.InvokePattern]::Pattern,
  [System.Windows.Automation.TogglePattern]::Pattern,
  [System.Windows.Automation.SelectionItemPattern]::Pattern,
  [System.Windows.Automation.ExpandCollapsePattern]::Pattern
)

$used = $null
try {
  $obj = $null
  if ($hit.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj)) {
    ([System.Windows.Automation.InvokePattern]$obj).Invoke(); $used = 'Invoke'
  } elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$obj)) {
    ([System.Windows.Automation.TogglePattern]$obj).Toggle(); $used = 'Toggle'
  } elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$obj)) {
    ([System.Windows.Automation.SelectionItemPattern]$obj).Select(); $used = 'Select'
  } elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$obj)) {
    $p = [System.Windows.Automation.ExpandCollapsePattern]$obj
    if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $p.Expand() } else { $p.Collapse() }
    $used = 'ExpandCollapse'
  } else {
    Out-Json @{ hit=$false; reason='element has no invokable pattern' }; exit 0
  }
} catch {
  Out-Json @{ hit=$false; reason='pattern call threw: ' + $_.Exception.Message }; exit 0
}

Out-Json @{ hit=$true; pattern=$used; name=[string]$hit.Current.Name; type=[string]$hit.Current.LocalizedControlType }
