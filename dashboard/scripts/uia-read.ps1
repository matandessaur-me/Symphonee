# uia-read.ps1
#
# Read the text/value of a UIA element matched by selector. Lets the agent
# verify state without taking a screenshot (button label, input contents,
# status bar text, dialog message).
#
# Emits ONE JSON line:
#   { "hit": true, "value": "...", "name": "...", "type": "..." }
#   { "hit": false, "reason": "..." }

param(
  [Parameter(Mandatory=$true)][long]$Hwnd,
  [Parameter(Mandatory=$true)][string]$SelectorJson
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

function Out-Json($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)) }

try { $sel = $SelectorJson | ConvertFrom-Json } catch { Out-Json @{ hit=$false; reason='bad selector JSON'}; exit 0 }
if ($sel -eq $null) { Out-Json @{ hit=$false; reason='empty selector'}; exit 0 }

$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$Hwnd)) } catch {}
if ($root -eq $null) { Out-Json @{ hit=$false; reason='window not automatable'}; exit 0 }

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

$elem = $null
try { $elem = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $combined) } catch {}
if ($elem -eq $null) { Out-Json @{ hit=$false; reason='no element matched selector' }; exit 0 }

$value = ''
$source = 'name'
# Prefer ValuePattern (text inputs) -> TextPattern (rich text) -> Name
try {
  $vp = $null
  if ($elem.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    $value = [string]$vp.Current.Value
    $source = 'value'
  }
} catch {}
if ($value -eq '') {
  try {
    $tp = $null
    if ($elem.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $rng = $tp.DocumentRange
      if ($rng) { $value = [string]$rng.GetText(2000); $source = 'text' }
    }
  } catch {}
}
if ($value -eq '') { $value = [string]$elem.Current.Name; $source = 'name' }

$type = ''
try {
  $pn = [string]$elem.Current.ControlType.ProgrammaticName
  if ($pn -match '^ControlType\.(.+)$') { $type = $Matches[1] }
} catch {}

Out-Json @{
  hit = $true
  value = $value
  source = $source
  name = [string]$elem.Current.Name
  type = $type
  automationId = [string]$elem.Current.AutomationId
}
