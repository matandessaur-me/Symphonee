# Run-Query.ps1 — Execute a PowerShell query file safely
# Usage: .\scripts\Run-Query.ps1 -File ".\.ai-workspace\my-query.ps1"
# The AI should write its query to .ai-workspace\ first, then run it via this script.
# This avoids all bash escaping issues with $_ and other PowerShell variables.
param(
    [Parameter(Mandatory=$true)]
    [string]$File
)

if (-not (Test-Path $File)) {
    Write-Host "  Error: File not found: $File" -ForegroundColor Red
    return
}

& $File
