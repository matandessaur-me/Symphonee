param(
  [Parameter(Mandatory = $true)]
  [string]$Id,

  # Inputs as a JSON string, e.g. -Inputs '{"iteration":"Sprint 42","version":"3.1.0"}'
  [string]$Inputs = "{}"
)

# Run a recipe with the given inputs.
# Reads $env:DEVOPS_PILOT_TERM_ID so the worker result is delivered back
# to the terminal that launched it (just like graph runs do).
#
# Usage:
#   ./scripts/Run-Recipe.ps1 -Id sprint-review
#   ./scripts/Run-Recipe.ps1 -Id release-notes -Inputs '{"version":"3.1.0"}'

try { $inputsObj = $Inputs | ConvertFrom-Json -AsHashtable } catch { Write-Error "Invalid -Inputs JSON: $_"; exit 1 }

$body = @{ id = $Id; inputs = $inputsObj }
if ($env:DEVOPS_PILOT_TERM_ID) { $body.originTermId = $env:DEVOPS_PILOT_TERM_ID }
$json = $body | ConvertTo-Json -Depth 6

try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/recipes/run' -Method Post -Body $json -ContentType 'application/json'
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  Write-Error "Failed: $msg"
  exit 1
}

Write-Host "Recipe: $($r.recipe)" -ForegroundColor Green
Write-Host "  cli:    $($r.cli)"
Write-Host "  model:  $($r.model)"
Write-Host "  task:   $($r.taskId)"
if ($r.advisedMode) { Write-Host "  advised mode: $($r.advisedMode) (recipe suggests this; switch the chip if needed)" -ForegroundColor Yellow }
Write-Host ""
Write-Host "Worker spawned. Result will be injected into this terminal when complete."
