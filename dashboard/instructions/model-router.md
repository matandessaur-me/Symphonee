# Model Router

**Do NOT hardcode CLI + model.** Use the router so picks respect the user's orchestration allowlist and API keys.

## How

```bash
# From bash
powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Get-ModelRecommendation.ps1 -Intent quick-summary"

# From API
curl -s -X POST http://127.0.0.1:3800/api/models/recommend \
  -H "Content-Type: application/json" \
  -d '{"intent":"quick-summary"}'
# -> { "cli": "claude", "model": "claude-haiku-4-5", "reasoning": "..." }
```

Feed the returned `cli` + `model` into your spawn body (`POST /api/orchestrator/spawn`) or graph-run worker node.

## Intents

- `quick-summary` — short output, classify, haiku, 1-paragraph answer
- `deep-code` — complex refactor, debugging, architecture
- `plan-and-implement` — reason then code
- `long-autonomy` — multi-hour agentic work
- `web-research` — needs current info from the open web
- `web-research-cheap` — light web lookup (pricing, docs)
- `pr-review` — pull-request / issue review workflow (plugin-dependent)
- `social-live` — live X/Twitter context
- `parallel-fanout` — one of N cheap workers
- `large-context` — input > 200k tokens (auto-promoted if `contextTokens` passed)

Budget flag (optional): `cheap`, `default`, `premium`.

Full catalog: `curl -s http://127.0.0.1:3800/api/models/catalog`

## When to skip the router

- User explicitly asked for a specific CLI or model
- The intent is already obvious from a previous router call in this session
- You're testing the router itself
