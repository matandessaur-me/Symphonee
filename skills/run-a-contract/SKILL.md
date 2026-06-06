---
name: Run a contract (intentional autonomous work)
description: For substantial or autonomous multi-step work, commit to a reviewable contract -- intent, a plan with acceptance criteria, then execute proving each unit with evidence -- instead of improvising. Use for overnight/large tasks or anything that must be auditable.
when: a large, multi-step, or autonomous task where the user wants the result to be trustworthy and provable
tags: workflow, contract, autonomy, core
---

# Run a contract

Turns "improvise a big task" into "commit to a plan and prove you met it." This is
how autonomous and overnight work earns trust: the user can see the intent, the
acceptance criteria, and the evidence for each unit -- not just a final claim.

## Use when
- A large or multi-step task, especially one you will run autonomously.
- Anything the user wants to be able to audit ("show me the full change, not half").
- Work with real constraints/unknowns worth stating up front.

## Do not use when
- A quick edit, a single-file fix, or a pure question -- the ceremony is not worth it.

## Steps (primary path)
1. **Intent.** Create the contract: `POST /api/contracts { title, createdBy,
   intent: { restatement, constraints[], assumptions[], unknowns[] } }`. Restate
   the task in your own words; list the real constraints (e.g. "don't push/merge"),
   the assumptions you are making, and the unknowns you cannot resolve.
2. **Plan.** Add a plan -- `POST /api/contracts/update { id, phase:'plan', plan:
   [{ id, goal, outputs, acceptance, deps }] }` -- where every unit has an
   explicit **acceptance criterion** (how you will know it is done) and its deps.
3. **Review gate.** If a human is available, pause for plan approval and set
   `review.planApproved`. If running autonomously with standing authorization,
   record your own plan-review note and proceed.
4. **Execute.** Work unit by unit (respecting deps). As each completes, record
   evidence: `POST /api/contracts/update { id, units:[{ id, status:'done',
   evidence:'<what proves the acceptance criterion>' }] }`. Use the `ship-a-change`
   skill for any code unit.
5. **Final review.** When all units are done, do a final pass against every
   acceptance criterion, set `review.finalApproved`, and the contract auto-moves to
   `done`. Summarize what was built and what (if anything) was deferred.

## Safety
- Honor every constraint you recorded in the intent (especially "do not push /
  merge / do anything external"). The contract is your commitment.
- Do not mark a unit `done` without real evidence that its acceptance criterion is
  met. No hedging, no "should work".
- If you hit an unknown that invalidates the plan, update the contract (new unit or
  revised acceptance) rather than silently diverging.

## Verification
- The contract has an intent, a plan where every unit has an acceptance criterion,
  and evidence on every `done` unit.
- Every recorded constraint was honored.
- The final review checked each acceptance criterion before `done`.
