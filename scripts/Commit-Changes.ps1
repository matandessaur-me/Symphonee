<#
.SYNOPSIS
    Stages and commits changes with AB# linking.

.DESCRIPTION
    Stages all changes, shows a summary, and commits with the provided message.
    Automatically appends AB#WorkItemId if the current branch contains one.
    Opens the diff viewer first so the user can review changes.

.PARAMETER Message
    The commit message.

.PARAMETER Repo
    Repository name. If omitted, uses the repo from the current directory.

.PARAMETER NoDiff
    Skip opening the diff viewer (use if you've already reviewed).

.EXAMPLE
    .\scripts\Commit-Changes.ps1 -Message "Fix login timeout"
    .\scripts\Commit-Changes.ps1 -Repo "MyRepo" -Message "Add dashboard feature"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Message,

    [string]$Repo,
    [switch]$NoDiff
)

$ErrorActionPreference = 'Stop'

# Determine repo path
if ($Repo) {
    $config = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/config"
    $repoPath = $config.Repos.$Repo
    if (-not $repoPath) { Write-Host "Repository '$Repo' not found." -ForegroundColor Red; return }
} else {
    $repoPath = (Get-Location).Path
}

# Show diff viewer first (unless skipped)
if (-not $NoDiff) {
    if ($Repo) {
        & "$PSScriptRoot\Show-Diff.ps1" -Repo $Repo
    } else {
        & "$PSScriptRoot\Show-Diff.ps1"
    }
    Write-Host "`nDiff viewer opened. Review the changes above." -ForegroundColor Cyan
}

# Get current branch and extract work item ID
$branch = git -C $repoPath rev-parse --abbrev-ref HEAD 2>$null
$wiId = $null
if ($branch -match 'AB#(\d+)') {
    $wiId = $Matches[1]
}

# Append AB# if not already in the message
$commitMsg = $Message
if ($wiId -and $Message -notmatch "AB#$wiId") {
    $commitMsg = "$Message AB#$wiId"
}

# Stage and commit
Write-Host "`nStaging changes..." -ForegroundColor Cyan
git -C $repoPath add -A 2>&1 | Write-Host

$status = git -C $repoPath status --porcelain 2>$null
if (-not $status) {
    Write-Host "No changes to commit." -ForegroundColor Yellow
    return
}

Write-Host "Committing: $commitMsg" -ForegroundColor Cyan
git -C $repoPath commit -m $commitMsg 2>&1 | Write-Host

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nCommit successful!" -ForegroundColor Green
    Write-Host "Branch: $branch" -ForegroundColor DarkCyan
    if ($wiId) { Write-Host "Linked to work item: #$wiId" -ForegroundColor DarkCyan }
} else {
    Write-Host "`nCommit failed." -ForegroundColor Red
}
