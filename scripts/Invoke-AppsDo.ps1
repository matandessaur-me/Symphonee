param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Goal,
  [int]$WaitMs = 600000,
  [string]$Provider,
  [string]$Model
)

$body = @{
  app = $App
  goal = $Goal
  waitMs = $WaitMs
}

if ($Provider) { $body.provider = $Provider }
if ($Model) { $body.model = $Model }
if ($env:SYMPHONEE_TERM_ID) { $body.termId = $env:SYMPHONEE_TERM_ID }

. "$PSScriptRoot\_ApiInit.ps1"  # attach API auth token
Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:3800/api/apps/do' `
  -ContentType 'application/json' `
  -Body ($body | ConvertTo-Json -Depth 10)
