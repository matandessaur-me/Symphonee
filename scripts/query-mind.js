#!/usr/bin/env node
// Query the shared Mind graph from bash.
//
// Usage:
//   node scripts/query-mind.js "what does the orchestrator do"
//   node scripts/query-mind.js "auth flow" --budget 1500
const args = process.argv.slice(2);
const question = args.find(a => !a.startsWith('--'));
if (!question) { console.error('Usage: node scripts/query-mind.js "<question>" [--budget N] [--mode bfs|dfs]'); process.exit(1); }
const budgetIdx = args.indexOf('--budget');
const budget = budgetIdx >= 0 ? parseInt(args[budgetIdx + 1], 10) : 2000;
const modeIdx = args.indexOf('--mode');
const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'bfs';

(async () => {
  const r = await fetch('http://127.0.0.1:3800/api/mind/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, budget, mode }),
  }).then(r => r.json());
  if (r.empty) { console.warn('Brain is empty - run scripts/build-mind.js first.'); return; }
  console.log(`Question: ${question}`);
  console.log(`Seed nodes: ${r.seedIds.join(', ')}`);
  console.log(`Sub-graph: ${r.nodes.length} nodes, ${r.edges.length} edges (~${r.estTokens} tokens)`);
  console.log('\n--- summary ---');
  console.log(r.answer.summary);
  console.log('\n--- nodes ---');
  for (const n of r.nodes.slice(0, 20)) {
    console.log(`${(n.kind || '?').padEnd(12)} ${(n.label || '').slice(0, 48).padEnd(50)} community ${n.communityId ?? '-'}`);
  }
  console.log('\n--- note ---');
  console.log(r.answer.note);
})().catch(e => { console.error(e); process.exit(1); });
