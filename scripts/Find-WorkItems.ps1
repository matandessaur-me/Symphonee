param(
    [string]$Search = "",
    [string]$Type = "",
    [string]$State = "",
    [string]$AssignedTo = "",
    [string]$IterationPath = "",
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$params = @()
if ($IterationPath) { $params += "iteration=$([uri]::EscapeDataString($IterationPath))" }
if ($State)         { $params += "state=$([uri]::EscapeDataString($State))" }
if ($Type)          { $params += "type=$([uri]::EscapeDataString($Type))" }
if ($AssignedTo)    { $params += "assignedTo=$([uri]::EscapeDataString($AssignedTo))" }
$params += "refresh=1"

$url = "$ApiBase/api/workitems?$($params -join '&')"
$items = Invoke-RestMethod $url

if ($Search) {
    $items = $items | Where-Object { $PSItem.title -match $Search -or $PSItem.id -eq $Search }
}

if ($items.Count -eq 0) {
    Write-Host "`n  No work items found.`n" -ForegroundColor Yellow
    return
}

Write-Host "`n  Found $($items.Count) items:" -ForegroundColor Cyan
Write-Host ""

foreach ($wi in $items | Select-Object -First 50) {
    $stateColor = switch ($wi.state) { 'New' { 'DarkCyan' } 'Active' { 'Green' } 'Resolved' { 'Magenta' } 'Closed' { 'DarkGray' } default { 'White' } }
    $pts = if ($wi.storyPoints) { " [$($wi.storyPoints)pts]" } else { "" }
    $assignee = if ($wi.assignedTo) { " - $($wi.assignedTo.Split(' ')[0])" } else { "" }
    Write-Host "  #$($wi.id) " -NoNewline -ForegroundColor DarkGray
    Write-Host "[$($wi.state)] " -NoNewline -ForegroundColor $stateColor
    Write-Host "$($wi.title)$pts$assignee" -ForegroundColor White
}

if ($items.Count -gt 50) {
    Write-Host "`n  ... and $($items.Count - 50) more" -ForegroundColor DarkGray
}
Write-Host ""
