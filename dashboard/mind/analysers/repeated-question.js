/**
 * Repeated-question analyser.
 *
 * Detects when the user has asked similar questions multiple times
 * without an existing memory card covering the topic. Emits an insight
 * suggesting "save this as a memory card."
 *
 * Heuristic:
 *   - Pull recent conversation nodes (save-result, drawer questions)
 *     from the last `windowDays` (default 14).
 *   - Cluster by token overlap on the question label.
 *   - For each cluster of >= MIN_REPEATS items:
 *     - Skip if any existing memory card's tags / body overlaps the
 *       cluster's anchor tokens (already covered).
 *     - Ask the local LLM whether this is a real recurring question
 *       and to suggest a memory-card title + body.
 *     - Emit insight with action: create-memory.
 *
 * Action payload is the full spec ready to POST to /api/mind/teach,
 * so executing the insight is a single call.
 */

'use strict';

const store = require('../store');
const llm = require('../llm');

const MIN_REPEATS = 3;
const MAX_INSIGHTS = 3;
const CLUSTER_THRESHOLD = 0.30;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'into', 'about',
  'when', 'what', 'where', 'which', 'while', 'will', 'your', 'their', 'they',
  'are', 'was', 'were', 'been', 'being', 'has', 'had', 'not', 'but', 'you',
  'how', 'why', 'who', 'can', 'cant', 'cannot', 'should', 'would', 'could',
  'just', 'like', 'one', 'two', 'use', 'used', 'using', 'all', 'any', 'some',
  'now', 'then', 'than', 'also', 'over', 'under', 'after', 'before',
]);

function _tokens(text) {
  if (!text) return [];
  return String(text).toLowerCase().split(/[^a-z0-9_]+/).filter(t => t && t.length >= 4 && !STOPWORDS.has(t));
}

function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function _cluster(items) {
  const enriched = items.map(n => ({
    node: n,
    tokens: new Set(_tokens(`${n.label || ''} ${n.answer || ''}`)),
  }));
  const clusters = [];
  for (const item of enriched) {
    if (item.tokens.size < 3) continue;
    let best = null, bestScore = 0;
    for (const c of clusters) {
      const s = _jaccard(item.tokens, c.tokens);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best && bestScore >= CLUSTER_THRESHOLD) {
      best.items.push(item);
      for (const t of item.tokens) best.tokens.add(t);
    } else {
      clusters.push({ items: [item], tokens: new Set(item.tokens) });
    }
  }
  return clusters;
}

function _coveredByExistingMemory(memories, clusterTokens) {
  for (const m of memories) {
    const t = new Set(_tokens(`${m.label || ''} ${m.body || ''}`));
    if (_jaccard(t, clusterTokens) >= 0.4) return true;
  }
  return false;
}

async function _llmSuggestMemoryCard(cluster) {
  if (!llm.pickChatModel()) return null;
  const sample = cluster.items.slice(0, 6).map((it, i) => {
    const lbl = (it.node.label || '').replace(/\s+/g, ' ').slice(0, 140);
    return `${i + 1}. ${lbl}`;
  }).join('\n');
  const sys = [
    'You analyze a developer\'s repeated questions to suggest a long-term memory card.',
    'Decide if the questions point to a real recurring topic worth saving (decision, constraint, lesson, gotcha) or just incidental rephrasings of unrelated things.',
    '',
    'Respond with JSON only. No markdown. No prose.',
    '',
    'Schema:',
    '{',
    '  "is_useful": true | false,',
    '  "title": "<imperative title under 90 chars>" | null,',
    '  "body": "<2-4 sentence answer / takeaway>" | null,',
    '  "tags": ["tag1", "tag2"] | null,',
    '  "kindOfMemory": "decision" | "preference" | "constraint" | "lesson" | "gotcha" | "pattern" | "fact" | null',
    '}',
    '',
    'is_useful=false when questions are unrelated or too vague to distill.',
  ].join('\n');
  const user = `The user has asked ${cluster.items.length} similar questions recently:\n\n${sample}\n\nWould a memory card help?`;
  try {
    const r = await llm.chatOllama([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { format: 'json', timeoutMs: 25_000, numPredict: 350 });
    return r.json;
  } catch (_) { return null; }
}

async function detect({ repoRoot, space, windowDays = 14 } = {}) {
  const g = store.loadGraph(repoRoot, space);
  if (!g) return [];
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const recentConvos = g.nodes.filter(n => {
    if (n.kind !== 'conversation' && n.kind !== 'drawer') return false;
    if (!n.createdAt) return false;
    return Date.parse(n.createdAt) >= since;
  });
  if (recentConvos.length < MIN_REPEATS) return [];

  const memories = g.nodes.filter(n => n.kind === 'memory');
  const clusters = _cluster(recentConvos)
    .filter(c => c.items.length >= MIN_REPEATS)
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, MAX_INSIGHTS);

  const out = [];
  for (const c of clusters) {
    if (_coveredByExistingMemory(memories, c.tokens)) continue;
    const suggestion = await _llmSuggestMemoryCard(c);
    if (!suggestion || !suggestion.is_useful || !suggestion.title || !suggestion.body) continue;
    out.push({
      category: 'repeated-question',
      title: `You've asked this ${c.items.length} times -- save as memory?`,
      body: `${suggestion.title}\n\n${suggestion.body}`,
      action: {
        type: 'create-memory',
        payload: {
          title: suggestion.title,
          body: suggestion.body,
          kindOfMemory: suggestion.kindOfMemory || 'lesson',
          tags: Array.isArray(suggestion.tags) ? suggestion.tags.slice(0, 8) : [],
          createdBy: 'mind/insights',
        },
      },
      evidence: c.items.map(i => i.node.id),
    });
  }
  return out;
}

module.exports = { detect };
