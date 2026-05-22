<#
.SYNOPSIS
  Tag a previously-logged brain decision with an outcome.

.DESCRIPTION
  Calls POST /api/symphonee/outcome. The outcome flows into the brain's
  feedback loop -- aggregate stats per (intent, cli) influence future
  routing decisions. After ~10 outcomes for an intent class, the planner's
  triage prompt starts seeing "Historical performance" hints biased toward
  the historically-validated CLI.

.PARAMETER DecisionId
  The id returned by /api/symphonee/think or /api/symphonee/answer (or
  visible in /api/symphonee/decisions).

.PARAMETER Outcome
  validated | contradicted | corrected | unused

.PARAMETER Detail
  Optional free-text note.

.EXAMPLE
  ./scripts/Outcome.ps1 -DecisionId dec_abc123_xyz -Outcome validated
  ./scripts/Outcome.ps1 -DecisionId dec_abc123_xyz -Outcome corrected -Detail "should have used claude-code"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$DecisionId,
  [Parameter(Mandatory = $true)]
  [ValidateSet('validated', 'contradicted', 'corrected', 'unused')]
  [string]$Outcome,
  [string]$Detail
)

$ErrorActionPreference = 'Stop'
$payload = @{
  decisionId = $DecisionId
  outcome = $Outcome
}
if ($Detail) { $payload.detail = $Detail }
$body = $payload | ConvertTo-Json -Compress
try {
  $response = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/outcome' -ContentType 'application/json' -Body $body
  $response | ConvertTo-Json -Depth 5
} catch {
  Write-Error ("Outcome failed: " + $_.Exception.Message)
  exit 1
}
