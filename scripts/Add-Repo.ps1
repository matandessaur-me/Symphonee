<#
.SYNOPSIS
    Register a local git repo with Symphonee so it shows up in the repo list.

.DESCRIPTION
    Thin wrapper over POST /api/repos. Use this right after you create or clone
    a repo from the terminal (e.g. `git init`, `git clone`, scaffolding a new
    project) so the user doesn't have to add it by hand. The server broadcasts
    config-changed, so the new repo appears in the UI immediately -- no restart.

    Repo NAMES are the user-facing configured names (e.g. "My Website"), not the
    folder name. PATH is the absolute on-disk path.

    Optionally attach the new repo to a space in the same call with -Space.

.PARAMETER Name
    The configured display name for the repo.

.PARAMETER Path
    Absolute path to the repo on disk.

.PARAMETER Space
    Optional: a space name to attach the repo to (single-membership is enforced
    server-side).

.EXAMPLE
    .\scripts\Add-Repo.ps1 -Name "Aleoresto v2" -Path "C:\Code\Personal\aleoresto_v2"

.EXAMPLE
    # after scaffolding a new project in the terminal
    .\scripts\Add-Repo.ps1 -Name "Invoice Tool" -Path "C:\Code\Personal\invoice-tool" -Space "Personal"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Space,
    [string]$BaseUrl = 'http://127.0.0.1:3800'
)

$ErrorActionPreference = 'Stop'

# Normalize to an absolute path so the server stores something usable.
$resolved = $Path
try { $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path } catch { }

$body = @{ name = $Name; path = $resolved } | ConvertTo-Json -Compress
. "$PSScriptRoot\_ApiInit.ps1"  # attach API auth token
$r = Invoke-RestMethod -Uri "$BaseUrl/api/repos" -Method Post -ContentType 'application/json' -Body $body
if (-not $r.ok) { Write-Error "Failed to add repo: $($r | ConvertTo-Json -Compress)"; exit 1 }
Write-Host "Registered repo '$Name' -> $resolved"

if ($Space) {
    $sb = @{ space = $Space; repo = $Name; attach = $true } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$BaseUrl/api/spaces/attach-repo" -Method Post -ContentType 'application/json' -Body $sb | Out-Null
    Write-Host "Attached '$Name' to space '$Space'"
}
