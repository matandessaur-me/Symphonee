/**
 * Reflection cycle — Mind's "dream pass."
 *
 * Mind reactively ingests everything that happens (file edits, conversations,
 * learnings, teaching). Reflection is the layer on top: a periodic scan over
 * recent activity that LOOKS FOR PATTERNS and promotes them to durable memory
 * cards. This is the difference between "remembering everything" and
 * "becoming smarter."
 *
 * What it does each pass:
 *   1. Pull conversations + drawers + auto-extracted memories from the last
 *      `windowHours` (default 24h, configurable).
 *   2. Cluster their labels/answers by simple token-overlap.
 *   3. For any cluster with >= MIN_CLUSTER_SIZE items that doesn't already
 *      have a covering memory card, promote it to a `lesson` or `pattern`
 *      card with `createdBy: "mind/reflection"`.
 *   4. Idempotent: re-running won't duplicate cards (memory.addMemoryCard
 *      already content-hashes).
 *
 * Trigger modes:
 *   - idle:        run when no knowledge event has fired for IDLE_MS
 *                  (default 10 minutes). Cheap, organic feel.
 *   - hourly:      run at most once per hour regardless of idle state, so
 *                  reflection still happens during sustained activity.
 *   - continuous:  shorter cadence (default 5 minutes). User opts in via
 *                  the EnableContinuousLearning setting.
 *
 * The schedule is a single tick that decides which mode applies based on
 * config + last-event timestamp. We don't run heavy work on a hot path.
 */

'use strict';

const store = require('./store');
const memoryModule = require('./memory');
const llm = require('./llm');

const MIN_CLUSTER_SIZE = 3;
const MAX_CARDS_PER_PASS = 4;
// Hard cap on LLM calls per reflection pass. The reflection scheduler
// can fire as often as every 5 min in continuous mode; with each LLM
// judgement taking 1-2s on a 1.5b model, an unbounded pass on a wide
// window could chew up minutes of GPU time. Sorting clusters by item
// count first means we always judge the most-plausible-pattern clusters
// first within this budget.
const MAX_CLUSTERS_JUDGED = 10;
const VALID_MEMORY_KINDS = new Set([
  'decision', 'preference', 'constraint',
  'lesson', 'gotcha', 'pattern', 'fact',
]);
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'into', 'about',
  'when', 'what', 'where', 'which', 'while', 'will', 'your', 'their', 'they',
  'are', 'was', 'were', 'been', 'being', 'has', 'had', 'not', 'but', 'you',
  'how', 'why', 'who', 'can', 'cant', 'cannot', 'should', 'would', 'could',
  'just', 'like', 'one', 'two', 'use', 'used', 'using', 'all', 'any', 'some',
  'now', 'then', 'than', 'also', 'over', 'under', 'after', 'before',
]);

function _tokens(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t && t.length >= 4 && !STOPWORDS.has(t));
}

function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function _clusterNodes(nodes, threshold = 0.35) {
  // Tiny greedy clusterer. For each unclustered node, find the best-overlap
  // cluster; if it beats `threshold`, join; otherwise start a new cluster.
  const items = nodes.map(n => ({
    node: n,
    tokens: new Set(_tokens(`${n.label || ''} ${n.body || n.answer || ''}`)),
  }));
  const clusters = [];
  for (const item of items) {
    if (item.tokens.size < 3) continue; // too thin to cluster
    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      const score = _jaccard(item.tokens, c.tokens);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && bestScore >= threshold) {
      best.items.push(item);
      for (const t of item.tokens) best.tokens.add(t);
    } else {
      clusters.push({ items: [item], tokens: new Set(item.tokens) });
    }
  }
  return clusters;
}

function _topTokens(tokens, k = 6) {
  // Surface the most-distinct tokens. We approximate distinctiveness by
  // token length (longer = more likely to be a specific concept than a
  // common stopword that slipped through).
  return Array.from(tokens).sort((a, b) => b.length - a.length).slice(0, k);
}

function _existingCardCovers(memCards, tokens) {
  // Check if any existing memory card already mentions enough of these
  // tokens that promoting another card would just be noise.
  for (const card of memCards) {
    const cardTokens = new Set(_tokens(`${card.label || ''} ${card.body || ''}`));
    if (_jaccard(cardTokens, tokens) >= 0.5) return true;
  }
  return false;
}

// Mechanical fallback card composer. Only used when no chat model is
// available. The LLM-driven path (below) produces much better cards.
function _composeCardFallback(cluster) {
  const sortedItems = cluster.items
    .slice()
    .sort((a, b) => (b.node.createdAt || '').localeCompare(a.node.createdAt || ''));
  const labels = sortedItems.map(i => (i.node.label || '').trim()).filter(Boolean);
  const sample = labels[0] || 'recurring theme';
  const tokenList = _topTokens(cluster.tokens, 5);
  const title = `Recurring theme: ${sample}`.slice(0, 180);
  const body = [
    `Mind noticed this pattern across ${sortedItems.length} recent items in the last reflection window.`,
    '',
    'Anchor tokens: ' + tokenList.join(', '),
    '',
    'Sources:',
    ...sortedItems.slice(0, 6).map(i => `  - [${i.node.kind}] ${(i.node.label || i.node.id || '').slice(0, 100)}`),
  ].join('\n');
  return {
    title,
    body,
    kindOfMemory: 'pattern',
    tags: tokenList,
    createdBy: 'mind/reflection',
  };
}

