param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$iterations = Invoke-RestMethod "$ApiBase/api/iterations"

# Find last completed sprint
$past = $iterations | Where-Object { $_.timeFrame -eq 'past' } | Sort-Object { [datetime]$_.finishDate } | Select-Object -Last 1

if (-not $past) {
    Write-Host "`n  No completed sprints found.`n" -ForegroundColor Yellow
    return
}

Write-Host "`n  === Retrospective: $($past.name) ===" -ForegroundColor Cyan
Write-Host "  $(([datetime]$past.startDate).ToString('MMM dd')) - $(([datetime]$past.finishDate).ToString('MMM dd yyyy'))" -ForegroundColor DarkGray
Write-Host ""

$items = Invoke-RestMethod "$ApiBase/api/workitems?iteration=$([uri]::EscapeDataString($past.path))"

$total = $items.Count
$done = $items | Where-Object { $_.state -in 'Closed','Resolved','Done' }
$notDone = $items | Where-Object { $_.state -notin 'Closed','Resolved','Done' }

$totalPts = ($items | Measure-Object -Property storyPoints -Sum).Sum
$donePts = ($done | Measure-Object -Property storyPoints -Sum).Sum

$completionRate = if ($total -gt 0) { [math]::Round(($done.Count / $total) * 100) } else { 0 }

Write-Host "  COMPLETION" -ForegroundColor White
Write-Host "    Items: $($done.Count)/$total ($completionRate%)" -ForegroundColor $(if ($completionRate -ge 80) { 'Green' } elseif ($completionRate -ge 50) { 'Yellow' } else { 'Red' })
Write-Host "    Points: $donePts/$totalPts" -ForegroundColor DarkGray
Write-Host ""

if ($done.Count -gt 0) {
    Write-Host "  COMPLETED ($($done.Count)):" -ForegroundColor Green
    foreach ($wi in $done) {
        $pts = if ($wi.storyPoints) { " [$($wi.storyPoints)pts]" } else { "" }
        Write-Host "    #$($wi.id) $($wi.title)$pts" -ForegroundColor DarkGreen
    }
    Write-Host ""
}

if ($notDone.Count -gt 0) {
    Write-Host "  NOT COMPLETED ($($notDone.Count)):" -ForegroundColor Red
    foreach ($wi in $notDone) {
        $pts = if ($wi.storyPoints) { " [$($wi.storyPoints)pts]" } else { "" }
        Write-Host "    #$($wi.id) $($wi.title) ($($wi.state))$pts" -ForegroundColor DarkRed
    }
    Write-Host ""
}

# By assignee
Write-Host "  BY ASSIGNEE:" -ForegroundColor Cyan
$items | Where-Object { $_.assignedTo } | Group-Object -Property assignedTo | ForEach-Object {
    $memberDone = ($_.Group | Where-Object { $_.state -in 'Closed','Resolved','Done' }).Count
    $memberPts = ($_.Group | Where-Object { $_.state -in 'Closed','Resolved','Done' } | Measure-Object -Property storyPoints -Sum).Sum
    Write-Host "    $($_.Name): $memberDone/$($_.Count) items, ${memberPts}pts" -ForegroundColor DarkGray
}
Write-Host ""
