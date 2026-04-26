#!/usr/bin/env node
// Build or incrementally update the Mind graph from bash.
//
// Usage:
//   node scripts/build-mind.js                          full build, all sources
//   node scripts/build-mind.js --incremental            skip unchanged files
//   node scripts/build-mind.js --sources notes,learnings  specific sources only
const args = process.argv.slice(2);
const incremental = args.includes('--incremental');
const sourcesIdx = args.indexOf('--sources');
const sources = sourcesIdx >= 0 && args[sourcesIdx + 1]
  ? args[sourcesIdx + 1].split(',')
  : ['notes', 'learnings', 'cli-memory', 'recipes', 'plugins', 'instructions', 'repo-code'];

(async () => {
  const url = `http://127.0.0.1:3800/api/mind/${incremental ? 'update' : 'build'}`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources }),
  }).then(r => r.json());
  console.log(`Job: ${r.jobId}  space: ${r.space}  sources: ${r.sources.join(', ')}`);

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const job = await fetch(`http://127.0.0.1:3800/api/mind/jobs?id=${r.jobId}`).then(r => r.json());
    if (job.status === 'completed') {
      console.log(`Done in ${((job.completedAt - job.startedAt) / 1000).toFixed(1)}s`);
      console.log(JSON.stringify(job.result.summary, null, 2));
      return;
    }
    if (job.status === 'failed') { console.error(`Build failed: ${job.error}`); process.exit(1); }
    if (job.progress?.length) console.log(`  > ${job.progress[job.progress.length - 1].msg}`);
  }
  console.warn(`Build did not complete in 5 minutes. Check /api/mind/jobs?id=${r.jobId}`);
})().catch(e => { console.error(e); process.exit(1); });
