param(
  [string]$Id = ""
)

# Shows graph run state. Pass -Id for a single run, omit for the list.
#
# Usage:
#   ./scripts/Get-GraphRun.ps1                  # list all runs
#   ./scripts/Get-GraphRun.ps1 -Id gr_abc123    # full detail for one run

if ($Id) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/graph-runs/$Id" -Method Get
  } catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    Write-Error "Failed: $msg"
    exit 1
  }
  Write-Host "$($r.name) [$($r.status)]" -ForegroundColor Cyan
  Write-Host "  id:       $($r.id)"
  Write-Host "  created:  $([DateTimeOffset]::FromUnixTimeMilliseconds($r.createdAt).ToString('u'))"
  Write-Host "  updated:  $([DateTimeOffset]::FromUnixTimeMilliseconds($r.updatedAt).ToString('u'))"
  Write-Host ""
  Write-Host "Nodes:" -ForegroundColor Yellow
  foreach ($n in $r.nodes) {
    $color = switch ($n.status) {
      'completed' { 'Green' }
      'running' { 'Cyan' }
      'failed' { 'Red' }
      'awaiting_approval' { 'Yellow' }
      'cancelled' { 'DarkGray' }
      default { 'White' }
    }
    Write-Host ("  {0,-20} {1,-20} ({2})" -f $n.id, $n.status, $n.type) -ForegroundColor $color
    if ($n.error) { Write-Host "      ERROR: $($n.error)" -ForegroundColor Red }
  }
  Write-Host ""
  Write-Host "State:" -ForegroundColor Yellow
  Write-Host ($r.state | ConvertTo-Json -Depth 8)
} else {
  try {
    $list = Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/graph-runs' -Method Get
  } catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    Write-Error "Failed: $msg"
    exit 1
  }
  if (-not $list -or $list.Count -eq 0) {
    Write-Host "No graph runs yet."
    return
  }
  Write-Host ("{0,-22} {1,-20} {2,-10} {3,-10} {4}" -f 'ID', 'NAME', 'STATUS', 'NODES', 'CREATED')
  foreach ($r in $list) {
    $created = [DateTimeOffset]::FromUnixTimeMilliseconds($r.createdAt).ToString('yyyy-MM-dd HH:mm')
    $nodes = "$($r.completedNodes)/$($r.nodeCount)"
    Write-Host ("{0,-22} {1,-20} {2,-10} {3,-10} {4}" -f $r.id, $r.name, $r.status, $nodes, $created)
  }
}
