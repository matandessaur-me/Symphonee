# Open the Mind tab in the dashboard. Optionally focus a specific node.
#
# Usage:
#   .\scripts\Show-Mind.ps1
#   .\scripts\Show-Mind.ps1 -NodeId code_dashboard_server_js
[CmdletBinding()]
param([string]$NodeId)

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/ui/tab' `
    -ContentType 'application/json' `
    -Body (@{ tab = 'mind' } | ConvertTo-Json -Compress) | Out-Null

if ($NodeId) {
    # Side panel pre-open via UI message would require dashboard-side handling.
    # For now just print the URL the agent would open.
    Write-Host "Opened Mind tab. Node detail for: $NodeId"
    $node = Invoke-RestMethod "http://127.0.0.1:3800/api/mind/node?id=$([uri]::EscapeDataString($NodeId))"
    $node | ConvertTo-Json -Depth 4
} else {
    $stats = Invoke-RestMethod 'http://127.0.0.1:3800/api/mind/stats'
    Write-Host "Mind tab opened. Space: $($stats.space)"
    if ($stats.stats) {
        Write-Host "  $($stats.stats.nodes) nodes, $($stats.stats.edges) edges, $($stats.stats.communities) communities"
    } else {
        Write-Host "  Brain is empty. Run Build-Mind.ps1 to populate."
    }
}
