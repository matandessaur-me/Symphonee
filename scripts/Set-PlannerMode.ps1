<#
.SYNOPSIS
  Set Symphonee's planner mode.

.DESCRIPTION
  Writes SymphoneeBrain.plannerMode in the config. Three modes:
  - off    -> planner endpoints are no-ops
  - shadow -> planner logs decisions, no dispatch (default)
  - active -> planner decisions surface to the orchestrator

.PARAMETER Mode
  off | shadow | active

.EXAMPLE
  ./scripts/Set-PlannerMode.ps1 -Mode active
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('off', 'shadow', 'active')]
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
