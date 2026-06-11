<#
.SYNOPSIS
    Verify that INSTRUCTIONS.base.md and its API endpoint references are
    coherent: no lost URLs, no hallucinated URLs, recognition triggers
    still in place, every baseline atom reachable, generated files under
    the 40 KB warning.

.DESCRIPTION
    Run this whenever you edit INSTRUCTIONS.base.md or any of the three
    reference markdown files at dashboard/instructions/*.md or
    dashboard/mind/instructions.md.

    Five checks:
      1. Hallucinated URLs - URLs mentioned in docs with no '/api/...'
         string in dashboard/**/*.js.
      2. Hidden routes (informational) - registered routes not mentioned
         in any AI-reachable doc. Informational only.
      3. Required inline phrases - recognition-time triggers must live in
         INSTRUCTIONS.base.md (the template), not just the references.
      4. Baseline atoms reachable - every atom in scripts/audit-baseline.txt
         must be findable in the corpus (whitespace-insensitive). This is
         the self-healing check: if you trim content and an atom drops
         out, the audit fails until you restore it OR regenerate the
         baseline with -UpdateBaseline.
      5. Generated file sizes - CLAUDE.md and siblings under Claude
         Code's 40 KB warning threshold.

    Exits 0 on PASS, 1 on FAIL. Wire into CI if desired.

.PARAMETER UpdateBaseline
    Regenerate scripts/audit-baseline.txt from the current corpus. Use
    after intentionally removing content so the audit no longer flags
    the removal as a loss.

.EXAMPLE
    pwsh ./scripts/Audit-Instructions.ps1
    powershell.exe -ExecutionPolicy Bypass -NoProfile -File ./scripts/Audit-Instructions.ps1
    pwsh ./scripts/Audit-Instructions.ps1 -UpdateBaseline
