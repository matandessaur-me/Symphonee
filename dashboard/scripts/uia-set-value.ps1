# uia-set-value.ps1
#
# Set the text/value of an edit-style UIA element via ValuePattern.SetValue.
# Used by sandboxed sessions where SendInput cannot deliver text to the
# off-screen target window. Most edit controls (Spotify search box,
# WinForms TextBox, WPF TextBox, modern UWP/WinUI input) support
# ValuePattern. Multiline RichTextBox uses TextPattern which is NOT
# settable — for those we return { hit:false, reason:'pattern_unset' }.
#
# Output: JSON with { hit, pattern, name, type } or { hit:false, reason }.

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [Parameter(Mandatory=$true)][string]$SelectorJson,
  [Parameter(Mandatory=$true)][string]$Value
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

# Try to focus the element first — some apps (Spotify, Edge) only accept
# value-set after the field has focus. This does NOT move the host cursor
# or steal foreground; SetFocus is per-element.
try { $hit.SetFocus() } catch {}

$obj = $null
if (-not $hit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj)) {
  Out-Json @{ hit=$false; reason='element does not support ValuePattern (try TextPattern + keyboard fallback)' }; exit 0
}
$vp = [System.Windows.Automation.ValuePattern]$obj
if ($vp.Current.IsReadOnly) { Out-Json @{ hit=$false; reason='element is read-only' }; exit 0 }
try {
  $vp.SetValue([string]$Value)
} catch {
  Out-Json @{ hit=$false; reason='SetValue threw: ' + $_.Exception.Message }; exit 0
}

Out-Json @{ hit=$true; pattern='Value'; name=[string]$hit.Current.Name; type=[string]$hit.Current.LocalizedControlType; chars=$Value.Length }
