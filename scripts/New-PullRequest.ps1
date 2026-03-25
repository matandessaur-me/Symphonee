<#
.SYNOPSIS
    Creates a pull request on GitHub.

.DESCRIPTION
    Pushes the current branch to origin, then creates a pull request via the
    DevOps Pilot API (which calls GitHub). Automatically detects the current
    branch and links to the Azure DevOps work item if the branch contains AB#ID.

.PARAMETER Repo
    Repository name (must match a configured repo).

.PARAMETER Title
    Pull request title.

.PARAMETER Description
    Optional PR description/summary.

.PARAMETER TargetBranch
    Target branch to merge into (default: main).

.EXAMPLE
    .\scripts\New-PullRequest.ps1 -Repo "MyRepo" -Title "Add login feature"
    .\scripts\New-PullRequest.ps1 -Repo "MyRepo" -Title "Fix bug" -Description "Fixed the timeout issue" -TargetBranch "develop"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Repo,

    [Parameter(Mandatory)]
    [string]$Title,

    [string]$Description,
    [string]$TargetBranch = "main"
)

$ErrorActionPreference = 'Stop'

# Get repo path from config
$config = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/config"
$repoPath = $config.Repos.$Repo
if (-not $repoPath) {
    Write-Host "Repository '$Repo' not found in config." -ForegroundColor Red
    return
}

# Get current branch
$branch = git -C $repoPath rev-parse --abbrev-ref HEAD 2>$null
if (-not $branch -or $branch -eq "HEAD") {
    Write-Host "Could not determine current branch." -ForegroundColor Red
    return
}

Write-Host "Current branch: $branch" -ForegroundColor Cyan

# Push to origin first
Write-Host "Pushing to origin..." -ForegroundColor Cyan
$pushOutput = git -C $repoPath push -u origin $branch 2>&1
$pushOutput | ForEach-Object { Write-Host $_ }

# Extract work item ID from branch name (e.g., feature/AB#12345-description)
$workItemId = $null
if ($branch -match 'AB#(\d+)') {
    $workItemId = $Matches[1]
    Write-Host "Linked work item: #$workItemId" -ForegroundColor Cyan
}

# Create PR on GitHub via DevOps Pilot API
$body = @{
    repoName = $Repo
    title = $Title
    description = if ($Description) { $Description } else { "" }
    sourceBranch = $branch
    targetBranch = $TargetBranch
}
if ($workItemId) { $body.workItemId = [int]$workItemId }

$json = $body | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/pull-request" -Method POST -ContentType 'application/json' -Body $json

if ($result.ok) {
    Write-Host "`nPull Request #$($result.pullRequestId) created!" -ForegroundColor Green
    Write-Host "Title: $($result.title)" -ForegroundColor Green
    Write-Host "URL: $($result.url)" -ForegroundColor Cyan
} else {
    Write-Host "Failed to create PR: $($result.error)" -ForegroundColor Red
}
