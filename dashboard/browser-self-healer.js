/**
 * Browser Self-Healer
 *
 * 4-tier escalation when a stored selector or click target misses on a
 * subsequent run. Mirrors apps-self-healer for desktop apps but speaks DOM:
 *
 *   Tier 1: ARIA-relaxed retry. Drop class chains, prefer role+name, then
 *           role alone. The agent already has fill_by_label / click_text,
 *           which are the relaxed equivalents — we route through them.
 *   Tier 2: Visual locator via the in-app agent's screenshot + click_text
 *           pipeline. Returns coordinates that resolved.
 *   Tier 3: Web research via the live runner's research helper ("where is
 *           the X button on Y today").
 *   Tier 4: ask_user — surfaced through wait_for_user.
 *
 * On any tier-2+ heal, attempt to recover a stable selector for the same
 * element so the recipe rewrites itself for next time. This is the
 * "learns to do it again" payoff; identical wiring to the desktop side.
 */

// Lazy require so unit tests of this file don't drag the agent module in.
function loadAgentChat() { return require('./browser-agent-chat'); }

// Drop selector specificity in fixed order so the relaxation ladder is
// reproducible. css class chains die first; ids next; tag last. Returns
// null when nothing remains to drop.
function relaxSelector(selector) {
  if (!selector || typeof selector !== 'string') return null;
  let s = selector.trim();
  // Strip the deepest `> child` segment first.
  if (s.includes('>')) {
    const parts = s.split('>');
    parts.pop();
    return parts.join('>').trim() || null;
  }
  // Strip the deepest css class.
  if (/\.[\w-]+/.test(s)) return s.replace(/\.[\w-]+(?=[^.]*$)/, '').trim() || null;
  // Strip an id.
  if (/#[\w-]+/.test(s)) return s.replace(/#[\w-]+/, '').trim() || null;
  // Strip a [attr=...] block.
  if (/\[[^\]]+\]/.test(s)) return s.replace(/\[[^\]]+\](?!.*\[)/, '').trim() || null;
  return null;
}

// Tier 1. Try the agent's existing relaxed-DOM helpers in order. Returns
// the first ok result or { ok: false }.
async function tier1RelaxedDOM({ agent, op, args }) {
  if (!agent) return { ok: false, tier: 1, reason: 'no agent' };
  try {
    if (op === 'click') {
      // role+name -> click_text -> relaxed CSS.
      if (args.text) {
        const r = await agent.clickText(args.text).catch(() => null);
        if (r && r.ok !== false) return { ok: true, tier: 1, via: 'click_text', result: r };
      }
      const relaxed = relaxSelector(args.selector);
      if (relaxed) {
        const r = await agent.click(relaxed).catch(() => null);
        if (r && r.ok !== false) return { ok: true, tier: 1, via: 'relaxed-css', selector: relaxed, result: r };
      }
    } else if (op === 'fill') {
      if (args.label) {
        const r = await agent.fillByLabel(args.label, args.value).catch(() => null);
        if (r && r.ok !== false) return { ok: true, tier: 1, via: 'fill_by_label', result: r };
      }
      const relaxed = relaxSelector(args.selector);
      if (relaxed) {
        const r = await agent.fill(relaxed, args.value).catch(() => null);
        if (r && r.ok !== false) return { ok: true, tier: 1, via: 'relaxed-css', selector: relaxed, result: r };
      }
    }
  } catch (_) {}
  return { ok: false, tier: 1 };
}

// Tier 2. Visual fallback. Hand the page a description and let click_text
// find a labelled element; failing that, ask the screenshot+coordinate path
// (existing wiring inside browser-agent.js).
async function tier2Visual({ agent, description }) {
  if (!agent || !description) return { ok: false, tier: 2 };
  try {
    const r = await agent.clickText(description).catch(() => null);
    if (r && r.ok !== false) return { ok: true, tier: 2, via: 'click_text-description', result: r };
  } catch (_) {}
  return { ok: false, tier: 2 };
}

// After a successful heal, try to derive a stable selector for the
// element that was actually used so the next run skips the heal. The
// browser agent's inspect_dom returns handles; we rely on the caller to
// pass the result and we record it.
function rewriteRecordedActions(thread, healed) {
  if (!thread || !Array.isArray(thread._recordedActions) || !healed || !healed.ok) return;
  for (let i = thread._recordedActions.length - 1; i >= 0; i--) {
    const a = thread._recordedActions[i];
    if (a.name === 'click' || a.name === 'fill') {
      a.args = a.args || {};
      if (healed.selector) a.args.selector = healed.selector;
      if (healed.via) a.args._healedVia = healed.via;
      return;
    }
  }
}

async function heal({ agent, thread, op, args, description }) {
  const tiersTried = [];
  const t1 = await tier1RelaxedDOM({ agent, op, args });
  tiersTried.push(t1);
  if (t1.ok) { rewriteRecordedActions(thread, t1); return { ...t1, tiersTried }; }
  const t2 = await tier2Visual({ agent, description });
  tiersTried.push(t2);
  if (t2.ok) { rewriteRecordedActions(thread, t2); return { ...t2, tiersTried }; }
  return { ok: false, tiersTried };
}

module.exports = { heal, tier1RelaxedDOM, tier2Visual, relaxSelector, rewriteRecordedActions };
