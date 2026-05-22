<#
.SYNOPSIS
  Read Symphonee's current intent state.

.DESCRIPTION
  Calls GET /api/symphonee/intent. Returns the live one-sentence theory of
  what the user is doing, plus confidence, current repo, and recent
  evidence. Updated by event hooks (file watcher, drawer turns, save-result)
  and debounced 5s.

.PARAMETER Recompute
  Force a recompute against pending evidence before reading.

.EXAMPLE
  ./scripts/Get-Intent.ps1
  ./scripts/Get-Intent.ps1 -Recompute
#>
param(
  [switch]$Recompute
)

$ErrorActionPreference = 'Stop'
try {
  if ($Recompute) {
    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/intent/recompute' -ContentType 'application/json' -Body '{}' | Out-Null
  }
  $response = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3800/api/symphonee/intent'
  $response | ConvertTo-Json -Depth 10
} catch {
  Write-Error ("Get-Intent failed: " + $_.Exception.Message)
  exit 1
}
