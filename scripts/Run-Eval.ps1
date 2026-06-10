<#
.SYNOPSIS
  Run THE EVAL and record the RRF retrieval baseline.

.DESCRIPTION
  THE EVAL is the gate-maker for the Symphonee 2.0 cognition bet (note:
  symphonee-2.0-development-plan). It loads the live Mind graph, runs the real
  retrieval (mind/query.bestSeedsHybrid) over a FROZEN known-item gold set,
  scores it (MRR / hit@k / recall@k / nDCG@k), prints a summary, and writes a
  durable baseline record under .symphonee/eval/baselines/.

  This is offline and deterministic - no models, no network. The recorded
  baseline is what the Stage-2 activation kernel must beat, judged by the
  pre-committed criterion in dashboard/eval/criterion.json.

.EXAMPLE
  ./scripts/Run-Eval.ps1
#>
param()

$ErrorActionPreference = 'Stop'

$runner = Join-Path $PSScriptRoot '..\dashboard\eval\run.js'
if (-not (Test-Path $runner)) {
  Write-Error "eval runner not found at $runner"
  exit 1
}
node $runner
exit $LASTEXITCODE
