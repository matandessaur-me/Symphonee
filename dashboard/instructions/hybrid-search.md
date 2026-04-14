# Hybrid Search

BM25-based search across Notes + Learnings. Always on. v1 is BM25 only; v2 will add a local vector embedding model and combine scores.

## Use it

```bash
./scripts/Search-Notes.ps1 -Query "permission modes"
./scripts/Search-Notes.ps1 -Query "rate limit" -Kinds learnings
```

API:
- `GET /api/search?q=<query>&kinds=note,learning&limit=20`
- `POST /api/search/reindex` -- rebuild from scratch
- `GET /api/search/stats`

MCP tool: `search_notes_and_learnings`.

## When to use

- Looking up a past decision: "what did we decide about MCP last week?"
- Finding a learning relevant to the current task before repeating a mistake.
- Searching notes by semantic concept rather than exact substring.

The index auto-rebuilds on note save. Auto-add on learning post is not yet wired (post a learning -> next reindex picks it up; or call `/api/search/reindex`).
