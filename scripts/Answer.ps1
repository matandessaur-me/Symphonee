<#
.SYNOPSIS
  Ask Symphonee to answer a question locally first (Mind / gemma) before
  spending frontier tokens.

.DESCRIPTION
  Calls POST /api/symphonee/answer. The brain tries Mind recall, then a
  local gemma synthesis, and only signals "escalate" if a frontier CLI
  is the right tool. Returns one of:

    source: mind     -> answer synthesized from Mind hits (zero frontier tokens)
    source: local    -> answer from gemma directly (zero frontier tokens)
    source: escalate -> the brain says this needs a real CLI worker
    source: no-op    -> greeting or empty input

.PARAMETER Input
  The question to answer.

.EXAMPLE
  ./scripts/Answer.ps1 -Input "what did we figure out about the planner?"
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Input
)

$ErrorActionPreference = 'Stop'
$payload = @{ input = $Input } | ConvertTo-Json -Compress
try {
  $response = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/answer' -ContentType 'application/json' -Body $payload
  $response | ConvertTo-Json -Depth 10
} catch {
  Write-Error ("Answer failed: " + $_.Exception.Message)
  exit 1
}
