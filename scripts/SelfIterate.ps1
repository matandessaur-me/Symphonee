<#
.SYNOPSIS
  Ask Symphonee's brain to propose an edit to its own routing rules.

.DESCRIPTION
  The brain reads the outcome stats, detects failure patterns, and asks
  gemma to propose a revised rules block. The proposal is RETURNED, NOT
  APPLIED -- you review it, then run with -Accept to apply, or with
  -Revert to roll back the most recent change.

  If there is not enough outcome data yet (default: 15 samples), the brain
  refuses to propose. Tag more outcomes via Outcome.ps1 first.

.PARAMETER Accept
  Apply the most recent proposal. The new rules block must be passed via
  -RulesFile (a file containing the new rules text) so you can review
  before committing.

.PARAMETER Revert
  Roll back to the previous rules state (one step in history).

.PARAMETER RulesFile
  Path to a file containing a revised rules block (used with -Accept).

.EXAMPLE
  # Step 1: ask for a proposal
  $proposal = ./scripts/SelfIterate.ps1 | ConvertFrom-Json
  $proposal.proposal.rules | Out-File proposed-rules.md
  # Step 2: review proposed-rules.md, edit if needed
  # Step 3: accept
  ./scripts/SelfIterate.ps1 -Accept -RulesFile proposed-rules.md
  # If you change your mind:
  ./scripts/SelfIterate.ps1 -Revert
#>
param(
  [switch]$Accept,
  [switch]$Revert,
  [string]$RulesFile
)

$ErrorActionPreference = 'Stop'

try {
  if ($Revert) {
    . "$PSScriptRoot\_ApiInit.ps1"  # attach API auth token
    $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/self-iterate/revert' -ContentType 'application/json' -Body '{}'
    $r | ConvertTo-Json -Depth 5
    return
  }
  if ($Accept) {
    if (-not $RulesFile -or -not (Test-Path $RulesFile)) {
      Write-Error "Accept requires -RulesFile pointing to a file with the new rules."
      exit 1
    }
    $rules = Get-Content -Raw -Path $RulesFile
    $body = @{ rules = $rules } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/self-iterate/accept' -ContentType 'application/json' -Body $body
    $r | ConvertTo-Json -Depth 5
    return
  }
  # Default: propose
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/symphonee/self-iterate' -ContentType 'application/json' -Body '{}'
  $r | ConvertTo-Json -Depth 10
} catch {
  Write-Error ("SelfIterate failed: " + $_.Exception.Message)
  exit 1
}
