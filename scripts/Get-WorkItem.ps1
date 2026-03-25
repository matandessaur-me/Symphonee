param(
    [Parameter(Mandatory=$true)]
    [int]$Id,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$wi = Invoke-RestMethod "$ApiBase/api/workitems/$Id"

if ($wi.error) {
    Write-Host "`n  Error: $($wi.error)`n" -ForegroundColor Red
    return
}

Write-Host ""
Write-Host "  [$($wi.type)] #$($wi.id) — $($wi.title)" -ForegroundColor Cyan
Write-Host "  State: $($wi.state) | Priority: P$($wi.priority) | Points: $(if($wi.storyPoints){$wi.storyPoints}else{'-'})" -ForegroundColor DarkGray
Write-Host "  Assigned: $(if($wi.assignedTo){$wi.assignedTo}else{'Unassigned'})" -ForegroundColor DarkGray
Write-Host "  Iteration: $($wi.iterationPath)" -ForegroundColor DarkGray
Write-Host ""

if ($wi.description) {
    Write-Host "  Description:" -ForegroundColor White
    $desc = $wi.description -replace '<[^>]+>','' -replace '&nbsp;',' ' -replace '&amp;','&' -replace '&#39;',"'"
    Write-Host "    $($desc.Trim().Substring(0, [math]::Min($desc.Trim().Length, 500)))" -ForegroundColor DarkGray
    Write-Host ""
}

if ($wi.acceptanceCriteria) {
    Write-Host "  Acceptance Criteria:" -ForegroundColor White
    $ac = $wi.acceptanceCriteria -replace '<[^>]+>','' -replace '&nbsp;',' '
    Write-Host "    $($ac.Trim().Substring(0, [math]::Min($ac.Trim().Length, 500)))" -ForegroundColor DarkGray
    Write-Host ""
}

if ($wi.linkedItems -and $wi.linkedItems.Count -gt 0) {
    Write-Host "  Linked Items:" -ForegroundColor White
    foreach ($link in $wi.linkedItems) {
        if ($link.id) { Write-Host "    #$($link.id) ($($link.rel.Split('.')[-1]))" -ForegroundColor DarkGray }
    }
    Write-Host ""
}
Write-Host ""