// Build the chat prompt that asks the local LLM to decide whether a
// cluster is a real recurring theme vs coincidental token overlap, and
// to write a clean memory card if it is. Output is forced to JSON via
// Ollama's format:'json' flag so we always get a parseable object.
function _buildClusterPrompt(cluster) {
  const sortedItems = cluster.items
    .slice()
    .sort((a, b) => (b.node.createdAt || '').localeCompare(a.node.createdAt || ''));
  const itemLines = sortedItems.slice(0, 10).map((item, idx) => {
    const n = item.node;
    const kind = n.kind || 'item';
    const label = (n.label || '').replace(/\s+/g, ' ').slice(0, 140);
    const body = (n.body || n.answer || '').replace(/\s+/g, ' ').slice(0, 220);
    return `${idx + 1}. [${kind}] ${label}${body ? '\n   ' + body : ''}`;
  }).join('\n');
  const sys = [
    'You analyze recent items from a developer\'s knowledge graph to decide whether a cluster of items represents a real recurring theme worth promoting to a long-term memory card, or just coincidental vocabulary overlap (filenames, timestamps, generic verbs).',
    '',
    'Real patterns: repeated decisions, recurring constraints, shared workflows, debugging gotchas, design choices that come up more than once.',
    'Coincidence: items that share filename tokens, dates, "run" / "test" / "build" / "ok" / "failed" tokens but no shared meaning.',
    '',
    'Respond with JSON only. No markdown. No prose.',
    '',
    'Schema:',
    '{',
    '  "is_pattern": true | false,',
    '  "title": "<short imperative title under 90 chars>" | null,',
    '  "summary": "<2-3 sentence explanation>" | null,',
    '  "tags": ["tag1", "tag2", ...] | null,',
    '  "kindOfMemory": "lesson" | "pattern" | "decision" | "preference" | "constraint" | "gotcha" | "fact" | null',
    '}',
    '',
    'If is_pattern is false, set the other fields to null.',
  ].join('\n');
  const user = `Here are ${sortedItems.length} items that share vocabulary:\n\n${itemLines}\n\nIs this a real recurring theme?`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

// Send a cluster to the local chat model. Returns `{ ok: true, card }` on
// a real pattern, `{ ok: false, reason: 'coincidence' }` when the LLM
// rejects the cluster, or `{ ok: false, reason: 'no-llm' | 'error' }`
// when the call itself fails. Never throws to the caller.
async function _judgeWithLLM(cluster) {
  if (!llm.pickChatModel()) return { ok: false, reason: 'no-llm' };
  try {
    const messages = _buildClusterPrompt(cluster);
    const res = await llm.chatOllama(messages, { format: 'json', timeoutMs: 25_000, numPredict: 400 });
    const j = res.json || {};
    if (!j.is_pattern) return { ok: false, reason: 'coincidence', model: res.model };
    const sortedItems = cluster.items
      .slice()
      .sort((a, b) => (b.node.createdAt || '').localeCompare(a.node.createdAt || ''));
    const title = String(j.title || '').slice(0, 180).trim();
    const summary = String(j.summary || '').trim();
    if (!title || !summary) return { ok: false, reason: 'empty-fields', model: res.model };
    const kind = VALID_MEMORY_KINDS.has(j.kindOfMemory) ? j.kindOfMemory : 'pattern';
    const tags = Array.isArray(j.tags)
      ? j.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 8)
      : [];
    const body = [
      summary,
      '',
      'Sources:',
      ...sortedItems.slice(0, 6).map(i => `  - [${i.node.kind}] ${(i.node.label || i.node.id || '').slice(0, 100)}`),
    ].join('\n');
    return {
      ok: true,
      card: {
        title,
        body,
        kindOfMemory: kind,
        tags,
        createdBy: 'mind/reflection-llm',
      },
      model: res.model,
    };
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
}

/**
 * Run one reflection pass. Returns a summary of what was promoted.
 *
 * @param {Object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.space
 * @param {number} [opts.windowHours=24]   how far back to look
 * @param {number} [opts.minClusterSize=3]
 * @param {number} [opts.maxCards=4]       cap on cards promoted per pass
 * @param {boolean} [opts.dryRun=false]    don't actually write cards
 */
async function reflectOnce({
  repoRoot, space,
  windowHours = 24,
  minClusterSize = MIN_CLUSTER_SIZE,
  maxCards = MAX_CARDS_PER_PASS,
  dryRun = false,
} = {}) {
  if (!repoRoot || !space) {
    return { ok: false, error: 'repoRoot and space required', clustersChecked: 0, cardsCreated: 0 };
  }
  const g = store.loadGraph(repoRoot, space);
  if (!g || !g.nodes || g.nodes.length === 0) {
    return { ok: true, clustersChecked: 0, cardsCreated: 0, reason: 'empty-graph' };
  }
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const recent = g.nodes.filter(n => {
    if (!n.createdAt) return false;
    const t = Date.parse(n.createdAt);
    if (Number.isNaN(t) || t < since) return false;
    return n.kind === 'conversation' || n.kind === 'drawer' || n.kind === 'memory' || n.kind === 'learning';
  });
  if (recent.length < minClusterSize) {
    return { ok: true, clustersChecked: 0, cardsCreated: 0, reason: 'too-few-recent', recent: recent.length };
  }
  const clusters = _clusterNodes(recent)
    .filter(c => c.items.length >= minClusterSize)
    // Biggest clusters first — they're statistically more likely to be
    // real patterns. Then cap at MAX_CLUSTERS_JUDGED so a wide reflection
    // window never runs the LLM more than ~10 times in one pass.
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, MAX_CLUSTERS_JUDGED);
  if (!clusters.length) {
    return { ok: true, clustersChecked: 0, cardsCreated: 0, reason: 'no-clusters-met-threshold' };
  }
  // Refresh chat-model availability so we know whether to use the LLM
  // judge or fall back to the mechanical title.
  await llm.refreshChatStatus({ force: false });
  const hasLLM = !!llm.pickChatModel();
  const existingMems = g.nodes.filter(n => n.kind === 'memory');
  const created = [];
  let rejected = 0;
  for (const cluster of clusters) {
    if (created.length >= maxCards) break;
    if (_existingCardCovers(existingMems, cluster.tokens)) continue;
    let spec, source;
    if (hasLLM) {
      // LLM path: model decides real-pattern vs coincidence AND writes
      // the card. Junk clusters (Figma recording titles, timestamp-token
      // overlap) get rejected here.
      const verdict = await _judgeWithLLM(cluster);
      if (!verdict.ok) { rejected++; continue; }
      spec = verdict.card;
      source = 'llm';
    } else {
      // Fallback path: no chat model installed yet. Mechanical title
      // from the first item. User sees less-interesting cards until the
      // auto-bootstrap finishes pulling a chat model.
      spec = _composeCardFallback(cluster);
      source = 'fallback';
    }
    if (dryRun) { created.push({ dryRun: true, source, ...spec }); continue; }
    try {
      const r = await memoryModule.addMemoryCard({ repoRoot, space, spec });
      created.push({ id: r.node.id, title: r.node.label, kindOfMemory: r.node.kindOfMemory, source });
    } catch (_) { /* lock contention or schema rejection — skip silently */ }
  }
  return {
    ok: true,
    clustersChecked: clusters.length,
    cardsCreated: created.length,
    cardsRejected: rejected,
    usedLLM: hasLLM,
    cards: created,
    windowHours,
    recentScanned: recent.length,
  };
}

