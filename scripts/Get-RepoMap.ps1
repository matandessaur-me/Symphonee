param(
  [string]$Repo = "",
  [int]$Budget = 4000
)

# Print a token-budgeted symbol map of the repo (languages, layout,
# top files and their key symbols ranked by recent activity).
#
# Usage:
#   ./scripts/Get-RepoMap.ps1                       # uses active repo
#   ./scripts/Get-RepoMap.ps1 -Repo "Symphonee"
#   ./scripts/Get-RepoMap.ps1 -Budget 8000          # bigger output

if (-not $Repo) {
  try {
    $ctx = Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/ui/context' -Method Get
    $Repo = $ctx.activeRepo
  } catch {}
}
if (-not $Repo) { Write-Error "No repo specified and no active repo selected"; exit 1 }

$url = "http://127.0.0.1:3800/api/repo/map?repo=$([uri]::EscapeDataString($Repo))&budget=$Budget"
try {
  $r = Invoke-WebRequest -Uri $url -Method Get -UseBasicParsing
  Write-Output $r.Content
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  Write-Error "Failed: $msg"
  exit 1
}
