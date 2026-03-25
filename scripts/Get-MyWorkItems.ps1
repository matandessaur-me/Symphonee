<#
.SYNOPSIS
    Lists work items assigned to the current user.

.DESCRIPTION
    Fetches all work items assigned to the configured DefaultUser from the
    current sprint. Groups by state for quick overview.

.PARAMETER State
    Optional filter by state (e.g., Active, New, Resolved).

.EXAMPLE
    .\scripts\Get-MyWorkItems.ps1
    .\scripts\Get-MyWorkItems.ps1 -State Active
#>
[CmdletBinding()]
param(
    [string]$State
)

$ErrorActionPreference = 'Stop'

$config = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/config"
$user = $config.DefaultUser
if (-not $user) {
    Write-Host "DefaultUser not configured in settings." -ForegroundColor Red
    return
}

# Get current sprint
$iterations = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/iterations"
$current = $iterations | Where-Object { $_.isCurrent } | Select-Object -First 1

$url = "http://127.0.0.1:3800/api/workitems?assignedTo=$([uri]::EscapeDataString($user))"
if ($current) { $url += "&iteration=$([uri]::EscapeDataString($current.path))" }
if ($State) { $url += "&state=$([uri]::EscapeDataString($State))" }

$items = Invoke-RestMethod -Uri $url

if ($items.Count -eq 0) {
    Write-Host "No work items assigned to $user." -ForegroundColor Yellow
    return
}

Write-Host "`nWork items assigned to $user" -ForegroundColor Cyan
if ($current) { Write-Host "Sprint: $($current.name)" -ForegroundColor DarkCyan }
Write-Host ("-" * 60)

$grouped = $items | Group-Object -Property state
foreach ($group in $grouped) {
    Write-Host "`n  $($group.Name) ($($group.Count)):" -ForegroundColor Yellow
    foreach ($wi in $group.Group) {
        $pts = if ($wi.storyPoints) { " ($($wi.storyPoints) pts)" } else { "" }
        Write-Host "    #$($wi.id) $($wi.title)$pts" -ForegroundColor White
    }
}

Write-Host "`nTotal: $($items.Count) items" -ForegroundColor Green
