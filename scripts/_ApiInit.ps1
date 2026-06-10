# _ApiInit.ps1 -- shared init dot-sourced by the API helper scripts.
# The Symphonee server gates mutating requests (POST/PUT/DELETE/PATCH) behind a
# per-boot token. This resolves the token and registers it as a default header
# for Invoke-RestMethod / Invoke-WebRequest, so every script that dot-sources
# this file authenticates without touching its individual calls.
#
# Token source order:
#   1. $env:SYMPHONEE_TOKEN  -- set when Symphonee spawns the shell (the usual case)
#   2. config/runtime.json   -- for scripts run manually outside a spawned shell
#
# If no token is found we attach nothing (so reads still work, and the server's
# kill switch / disabled-enforcement modes are unaffected).

$SymphoneeToken = $env:SYMPHONEE_TOKEN
if (-not $SymphoneeToken) {
    $runtimePath = Join-Path $PSScriptRoot '..\config\runtime.json'
    if (Test-Path $runtimePath) {
        try { $SymphoneeToken = (Get-Content $runtimePath -Raw | ConvertFrom-Json).token } catch { }
    }
}

if ($SymphoneeToken) {
    if (-not $global:PSDefaultParameterValues) { $global:PSDefaultParameterValues = @{} }
    $global:PSDefaultParameterValues['Invoke-RestMethod:Headers'] = @{ 'X-Symphonee-Token' = $SymphoneeToken }
    $global:PSDefaultParameterValues['Invoke-WebRequest:Headers'] = @{ 'X-Symphonee-Token' = $SymphoneeToken }
}
