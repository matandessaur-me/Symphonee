param(
  [Parameter(Mandatory = $true)][string]$Id,
  [ValidateSet('pause', 'resume', 'cancel')]
  [string]$Action = 'pause'
)

# Pauses, resumes, or cancels a graph run.
#
# Usage:
#   ./scripts/Stop-GraphRun.ps1 -Id gr_abc                 # pause
#   ./scripts/Stop-GraphRun.ps1 -Id gr_abc -Action resume
#   ./scripts/Stop-GraphRun.ps1 -Id gr_abc -Action cancel

try {
  $res = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/graph-runs/$Id/$Action" -Method Post
  Write-Host "Run $Id -> $($res.status)" -ForegroundColor Green
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  Write-Error "Failed: $msg"
  exit 1
}
