/**
 * Apps Self-Healer
 *
 * 4-tier escalation for failed app-automation actions, with selector recovery
 * so a healed run rewrites the recipe step from coordinate-based back to
 * stable UIA selector-based.
 *
 *   Tier 1: relax the selector (drop automationId, then class, then by name
 *           substring) and retry via UIA.
 *   Tier 2: vision fallback. Take a screenshot and ask the live runner's
 *           locateTarget helper for window-relative coordinates, then click.
 *   Tier 3: web research. Inject "How to <subgoal> in <app>" into context.
 *   Tier 4: ask_user. Surface the blocker as a concrete question.
 *
 * Each successful tier-2+ heal calls findUIAElementAt(x,y) to recover a UIA
 * selector for the click point and rewrites the action log entry — next run
 * skips the heal because the selector is now in the recipe.
 */

const { runRecipe } = (() => {
  // apps-recipe-runner exposes locateTarget but the import is heavy; lazy
  // require so unit tests of this file don't drag in the runner.
  let cached = null;
  return {
    runRecipe: () => {
      if (!cached) cached = require('./apps-recipe-runner');
      return cached;
    },
  };
})();

// Drop the most-restrictive field from a selector. Mirrors the relaxation
// ladder in scripts/uia-find.ps1: class -> name -> id -> type.
function relaxSelector(selector, dropOrder = ['class', 'id']) {
  const out = { ...(selector || {}) };
  for (const k of dropOrder) {
    if (out[k]) { delete out[k]; return { selector: out, dropped: k }; }
  }
  return null;
}

// Tier 1. Try the same UIA op with progressively looser selectors.
async function tier1RelaxedUIA({ driver, hwnd, selector, op }) {
  const tries = [
    relaxSelector(selector, ['class']),
    relaxSelector(selector, ['class', 'id']),
    relaxSelector(selector, ['class', 'id', 'type']),
  ].filter(Boolean);
  for (const t of tries) {
    try {
      const result = op === 'invoke'
        ? await driver.invokeUIAElement(hwnd, t.selector)
        : await driver.findUIAElement(hwnd, t.selector);
      if (result && (result.ok || result.x != null)) {
        return { ok: true, tier: 1, dropped: t.dropped, selector: t.selector, result };
      }
    } catch (_) {}
  }
  return { ok: false, tier: 1 };
}

// Tier 2. Take a screenshot and use the recipe runner's vision locator to
// find the same target in pixels. Click the returned coords, then reverse-
// lookup a UIA selector at the hit point so the recipe heals itself.
async function tier2VisionFallback({ driver, hwnd, description }) {
  if (!description || typeof description !== 'string') return { ok: false, tier: 2, reason: 'no description for vision' };
  try {
    const runner = runRecipe();
    const session = { hwnd };
    const located = await runner.locateTarget({ session, driver, description });
    if (!located || located.x == null) return { ok: false, tier: 2, reason: 'vision miss' };
    await driver.click(located.x, located.y, { hwnd });
    // Recover a stable selector at the click point so the next run skips
    // tier 2 entirely. This is the "learns to do it again" payoff.
    let recovered = null;
    try { recovered = await driver.findUIAElementAt(hwnd, located.x, located.y); } catch (_) {}
    return {
      ok: true, tier: 2,
      xy: { x: located.x, y: located.y },
      recoveredSelector: recovered && recovered.hit ? {
        name: recovered.name || undefined,
        type: recovered.type || undefined,
        id: recovered.automationId || undefined,
        class: recovered.class || undefined,
        ancestors: recovered.ancestors,
      } : null,
    };
  } catch (e) {
    return { ok: false, tier: 2, reason: e.message };
  }
}

// Walk the action log and rewrite the most recent failed/healed step into a
// UIA-selector-based step. Called immediately after a tier-2 heal so the
// session's draft recipe will save with the recovered selector.
function rewriteActionLogWithSelector(session, recoveredSelector) {
  if (!session || !Array.isArray(session.actionLog) || !recoveredSelector) return;
  for (let i = session.actionLog.length - 1; i >= 0; i--) {
    const e = session.actionLog[i];
    if (e.outcome === 'miss' || e.outcome === 'healed') {
      e.outcome = 'healed';
      e.target = e.target || {};
      e.target.healedSelector = recoveredSelector;
      // Mirror into the recorded actions feed so the auto-recipe pass
      // picks the new selector instead of the original miss.
      if (Array.isArray(session._recordedActions)) {
        for (let j = session._recordedActions.length - 1; j >= 0; j--) {
          const a = session._recordedActions[j];
          if (a.name === 'click_element' || a.name === 'type_into_element') {
            a.args = a.args || {};
            a.args.selector = recoveredSelector;
            break;
          }
        }
      }
      return;
    }
  }
}

// Top-level entry. Pass the failing UIA call, the session, and a description
// of the target (for vision fallback). Returns whatever tier succeeded, or
// { ok: false, tiersTried } when everything failed.
async function heal({ driver, session, op, selector, description }) {
  const hwnd = session && session.hwnd;
  if (hwnd == null) return { ok: false, reason: 'no hwnd' };
  const tiersTried = [];

  // Tier 1
  const t1 = await tier1RelaxedUIA({ driver, hwnd, selector, op });
  tiersTried.push(t1);
  if (t1.ok) return { ok: true, tier: 1, ...t1 };

  // Tier 2
  const t2 = await tier2VisionFallback({ driver, hwnd, description });
  tiersTried.push(t2);
  if (t2.ok) {
    if (t2.recoveredSelector) rewriteActionLogWithSelector(session, t2.recoveredSelector);
    return { ok: true, tier: 2, ...t2 };
  }

  // Tier 3 + 4 are handled by the existing stuck-handler in apps-agent-chat.js
  // (web_research and ask_user). The healer reports failure; the surrounding
  // loop escalates from there.
  return { ok: false, tiersTried };
}

module.exports = {
  heal,
  tier1RelaxedUIA,
  tier2VisionFallback,
  relaxSelector,
  rewriteActionLogWithSelector,
};
