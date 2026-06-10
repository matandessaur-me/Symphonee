<#
.SYNOPSIS
  Ask Symphonee's planner what to do with an input.

.DESCRIPTION
  Calls POST /api/symphonee/think. Returns a routing decision (intent,
  primary_cli, needed_tools, rationale, confidence). The brain is always
  on; the orchestrator already consults it for /spawn calls without a
  cli, so you usually do not need to call Think.ps1 directly -- it is
  useful for inspecting what the brain WOULD route a prompt to.

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
  . "$PSScriptRoot\_ApiInit.ps1"  # attach API auth token
  $response = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/think' -ContentType 'application/json' -Body $payload
  $response | ConvertTo-Json -Depth 10
} catch {
  Write-Error ("Think failed: " + $_.Exception.Message)
  exit 1
}
