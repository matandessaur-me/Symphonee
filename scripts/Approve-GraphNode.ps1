param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$NodeId,
  [switch]$Reject,
  [string]$Note = ""
)

# Resolves a pending approval node in a graph run.
#
# Usage:
#   ./scripts/Approve-GraphNode.ps1 -RunId gr_abc -NodeId review
#   ./scripts/Approve-GraphNode.ps1 -RunId gr_abc -NodeId review -Reject -Note 'data looked wrong'

$body = @{
  approved = -not $Reject
  note = $Note
} | ConvertTo-Json

try {
  $res = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/graph-runs/$RunId/approve/$NodeId" -Method Post -Body $body -ContentType 'application/json'
  Write-Host "Resolved. approved=$(-not $Reject)" -ForegroundColor Green
  Write-Host ($res | ConvertTo-Json -Depth 4)
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  Write-Error "Failed: $msg"
  exit 1
}
