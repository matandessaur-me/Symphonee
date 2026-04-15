<#
.SYNOPSIS
    Opens the diff viewer in the Symphonee dashboard.

.DESCRIPTION
    Sends a UI action to Symphonee to open the diff viewer tab.
    Can show all working changes or a specific file's diff.

.PARAMETER Repo
    Repository name (must match a configured repo). If omitted, uses the currently selected repo.

.PARAMETER Path
    Optional file path within the repo to show diff for. If omitted, shows all working changes.

.EXAMPLE
    .\scripts\Show-Diff.ps1
    .\scripts\Show-Diff.ps1 -Repo "MyRepo"
    .\scripts\Show-Diff.ps1 -Repo "MyRepo" -Path "src/components/Header.tsx"
#>
[CmdletBinding()]
param(
    [string]$Repo,
    [string]$Path
)

$body = @{}
if ($Repo) { $body.repo = $Repo }
if ($Path) { $body.path = $Path }

$json = $body | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/ui/view-diff" -Method POST -ContentType 'application/json' -Body $json

if ($result.ok) {
    if ($Path) {
        Write-Host "Opened diff viewer for: $Path" -ForegroundColor Green
    } else {
        Write-Host "Opened diff viewer with all working changes." -ForegroundColor Green
    }
} else {
    Write-Host "Failed to open diff viewer." -ForegroundColor Red
}
