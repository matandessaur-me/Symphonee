/**
 * Mind - Symphonee's shared knowledge graph.
 *
 * The brain belongs to Symphonee, not to any one CLI. Every dispatched AI
 * worker (Claude Code, Codex, Gemini, Copilot, Grok, Qwen) reads from and
 * writes to the same graph through this REST surface.
 *
 * mountMind(addRoute, json, ctx) registers all /api/mind/* routes and
 * exports lifecycle hooks the rest of the server uses (bootstrap field,
 * orchestrator hint injection, Q&A feedback loop).
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Manifest } = require('./manifest');
const engine = require('./engine');
const query = require('./query');
const kit = require('./kit');
const { cluster } = require('./cluster');
const { analyze } = require('./analyze');
const { composeWakeUp, DEFAULT_BUDGET_TOKENS } = require('./wakeup');
const { sanitizeLabel, validateUrl } = require('./security');
const { MindWatcher } = require('./watch');
const { reflectOnce, startReflectionScheduler } = require('./reflect');
const { healOnce, startHealingScheduler } = require('./heal');
const insights = require('./insights');
const repeatedQuestionAnalyser = require('./analysers/repeated-question');
const coEditAnalyser = require('./analysers/co-edit');
const memoryDecayAnalyser = require('./analysers/memory-decay');
const crossRepoAnalyser = require('./analysers/cross-repo');
const memoryStalenessAnalyser = require('./analysers/memory-staleness');
const memoryContradictionAnalyser = require('./analysers/memory-contradiction');
const memoryModule = require('./memory');
const ollamaSetup = require('./ollama-setup');
const llm = require('./llm');
const lock = require('./lock');
const checkpoint = require('./checkpoint');
const impact = require('./impact');
const embeddings = require('./embeddings');
const { VectorStore } = require('./vectors');
const viz = require('./viz');

// In-memory job table for build/update progress. Jobs are ephemeral; the
// canonical graph on disk is the system of record.
const jobs = new Map();
const DEFAULT_BUILD_SOURCES = ['notes', 'learnings', 'cli-memory', 'cli-skills', 'app-recipes', 'site-map', 'plugins', 'instructions', 'repo-code', 'cli-history', 'cli-drawers', 'context-artifacts', 'repos', 'entities'];
function makeJobId() { return 'mj_' + Math.random().toString(36).slice(2, 10); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function tryDenseSeeds(repoRoot, space, question, k = 50) {
  const vs = new VectorStore(repoRoot, space);
  if (!vs.load() || vs.count() === 0) return null;
  const provider = vs.provider || process.env.SYMPHONEE_EMBED_PROVIDER || embeddings.pickProvider();
  if (!provider) return null;
  let qv;
  try {
    qv = await embeddings.embedSingle(question, { provider, model: vs.model || undefined });
  } catch (_) {
    return null;
  }
  if (!qv) return null;
  return vs.query(qv, k);
}

function mountMind(addRoute, json, ctx) {
  const { repoRoot, getUiContext, getLearnings, getPlugins, getNotesDir, broadcast, getAiApiKeys, getConfig } = ctx;
  // Startup-settle tracking: the boot loading overlay waits on this so the
  // dashboard is revealed only once the Mind refresh (+ repo re-ingest) has
  // actually finished -- not merely when page assets loaded.
  let _startupTriggered = false;
  let _startupSettled = false;
  // Make the user's configured API keys available to the embedding layer so
  // it can pick a provider automatically (OpenAI > Google) instead of
  // defaulting to Ollama. Refreshes on every request so config edits take
  // effect without a restart.
  function refreshEmbedKeys() {
    // Keys still flow through in case the orchestrator/other features
    // call embed() with an explicit provider, but the default picker is
    // hard-locked to Ollama-or-nothing.
    try { embeddings.setAvailableApiKeys(getAiApiKeys ? getAiApiKeys() : {}); } catch (_) {}
  }
  refreshEmbedKeys();
  // Probe Ollama at boot + every 5 min so the picker prefers local
  // semantic search the moment Ollama becomes available (no restart
  // required). Failure is silent — falls back to BM25.
  embeddings.refreshOllamaStatus({ force: true }).catch(() => {});
  setInterval(() => { embeddings.refreshOllamaStatus().catch(() => {}); }, 5 * 60 * 1000).unref();
  // Same cadence for the chat-model probe so reflection wakes up the
  // instant a chat model gets pulled (whether by auto-bootstrap or by
  // the user running `ollama pull` manually).
  llm.refreshChatStatus({ force: true }).catch(() => {});
  setInterval(() => { llm.refreshChatStatus().catch(() => {}); }, 5 * 60 * 1000).unref();

  const getSpace = () => {
    const c = getUiContext ? getUiContext() : {};
    return c.activeSpace || c.notesNamespace || '_global';
  };

  function persistDerivedGraph(space, graph) {
    const next = graph || store.emptyGraph({ space });
    next.version = next.version || 1;
    next.scope = next.scope || { space, isGlobal: false };
    const { communities } = cluster(next);
    const { gods, surprises, suggested } = analyze({ ...next, communities });
    next.communities = communities;
    next.gods = gods;
    next.surprises = surprises;
    next.suggested = suggested;
    return store.saveGraph(repoRoot, space, next);
  }

  // ── Knowledge-event hook (the brain reacts) ──────────────────────────────
  //
  // Anything that adds a node to the graph from a non-file source
  // (save-result, teach, /add, learnings, manual ingest) should call
  // notifyKnowledgeEvent so Mind does the same incremental rebuild +
  // per-node embed it would do for a file change.
  //
  // Debounced separately from the file watcher: knowledge writes burst
  // (one save-result -> N memory cards -> N embeds), so we coalesce a
  // 3s window before re-clustering / re-embedding.
  let knowledgeTimer = null;
  const pendingNodes = new Set();
  let pendingReasons = new Set();
  let lastEventAt = 0;
  const getLastEventAt = () => lastEventAt;

  async function embedSingleNode(space, nodeId) {
    refreshEmbedKeys();
    const vs = new VectorStore(repoRoot, space);
    const loaded = vs.load();
    // Only embed if a vector store already exists for this space — we
    // never want a single new node to spin up a brand-new store with
    // dim 0. The full /api/mind/embed run owns initialisation.
    if (!loaded || vs.count() === 0) return { ok: false, reason: 'no-vector-store' };
    const g = store.loadGraph(repoRoot, space);
    if (!g) return { ok: false, reason: 'no-graph' };
    const node = g.nodes.find(n => n.id === nodeId);
    if (!node) return { ok: false, reason: 'node-missing' };
    const text = [node.label, node.body, node.answer].filter(Boolean).join('\n\n').slice(0, 4000);
    if (!text.trim()) return { ok: false, reason: 'no-text' };
    const provider = vs.provider || embeddings.pickProvider();
    if (!provider) return { ok: false, reason: 'no-provider' };
    try {
      const vec = await embeddings.embedSingle(text, { provider, model: vs.model || undefined });
      if (!vec) return { ok: false, reason: 'empty-embedding' };
      vs.upsert(nodeId, vec);
      vs.save();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'embed-error', error: err.message };
    }
  }

  function notifyKnowledgeEvent({ kind, nodeIds = [], reason }) {
    lastEventAt = Date.now();
    for (const id of nodeIds) pendingNodes.add(id);
    if (reason) pendingReasons.add(reason);
    if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'knowledge-event', reason: kind || reason, nodeCount: nodeIds.length } });
    // Out-of-band hook for layers above Mind (the brain feeds intent +
    // sequence recorder from here). Must never throw or block.
    if (typeof ctx.onKnowledgeEvent === 'function') {
      try { ctx.onKnowledgeEvent({ kind, reason, nodeIds }); } catch (_) { /* swallow */ }
    }
    if (knowledgeTimer) clearTimeout(knowledgeTimer);
    knowledgeTimer = setTimeout(async () => {
      const ids = Array.from(pendingNodes);
      const reasons = Array.from(pendingReasons);
      pendingNodes.clear();
      pendingReasons.clear();
      knowledgeTimer = null;
      const space = getSpace();
      // Auto-embed every new node we know about. Independent of the
      // full incremental build below — the per-node embed is cheap and
      // gives semantic recall an immediate signal.
      for (const id of ids) {
        try { await embedSingleNode(space, id); } catch (_) { /* one bad embed must not block the rest */ }
      }
      // Same incremental rebuild the file watcher fires. Picks up any
      // sources that may have changed alongside the knowledge event
      // (e.g. a note that was edited in the same turn).
      try {
        await triggerIncrementalUpdate({ knowledgeEvent: true, reasons, nodeIds: ids });
      } catch (e) {
        console.warn('[mind/knowledge-event] update error:', e.message);
      }
    }, 3000);
  }

  // ── Reads ────────────────────────────────────────────────────────────────


  // ── Splash / boot-overlay quotes ─────────────────────────────────────────
  // Instant read of the cached, brain-generated quote pool (or placeholders).
  // Served on the boot path, so it must never block. Both splash.html and the
  // dashboard loading overlay fetch this. Regeneration happens in the deferred
  // boot work (see server.js runDeferredBootWork -> regenerateSplashQuotes).
  const splashQuotes = require('./splash-quotes');
  addRoute('GET', '/api/splash/quotes', (req, res) => {
    return json(res, splashQuotes.getQuotes(repoRoot));
  });

  // ── Mind-aware CLI routing suggestion ────────────────────────────────────
  //
  // Returns a CLI ranking based on which CLIs have previously completed
  // similar tasks successfully. Pulls conversation/task nodes whose label
  // overlaps with the prompt (BM25), groups by `createdBy` (the CLI), and
  // weights by recency.
  //
  // This is ADVISORY. The model-router script is still authoritative for
  // intent-based routing; this answers a different question:
  // "for THIS specific task, who has been on it before?"
  //
  // Multi-CLI: every CLI Symphonee supports can appear in the ranking.
  // If a CLI has never completed a similar task, it simply doesn't appear
  // — that's not a vote against it, just absence of evidence.


  // Startup readiness for the boot loading overlay. `ready` flips true only once
  // the deferred startup refresh has run AND the graph build lock is free (so a
  // 'skipped' refresh -- where the watcher's auto-resume build is the one
  // actually running -- still waits for that build to finish). `building`
  // reflects the live lock so the overlay can show that work is in flight.
  addRoute('GET', '/api/startup/status', (req, res) => {
    const space = getSpace();
    let building = false;
    try { building = !!(lock.status(space, 'graph') || {}).locked; } catch (_) {}
    return json(res, { ok: true, ready: _startupSettled, triggered: _startupTriggered, building, space });
  });

  // Dense-only semantic search (debug + UI smart-search). Returns ranked nodes
  // by cosine similarity. The graph has to have been embedded first via
  // /api/mind/embed (or SYMPHONEE_EMBED_AUTO=1 during build).
  addRoute('POST', '/api/mind/search-semantic', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const q = body.q || body.query;
    if (!q) return json(res, { error: 'q required' }, 400);
    const k = Math.min(50, Math.max(1, body.k || 10));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const dense = await tryDenseSeeds(repoRoot, space, q, k);
    if (!dense) return json(res, { error: 'embeddings unavailable - run /api/mind/embed first', q, results: [] }, 200);
    const nodeMap = new Map(g.nodes.map(n => [n.id, n]));
    return json(res, {
      q,
      k,
      results: dense.map(r => ({
        id: r.id,
        score: r.score,
        node: nodeMap.get(r.id) || null,
      })),
    });
  });

  addRoute('POST', '/api/mind/embed', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    refreshEmbedKeys();
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const acq = lock.acquire(space, 'embed');
    if (!acq.ok) return json(res, { error: 'embedding already running', holderPid: acq.holderPid }, 409);

    // Build a provider chain: requested first, then the rest in priority order.
    const keys = (typeof getAiApiKeys === 'function' ? getAiApiKeys() : {}) || {};
    const candidates = [];
    if (body.provider) candidates.push(body.provider);
    if (keys.OPENAI_API_KEY && !candidates.includes('openai')) candidates.push('openai');
    if (keys.GOOGLE_API_KEY && !candidates.includes('google')) candidates.push('google');
    if (!candidates.length) {
      lock.release(space, 'embed');
      return json(res, {
        error: 'No embedding provider configured. Add an OpenAI or Google API key in Settings > AI Providers.',
      }, 400);
    }

    json(res, { ok: true, started: true, providerChain: candidates });
    let lastErr = null;
    for (const provider of candidates) {
      try {
        const r = await engine.refreshEmbeddings({
          repoRoot, space, graph: g,
          ctx: { embedProvider: provider },
          onProgress: (msg) => {
            if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-progress', msg, provider } });
          },
        });
        if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-complete', result: { ...r, provider } } });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err.message || String(err);
        const isProviderError = /api[_ ]?key|credit|quota|insufficient|RESOURCE_EXHAUSTED|401|402|403|429|unavailable|ECONNREFUSED|fetch failed/i.test(msg);
        if (!isProviderError || candidates.indexOf(provider) === candidates.length - 1) {
          // Either not a failover-able error, or we're out of candidates.
          break;
        }
        // Try next provider; broadcast a notice so the UI can toast.
        if (broadcast) broadcast({
          type: 'orchestrator-event',
          event: 'provider-failover',
          from: provider,
          reason: 'embedding ' + (msg.match(/credit|quota/i) ? 'out of credits' : 'failed'),
          errorSnippet: msg.slice(0, 160),
        });
      }
    }
    if (lastErr) {
      const msg = lastErr.message || String(lastErr);
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-failed', error: msg } });
      if (broadcast) broadcast({
        type: 'orchestrator-event',
        event: 'provider-exhausted',
        lastCli: candidates[candidates.length - 1],
        reason: 'embedding failed after trying ' + candidates.length + ' provider(s)',
      });
    }
    lock.release(space, 'embed');
  });

  // ── Health (embeddings + vectors store status) ───────────────────────────
  addRoute('GET', '/api/mind/health', async (req, res) => {
    const space = getSpace();
    const vs = new VectorStore(repoRoot, space);
    vs.load();
    const url = new URL(req.url, 'http://x');
    refreshEmbedKeys();
    const provider = url.searchParams.get('provider') || embeddings.pickProvider();
    const fresh = url.searchParams.get('fresh') === '1';
    const h = provider
      ? await embeddings.health({ provider, fresh })
      : await embeddings.health({ fresh });
    return json(res, {
      space,
      embeddings: h,
      vectors: {
        count: vs.count(),
        dim: vs.dim,
        provider: vs.provider,
        model: vs.model,
        ok: vs.count() > 0,
      },
    });
  });


  // ── Watch mode ───────────────────────────────────────────────────────────
  let watcher = null;
  // Watch always re-ingests every Symphonee-managed repo on each tick. Mind
  // is meant to span all connected projects.
  const triggerIncrementalUpdate = async (trigger) => {
    const space = getSpace();
    const jobId = makeJobId();
    // trigger can be an array of changed file paths (file watcher) OR an
    // object { knowledgeEvent, reasons, nodeIds } (notifyKnowledgeEvent).
    const triggerSummary = Array.isArray(trigger) ? { changedFiles: trigger } : (trigger || {});
    const job = { id: jobId, kind: triggerSummary.knowledgeEvent ? 'knowledge-update' : 'watch-update', space, status: 'running', startedAt: Date.now(), progress: [], trigger: triggerSummary };
    jobs.set(jobId, job);
    try {
      const result = await engine.runBuild({
        repoRoot, space,
        sources: DEFAULT_BUILD_SOURCES,
        incremental: true, ctx,
        onProgress: (msg) => job.progress.push({ ts: Date.now(), msg }),
      });
      job.status = 'completed'; job.completedAt = Date.now(); job.result = result;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'update-complete', jobId, result, trigger: 'watch' } });
    } catch (err) {
      job.status = 'failed'; job.completedAt = Date.now(); job.error = err.message;
    }
  };

  function startWatcher(debounceMs) {
    if (watcher) watcher.stop();
    watcher = new MindWatcher({
      repoRoot, getUiContext: ctx.getUiContext, broadcast,
      debounceMs: typeof debounceMs === 'number' ? debounceMs : 3000,
      onTrigger: triggerIncrementalUpdate,
    });
    watcher.start();
    persistWatchPreference(true);
  }
  function stopWatcher() {
    if (watcher) { watcher.stop(); watcher = null; }
    persistWatchPreference(false);
  }
  function persistWatchPreference(enabled) {
    try {
      const file = path.join(repoRoot, '.symphonee', 'mind', 'watch.json');
      require('fs').mkdirSync(path.dirname(file), { recursive: true });
      require('fs').writeFileSync(file, JSON.stringify({ enabled, savedAt: Date.now() }), 'utf8');
    } catch (_) { /* best-effort */ }
  }
  function readWatchPreference() {
    try {
      const file = path.join(repoRoot, '.symphonee', 'mind', 'watch.json');
      if (!require('fs').existsSync(file)) return null;
      return JSON.parse(require('fs').readFileSync(file, 'utf8'));
    } catch (_) { return null; }
  }

  addRoute('POST', '/api/mind/watch', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const enabled = body.enabled !== false;
    if (!enabled) { stopWatcher(); return json(res, { enabled: false }); }
    startWatcher(body.debounceMs);
    return json(res, { enabled: true, debounceMs: watcher.debounceMs });
  });

  // Watcher is ON by default. Mind is meant to feel continuously alive —
  // every edit, every learning, every conversation should land without
  // anyone having to remember to rebuild. The only way it stays off is if
  // the user explicitly disabled it (watch.json says enabled:false).
  // Defer one tick so the rest of the server (routes, broadcast) is wired.
  setImmediate(() => {
    try {
      const saved = readWatchPreference();
      if (saved && saved.enabled === false) return; // explicit opt-out
      startWatcher();
    } catch (_) { /* best-effort; default-on still applies */ }
  });

  // ── Reflection (dream pass) ──────────────────────────────────────────────
  // Manual trigger: POST /api/mind/reflect { windowHours?, dryRun? }
  addRoute('POST', '/api/mind/reflect', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    try {
      const result = await reflectOnce({
        repoRoot, space,
        windowHours: typeof body.windowHours === 'number' ? body.windowHours : 24,
        dryRun: body.dryRun === true,
      });
      if (result.cardsCreated > 0 && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'reflection-promoted', count: result.cardsCreated, cards: result.cards } });
      }
      return json(res, result);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  });

  // ── Embedding setup (Smart Search) ───────────────────────────────────────
  //
  // /api/mind/embed-status returns what the UI's Settings panel needs to
  // render its current state: which provider is active, whether Ollama is
  // installed/running/has the model, vector count.
  addRoute('GET', '/api/mind/embed-status', async (req, res) => {
    refreshEmbedKeys();
    const space = getSpace();
    let vectorCount = 0, vectorDim = 0;
    try {
      const vs = new VectorStore(repoRoot, space);
      vs.load();
      vectorCount = vs.count();
      vectorDim = vs.dim;
    } catch (_) {}
    // Live probe of Ollama (forced — bypasses the 5min cache so the UI
    // always sees current state when the user opens Settings).
    try { await embeddings.refreshOllamaStatus({ force: true }); } catch (_) {}
    try { await llm.refreshChatStatus({ force: true }); } catch (_) {}
    const detect = await ollamaSetup.detect({
      model: embeddings.OLLAMA_DEFAULT_MODEL,
      chatModel: ollamaSetup.DEFAULT_CHAT_MODEL,
    });
    const provider = embeddings.pickProvider();
    return json(res, {
      activeProvider: provider || 'bm25',   // ollama | bm25 (cloud never picked)
      ollama: {
        installed: detect.installed,
        installPath: detect.installPath,
        running: detect.running,
        modelInstalled: detect.modelInstalled,
        model: detect.model,
        models: detect.models,
      },
      chat: {
        modelInstalled: detect.chatModelInstalled,
        preferredModel: detect.preferredChat,
        defaultModel: detect.chatModel,
        installedChatModels: detect.chatModels,
      },
      vectors: { count: vectorCount, dim: vectorDim },
      downloadUrl: 'https://ollama.com/download',
    });
  });

  // Shared setup pipeline used by both the auto-bootstrap and the manual
  // /api/mind/embed-setup route. Idempotent. Returns a result describing
  // the final state. Every progress beat fires as a `mind-update` event
  // with kind:'embed-setup' so any subscribed UI can render it.
  let _embedSetupRunning = false;
  async function runEmbedSetup({ model, source = 'manual' } = {}) {
    if (_embedSetupRunning) return { ok: false, reason: 'already-running' };
    _embedSetupRunning = true;
    const m = model || embeddings.OLLAMA_DEFAULT_MODEL;
    const space = getSpace();
    const step = (kind, payload = {}) => {
      if (!broadcast) return;
      broadcast({ type: 'mind-update', payload: { kind: 'embed-setup', step: kind, source, ...payload } });
    };
    try {
      step('detect', {});
      let detect = await ollamaSetup.detect({ model: m });
      if (!detect.installed) {
        step('needs-install', { downloadUrl: 'https://ollama.com/download' });
        return { ok: false, reason: 'needs-install' };
      }
      if (!detect.running) {
        step('launching', { installPath: detect.installPath });
        const launch = await ollamaSetup.ensureRunning({ installPath: detect.installPath });
        if (!launch.ok) { step('launch-failed', launch); return { ok: false, reason: 'launch-failed' }; }
        detect = await ollamaSetup.detect({ model: m });
      }
      if (!detect.modelInstalled) {
        step('pulling-model', { model: m });
        const pull = await ollamaSetup.ensureModel({ model: m, broadcast });
        if (!pull.ok) { step('pull-failed', pull); return { ok: false, reason: 'pull-failed' }; }
      }
      // Vector store is provider-specific (OpenAI=1536, Ollama=768).
      // Switching providers means dropping the old store before the
      // rebuild — engine.refreshEmbeddings expects an empty store when
      // initialising with a new provider.
      step('dropping-old-vectors', {});
      try {
        const vs = new VectorStore(repoRoot, space);
        if (vs.load() && vs.provider !== 'ollama') vs.drop();
      } catch (_) { /* nothing to drop */ }
      await embeddings.refreshOllamaStatus({ force: true });
      step('rebuilding-vectors', { provider: 'ollama' });
      const g = store.loadGraph(repoRoot, space);
      if (!g) { step('done', { reason: 'no-graph', vectorCount: 0 }); return { ok: true, vectorCount: 0 }; }
      try {
        await engine.refreshEmbeddings({
          repoRoot, space, graph: g,
          ctx: { embedProvider: 'ollama' },
          onProgress: (msg) => step('embed-progress', { msg }),
        });
      } catch (e) {
        step('embed-failed', { error: e.message });
        return { ok: false, reason: 'embed-failed', error: e.message };
      }
      step('done', { provider: 'ollama' });
      return { ok: true, provider: 'ollama' };
    } catch (e) {
      step('error', { error: e.message });
      return { ok: false, reason: 'error', error: e.message };
    } finally {
      _embedSetupRunning = false;
    }
  }

  // /api/mind/embed-setup is now a thin wrapper over runEmbedSetup so
  // the user can still trigger it explicitly (recovery / diagnostics).
  // The same pipeline runs automatically on boot — see autoBootstrap below.
  addRoute('POST', '/api/mind/embed-setup', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    json(res, { ok: true, started: true, model: body.model || embeddings.OLLAMA_DEFAULT_MODEL });
    runEmbedSetup({ model: body.model, source: 'manual' }).catch(() => {});
  });

  // Auto-bootstrap: every boot, Mind tries to make local embeddings work
  // without anyone clicking anything. Silent unless something needs the
  // user — and even then it's a passive UI hint, not a modal.
  //
  // States:
  //   - Ollama installed + running + model pulled + vectors match    -> nothing to do
  //   - Ollama installed but not running                              -> launch
  //   - Ollama running but model missing                              -> pull
  //   - Vector store has wrong provider/dim                           -> drop + rebuild
  //   - Ollama not installed                                          -> emit `needs-install` hint, exit
  //
  // After the initial bootstrap, the heal watchdog (every 5min) keeps
  // filling in vectors for new nodes — no further intervention needed.
  async function autoBootstrapEmbeddings() {
    try {
      const space = getSpace();
      const m = embeddings.OLLAMA_DEFAULT_MODEL;
      const chatM = ollamaSetup.DEFAULT_CHAT_MODEL;
      const detect = await ollamaSetup.detect({ model: m, chatModel: chatM });
      if (!detect.installed) {
        if (broadcast) broadcast({
          type: 'mind-update',
          payload: { kind: 'embed-setup', step: 'needs-install', source: 'auto', downloadUrl: 'https://ollama.com/download' },
        });
        return;
      }
      // Embedding side: rebuild only when there's nothing usable yet OR
      // the store belongs to a different provider. Heal watchdog handles
      // ongoing backfill, so we don't touch the store when it's healthy.
      let needsRebuild = false;
      try {
        const vs = new VectorStore(repoRoot, space);
        if (!vs.load() || vs.count() === 0 || vs.provider !== 'ollama') needsRebuild = true;
      } catch (_) { needsRebuild = true; }
      if (!detect.running || !detect.modelInstalled || needsRebuild) {
        await runEmbedSetup({ model: m, source: 'auto' });
      } else {
        await embeddings.refreshOllamaStatus({ force: true });
      }
      // Chat-model side: silently pull the reflection model if no chat
      // model is installed yet. This is the "humanless" pull — the user
      // never has to know it happened. ensureRunning was already handled
      // above so we know Ollama is alive at this point.
      const postEmbedDetect = await ollamaSetup.detect({ model: m, chatModel: chatM });
      if (postEmbedDetect.running && !postEmbedDetect.chatModelInstalled) {
        if (broadcast) broadcast({
          type: 'mind-update',
          payload: { kind: 'embed-setup', step: 'pulling-chat-model', source: 'auto', model: chatM },
        });
        const pull = await ollamaSetup.ensureModel({ model: chatM, broadcast });
        if (pull.ok) {
          if (broadcast) broadcast({
            type: 'mind-update',
            payload: { kind: 'embed-setup', step: 'chat-model-ready', source: 'auto', model: chatM },
          });
          await llm.refreshChatStatus({ force: true });
        }
      } else if (postEmbedDetect.chatModelInstalled) {
        await llm.refreshChatStatus({ force: true });
      }
    } catch (e) {
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-setup', step: 'error', source: 'auto', error: e.message } });
    }
  }
  // Run shortly after boot so other subsystems (broadcast, watcher,
  // schedulers) are wired before any progress events start firing.
  if (!ctx._autoBootstrapStarted) {
    ctx._autoBootstrapStarted = true;
    setTimeout(() => { autoBootstrapEmbeddings().catch(() => {}); }, 3_500);
    // Retry every 30 min in case Ollama becomes available later (e.g.
    // user installed it without restarting Symphonee).
    setInterval(() => { autoBootstrapEmbeddings().catch(() => {}); }, 30 * 60 * 1000).unref();
  }

  // ── Self-healing watchdog ────────────────────────────────────────────────
  // Manual trigger: POST /api/mind/heal { skipEmbed?, maxNodes? }
  addRoute('POST', '/api/mind/heal', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    try {
      const result = await healOnce({
        repoRoot, space, getAiApiKeys,
        opts: { skipEmbed: body.skipEmbed === true, maxNodes: body.maxNodes },
      });
      if (result.healed > 0 && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'self-healed', healed: result.healed, findings: result.findings } });
      }
      return json(res, result);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  });

  // ── Proactive insights ────────────────────────────────────────────────
  //
  // Insights run all four analysers, dedupe via signature, persist as
  // kind:insight graph nodes. The scheduler fires hourly (or on the
  // continuous-learning cadence) and also after save-result for fast
  // signals like repeated-question.

  async function generateInsights({ source = 'manual', categories } = {}) {
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const enabled = !categories || categories.length === 0
      ? ['repeated-question', 'co-edit', 'memory-decay', 'cross-repo', 'memory-staleness', 'memory-contradiction']
      : categories;
    const candidates = [];
    if (enabled.includes('repeated-question')) {
      try { candidates.push(...await repeatedQuestionAnalyser.detect({ repoRoot, space })); } catch (e) { console.warn('[insights/A]', e.message); }
    }
    if (enabled.includes('co-edit')) {
      try { candidates.push(...await coEditAnalyser.detect({ getUiContext })); } catch (e) { console.warn('[insights/B]', e.message); }
    }
    if (enabled.includes('memory-decay')) {
      try { candidates.push(...memoryDecayAnalyser.detect({ repoRoot, space })); } catch (e) { console.warn('[insights/C]', e.message); }
    }
    if (enabled.includes('cross-repo')) {
      try { candidates.push(...await crossRepoAnalyser.detect({ repoRoot, space })); } catch (e) { console.warn('[insights/D]', e.message); }
    }
    if (enabled.includes('memory-staleness')) {
      try { candidates.push(...memoryStalenessAnalyser.detect({ repoRoot, space, getUiContext, getAllRepos: ctx.getAllRepos })); } catch (e) { console.warn('[insights/E]', e.message); }
    }
    if (enabled.includes('memory-contradiction')) {
      try { candidates.push(...memoryContradictionAnalyser.detect({ repoRoot, space })); } catch (e) { console.warn('[insights/F]', e.message); }
    }
    const added = [];
    for (const spec of candidates) {
      try {
        const r = await insights.addInsight({ repoRoot, space, spec });
        if (!r.deduped) added.push(r.node);
      } catch (e) { console.warn('[insights/add]', e.message); }
    }
    if (added.length && broadcast) {
      broadcast({ type: 'mind-update', payload: { kind: 'insights-generated', source, count: added.length, ids: added.map(n => n.id) } });
    }
    return { ok: true, generated: added.length, candidates: candidates.length, source };
  }


  // Hourly scheduler. Reuses the same idle/continuous cadence the
  // reflection cycle uses so users only have to think about one knob.
  function startInsightsScheduler() {
    const TICK_MS = 60 * 1000;
    const HOURLY_MS = 60 * 60 * 1000;
    const CONTINUOUS_MS = 15 * 60 * 1000; // less aggressive than reflection
    let lastRun = 0;
    let running = false;
    const tick = async () => {
      if (running) return;
      let cfg = {};
      try { cfg = getConfig ? getConfig() : {}; } catch (_) {}
      const continuous = cfg.EnableContinuousLearning === true;
      const since = Date.now() - lastRun;
      if (!(since >= (continuous ? CONTINUOUS_MS : HOURLY_MS))) return;
      running = true;
      try {
        await generateInsights({ source: continuous ? 'continuous' : 'hourly' });
        lastRun = Date.now();
      } catch (e) {
        console.warn('[insights/scheduler]', e.message);
      } finally { running = false; }
    };
    const timer = setInterval(tick, TICK_MS);
    const boot = setTimeout(() => { tick().catch(() => {}); }, 45_000);
    return () => { clearInterval(timer); clearTimeout(boot); };
  }

  // Start the background reflection + healing + insights loops. All
  // are cheap when nothing's wrong (a few filesystem stats per tick);
  // expensive only when there's actual work. Idempotent if mountMind
  // is called twice (would never happen in production but keeps tests
  // sane).
  if (!ctx._schedulersStarted) {
    ctx._schedulersStarted = true;
    startReflectionScheduler({ repoRoot, getSpace, getConfig, getLastEventAt, broadcast });
    startHealingScheduler({ repoRoot, getSpace, getAiApiKeys, broadcast });
    startInsightsScheduler();
  }

  // ── Memory integrity: health + on-demand audit ───────────────────────────
  // health is a cheap read (counts + a staleness scan) surfaced in bootstrap so
  // every CLI sees brain quality at login. audit runs the memory analysers and
  // persists findings as insights (the same surface the scheduler feeds).
  function _memoryHealth() {
    const space = getSpace();
    let total = 0, archived = 0, unreferenced = 0;
    try {
      const g = store.loadGraph(repoRoot, space);
      const mem = (g && g.nodes || []).filter((n) => n.kind === 'memory');
      archived = mem.filter((n) => n.status === 'archived').length;
      const live = mem.filter((n) => n.status !== 'archived');
      total = live.length;
      unreferenced = live.filter((n) => !Array.isArray(n.referencedAt) || n.referencedAt.length === 0).length;
    } catch (_) {}
    let stale = [];
    try { stale = memoryStalenessAnalyser.scan({ repoRoot, space, getUiContext, getAllRepos: ctx.getAllRepos }).stale || []; } catch (_) {}
    return {
      ok: stale.length === 0,
      memories: total,
      archived,
      unreferenced,
      stale: stale.length,
      staleSamples: stale.slice(0, 5).map((s) => ({ id: s.id, label: s.label, missing: s.missing })),
      ranAt: new Date().toISOString(),
    };
  }

  // Lightweight, graph-only health for the bootstrap field (no disk walk). It
  // reflects integrity findings the scheduler / audit already surfaced as
  // pending insights, so every CLI sees brain quality at login without paying
  // a filesystem scan on each bootstrap.
  function _miniHealth(g) {
    if (!g || !Array.isArray(g.nodes)) return null;
    const mem = g.nodes.filter((n) => n.kind === 'memory');
    const live = mem.filter((n) => n.status !== 'archived');
    const pending = g.nodes.filter((n) => n.kind === 'insight' && n.status === 'pending' && (n.category === 'memory-staleness' || n.category === 'memory-contradiction'));
    const flagged = new Set();
    pending.forEach((i) => (i.evidence || []).forEach((id) => flagged.add(id)));
    return {
      memories: live.length,
      archived: mem.length - live.length,
      unreferenced: live.filter((n) => !Array.isArray(n.referencedAt) || !n.referencedAt.length).length,
      flagged: flagged.size,
      pendingIntegrityInsights: pending.length,
      ok: flagged.size === 0,
      auditUrl: '/api/mind/audit',
      healthUrl: '/api/mind/health',
    };
  }
  ctx._miniHealth = _miniHealth;

  addRoute('GET', '/api/mind/health', (req, res) => {
    try { return json(res, _memoryHealth()); } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  });

  addRoute('POST', '/api/mind/audit', async (req, res) => {
    try {
      const r = await generateInsights({ source: 'audit', categories: ['memory-staleness', 'memory-decay', 'memory-contradiction'] });
      return json(res, { ...r, health: _memoryHealth() });
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  });

  // Expose for the bootstrap composer (see /api/bootstrap) without re-querying.
  ctx._memoryHealth = _memoryHealth;

  addRoute('GET', '/api/mind/watch', (req, res) => {
    return json(res, { enabled: !!(watcher && watcher._enabled) });
  });


  // ── Delete (purge a hallucinated node) ───────────────────────────────────
  addRoute('DELETE', '/api/mind/node', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = body.id;
    if (!id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'no graph' }, 404);
    const before = g.nodes.length;
    g.nodes = g.nodes.filter(n => n.id !== id);
    g.edges = g.edges.filter(e => e.source !== id && e.target !== id);
    if (g.nodes.length === before) return json(res, { error: 'not found' }, 404);
    persistDerivedGraph(space, g);
    return json(res, { ok: true, removed: id });
  });

  // ── Extracted route groups (decoupled reads/IO; see routes-*.js) ─────────
  const routeDeps = { repoRoot, getSpace, getUiContext, readBody, ctx, tryDenseSeeds, jobs, persistDerivedGraph, notifyKnowledgeEvent, broadcast, generateInsights, makeJobId, DEFAULT_BUILD_SOURCES };
  require('./routes-graph-detail').register(addRoute, json, routeDeps);
  require('./routes-code-intel').register(addRoute, json, routeDeps);
  require('./routes-artifacts').register(addRoute, json, routeDeps);
  require('./routes-layout').register(addRoute, json, routeDeps);
  require('./routes-graph-reads').register(addRoute, json, routeDeps);
  require('./routes-diagnostics').register(addRoute, json, routeDeps);
  require('./routes-knowledge').register(addRoute, json, routeDeps);
  require('./routes-insights').register(addRoute, json, routeDeps);
  require('./routes-builds').register(addRoute, json, routeDeps);

  return {
    // For the bootstrap composer
    bootstrapField() {
      const space = getSpace();
      const stats = store.statsFor(repoRoot, space);
      const ui = getUiContext ? getUiContext() : {};
      // L0+L1 wake-up text bundled with the bootstrap so every CLI gets the
      // identity + essential-story tier without a follow-up call. Cheap (no
      // I/O beyond the graph file already cached + an optional CLAUDE.md
      // read) and capped to ~600 tokens. CLIs that want depth use
      // /api/mind/query as before.
      let wakeup = null;
      // Active repo's focused knowledge spec, bundled so EVERY CLI session --
      // including a user talking to it directly -- opens already grounded in the
      // current project, not just dispatched workers. Reuses the graph already
      // loaded for the wake-up (no extra I/O) and is capped small (~300 tokens,
      // grouped by kind) so it stays concrete and token-cheap. Only ships when
      // the active repo actually has connected knowledge beyond its own node.
      let spec = null;
      let healthField = null;
      if (stats) {
        try {
          const g = store.loadGraph(repoRoot, space);
          if (g) {
            try { healthField = _miniHealth(g); } catch (_) {}
            wakeup = composeWakeUp(g, {
              activeRepo: ui.activeRepo, activeRepoPath: ui.activeRepoPath, space,
              budgetTokens: 600,
              repoRoot,
            });
            if (ui.activeRepo) {
              try {
                const ex = kit.exportKit(g, { topic: ui.activeRepo, maxNodes: 120, maxDepth: 2 });
                if (ex.ok && ex.kit && ex.kit.stats && ex.kit.stats.nodes > 1) {
                  spec = {
                    anchor: ui.activeRepo,
                    stats: ex.kit.stats,
                    digest: kit.specDigest(ex.kit, { anchor: ui.activeRepo, maxChars: 1200, perKind: 6 }),
                  };
                }
              } catch (_) { /* spec is best-effort; bootstrap still ships without it */ }
            }
          }
        } catch (_) { /* graph corrupt - skip wake-up, bootstrap still ships */ }
      }
      // Vector store presence: cheap (one filesystem stat) but skipped if
      // the graph is empty since vectors require a graph.
      let vectorsField = null;
      if (stats) {
        try {
          const vs = new VectorStore(repoRoot, space);
          vs.load();
          vectorsField = {
            enabled: vs.count() > 0,
            count: vs.count(),
            dim: vs.dim,
            provider: vs.provider,
            model: vs.model,
          };
        } catch (_) { /* ignore */ }
      }
      return {
        enabled: !!stats,
        scope: { space, isGlobal: false },
        graphStats: stats || null,
        wakeup,
        spec,
        health: healthField,
        vectors: vectorsField,
        instructionsUrl: '/api/mind/instructions',
        queryUrl: '/api/mind/query',
        wakeupUrl: '/api/mind/wakeup',
        message: stats
          ? 'A shared knowledge graph exists for this space. For questions about CODE STRUCTURE call POST /api/mind/query. For questions about PRIOR WORK / PAST DECISIONS / WHAT DID WE FIGURE OUT call POST /api/mind/recall (returns memory cards + conversations ranked by topic + recency). When the user TEACHES you something durable ("remember:", "we decided", "always X", "never Y", "X has different Y", "prefer X", "watch out for"), call POST /api/mind/teach BEFORE answering — that is how the AI gets smarter across sessions. Save findings from regular Q&A via POST /api/mind/save-result, which also auto-extracts memory cards from teaching language in your answer.'
          : 'Mind graph is empty for this space. Run POST /api/mind/build to populate it.',
      };
    },

    // For orchestrator: invoked once per task completion, saves the result as
    // a conversation node so every future CLI (including the worker that
    // produced it) can find it via /api/mind/query.
    saveTaskToMind(task) {
      if (!task || !task.result) return;
      const space = (task.space || getSpace()) || '_global';
      let g = store.loadGraph(repoRoot, space) || store.emptyGraph({ space });
      const id = `task_${task.id}`;
      if (g.nodes.find(n => n.id === id)) return; // idempotent: already saved
      const promptSnippet = (typeof task.prompt === 'string' ? task.prompt : '').slice(0, 300);
      g.nodes.push({
        id, label: sanitizeLabel((promptSnippet || `${task.cli} task`).slice(0, 120)),
        kind: 'conversation',
        source: { type: 'orchestrator-task', ref: task.id, cli: task.cli, model: task.model },
        sourceLocation: null,
        createdBy: task.cli || 'orchestrator',
        createdAt: new Date(task.completedAt || Date.now()).toISOString(),
        tags: ['conversation', task.cli, task.from || ''].filter(Boolean),
        prompt: promptSnippet,
        result: sanitizeLabel(String(task.result).slice(0, 4000)),
      });
      // Tag with CLI so all per-CLI conversations cluster together.
      const cliId = `cli_${task.cli || 'unknown'}`;
      if (!g.nodes.find(n => n.id === cliId)) {
        g.nodes.push({
          id: cliId, label: sanitizeLabel(task.cli || 'unknown'), kind: 'tag',
          source: { type: 'cli', ref: task.cli }, sourceLocation: null,
          createdBy: 'mind/orchestrator-hook', createdAt: new Date().toISOString(), tags: [],
        });
      }
      g.edges.push({
        source: id, target: cliId, relation: 'tagged_with',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy: task.cli || 'orchestrator', createdAt: new Date().toISOString(),
      });
      try { persistDerivedGraph(space, g); } catch (_) { /* schema validation failure - non-fatal */ }
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'node-added', id, createdBy: task.cli } });
      notifyKnowledgeEvent({ kind: 'task-saved', nodeIds: [id], reason: 'orchestrator-task' });
    },

    // Public knowledge-event hook. Anything outside Mind that adds graph
    // state (learnings, notes, plugins) calls this so the brain reacts.
    notifyKnowledgeEvent,

    // For orchestrator: hint injected as prefix into dispatched prompts.
    //
    // Two-tier output:
    //   - Always: a one-line metadata stamp + query/save instructions.
    //   - When the graph has god nodes or recent conversations: append the
    //     L0+L1 wake-up (~400-700 tokens) so the worker starts with identity
    //     + essential-story context without making a /api/mind/wakeup call.
    //
    // The worker is still expected to call /api/mind/query for anything
    // specific - the hint is the wake-up, not the answer.
    // Run an incremental refresh on app startup so every session begins
    // with a fresh graph (new files since last shutdown, new app/site
    // recipes, new memory bullets). Fires a 'mind-startup-refresh' WS
    // event with phase: started | done | error so the UI can toast.
    // Idempotent: if a build is already in progress, this is a no-op.
    // Best-effort regeneration of the splash/boot-overlay quote pool from the
    // current Mind graph. Called by the deferred boot work after the graph
    // refresh, so the next boot shows fresh, personal quotes. Fail-soft.
    async regenerateSplashQuotes() {
      const space = getSpace();
      return splashQuotes.regenerate({ repoRoot, space, store, broadcast });
    },

    async kickoffStartupRefresh() {
      const space = getSpace();
      const acq = lock.acquire(space, 'graph');
      if (!acq.ok) {
        // A build is already running (likely the auto-resumed watcher).
        // Treat as success so the UI doesn't toast a stale error.
        if (broadcast) broadcast({ type: 'mind-startup-refresh', payload: { phase: 'skipped', reason: 'build already in progress', space } });
        return { ok: false, skipped: true, reason: 'busy' };
      }
      lock.release(space, 'graph');
      const startedAt = Date.now();
      if (broadcast) broadcast({ type: 'mind-startup-refresh', payload: { phase: 'started', space, startedAt } });
      try {
        const result = await engine.runBuild({
          repoRoot, space,
          sources: DEFAULT_BUILD_SOURCES,
          incremental: true,
          ctx,
          onProgress: () => { /* progress is internal; the UI just wants the toast */ },
        });
        if (broadcast) broadcast({
          type: 'mind-startup-refresh',
          payload: {
            phase: 'done', space,
            durationMs: Date.now() - startedAt,
            stats: store.statsFor(repoRoot, space),
            sources: Object.keys(result && result.sources ? result.sources : {}),
          },
        });
        return { ok: true, durationMs: Date.now() - startedAt };
      } catch (e) {
        if (broadcast) broadcast({ type: 'mind-startup-refresh', payload: { phase: 'error', space, error: e.message } });
        return { ok: false, error: e.message };
      }
    },

    // Run the startup refresh, then wait until the graph build lock is actually
    // free before declaring startup settled. This is what the boot overlay gates
    // on. The lock wait is the key: when kickoffStartupRefresh is 'skipped'
    // (another build -- e.g. the watcher's auto-resume -- already holds the
    // lock), we still wait for THAT build to finish, so the dashboard is not
    // revealed mid-build. Capped so it can never hang the reveal forever.
    async awaitStartupSettle() {
      if (_startupTriggered) return { ok: true, already: true };
      _startupTriggered = true;
      const space = getSpace();
      try { await this.kickoffStartupRefresh(); } catch (_) { /* settle regardless */ }
      const deadline = Date.now() + 30000;
      for (;;) {
        let building = false;
        try { building = !!(lock.status(space, 'graph') || {}).locked; } catch (_) {}
        if (!building || Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 300));
      }
      _startupSettled = true;
      if (broadcast) broadcast({ type: 'mind-startup-refresh', payload: { phase: 'settled', space } });
      return { ok: true };
    },

    orchestratorHint(opts = {}) {
      const space = getSpace();
      const stats = store.statsFor(repoRoot, space);
      if (!stats) return `[mind: ${space} empty]`;
      const ageMin = Math.round((Date.now() - new Date(stats.lastBuildAt).getTime()) / 60000);
      const stamp = `[mind: ${space} nodes=${stats.nodes} edges=${stats.edges} communities=${stats.communities} staleness=${ageMin}m] Query before answering: POST http://127.0.0.1:3800/api/mind/query {"question":"..."}. Save findings: POST /api/mind/save-result {"question","answer","citedNodeIds"}.`;
      // Apps + sites awareness: enumerate which apps and which sites have
      // automations indexed and how many are verified. Lets the dispatched
      // worker know up front that a recipe path exists without re-querying.
      // Two short lines, zero call cost.
      let appsLine = '';
      let sitesLine = '';
      try {
        const g = store.loadGraph(repoRoot, space);
        if (g && Array.isArray(g.nodes)) {
          const byApp = new Map();
          const bySite = new Map();
          for (const n of g.nodes) {
            if (n.kind !== 'recipe' || !Array.isArray(n.tags)) continue;
            if (n.tags.includes('app-automation')) {
              const appTag = n.tags.find(t => t !== 'app-automation' && t !== 'verified' && t !== 'draft' && t !== 'archived');
              if (appTag) {
                const slot = byApp.get(appTag) || { total: 0, verified: 0 };
                slot.total++;
                if (n.tags.includes('verified')) slot.verified++;
                byApp.set(appTag, slot);
              }
            }
            if (n.tags.includes('site-automation')) {
              const siteTag = n.tags.find(t => t !== 'site-automation' && t !== 'verified' && t !== 'draft' && t !== 'archived');
              if (siteTag) {
                const slot = bySite.get(siteTag) || { total: 0, verified: 0 };
                slot.total++;
                if (n.tags.includes('verified')) slot.verified++;
                bySite.set(siteTag, slot);
              }
            }
          }
          if (byApp.size) {
            const summary = [...byApp.entries()].slice(0, 8).map(([a, s]) => `${a}=${s.verified}/${s.total}`).join(' ');
            appsLine = `\n[apps: ${summary}] Use POST /api/apps/do { app, goal } to drive desktop apps; verified recipes replay without LLM tokens.`;
          }
          if (bySite.size) {
            const summary = [...bySite.entries()].slice(0, 8).map(([h, s]) => `${h}=${s.verified}/${s.total}`).join(' ');
            sitesLine = `\n[sites: ${summary}] Use POST /api/browser/router/run { goal, url } to drive websites; verified site recipes replay without LLM tokens.`;
          }
        }
      } catch (_) {}
      // Concatenate so legacy callers that read appsLine alone still work.
      appsLine = appsLine + sitesLine;
      if (opts.minimal) return stamp + appsLine;
      try {
        const g = store.loadGraph(repoRoot, space);
        if (!g) return stamp + appsLine;
        const ui = getUiContext ? getUiContext() : {};
        const wake = composeWakeUp(g, {
          activeRepo: ui.activeRepo, activeRepoPath: ui.activeRepoPath, space,
          budgetTokens: opts.budgetTokens || 600,
          question: opts.question || '',
          repoRoot,
        });
        // Inline the active repo's focused spec digest so a dispatched worker
        // starts already grounded in the current project's knowledge -- no
        // round-trip, no need to know the repo's name. This is the "you'll know
        // by default" path: the same bounded sub-graph the Specs UI shows,
        // distilled to a compact, readable block.
        let specLine = '';
        try {
          if (ui.activeRepo) {
            const ex = kit.exportKit(g, { topic: ui.activeRepo, maxNodes: 120, maxDepth: 2 });
            if (ex.ok) {
              const digest = kit.specDigest(ex.kit, { anchor: ui.activeRepo, maxChars: 1400, perKind: 6 });
              if (digest) specLine = `\n\n[spec: ${ui.activeRepo}] Focused knowledge for the active project (already grounded -- query Mind only for what is missing here):\n${digest}`;
            }
          }
        } catch (_) {}
        return `${stamp}${appsLine}\n\n${wake.text}${specLine}`;
      } catch (_) {
        return stamp + appsLine;
      }
    },
  };
}

module.exports = { mountMind };
