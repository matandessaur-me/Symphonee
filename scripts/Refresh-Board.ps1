<#
.SYNOPSIS
    Refreshes the work items board/backlog in the dashboard.

.DESCRIPTION
    Triggers a refresh of work items from Azure DevOps. Use after making
    changes via the API or scripts to ensure the UI is up to date.

.EXAMPLE
    .\scripts\Refresh-Board.ps1
#>
Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/ui/refresh-workitems" -Method POST -ContentType 'application/json' -Body '{}'
Write-Host "Board refreshed." -ForegroundColor Green
