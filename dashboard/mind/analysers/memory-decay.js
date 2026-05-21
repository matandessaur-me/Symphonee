/**
 * Memory decay analyser.
 *
 * Surfaces memory cards that have aged without being recalled. Mind
 * keeps a `referencedAt` array on each card that recall.js appends to
 * whenever the card surfaces. Cards that haven't been touched in
 * `staleDays` (default 90) are candidates for archive.
 *
 * Emits ONE insight per pass listing up to BATCH_SIZE stale cards;
 * the user acts on it to archive the batch in one click rather than
 * pestering them with N separate insights.
 *
 * Archived = status:archived field added to the memory node. We never
 * delete the card content (the graph keeps history); we just hide it
 * from wakeup / recall surfaces.
 */

'use strict';

const store = require('../store');

const STALE_DAYS = 90;
const BATCH_SIZE = 8;

function _lastTouched(card) {
  // referencedAt is an array of ISO strings; pick the most recent.
  // Fall back to createdAt if the card has never been recalled.
  if (Array.isArray(card.referencedAt) && card.referencedAt.length) {
    return Math.max(...card.referencedAt.map(s => Date.parse(s)).filter(t => !Number.isNaN(t)));
  }
  if (card.createdAt) {
    const t = Date.parse(card.createdAt);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function detect({ repoRoot, space, staleDays = STALE_DAYS } = {}) {
  const g = store.loadGraph(repoRoot, space);
  if (!g) return [];
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  // Eligible: memory cards that aren't already archived AND haven't been
  // touched since the cutoff. Cards created less than staleDays ago are
  // still warm enough to skip.
  const stale = (g.nodes || [])
    .filter(n => n.kind === 'memory' && n.status !== 'archived')
    .filter(n => _lastTouched(n) < cutoff)
    .sort((a, b) => _lastTouched(a) - _lastTouched(b));
  if (stale.length === 0) return [];
  const batch = stale.slice(0, BATCH_SIZE);
  const body = [
    `${stale.length} memory card${stale.length === 1 ? '' : 's'} haven't been recalled in over ${staleDays} days.`,
    '',
    'Suggested for archive:',
    ...batch.map(n => `  - [${n.kindOfMemory || 'fact'}] ${(n.label || '').slice(0, 100)}`),
    stale.length > BATCH_SIZE ? `  ... and ${stale.length - BATCH_SIZE} more` : '',
    '',
    'Archiving keeps them in history but hides them from wakeup + recall surfaces.',
  ].filter(Boolean).join('\n');
  return [{
    category: 'memory-decay',
    title: `${stale.length} memor${stale.length === 1 ? 'y' : 'ies'} unused for ${staleDays}+ days -- archive?`,
    body,
    action: {
      type: 'archive-memories',
      payload: { ids: batch.map(n => n.id) },
    },
    evidence: batch.map(n => n.id),
  }];
}

module.exports = { detect };
