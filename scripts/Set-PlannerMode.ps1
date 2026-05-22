<#
.SYNOPSIS
  Set Symphonee's planner mode.

.DESCRIPTION
  Writes SymphoneeBrain.plannerMode in the config. Two modes:
  - smart  -> brain observes, maintains intent, logs decisions (default).
              Does NOT override the orchestrator's CLI selection.
  - active -> brain also fills in the missing cli on orchestrator/spawn
              when the caller does not specify one.

  Legacy values ("off", "shadow") read as "smart" so old configs keep
  working without a migration.

.PARAMETER Mode
  smart | active

.EXAMPLE
  ./scripts/Set-PlannerMode.ps1 -Mode active
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('smart', 'active')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
try {
  $current = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3800/api/config'
  if (-not $current.SymphoneeBrain) {
    $current | Add-Member -NotePropertyName SymphoneeBrain -NotePropertyValue (@{}) -Force
  }
  $current.SymphoneeBrain.plannerMode = $Mode
  $payload = $current | ConvertTo-Json -Depth 10
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/config' -ContentType 'application/json' -Body $payload | Out-Null
  $status = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3800/api/symphonee/status'
  Write-Host ("Planner mode set: " + $status.mode)
  $status | ConvertTo-Json -Depth 5
} catch {
  Write-Error ("Set-PlannerMode failed: " + $_.Exception.Message)
  exit 1
}
