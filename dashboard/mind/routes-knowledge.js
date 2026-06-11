'use strict';
// Mind knowledge surface: query / ask / kit / save-result / recall / teach / add
// + wakeup + instructions. Reads and graph writes; the heavy lifecycle (build,
// embed, insights, watch) stays in the controller.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const query = require('./query');
const kit = require('./kit');
const llm = require('./llm');
const { sanitizeLabel, validateUrl } = require('./security');
const { composeWakeUp, DEFAULT_BUDGET_TOKENS } = require('./wakeup');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, getUiContext, readBody, tryDenseSeeds, persistDerivedGraph, notifyKnowledgeEvent, broadcast } = deps;

  // ── Wake-up (L0+L1 layered context for prompt injection) ─────────────────
  addRoute('GET', '/api/mind/wakeup', (req, res) => {
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const url = new URL(req.url, 'http://x');
    const budget = parseInt(url.searchParams.get('budget') || '', 10);
    const question = url.searchParams.get('question') || '';
    const g = store.loadGraph(repoRoot, space) || { nodes: [], edges: [], gods: [] };
    const wake = composeWakeUp(g, {
      activeRepo: ui.activeRepo, activeRepoPath: ui.activeRepoPath, space,
      budgetTokens: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_TOKENS,
      question,
      repoRoot,
    });
    return json(res, { space, ...wake });
  });



  addRoute('GET', '/api/mind/instructions', (req, res) => {
    const p = path.join(__dirname, 'instructions.md');
    try { res.writeHead(200, { 'Content-Type': 'text/markdown' }); res.end(fs.readFileSync(p)); }
    catch (e) { json(res, { error: e.message }, 500); }
  });

  // ── Query (BFS sub-graph + suggested answer scaffold) ────────────────────
  addRoute('POST', '/api/mind/query', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty - run /api/mind/build first', empty: true }, 200);

    // If hybrid:false explicitly passed, skip dense entirely.
    let denseSeeds = null;
    if (body.hybrid !== false && body.question) {
      denseSeeds = await tryDenseSeeds(repoRoot, space, body.question, 50).catch(() => null);
    }

    const result = query.runQuery(g, {
      question: body.question || '',
      mode: body.mode || 'bfs',
      budget: body.budget || 2000,
      seedIds: body.seedIds || (denseSeeds && denseSeeds.length ? query.bestSeedsHybrid(g, body.question, 5, { dense: denseSeeds }) : null),
      asOf: body.asOf || null,
    });
    if (denseSeeds) result.denseSeedCount = denseSeeds.length;
    return json(res, result);
  });

  // ── Ask: a quick, Mind-grounded answer from the LOCAL chat model ──────────
  // Powers the command palette's "informational question" path: instead of
  // dispatching a heavyweight agent, answer the question locally with Gemma,
  // grounded in the knowledge graph. Returns {ok:false, reason:'no-local-model'}
  // so the client can fall back to an agent dispatch.
  addRoute('POST', '/api/mind/ask', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const question = String(body.question || '').trim();
    if (!question) return json(res, { error: 'question required' }, 400);
    // When asking ABOUT a specific node (e.g. "Ask Mind about this" from the
    // graph), ground directly on that node's own neighborhood -- far sharper than
    // re-searching the label as free text, which produced vague answers.
    const nodeId = body.nodeId ? String(body.nodeId) : null;
    const explicitSeeds = Array.isArray(body.seedIds) ? body.seedIds.map(String) : null;

    let model = null;
    try { model = llm.pickChatModel(); } catch (_) {}
    if (!model) return json(res, { ok: false, reason: 'no-local-model' }, 200);

    // Gather grounding context from the graph (best-effort, never throws).
    const space = getSpace();
    const blocks = [];
    const citedNodeIds = [];
    try {
      const g = store.loadGraph(repoRoot, space);
      if (g) {
        let seeds = [];
        if (explicitSeeds && explicitSeeds.length) seeds = explicitSeeds.slice();
        if (nodeId && !seeds.includes(nodeId)) seeds.unshift(nodeId);
        // Only fall back to a text search when we were not handed a node/seeds.
        if (!seeds.length) {
          const dense = await tryDenseSeeds(repoRoot, space, question, 12).catch(() => null);
          seeds = (dense && dense.length) ? query.bestSeedsHybrid(g, question, 5, { dense }) : [];
          seeds = Array.isArray(seeds) ? seeds.slice() : [];
        }
        // For a free-text question, anchor on the active project so answers are
        // grounded in what the user is working on RIGHT NOW by default -- quicker,
        // more relevant retrieval without naming the repo. Skipped for a node ask,
        // where we keep the focus tight on the clicked node.
        if (!nodeId && !(explicitSeeds && explicitSeeds.length)) {
          try {
            const ui = getUiContext ? getUiContext() : {};
            if (ui.activeRepo) {
              for (const id of kit.resolveSeeds(g, ui.activeRepo).slice(0, 2)) {
                if (!seeds.includes(id)) seeds.push(id);
              }
            }
          } catch (_) {}
        }
        const result = query.runQuery(g, {
          question, mode: 'bfs', budget: 1500,
          seedIds: seeds.length ? seeds : null,
        });
        for (const n of ((result && result.nodes) || []).slice(0, 12)) {
          const text = [n.label, n.body || n.answer || n.description].filter(Boolean).join(': ').replace(/\s+/g, ' ').slice(0, 400);
          if (text) { blocks.push('- ' + text); citedNodeIds.push(n.id); }
        }
      }
    } catch (_) { /* answer without grounding */ }

    const sys = 'You are Symphonee, a concise developer assistant. Answer the question practically and directly. Use the CONTEXT from the user knowledge graph when it is relevant; if it does not cover the question, answer from general knowledge. Keep it tight - no preamble, no headers.';
    const ctx = blocks.length ? ('CONTEXT from the knowledge graph:\n' + blocks.join('\n') + '\n\n') : '';
    try {
      // chatOllama returns a wrapper { ok, model, text } -- read .text, do NOT
      // stringify the object (that yields "[object Object]").
      const resp = await llm.chatOllama(
        [{ role: 'system', content: sys }, { role: 'user', content: ctx + 'QUESTION: ' + question }],
        { format: null, temperature: 0.3, numPredict: 700, timeoutMs: 60000 }
      );
      const answer = String((resp && (resp.text != null ? resp.text : resp)) || '').trim();
      return json(res, { ok: true, answer, model: (resp && resp.model) || model, grounded: blocks.length, citedNodeIds });
    } catch (e) {
      return json(res, { ok: false, reason: 'llm-error', error: e.message || String(e) }, 200);
    }
  });

  // ── KIT (Know It Too): portable, shareable knowledge ─────────────────────
  // Export a topic + everything connected to it as a self-contained mind-graph;
  // ingest a KIT by merging only the gaps (no duplicates) into the local graph.
  addRoute('POST', '/api/mind/kit/export', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { ok: false, reason: 'empty-graph', hint: 'build the mind first' }, 200);
    const r = kit.exportKit(g, {
      topic: body.topic || '',
      seedIds: Array.isArray(body.seedIds) ? body.seedIds : null,
      space,
      maxNodes: Math.max(1, Math.min(Number(body.maxNodes) || 800, 5000)),
      maxDepth: Math.max(1, Math.min(Number(body.maxDepth) || 4, 8)),
    });
    return json(res, r);
  });
  addRoute('POST', '/api/mind/kit/ingest', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const incoming = body && body.kit ? body.kit : body; // accept {kit:...} or a raw KIT
    if (!incoming || !Array.isArray(incoming.nodes)) return json(res, { ok: false, reason: 'invalid-kit' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space) || store.emptyGraph({ space });
    const r = kit.ingestKit(g, incoming);
    if (r.ok && (r.addedNodes || r.addedEdges)) {
      try { store.saveGraph(repoRoot, space, g); } catch (e) { return json(res, { ok: false, reason: 'save-failed', error: e.message }, 500); }
      try { broadcast({ type: 'mind-update', payload: { kind: 'kit-ingest', ...r } }); } catch (_) {}
      try { notifyKnowledgeEvent({ kind: 'kit-ingest', reason: 'kit-ingest', nodeIds: [] }); } catch (_) {}
    }
    return json(res, r);
  });

  // ── Q&A feedback loop: save an answer back into the graph ────────────────
  //
  // Cite-grounding check: every cited node ID must (a) actually exist in the
  // graph, and (b) have its label or a substring of its content referenced
  // somewhere in the answer text. Otherwise the brain would happily store
  // plausible-sounding but ungrounded text — the failure mode that erodes
  // trust in RAG systems over time.
  //
  // The check is *advisory by default* — confidence on ungrounded edges
  // downgrades to AMBIGUOUS rather than rejecting the save outright.
  // Pass `strict: true` to reject saves with no grounded citations at all.
  addRoute('POST', '/api/mind/save-result', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const { question, answer, citedNodeIds = [], createdBy = 'unknown', strict = false } = body;
    if (!question || !answer) return json(res, { error: 'question and answer required' }, 400);
    const space = getSpace();
    let g = store.loadGraph(repoRoot, space) || store.emptyGraph({ space });

    // Audit each citation: does the answer actually reference the node?
    const lowerAnswer = String(answer).toLowerCase();
    const audit = [];
    for (const cited of citedNodeIds) {
      const node = g.nodes.find(n => n.id === cited);
      if (!node) { audit.push({ id: cited, status: 'unknown' }); continue; }
      const labelHit = node.label && lowerAnswer.includes(String(node.label).toLowerCase().slice(0, 60));
      const idHit = lowerAnswer.includes(String(cited).toLowerCase());
      audit.push({ id: cited, status: (labelHit || idHit) ? 'grounded' : 'ungrounded' });
    }
    const grounded = audit.filter(a => a.status === 'grounded');
    if (strict && citedNodeIds.length > 0 && grounded.length === 0) {
      return json(res, {
        error: 'no cited nodes are grounded in the answer text',
        audit,
        hint: 'reference each cited node by its label or id in your answer, or set strict:false to save anyway',
      }, 400);
    }

    const ts = Date.now();
    const id = `qa_${ts}_${Math.random().toString(36).slice(2, 6)}`;
    g.nodes.push({
      id, label: sanitizeLabel(question.slice(0, 120)), kind: 'conversation',
      source: { type: 'qa', ref: createdBy }, sourceLocation: null,
      createdBy, createdAt: new Date().toISOString(), tags: ['qa'],
      answer: sanitizeLabel(answer.slice(0, 4000)),
      groundedCount: grounded.length,
      citationCount: citedNodeIds.length,
    });
    for (const cited of citedNodeIds) {
      const node = g.nodes.find(n => n.id === cited);
      if (!node) continue;
      const a = audit.find(x => x.id === cited);
      // Ungrounded citations get edge confidence INFERRED + a lower score,
      // so query consumers see the warning without the data being lost.
      const isGrounded = a && a.status === 'grounded';
      g.edges.push({
        source: id, target: cited, relation: 'derived_from',
        confidence: isGrounded ? 'EXTRACTED' : 'INFERRED',
        confidenceScore: isGrounded ? 1.0 : 0.5,
        weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }
    persistDerivedGraph(space, g);
    if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'node-added', id, createdBy } });
    notifyKnowledgeEvent({ kind: 'save-result', nodeIds: [id], reason: 'qa-saved' });

    // Auto-extract memory cards from the answer text. Conservative
    // patterns ("remember:", "we decided", "the rule is", "prefer X",
    // "watch out for", ...) become first-class kind:memory nodes linked
    // back to this conversation node. Idempotent via content-hash so
    // re-saving the same answer doesn't duplicate cards.
    const memoryModule = require('./memory');
    const candidates = memoryModule.extractMemoriesFromText(answer);
    const memoriesCreated = [];
    if (candidates.length) {
      // Reload the graph so we see the conversation node we just wrote.
      const reloaded = store.loadGraph(repoRoot, space) || g;
      const existingMemoryHashes = new Set();
      for (const n of reloaded.nodes) {
        if (n.kind === 'memory' && typeof n.body === 'string') {
          existingMemoryHashes.add(n.body.toLowerCase().trim().slice(0, 240));
        }
      }
      // Carry forward brand tags from cited entity nodes so a memory
      // about "Aurora design" auto-tags Aurora even if the answer text
      // didn't list it.
      const carryTags = [];
      for (const cited of citedNodeIds) {
        const node = reloaded.nodes.find(n => n.id === cited);
        if (!node) continue;
        if (node.kind === 'entity' && typeof node.label === 'string') carryTags.push(node.label);
      }
      for (const cand of candidates) {
        const hash = cand.body.toLowerCase().trim().slice(0, 240);
        if (existingMemoryHashes.has(hash)) continue;
        existingMemoryHashes.add(hash);
        try {
          const r = await memoryModule.addMemoryCard({
            repoRoot, space,
            spec: {
              ...cand,
              tags: carryTags,
              source: { type: 'conversation', ref: id },
              createdBy: createdBy || 'mind/auto-extract',
            },
          });
          memoriesCreated.push({ id: r.node.id, title: r.node.label, kindOfMemory: r.node.kindOfMemory });
        } catch (_) { /* one bad pattern must not break the save */ }
      }
      if (memoriesCreated.length && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'memory-extracted', conversationId: id, count: memoriesCreated.length, memories: memoriesCreated } });
      }
      if (memoriesCreated.length) {
        notifyKnowledgeEvent({ kind: 'memory-auto-extracted', nodeIds: memoriesCreated.map(m => m.id), reason: 'auto-memory' });
      }
    }

    return json(res, { ok: true, nodeId: id, audit, groundedCount: grounded.length, memoriesCreated });
  });

  // ── Recall: time-ranged + topic-filtered retrieval ─────────────────────
  // Different from /api/mind/query (BFS sub-graph) - returns a ranked
  // LIST of recall-eligible items (memories, conversations, drawers)
  // restricted to a time window and optionally a repo. Answers "what
  // did I figure out about X 10 days ago?" / "what do I know about
  // Playdate?" without graph traversal.
  //
  // POST /api/mind/recall
  //   {
  //     "question": "Aurora design",          // optional, BM25 ranks
  //     "since":    "10 days ago",          // ISO or natural string
  //     "until":    "today",                // ISO or natural string
  //     "repo":     "Aurora3",                // optional repo scope
  //     "kinds":    ["memory","conversation"], // default all
  //     "limit":    20
  //   }
  // Returns { hits, total, since, until, repo, question }
  addRoute('POST', '/api/mind/recall', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body || typeof body !== 'object') {
      return json(res, { error: 'request body must be a JSON object' }, 400);
    }
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { hits: [], total: 0, message: 'no graph for this space' });
    const recallModule = require('./recall');
    try {
      const result = recallModule.recall(g, {
        question: body.question || '',
        since:    body.since,
        until:    body.until,
        repo:     body.repo,
        kinds:    body.kinds,
        limit:    body.limit,
      });
      return json(res, result);
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  });

  // ── Memory cards: durable knowledge taught mid-conversation ─────────────
  // The user (or an AI on their behalf) committed a fact. "Aurora doesn't
  // follow the Blue Falcon design system." "For Playdate, prefer pulldown
  // for menu navigation." "Don't mock the database in tests - we got
  // burned last quarter." Each becomes a kind:memory node, indexed by
  // tags, linked to its source conversation if known, and surfaceable on
  // wakeup + recall queries.
  //
  // POST /api/mind/teach
  //   {
  //     "title":          "Aurora doesn't follow Blue Falcon brand",
  //     "body":           "Different colour palette + typography ...",
  //     "kindOfMemory":   "constraint" | "decision" | "preference" |
  //                       "lesson" | "gotcha" | "pattern" | "fact",
  //     "tags":           ["Aurora", "Blue Falcon", "design"],
  //     "scope":          { "repo": "Aurora3" },          // optional
  //     "source":         { "type": "conversation",     // optional
  //                         "ref":  "<existing node id>" },
  //     "createdBy":      "claude" | "codex" | "user" | ...
  //   }
  // Returns: { ok, nodeId, node, edges }
  addRoute('POST', '/api/mind/teach', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body || typeof body !== 'object') {
      return json(res, { error: 'request body must be a JSON object' }, 400);
    }
    const space = getSpace();
    const memoryModule = require('./memory');
    try {
      const { node, edges } = await memoryModule.addMemoryCard({
        repoRoot, space, spec: body,
      });
      if (broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'memory-added', id: node.id, title: node.label, createdBy: node.createdBy } });
      }
      notifyKnowledgeEvent({ kind: 'teach', nodeIds: [node.id], reason: 'memory-card-taught' });
      return json(res, { ok: true, nodeId: node.id, node, edges });
    } catch (e) {
      if (e.code === 'MIND_LOCKED') {
        return json(res, { error: e.message, holderPid: e.holderPid }, 409);
      }
      return json(res, { error: e.message }, 400);
    }
  });

  // ── Manual ingest: a user/agent pushes one artefact at a time ────────────
  addRoute('POST', '/api/mind/add', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (body.url) { try { validateUrl(body.url); } catch (e) { return json(res, { error: e.message }, 400); } }
    const space = getSpace();
    let g = store.loadGraph(repoRoot, space) || store.emptyGraph({ space });
    const ts = Date.now();
    const id = `manual_${ts}_${Math.random().toString(36).slice(2, 6)}`;
    g.nodes.push({
      id, label: sanitizeLabel(body.label || body.url || body.path || 'untitled'),
      kind: body.kind || 'concept',
      source: { type: 'manual', ref: body.url || body.path || null },
      createdBy: body.createdBy || 'manual', createdAt: new Date().toISOString(),
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
    persistDerivedGraph(space, g);
    notifyKnowledgeEvent({ kind: 'manual-ingest', nodeIds: [id], reason: 'manual-add' });
    return json(res, { ok: true, nodeId: id });
  });
}

module.exports = { register };
