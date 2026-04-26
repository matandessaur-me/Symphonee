# Query the shared Mind graph and print the BFS sub-graph the brain considers
# most relevant to a question.
#
# Usage:
#   .\scripts\Query-Mind.ps1 -Question "what does the orchestrator do"
#   .\scripts\Query-Mind.ps1 -Question "auth flow" -Budget 1500
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Question,
    [int]$Budget = 2000,
    [ValidateSet('bfs','dfs')] [string]$Mode = 'bfs'
)

$body = @{ question = $Question; budget = $Budget; mode = $Mode } | ConvertTo-Json -Compress
$resp = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/mind/query' `
    -ContentType 'application/json' -Body $body

if ($resp.empty) { Write-Warning "Brain is empty for this space. Run Build-Mind.ps1 first."; return }

Write-Host "Question: $Question"
Write-Host "Seed nodes: $($resp.seedIds -join ', ')"
Write-Host "Sub-graph: $($resp.nodes.Count) nodes, $($resp.edges.Count) edges (~$($resp.estTokens) tokens)"
Write-Host ''
Write-Host '--- summary ---'
Write-Host $resp.answer.summary
Write-Host ''
Write-Host '--- nodes ---'
$resp.nodes | Select-Object -First 20 | ForEach-Object {
    "{0,-12} {1,-50} (community {2})" -f $_.kind, $_.label.Substring(0, [Math]::Min($_.label.Length, 48)), $_.communityId
}
Write-Host ''
Write-Host '--- note ---'
Write-Host $resp.answer.note