#>
[CmdletBinding()]
param(
    [switch]$VerboseReport,
    [switch]$UpdateBaseline
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

function Read-Text($relativePath) {
    $p = Join-Path $repoRoot $relativePath
    if (-not (Test-Path $p)) { return '' }
    return [System.IO.File]::ReadAllText($p)
}

# --- Inputs ----------------------------------------------------------------
$template = Read-Text 'INSTRUCTIONS.base.md'
$mindRef  = Read-Text 'dashboard/mind/instructions.md'
$appsRef  = Read-Text 'dashboard/instructions/apps-automation.md'
$browRef  = Read-Text 'dashboard/instructions/browser-router.md'
$corpus   = "$template`n$mindRef`n$appsRef`n$browRef"

if (-not $template) { Write-Error 'INSTRUCTIONS.base.md missing'; exit 1 }

# --- Extract URLs ----------------------------------------------------------
function Get-Urls($text) {
    [regex]::Matches($text, '/api/[a-zA-Z0-9/_-]+') |
        ForEach-Object { ($_.Value -replace '\?.*$','').TrimEnd('/') } |
        Where-Object { $_ -ne '/api' } |
        Sort-Object -Unique
}
$docUrls = Get-Urls $corpus

# --- Extract registered routes from dashboard/**/*.js ----------------------
# Routes are registered in several patterns:
#   addRoute('METHOD', '/api/...', handler)        - explicit
#   url.pathname === '/api/...'                    - direct match in server.js
#   url.pathname.startsWith('/api/.../')           - prefix match
#   const PREFIX = '/api/...'  then  PREFIX + '/x' - constant-based router
# We extract all '/api/...' string literals from server JS as a permissive
# proxy. False positives here are fine (over-broad set = fewer false alarms
# in the hallucination check below).
$jsFiles = Get-ChildItem -Path (Join-Path $repoRoot 'dashboard') -Recurse -Filter *.js |
    Where-Object { $_.Name -notlike '*.test.js' -and $_.FullName -notmatch '\\node_modules\\' }
$routes = @()
$apiStringRegex = [regex]"['""``](/api/[a-zA-Z0-9/_-]+)['""``]"
foreach ($f in $jsFiles) {
    $c = [System.IO.File]::ReadAllText($f.FullName)
    foreach ($m in $apiStringRegex.Matches($c)) {
        $u = ($m.Groups[1].Value -replace '\?.*$','').TrimEnd('/')
        if ($u -ne '/api') { $routes += $u }
    }
}
$routes = $routes | Sort-Object -Unique

# --- Match doc URL -> route (with prefix/wildcard tolerance) ---------------
function Test-DocUrlRegistered($url) {
    $u = $url -replace '/\*$',''
    if ($routes -contains $u) { return $true }
    foreach ($r in $routes) {
        if ($r.StartsWith("$u/") -or $u.StartsWith("$r/")) { return $true }
    }
    return $false
}

# --- Check 1: hallucinated URLs (doc says exists, code doesn't) -----------
$hallucinated = @($docUrls | Where-Object { -not (Test-DocUrlRegistered $_) })

# --- Check 2: hidden routes (informational only) ---------------------------
function Test-RouteDocumented($route) {
    if ($corpus -match [regex]::Escape($route)) { return $true }
    # check parent path mentions (e.g. /api/mind/* covers /api/mind/foo)
    $parent = $route -replace '/[^/]+$',''
    if ($parent -and ($corpus -match [regex]::Escape("$parent/*"))) { return $true }
    return $false
}
$hidden = @($routes | Where-Object { -not (Test-RouteDocumented $_) })

# --- Check 3: required inline recognition phrases --------------------------
# Each entry is a regex pattern (case-insensitive) that MUST appear in
# INSTRUCTIONS.base.md (the template), not just the references. These are
# the signals an AI uses to decide whether to fire teach/recall/COM/router.
$requiredInline = @(
    @{ name='/teach trigger: remember';        pattern='remember' },
    @{ name='/teach trigger: from now on';     pattern='from now on' },
    @{ name='/teach trigger: we decided/use';  pattern='we (use|chose|picked|decided)' },
    @{ name='/teach trigger: prefer X over Y'; pattern='prefer .* over' },
    @{ name='/teach trigger: watch out for';   pattern='watch out for' },
    @{ name='/recall trigger: what did we';    pattern='what did we' },
    @{ name='/recall trigger: have we worked'; pattern='have we worked on' },
    @{ name='/recall trigger: what do I know'; pattern='what do I know about' },
    @{ name='Mind: POST /teach mentioned';     pattern='/api/mind/teach' },
    @{ name='Mind: POST /recall mentioned';    pattern='/api/mind/recall' },
    @{ name='Mind: POST /query mentioned';     pattern='/api/mind/query' },
    @{ name='Mind: save-result mentioned';     pattern='/api/mind/save-result' },
    @{ name='API token: env var mentioned';    pattern='SYMPHONEE_TOKEN' },
    @{ name='API token: header mentioned';     pattern='x-symphonee-token' },
    @{ name='API token: TOKEN_REQUIRED';        pattern='TOKEN_REQUIRED' },
    @{ name='Apps: /api/apps/do default';      pattern='/api/apps/do' },
    @{ name='Apps: COM decision (Office)';     pattern='/api/apps/com' },
    @{ name='Apps: stealth decision (UIA)';    pattern='sandbox.*true' },
    @{ name='Browser: router-first';           pattern='/api/browser/router' },
    @{ name='Shell: powershell.exe (not pwsh)';pattern='powershell\.exe' },
    @{ name='Shell: Show-Diff.ps1 enforced';   pattern='Show-Diff\.ps1' },
    @{ name='Shell: never git diff';           pattern='NEVER use .git diff' },
    @{ name='Bootstrap: checksum tag';         pattern='\[bootstrap:' },
    @{ name='Bootstrap: activeRepo';           pattern='activeRepo' },
    @{ name='Bootstrap: activeRepoPath';       pattern='activeRepoPath' },
    @{ name='Plugins: ask before using';       pattern='ASK the user' },
    @{ name='Permissions: 403 deny = stop';    pattern='403' }
)
$missingPhrases = @()
foreach ($r in $requiredInline) {
    if ($template -notmatch "(?i)$($r.pattern)") {
        $missingPhrases += $r.name
    }
}

# --- Check 4: baseline atoms reachable (self-healing) ---------------------
# Baseline = atoms that must always be findable in the corpus. Whitespace-
# insensitive substring match. If you intentionally remove content,
# regenerate with -UpdateBaseline.
$baselinePath = Join-Path $repoRoot 'scripts/audit-baseline.txt'
$baselineAtoms = @()
$corpusNorm = ($corpus -replace '\s+', '').ToLower()

if ($UpdateBaseline) {
    # Regenerate from current corpus + any historical deletion atoms
    $newAtoms = [regex]::Matches($corpus, '`([^`\n]{2,100})`') |
        ForEach-Object { $_.Groups[1].Value.Trim() } |
        Where-Object { $_ -and ($_ -notmatch '^[\s\.,]') } |
        Sort-Object -Unique
    $header = @"
# Audit baseline - atoms that must remain reachable in the corpus
# (INSTRUCTIONS.base.md + the three /api/instructions reference docs).
#
# Regenerated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss').
# Audit-Instructions.ps1 verifies every atom below is findable in the corpus
# (whitespace-insensitive substring match). To regenerate after intentional
# removals: pwsh ./scripts/Audit-Instructions.ps1 -UpdateBaseline
#
# Lines starting with # are comments.
"@
    $bodyText = $header + "`n`n" + ($newAtoms -join "`n") + "`n"
    [System.IO.File]::WriteAllText($baselinePath, $bodyText)
    Write-Host ('[INFO] Baseline regenerated: {0} atoms written to {1}' -f $newAtoms.Count, $baselinePath) -ForegroundColor Cyan
}

if (Test-Path $baselinePath) {
    $baselineAtoms = @(Get-Content $baselinePath | Where-Object { $_ -and ($_ -notmatch '^\s*#') -and ($_.Trim() -ne '') })
}

$missingAtoms = @()
foreach ($a in $baselineAtoms) {
    $aNorm = ($a -replace '\s+', '').ToLower()
    if (-not $aNorm) { continue }
    if ($corpusNorm -notmatch [regex]::Escape($aNorm)) {
        $missingAtoms += $a
    }
}

# --- Check 5: generated file sizes -----------------------------------------
$generated = @(
    'CLAUDE.md','AGENTS.md','GEMINI.md','GROK.md','QWEN.md','.github/copilot-instructions.md'
)
$sizeReport = @()
$oversized = @()
foreach ($f in $generated) {
    $p = Join-Path $repoRoot $f
    if (-not (Test-Path $p)) { continue }
    $sz = (Get-Item $p).Length
    $sizeReport += [pscustomobject]@{ File=$f; Bytes=$sz; OverLimit = ($sz -gt 40000) }
    if ($sz -gt 40000) { $oversized += $f }
}

# --- Report ----------------------------------------------------------------
$fail = $false
Write-Host ''
Write-Host '=== Audit-Instructions ===' -ForegroundColor Cyan
Write-Host ''

Write-Host ('Corpus: {0} URLs referenced, {1} routes registered' -f $docUrls.Count, $routes.Count)
Write-Host ''

# Check 1
if ($hallucinated.Count -eq 0) {
    Write-Host '[PASS] Hallucinated URLs: none. Every URL in the docs has a registered route.' -ForegroundColor Green
} else {
    $fail = $true
    Write-Host ('[FAIL] Hallucinated URLs: {0} doc URLs have no addRoute() in dashboard/**/*.js' -f $hallucinated.Count) -ForegroundColor Red
    $hallucinated | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
}
Write-Host ''

# Check 2 (informational)
Write-Host ('[INFO] Hidden routes (registered but not documented for AI): {0}' -f $hidden.Count) -ForegroundColor Yellow
if ($VerboseReport -and $hidden.Count -gt 0) {
    $hidden | Select-Object -First 20 | ForEach-Object { Write-Host "        - $_" -ForegroundColor DarkGray }
    if ($hidden.Count -gt 20) { Write-Host ('        ... and {0} more' -f ($hidden.Count - 20)) -ForegroundColor DarkGray }
}
Write-Host ''

# Check 3
if ($missingPhrases.Count -eq 0) {
    Write-Host ('[PASS] Required inline phrases: all {0} present in INSTRUCTIONS.base.md' -f $requiredInline.Count) -ForegroundColor Green
} else {
    $fail = $true
    Write-Host ('[FAIL] Required inline phrases missing from INSTRUCTIONS.base.md: {0}' -f $missingPhrases.Count) -ForegroundColor Red
    $missingPhrases | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
    Write-Host '        These are recognition-time signals. An AI that does not fetch the references' -ForegroundColor DarkRed
    Write-Host '        must still see them inline. If you removed one intentionally, update this script.' -ForegroundColor DarkRed
}
Write-Host ''

# Check 4
if ($baselineAtoms.Count -eq 0) {
    Write-Host '[WARN] Baseline atoms: scripts/audit-baseline.txt empty or missing. Run with -UpdateBaseline to seed it.' -ForegroundColor Yellow
} elseif ($missingAtoms.Count -eq 0) {
    Write-Host ('[PASS] Baseline atoms: all {0} reachable in the corpus (whitespace-insensitive).' -f $baselineAtoms.Count) -ForegroundColor Green
} else {
    $fail = $true
    Write-Host ('[FAIL] Baseline atoms missing from corpus: {0} of {1}' -f $missingAtoms.Count, $baselineAtoms.Count) -ForegroundColor Red
    Write-Host '        These atoms were in the corpus historically and are now absent.' -ForegroundColor DarkRed
    Write-Host '        If intentional, regenerate the baseline: pwsh ./scripts/Audit-Instructions.ps1 -UpdateBaseline' -ForegroundColor DarkRed
    $missingAtoms | Select-Object -First 30 | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
    if ($missingAtoms.Count -gt 30) { Write-Host ('        ... and {0} more' -f ($missingAtoms.Count - 30)) -ForegroundColor Red }
}
Write-Host ''

# Check 5
if ($oversized.Count -eq 0) {
    Write-Host '[PASS] Generated files: all under 40 KB warning.' -ForegroundColor Green
} else {
    $fail = $true
    Write-Host ('[FAIL] Generated files over 40 KB: {0}' -f $oversized.Count) -ForegroundColor Red
    $oversized | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
}
$sizeReport | Format-Table File, Bytes, OverLimit -AutoSize | Out-String | Write-Host

Write-Host ''
if ($fail) {
    Write-Host 'AUDIT FAILED.' -ForegroundColor Red
    exit 1
} else {
    Write-Host 'AUDIT PASSED.' -ForegroundColor Green
    exit 0
}
