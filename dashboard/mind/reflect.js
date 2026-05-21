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

const MIN_CLUSTER_SIZE = 3;
const MAX_CARDS_PER_PASS = 4;
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

function _composeCard(cluster) {
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
  const clusters = _clusterNodes(recent).filter(c => c.items.length >= minClusterSize);
  if (!clusters.length) {
    return { ok: true, clustersChecked: 0, cardsCreated: 0, reason: 'no-clusters-met-threshold' };
  }
  const existingMems = g.nodes.filter(n => n.kind === 'memory');
  const created = [];
  for (const cluster of clusters) {
    if (created.length >= maxCards) break;
    if (_existingCardCovers(existingMems, cluster.tokens)) continue;
    const spec = _composeCard(cluster);
    if (dryRun) { created.push({ dryRun: true, ...spec }); continue; }
    try {
      const r = await memoryModule.addMemoryCard({ repoRoot, space, spec });
      created.push({ id: r.node.id, title: r.node.label, kindOfMemory: r.node.kindOfMemory });
    } catch (_) { /* lock contention or schema rejection — skip silently */ }
  }
  return {
    ok: true,
    clustersChecked: clusters.length,
    cardsCreated: created.length,
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