/**
 * Scheduler. Runs forever. Each tick decides whether to call reflectOnce
 * based on config (continuous? idle threshold met?) and last-event time.
 */
function startReflectionScheduler({ repoRoot, getSpace, getConfig, getLastEventAt, broadcast }) {
  const IDLE_MS = 10 * 60 * 1000;       // 10 minutes of quiet -> reflect
  const HOURLY_MS = 60 * 60 * 1000;     // hourly fallback
  const CONTINUOUS_MS = 5 * 60 * 1000;  // continuous mode cadence
  const TICK_MS = 60 * 1000;            // scheduler tick

  let lastReflectAt = 0;
  let running = false;

  const tick = async () => {
    if (running) return;
    let cfg = {};
    try { cfg = getConfig ? getConfig() : {}; } catch (_) {}
    const continuous = cfg.EnableContinuousLearning === true;
    const now = Date.now();
    const lastEventAt = getLastEventAt ? getLastEventAt() : 0;
    const idleFor = now - (lastEventAt || 0);
    const sinceReflect = now - lastReflectAt;

    let shouldRun = false;
    if (continuous && sinceReflect >= CONTINUOUS_MS) shouldRun = true;
    else if (idleFor >= IDLE_MS && sinceReflect >= IDLE_MS) shouldRun = true;
    else if (sinceReflect >= HOURLY_MS) shouldRun = true;
    if (!shouldRun) return;

    running = true;
    try {
      const space = getSpace ? getSpace() : '_global';
      const result = await reflectOnce({ repoRoot, space });
      lastReflectAt = Date.now();
      if (result.cardsCreated > 0 && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'reflection-promoted', count: result.cardsCreated, cards: result.cards } });
      }
    } catch (e) {
      console.warn('[mind/reflect] error:', e.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, TICK_MS);
  // Run an initial tick after 30s so a freshly-started server can promote
  // anything from drawers/conversations that landed during boot.
  const bootTimer = setTimeout(() => { tick().catch(() => {}); }, 30_000);
  return () => { clearInterval(timer); clearTimeout(bootTimer); };
}

module.exports = { reflectOnce, startReflectionScheduler };
