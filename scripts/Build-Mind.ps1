# Build the shared Mind knowledge graph for the active space.
#
# Usage:
#   .\scripts\Build-Mind.ps1                      # full build, all sources
#   .\scripts\Build-Mind.ps1 -Incremental         # skip unchanged files
#   .\scripts\Build-Mind.ps1 -Sources notes,learnings   # only specific sources
[CmdletBinding()]
param(
    [switch]$Incremental,
    [string[]]$Sources = @('notes','learnings','cli-memory','recipes','plugins','instructions','repo-code')
)

$ErrorActionPreference = 'Stop'
$endpoint = if ($Incremental) { 'update' } else { 'build' }
$body = @{ sources = $Sources } | ConvertTo-Json -Compress
$resp = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3800/api/mind/$endpoint" `
    -ContentType 'application/json' -Body $body
Write-Host "Job: $($resp.jobId)  space: $($resp.space)  sources: $($resp.sources -join ', ')"

# Poll until the job completes (or 5 min)
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $job = Invoke-RestMethod "http://127.0.0.1:3800/api/mind/jobs?id=$($resp.jobId)"
    if ($job.status -eq 'completed') {
        Write-Host "Done in $([math]::Round(($job.completedAt - $job.startedAt) / 1000,1))s"
        $job.result.summary | ConvertTo-Json -Depth 4
        return
    }
    if ($job.status -eq 'failed') {
        Write-Error "Build failed: $($job.error)"
        return
    }
    if ($job.progress.Count -gt 0) {
        Write-Host "  > $($job.progress[-1].msg)"
    }
}
Write-Warning "Build did not complete within 5 minutes - it may still be running. Check /api/mind/jobs?id=$($resp.jobId)"
