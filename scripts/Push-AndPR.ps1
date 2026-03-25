<#
.SYNOPSIS
    One-shot: push branch and create pull request.

.DESCRIPTION
    Pushes the current branch to origin and creates a pull request on GitHub.
    Automatically detects branch, work item ID, and generates a title from the branch name.

.PARAMETER Repo
    Repository name (must match a configured repo).

.PARAMETER Title
    Optional PR title. If omitted, generates from branch name.

.PARAMETER Description
    Optional PR description.

.PARAMETER TargetBranch
    Target branch (default: main).

.EXAMPLE
    .\scripts\Push-AndPR.ps1 -Repo "MyRepo"
    .\scripts\Push-AndPR.ps1 -Repo "MyRepo" -Title "Custom title" -Description "Details"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Repo,

    [string]$Title,
    [string]$Description,
    [string]$TargetBranch = "main"
)

$ErrorActionPreference = 'Stop'

$config = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/config"
$repoPath = $config.Repos.$Repo
if (-not $repoPath) { Write-Host "Repository '$Repo' not found." -ForegroundColor Red; return }

# Get branch info
$branch = git -C $repoPath rev-parse --abbrev-ref HEAD 2>$null
if (-not $branch -or $branch -eq "HEAD") { Write-Host "Not on a branch." -ForegroundColor Red; return }
if ($branch -eq "main" -or $branch -eq "master") { Write-Host "You're on $branch — switch to a feature branch first." -ForegroundColor Red; return }

# Generate title from branch if not provided
if (-not $Title) {
    $slug = $branch -replace '^(feature|bugfix|hotfix)/', '' -replace 'AB#\d+-?', '' -replace '-', ' '
    $Title = (Get-Culture).TextInfo.ToTitleCase($slug.Trim())
    if (-not $Title) { $Title = $branch }
}

Write-Host "Branch: $branch" -ForegroundColor Cyan
Write-Host "Title:  $Title" -ForegroundColor Cyan
Write-Host ""

# Push
Write-Host "Pushing to origin..." -ForegroundColor Cyan
$pushOutput = git -C $repoPath push -u origin $branch 2>&1
$pushOutput | ForEach-Object { Write-Host $_ }

# Create PR
Write-Host "`nCreating pull request..." -ForegroundColor Cyan
& "$PSScriptRoot\New-PullRequest.ps1" -Repo $Repo -Title $Title -Description $Description -TargetBranch $TargetBranch
