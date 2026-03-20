param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$iterations = Invoke-RestMethod "$ApiBase/api/iterations"
$current = $iterations | Where-Object { $_.isCurrent -eq $true }

if (-not $current) {
    Write-Host "`n  No current sprint found.`n" -ForegroundColor Yellow
    return
}

Write-Host "`n  Sprint: $($current.name)" -ForegroundColor Cyan
Write-Host "  Period: $(([datetime]$current.startDate).ToString('MMM dd')) - $(([datetime]$current.finishDate).ToString('MMM dd yyyy'))" -ForegroundColor DarkGray

$items = Invoke-RestMethod "$ApiBase/api/workitems?iteration=$([uri]::EscapeDataString($current.path))"

$byState = $items | Group-Object -Property state
$total = $items.Count
$done = ($items | Where-Object { $_.state -in 'Closed','Resolved','Done' }).Count
$active = ($items | Where-Object { $_.state -eq 'Active' }).Count
$new = ($items | Where-Object { $_.state -eq 'New' }).Count

$totalPts = ($items | Measure-Object -Property storyPoints -Sum).Sum
$donePts = ($items | Where-Object { $_.state -in 'Closed','Resolved','Done' } | Measure-Object -Property storyPoints -Sum).Sum

$finish = [datetime]$current.finishDate
$daysLeft = [math]::Max(0, ($finish - (Get-Date)).Days)
$pct = if ($total -gt 0) { [math]::Round(($done / $total) * 100) } else { 0 }

Write-Host ""
Write-Host "  Items:  $done/$total completed ($pct%)" -ForegroundColor White
Write-Host "  Points: $donePts/$totalPts" -ForegroundColor White
Write-Host "  Days remaining: $daysLeft" -ForegroundColor $(if ($daysLeft -le 2) { 'Red' } elseif ($daysLeft -le 5) { 'Yellow' } else { 'Green' })
Write-Host ""
Write-Host "  New: $new | Active: $active | Done: $done" -ForegroundColor DarkGray

if ($items.Count -gt 0) {
    Write-Host ""
    Write-Host "  By Type:" -ForegroundColor Cyan
    $items | Group-Object -Property type | ForEach-Object {
        $typeDone = ($_.Group | Where-Object { $_.state -in 'Closed','Resolved','Done' }).Count
        Write-Host "    $($_.Name): $typeDone/$($_.Count) done" -ForegroundColor DarkGray
    }
}
Write-Host ""
