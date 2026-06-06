---
name: Use Mind (recall, teach, save)
description: The cross-CLI memory discipline -- recall prior work before answering, teach durable corrections the moment you hear them, and save findings after every substantive reply so the next session of every CLI inherits them.
when: any substantive turn -- especially questions about prior work, user corrections, or after answering
tags: mind, memory, core
---

# Use Mind

Symphonee is the brain; you are one of many mouths connected to it. Mind is the
ONLY surface that carries intelligence across CLIs and sessions. A turn that ends
without writing to Mind has wasted intelligence for every future session.

## Use when
- BEFORE answering: the user asks about prior work / past decisions ("what did we
  figure out about X", "didn't we...", "what do I know about X").
- WHEN the user teaches something durable ("remember", "from now on", "always",
  "never", "we decided", "prefer X", "the rule is", "watch out for") or corrects
  your earlier behaviour.
- DURING a code-structure question ("what calls X", "where is Z defined").
- AFTER every substantive reply.

## Do not use when
- Pure greetings or trivial chit-chat.

## Steps (primary path)
1. Recall first for prior-work questions: `POST /api/mind/recall { question, since?,
   until?, repo? }`. Cite the memory IDs that come back.
2. Query for code structure: `POST /api/mind/query { question }`. Cite returned
   node IDs only -- never invent IDs.
3. Teach durable facts the moment you hear them: `POST /api/mind/teach { title,
   body, kindOfMemory, tags, createdBy }`. You make the call when YOU hear the
   signal -- do not wait for the user to remind you.
4. Save after answering: `POST /api/mind/save-result { question, answer,
   citedNodeIds, createdBy }`. It auto-extracts memory cards from teaching
   language in your answer.

## Safety
- Do not invent node IDs; cite only IDs returned from a query.
- Do not mark guesses as EXTRACTED -- inferred edges are INFERRED/AMBIGUOUS.
- Never record company/client names, URLs, secrets, or credentials in learnings.

## Verification
- For a prior-work question, you recalled before answering and cited memory IDs.
- For a durable correction, a teach (or a save-result that auto-extracted it) landed.
- After a substantive reply, a save-result was written.
