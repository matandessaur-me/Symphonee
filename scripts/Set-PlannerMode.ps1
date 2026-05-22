<#
.SYNOPSIS
  Deprecated. The Symphonee brain is always on; there is no mode to set.

.DESCRIPTION
  Earlier versions of this script flipped SymphoneeBrain.plannerMode in the
  config (off / shadow / smart / active). The brain no longer has modes:
  it always observes intent and always fills in the missing cli on
  /api/orchestrator/spawn when the caller does not specify one.

  Any SymphoneeBrain.plannerMode value left in the config is ignored.

  This stub exists so older muscle memory does not error out silently. It
  prints a one-line notice and returns success.
#>
param(
  [Parameter(Position = 0)]
  [string]$Mode
)

Write-Host "Set-PlannerMode is deprecated -- the brain is always on. No action taken."
exit 0
