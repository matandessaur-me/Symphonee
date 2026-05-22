<#
.SYNOPSIS
  Ask Symphonee's planner what to do with an input.

.DESCRIPTION
  Calls POST /api/symphonee/think. By default planner runs in smart mode -
  it returns a routing decision but does NOT dispatch. Flip planner mode to
  "active" to have the orchestrator honor the decision.

.PARAMETER Input
  The user input to classify.

.EXAMPLE
  ./scripts/Think.ps1 -Input "fix the co-edit dedup bug"
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Input
)

$ErrorActionPreference = 'Stop'
$payload = @{ input = $Input } | ConvertTo-Json -Compress
try {
  $response = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/think' -ContentType 'application/json' -Body $payload
  $response | ConvertTo-Json -Depth 10
} catch {
  Write-Error ("Think failed: " + $_.Exception.Message)
  exit 1
}
