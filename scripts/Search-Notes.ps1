param(
  [Parameter(Mandatory = $true)]
  [string]$Query,
  [ValidateSet('all','notes','learnings')]
  [string]$Kinds = 'all',
  [int]$Limit = 10
)

# Hybrid search (BM25) across Notes + Learnings.
#
# Usage:
#   ./scripts/Search-Notes.ps1 -Query "permission modes"
#   ./scripts/Search-Notes.ps1 -Query "rate limit" -Kinds learnings
#   ./scripts/Search-Notes.ps1 -Query "graph runs" -Limit 5

$kindsParam = if ($Kinds -eq 'all') { '' } else { "&kinds=$Kinds" }
$url = "http://127.0.0.1:3800/api/search?q=$([uri]::EscapeDataString($Query))&limit=$Limit$kindsParam"

try {
  $r = Invoke-RestMethod -Uri $url -Method Get
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  Write-Error "Failed: $msg"
  exit 1
}

if (-not $r.results -or $r.results.Count -eq 0) {
  Write-Host "No matches for '$Query'." -ForegroundColor Yellow
  return
}

Write-Host ("{0,-8} {1,-7} {2,-50} {3}" -f 'SCORE', 'KIND', 'TITLE', 'SNIPPET') -ForegroundColor Cyan
foreach ($x in $r.results) {
  $title = if ($x.title.Length -gt 48) { $x.title.Substring(0,48) + '...' } else { $x.title }
  $snippet = if ($x.snippet.Length -gt 120) { $x.snippet.Substring(0,120) + '...' } else { $x.snippet }
  Write-Host ("{0,-8} {1,-7} {2,-50} {3}" -f $x.score, $x.kind, $title, $snippet)
}
