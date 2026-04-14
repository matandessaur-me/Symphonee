param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('quick-summary','deep-code','plan-and-implement','long-autonomy','web-research','web-research-cheap','pr-review','social-live','parallel-fanout','large-context')]
  [string]$Intent,

  [int]$ContextTokens = 0,

  [ValidateSet('cheap','default','premium')]
  [string]$Budget = 'default',

  [switch]$Json
)

# Ask the model router for the best (cli, model) for a given intent.
# Respects your orchestration allowlist and required API keys.
#
# Usage:
#   ./scripts/Get-ModelRecommendation.ps1 -Intent quick-summary
#   ./scripts/Get-ModelRecommendation.ps1 -Intent deep-code -Budget premium
#   ./scripts/Get-ModelRecommendation.ps1 -Intent web-research -Json

$body = @{
  intent = $Intent
  contextTokens = $ContextTokens
  budget = $Budget
} | ConvertTo-Json

try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/models/recommend' -Method Post -Body $body -ContentType 'application/json'
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  Write-Error "Failed: $msg"
  exit 1
}

if ($Json) {
  $r | ConvertTo-Json -Depth 6
  return
}

if (-not $r.cli) {
  Write-Host "No model available for intent '$Intent'." -ForegroundColor Yellow
  Write-Host "  $($r.reasoning)"
  return
}

Write-Host "Intent: $Intent"
if ($r.fallback) {
  Write-Host "CLI:    $($r.cli) (FALLBACK - no preferred model matched)" -ForegroundColor Yellow
} else {
  Write-Host "CLI:    $($r.cli)" -ForegroundColor Green
  Write-Host "Model:  $($r.model)"
}
Write-Host "Why:    $($r.reasoning)"
if ($r.meta -and $r.meta.note) {
  Write-Host "Note:   $($r.meta.note)" -ForegroundColor Cyan
}
