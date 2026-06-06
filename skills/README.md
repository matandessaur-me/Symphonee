# Symphonee Skills (the procedural layer)

Skills are model-neutral `SKILL.md` procedures for **how** to do a task the same way
every time. They are the procedural layer of Symphonee's cognitive loop, alongside:

- **Mind** = knowledge ("what we know / decided")  -> `/api/mind/*`
- **plugins** = integrations ("how to reach a system") -> `/api/plugins/*`
- **skills** = procedures ("how WE do a task, step by step") -> `/api/skills/*`

Every CLI sees the catalog at bootstrap (`bootstrap.skills`) and dispatched
workers get it injected into their prompt, so behaviour is consistent across CLIs
and sessions.

## Layout

```
skills/
  <id>/
    SKILL.md
```

`SKILL.md` is frontmatter + a markdown body:

```markdown
---
name: Human-readable capability name
description: What it does and when to use it (one line -- shown in the catalog).
when: short trigger phrase (optional)
tags: comma, separated (optional)
---

# Title

## Use when
## Do not use when
## Steps (primary path)
## Safety
## Verification
```

## API

- `GET  /api/skills` -- catalog (name/description/when, no bodies)
- `GET  /api/skills/item?id=<id>` -- one skill, full body
- `POST /api/skills` -- author/upsert `{ id, name, description, when?, tags?, body }`
- `DELETE /api/skills/item?id=<id>` -- remove

## Authoring

When the user corrects a procedure, or you find a repeatable better way, capture
it as a skill so no one has to teach it twice. See the `author-a-skill` skill for
the exact shape. Keep bodies model-neutral and plain ASCII; encode the Safety, not
just the happy path.
