<#
.SYNOPSIS
  Startup profiler for Symphonee (P0.1). Runs the module-load harness and, if a
  boot trace exists, prints the end-to-end phase breakdown.

.DESCRIPTION
  Two data sources:
   1. Module-load harness - require() cost of server.js's dependency tree.
      Safe to run anytime; does NOT boot the server or bind a port.
   2. Boot trace - the real launch timeline written by dashboard/startup-trace.js
      to .ai-workspace/startup-traces/boot-<n>.json. Produced only by an actual
      Symphonee launch (quit and relaunch to refresh).

.EXAMPLE
  ./scripts/Profile-Startup.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$harness = Join-Path $root 'dashboard\tools\profile-module-load.js'
$traceDir = Join-Path $root '.ai-workspace\startup-traces'

Write-Host "`n=== Module require() cost (safe, no server boot) ===" -ForegroundColor Cyan
node $harness

Write-Host "`n=== Latest boot trace (real launch timeline) ===" -ForegroundColor Cyan
$boot = $null
if (Test-Path $traceDir) {
  $boot = Get-ChildItem $traceDir -Filter 'boot-*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $boot) {
    $latest = Join-Path $traceDir 'boot-latest.json'
    if (Test-Path $latest) { $boot = Get-Item $latest }
  }
}

if (-not $boot) {
  Write-Host "No boot trace found yet. Quit and relaunch Symphonee, then re-run." -ForegroundColor Yellow
  return
}

$doc = Get-Content $boot.FullName -Raw | ConvertFrom-Json
Write-Host ("File: {0}  (total {1} ms, reason: {2})" -f $boot.Name, $doc.totalMs, $doc.reason)
Write-Host ("{0,-38} {1,10} {2,10}" -f 'phase', 'atMs', 'deltaMs')
Write-Host ('-' * 60)
foreach ($m in $doc.marks) {
  Write-Host ("{0,-38} {1,10} {2,10}" -f $m.name, $m.atMs, $m.deltaMs)
}
