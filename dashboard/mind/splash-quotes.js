/**
 * splash-quotes.js -- the cycling quote pool shown on the splash / boot overlay.
 *
 * getQuotes()  : instant read of the cached pool (or placeholders). Never blocks,
 *                never throws -- safe to serve on the boot path.
 * regenerate() : best-effort background job. Pulls recent memory / conversation /
 *                decision nodes from the Mind graph and asks the local chat model
 *                for short, warm one-liners about how this person works and what
 *                they have been building, then caches them to disk. If no chat
 *                model is installed yet (first run / mid-download) it fails soft
 *                and the placeholders stay until a later boot succeeds.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function cacheFile(repoRoot) {
  return path.join(repoRoot, '.ai-workspace', 'splash-quotes.json');
}

// Warm, working-style one-liners used until the first successful generation.
// Deliberately about building / iterating rather than famous-programmer quips,
// so the placeholder run already feels like "your" loader.
const PLACEHOLDERS = [
  { text: 'Every session you teach me something. Loading what we know.', author: 'Symphonee' },
  { text: 'Small, deliberate steps. That is how the good work gets done.', author: 'Symphonee' },
  { text: 'Measure first, then change. Profiling beats guessing.', author: 'Symphonee' },
  { text: 'A branch for every idea, a diff before every commit.', author: 'Symphonee' },
  { text: 'The mind remembers so the next session does not start from zero.', author: 'Symphonee' },
  { text: 'Plan it, do not rush it. Engineered, not on the fly.', author: 'Symphonee' },
  { text: 'Lazy-load the heavy things; let the light things fly.', author: 'Symphonee' },
  { text: 'Warming up the knowledge graph...', author: 'Symphonee' },
];

function loadCache(repoRoot) {
  try {
    const raw = fs.readFileSync(cacheFile(repoRoot), 'utf8');
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.quotes) && doc.quotes.length) return doc;
  } catch (_) {}
  return null;
}

// Instant, safe accessor for the boot path.
function getQuotes(repoRoot) {
  const cached = loadCache(repoRoot);
  if (cached) return { quotes: cached.quotes, generatedAt: cached.generatedAt || null, source: 'mind' };
  return { quotes: PLACEHOLDERS, generatedAt: null, source: 'placeholder' };
}

// Pull short material from the Mind graph: recent memory cards (durable facts),
// conversation questions, and decisions. Returns a compact string list for the
// prompt. Defensive about node shape; returns [] on any failure.
function gatherMaterial(store, repoRoot, space, limit = 24) {
  try {
    const g = store.loadGraph(repoRoot, space);
    if (!g || !Array.isArray(g.nodes)) return [];
    const WANT = new Set(['memory', 'conversation', 'decision', 'drawer']);
    const items = g.nodes
      .filter(n => n && WANT.has(n.kind))
      .map(n => ({
        kind: n.kind,
        when: n.createdAt || n.updatedAt || null,
        text: String(n.label || n.title || '').trim(),
        body: String(n.body || n.summary || '').trim(),
      }))
      .filter(n => n.text || n.body);
    // Most recent first when timestamps exist.
    items.sort((a, b) => {
      const ta = a.when ? Date.parse(a.when) || 0 : 0;
      const tb = b.when ? Date.parse(b.when) || 0 : 0;
      return tb - ta;
    });
    return items.slice(0, limit).map(n => {
      const snip = (n.body && n.body.length > n.text.length ? n.body : n.text).slice(0, 200);
      return `(${n.kind}) ${snip}`;
    });
  } catch (_) {
    return [];
  }
}

// Best-effort regeneration. Resolves to a result object; never rejects.
async function regenerate({ repoRoot, space, store, broadcast } = {}) {
  try {
    if (!repoRoot || !space || !store) return { ok: false, reason: 'missing-args' };
    const material = gatherMaterial(store, repoRoot, space);
    if (material.length < 3) {
      // Not enough signal yet (fresh PC / empty graph). Keep placeholders.
      return { ok: false, reason: 'insufficient-material' };
    }
    const { chatOllama } = require('./llm');
    const sys = 'You write short, warm, reflective one-liners for a developer loading screen. ' +
      'Each line is about HOW this person works and WHAT they have been building, in second person ("you"). ' +
      'Grounded in the provided notes. No names, no hashtags, no quotes-marks in the text, under 120 characters each. ' +
      'Return strict JSON: {"quotes":[{"text":"..."}]} with 12 items.';
    const user = 'Notes from my knowledge graph:\n' + material.join('\n') +
      '\n\nWrite 12 lines as specified.';
    const out = await chatOllama(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { format: 'json', temperature: 0.7, numPredict: 700, timeoutMs: 60000 }
    );
    const raw = (out && Array.isArray(out.quotes)) ? out.quotes : [];
    const quotes = raw
      .map(q => ({ text: String((q && q.text) || '').replace(/^["']|["']$/g, '').trim(), author: 'Symphonee' }))
      .filter(q => q.text && q.text.length <= 160)
      .slice(0, 12);
    if (quotes.length < 3) return { ok: false, reason: 'too-few-generated' };
    const doc = { quotes, generatedAt: new Date().toISOString(), space };
    try { fs.mkdirSync(path.dirname(cacheFile(repoRoot)), { recursive: true }); } catch (_) {}
    fs.writeFileSync(cacheFile(repoRoot), JSON.stringify(doc, null, 2));
    if (typeof broadcast === 'function') {
      try { broadcast({ type: 'splash-quotes-updated', payload: { count: quotes.length } }); } catch (_) {}
    }
    return { ok: true, count: quotes.length };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

module.exports = { getQuotes, regenerate, PLACEHOLDERS };
