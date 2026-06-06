---
name: Author a skill
description: Turn a correction, a gotcha, or a procedure you just did well into a durable SKILL.md so every future session of every CLI inherits it. This is how the system improves its own behaviour, not just its knowledge.
when: the user corrects a procedure, or you discover a repeatable better way to do something
tags: skills, learning-loop, meta, core
---

# Author a skill

Mind remembers what we KNOW. Skills remember how we WORK. When you learn a better
or required way to do a task, capture it as a skill so the next CLI does it right
by default -- the user should never have to teach the same procedure twice.

## Use when
- The user corrects HOW you did something ("don't bundle the diff with the
  commit", "always X before Y", "the way we do Z here is...").
- You notice a recurring task you keep re-deriving, or a non-obvious gotcha that
  cost you a retry.
- A digest of recent sessions surfaces a repeated mistake or missed route.

## Do not use when
- The fact is knowledge, not procedure -- that belongs in Mind (`use-mind`).
- It is a one-off specific to this repo state with no reuse value.

## Steps (primary path)
1. Name the procedure as an imperative capability ("Ship a code change"), pick a
   kebab-case `id`, and write a one-line `description` that states what it does and
   when to use it (this is what other CLIs see in the catalog).
2. Write the body with these sections: `Use when`, `Do not use when`,
   `Steps (primary path)` (numbered, concrete, ordered), `Safety` (the guardrails
   / the exact mistake to avoid), `Verification` (how to know it was done right).
   Keep it model-neutral -- no provider names, plain ASCII.
3. If you are upgrading an existing skill rather than creating one, fetch it
   (`GET /api/skills/item?id=<id>`), fold the new lesson into the right section,
   and keep the id stable.
4. Save it: `POST /api/skills { id, name, description, when?, tags?, body }`. It is
   immediately in the corpus and surfaces in the next bootstrap for every CLI.
5. Also record the underlying decision in Mind (`use-mind`) if it is a durable
   fact, so knowledge and procedure both persist.

## Safety
- Encode the SAFETY of the procedure, not just the happy path -- a skill without
  guardrails teaches the next CLI to repeat the unsafe version.
- Do not put secrets, credentials, or client names in a skill body.
- Prefer upgrading an existing skill over creating a near-duplicate.

## Verification
- `GET /api/skills` lists the new/updated skill with a valid name + description.
- The body has the required sections and a concrete, ordered Steps list.
- The exact correction that triggered this is now structurally prevented by the
  skill, not merely remembered.
