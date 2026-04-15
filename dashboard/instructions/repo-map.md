# Repo Map

Token-budgeted symbol map of a repository. Use this **before grepping** a codebase you do not know. Saves tokens, gives you the structural view first, lets you target the files that actually matter.

## Use it

```bash
./scripts/Get-RepoMap.ps1                       # active repo, ~4k tokens
./scripts/Get-RepoMap.ps1 -Repo "Symphonee"  # explicit repo
./scripts/Get-RepoMap.ps1 -Budget 8000          # larger map
```

API:
- `GET /api/repo/map?repo=<name>&budget=<tokens>` returns markdown.

MCP tool: `get_repo_map`.

## What you get

- Language(s) detected, file counts, HEAD sha
- Manifests (package.json / pyproject.toml / Cargo.toml etc.) with one-line summaries
- Top-level layout (which directories exist and how many files each holds)
- Top files ranked by recent commit activity + structural importance, each with their key symbols (classes, functions, interfaces, types) extracted via lightweight regex per language

Languages with symbol extraction: JS, TS, Python, C#, Go, Rust, Java, Kotlin, Ruby, PHP, Swift. Other source files contribute structure but no symbols.

## When to use

- First time touching a repo
- Onboarding a worker that needs to make changes
- Recipes that operate on unfamiliar codebases (the `explain-codebase` recipe is a natural fit)
- Triaging "where would I put X?" questions

Cached per-commit. A second call on the same HEAD sha is free.
