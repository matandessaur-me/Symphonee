# THE EVAL

The gate-maker for the Symphonee 2.0 cognition bet (note: `symphonee-2.0-development-plan`).

> "THE EVAL: a frozen query set + an explicit scoring rule + a PRE-COMMITTED kill
> criterion. Without this the Stage-2 gate is theater and the romance of the idea
> wins by default."

This harness measures how well Mind retrieval finds the right node for a question,
records an **RRF baseline**, and provides the ruler + the pre-committed criterion
that the Stage-2 activation kernel must beat to survive.

## Run it

```bash
node dashboard/eval/run.js
# or, script-first:
powershell.exe -ExecutionPolicy Bypass -NoProfile -File ./scripts/Run-Eval.ps1
```

Loads the live graph for the gold set's space, runs the real retrieval
(`mind/query.bestSeedsHybrid`) over the frozen gold set, scores every query,
prints a summary, and writes a durable record to
`.symphonee/eval/baselines/` (`latest.json` + a timestamped copy).

## The pieces

| file | role |
|------|------|
| `gold/retrieval.json` | **frozen** known-item gold set: paraphrased questions -> the node that answers them. Stable note ids. |
| `criterion.json` | **pre-committed** Stage-2 kill criterion (margins, metric, latency budget). |
| `metrics.js` | pure scoring: `hit@k`, `recall@k`, `reciprocalRank` (MRR), `ndcg@k`. |
| `retrievers.js` | thin adapters over the REAL `mind/query.js` retrieval. No reimplementation. |
| `harness.js` | retriever-agnostic `evaluate()` + the `compareToBaseline()` criterion logic. |
| `run.js` | CLI runner: `runBaseline()` (Stage 0) and `judgeChallenger()` (Stage 2+). |

## How Stage 2 plugs in

A retriever is just `(graph, question, k) => string[]` (ranked node ids). The
activation kernel satisfies the same shape, so it is scored by the identical
ruler:

```js
const { judgeChallenger } = require('./run');
const result = judgeChallenger((graph, question, k) => activationKernel(graph, question, k));
// result.verdict.pass === true  -> cognition may proceed (Stage 3)
// result.verdict.pass === false -> cognition STOPS at Stage 2 (per the plan)
```

`compareToBaseline` applies `criterion.json`: the challenger must beat the
baseline's primary metric by `minMargin`, must not regress the secondary metric,
and must converge within the p50 latency budget. **All three or it stops.**

## Rules of the frozen set

- The gold set and the criterion are **frozen**. Do not retune relevance or move
  the criterion numbers after seeing a challenger's score - that is precisely the
  "gate is theater" failure the plan warns against.
- Grow coverage only by **adding** new queries (new ids) or a new versioned
  criterion. Never edit existing entries in place.
- `denseUsed=false` on an offline run is expected: with no embedding index loaded
  RRF reduces to its BM25 leg. Re-run with a `denseProvider` once vectors are
  loaded to capture the fused baseline.
