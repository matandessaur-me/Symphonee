param(
    [string]$ApiBase = "http://127.0.0.1:3800",
    [string]$IterationPath = ""
)

# Find current sprint if not specified
if (-not $IterationPath) {
    $iterations = Invoke-RestMethod "$ApiBase/api/iterations"
    $current = $iterations | Where-Object { $_.isCurrent -eq $true }
    if ($current) { $IterationPath = $current.path }
}

if (-not $IterationPath) {
    Write-Host "`n  No sprint selected or current.`n" -ForegroundColor Yellow
    return
}

$items = Invoke-RestMethod "$ApiBase/api/workitems?iteration=$([uri]::EscapeDataString($IterationPath))&refresh=1"

$yesterday = (Get-Date).AddDays(-1)

# Recently changed items (last 24h)
$recent = $items | Where-Object { [datetime]$_.changedDate -gt $yesterday }

Write-Host "`n  === Standup Summary ===" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'dddd, MMMM dd yyyy')" -ForegroundColor DarkGray
Write-Host ""

# Active items (in progress)
$activeItems = $items | Where-Object { $_.state -eq 'Active' }
if ($activeItems) {
    Write-Host "  IN PROGRESS ($($activeItems.Count)):" -ForegroundColor Yellow
    foreach ($wi in $activeItems) {
        $assignee = if ($wi.assignedTo) { " - $($wi.assignedTo.Split(' ')[0])" } else { "" }
        Write-Host "    #$($wi.id) $($wi.title)$assignee" -ForegroundColor White
    }
    Write-Host ""
}

# Recently completed
$recentDone = $recent | Where-Object { $_.state -in 'Closed','Resolved','Done' }
if ($recentDone) {
    Write-Host "  COMPLETED RECENTLY ($($recentDone.Count)):" -ForegroundColor Green
    foreach ($wi in $recentDone) {
        $assignee = if ($wi.assignedTo) { " - $($wi.assignedTo.Split(' ')[0])" } else { "" }
        Write-Host "    #$($wi.id) $($wi.title)$assignee" -ForegroundColor DarkGreen
    }
    Write-Host ""
}

# New items not yet started
$newItems = $items | Where-Object { $_.state -eq 'New' }
if ($newItems) {
    Write-Host "  NOT STARTED ($($newItems.Count)):" -ForegroundColor DarkGray
    foreach ($wi in $newItems | Select-Object -First 10) {
        Write-Host "    #$($wi.id) $($wi.title)" -ForegroundColor DarkGray
    }
    if ($newItems.Count -gt 10) { Write-Host "    ... and $($newItems.Count - 10) more" -ForegroundColor DarkGray }
    Write-Host ""
}

# Summary line
$total = $items.Count
$done = ($items | Where-Object { $_.state -in 'Closed','Resolved','Done' }).Count
Write-Host "  Total: $done/$total completed" -ForegroundColor Cyan
Write-Host ""
