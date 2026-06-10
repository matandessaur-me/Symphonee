<#
.SYNOPSIS
  Ask Symphonee to propose recipes from recently observed workflow shapes.

.DESCRIPTION
  Calls POST /api/symphonee/synthesize. Reads the rolling event log,
  clusters sessions by shape, and asks gemma4:26b to draft a recipe for
  each mature cluster. Drafts are NOT auto-accepted -- this is a
  proposal step.

  To accept a draft, pipe the returned JSON back with:
    POST /api/symphonee/synthesize/accept { draft }
  or use Accept-RecipeDraft.ps1 (when added).

.PARAMETER Days
  Look-back window for sessions (default 30).

.PARAMETER MinClusterSize
  Minimum sessions in a cluster before drafting (default 3).

.EXAMPLE
  ./scripts/Synthesize.ps1
  ./scripts/Synthesize.ps1 -Days 14 -MinClusterSize 4
#>
param(
  [int]$Days = 30,
  [int]$MinClusterSize = 3,
  [int]$MaxDrafts = 5
)

$ErrorActionPreference = 'Stop'
$payload = @{
  days = $Days
  minClusterSize = $MinClusterSize
  maxDrafts = $MaxDrafts
} | ConvertTo-Json -Compress

try {
  . "$PSScriptRoot\_ApiInit.ps1"  # attach API auth token
  $response = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/synthesize' -ContentType 'application/json' -Body $payload
  $response | ConvertTo-Json -Depth 10
} catch {
  Write-Error ("Synthesize failed: " + $_.Exception.Message)
  exit 1
}
