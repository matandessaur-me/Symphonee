# Graph Runs (BETA)

Part of the AI Orchestration BETA. Gated by the same `OrchestrateMode` config flag — when AI Orchestration is enabled in Settings -> Other, graph runs are available too. If disabled, `/api/graph-runs` returns 501.

Use graph runs for multi-step workflows that need:
- durability across app restarts
- branching based on state
- human-approval gates
- multiple workers with real dependencies

One-shot `POST /api/orchestrator/spawn` is unchanged. Use graph runs only when the task actually needs the structure.

## Scripts (primary surface)

```bash
./scripts/Start-GraphRun.ps1 -File .ai-workspace/my-graph.json
./scripts/Get-GraphRun.ps1                    # list
./scripts/Get-GraphRun.ps1 -Id gr_abc         # detail
./scripts/Approve-GraphNode.ps1 -RunId gr_abc -NodeId review
./scripts/Stop-GraphRun.ps1 -Id gr_abc -Action pause|resume|cancel
```

## API endpoints

- `POST /api/graph-runs` — start a run. Body: `{ name, nodes[], state? }`
- `GET /api/graph-runs` — list
- `GET /api/graph-runs/:id` — detail with full state
- `POST /api/graph-runs/:id/pause|resume|cancel`
- `POST /api/graph-runs/:id/interrupt` with `{ patch: {...} }` — edit state mid-run
- `POST /api/graph-runs/:id/approve/:nodeId` with `{ approved, note }`

## Node types (v1)

- **`worker`** — spawns a CLI via `/api/orchestrator/spawn`. Fields: `cli`, `model`, `prompt`. Prompt supports `{{ state.foo }}` substitution. Output auto-merges into `state.results[nodeId]`. Call the model router first if the user didn't specify a CLI.
- **`approval`** — human gate. Fields: `title`. Fires the header approval modal.
- **`branch`** — JS expression on state. Fields: `expr`, `thenNext`, `elseNext`. The branch NOT taken is marked skipped; downstream merge nodes with at least one reachable parent still run.

## Dependencies

Each node may declare `dependsOn: [nodeId, ...]`. Nodes run when all deps are `completed` or `cancelled`.

## Result delivery

When a run terminates, the engine injects a one-line summary back into the PTY that launched it (via `SYMPHONEE_TERM_ID`). Supervisor agents pick that up and continue.

## Example

See `examples/graph-runs/sprint-review.json` for a real graph.
