/**
 * The local answering machine - Symphonee's own voice (Stage 5, redone right).
 *
 * This replaces the templated snippet-dump, which was robotic in a different
 * way: it searched the wrong corpus (memory cards only, not the NOTES/DOCS
 * where project knowledge lives) and never synthesized, so "what do you know
 * about Aurora3" came back as unrelated fragments. The user's verdict was correct.
 *
 * What this does instead - per the user's direction ("pull all knowledge, then
 * answer humanly; a human will use this"):
 *   1. RETRIEVE BROADLY across ALL curated knowledge - notes, docs, memory,
 *      conversations, concepts - with a hybrid of BM25 (catches the topic by
 *      title, e.g. "Aurora3 - Production Readiness Plan") and dense vectors
 *      (catches meaning). Raw CLI drawer transcripts are excluded (noise).
 *   2. PULL THE REAL BODIES of the top sources (notes/docs from their .md on
 *      disk, memory cards from node.body) - not just titles.
 *   3. SYNTHESIZE A HUMAN ANSWER with the 26B reasoning model (NOT the 1.5B
 *      triage model the old path accidentally used), prompted to talk like a
 *      sharp, warm colleague who has read everything.
 *
 * This is Symphonee's voice, CLI-neutral: a person - or any CLI - asks, and the
 * local machine answers. The frontier (the user's active CLI) stays one button
 * away for when they want to go deeper.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('../mind/store');
const { bestSeedsRanked } = require('../mind/query');
const { fuse } = require('../mind/rrf');
const { VectorStore } = require('../mind/vectors');
const embeddings = require('../mind/embeddings');
const llm = require('../lib/llm');

// Curated knowledge worth answering FROM. Raw drawers (verbatim CLI turns) are
// deliberately excluded - BM25 over-ranks them and they are noise for "what do
// you know about X".
const KNOWLEDGE_KINDS = new Set(['note', 'doc', 'memory', 'conversation', 'recipe', 'skill', 'insight', 'concept']);
// The local writer. Default to the fast small model: the big reasoning model
// (gemma) is a thinking model that returns empty content on the plain-text path
// and is too slow (15-45s) for a quick answer. With GOOD retrieved context, the
// small model summarises grounded + fast. Override via SYMPHONEE_ANSWER_MODEL.
const SYNTH_MODEL = process.env.SYMPHONEE_ANSWER_MODEL || process.env.SYMPHONEE_TRIAGE_MODEL || 'qwen2.5:1.5b';
const MAX_SOURCES = 6;
const BODY_CAP = 1100;     // per-source excerpt fed to the model
const MIN_CONTENT = 60;    // drop label-only stubs (e.g. 40-char concept nodes)
const SYNTH_TIMEOUT_MS = 45_000;

// Question stopwords stripped before BM25 so the TOPIC drives the title match
// ("what do you know about aurora3" -> "aurora3"), not "know"/"about".
const QUESTION_STOPWORDS = new Set(('what whats what\'s how why when where who which whose do does did is are am was were ' +
  'can could should would will the a an of to in on for and or about tell me give show know explain define i you we ' +
  'my your our this that it its any some please got have has had with').split(/\s+/));

function _keyTerms(question) {
  const terms = String(question).toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !QUESTION_STOPWORDS.has(t));
  return terms.length ? terms.join(' ') : String(question);
}

// Pull the real content of a node: inline body/answer/description, or the
// file-backed body for notes/docs (their text lives in a .md on disk).
function nodeContent(node) {
  if (!node) return '';
  if (node.body) return String(node.body);
  if (node.answer) return String(node.answer);
  const f = node.source && node.source.file;
  if (f && /\.(md|markdown|txt|mdx)$/i.test(f)) {
    try { return fs.readFileSync(f, 'utf8'); } catch (_) { /* fall through */ }
  }
  if (node.description) return String(node.description);
  if (node.summary) return String(node.summary);
  return node.label || '';
}

/**
 * Retrieve the top knowledge sources for a question (hybrid BM25 + dense,
 * scoped to curated kinds), each with its real body excerpt.
 */
async function retrieveSources(repoRoot, space, question, max = MAX_SOURCES) {
  const graph = store.loadGraph(repoRoot, space);
  if (!graph || !graph.nodes || !graph.nodes.length) return { graph: null, sources: [] };
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  // Knowledge nodes that actually carry CONTENT (not 40-char concept stubs).
  const hasContent = (id) => {
    const n = byId.get(id);
    if (!n || !KNOWLEDGE_KINDS.has(n.kind)) return false;
    return nodeContent(n).trim().length >= MIN_CONTENT;
  };
  const terms = _keyTerms(question);

  // BM25 leg on the key TERMS: reliable for "tell me about <entity>" - matches
  // the topic in the node's title/label.
  const bm = bestSeedsRanked(graph, terms, max * 8)
    .filter(r => hasContent(r.id)).slice(0, max * 3)
    .map(r => ({ id: r.id, score: r.score }));
  bm._label = 'bm25';

  // Dense leg: catches paraphrase/meaning. Best-effort - degrades to BM25-only
  // if the index or embedder is unavailable.
  let dn = [];
  try {
    const vs = new VectorStore(repoRoot, space);
    if (vs.load()) {
      const qv = await embeddings.embedSingle(terms, { provider: 'ollama', task: 'search_query' });
      if (qv && qv.length) {
        dn = vs.query(qv, max * 12).filter(h => hasContent(h.id)).slice(0, max * 3)
          .map(h => ({ id: h.id, score: h.score }));
      }
    }
  } catch (_) { /* dense optional */ }
  dn._label = 'dense';

  const fused = dn.length ? fuse([bm, dn], { k: 60, limit: max }) : bm.slice(0, max);
  const sources = [];
  for (const r of fused) {
    const n = byId.get(r.id);
    if (!n) continue;
    const content = nodeContent(n).replace(/\s+/g, ' ').trim().slice(0, BODY_CAP);
    if (content && content.length >= MIN_CONTENT) sources.push({ id: r.id, kind: n.kind, label: n.label || r.id, content });
  }
  return { graph, sources };
}

// Strip the robotic "Based on your notes,..." preambles small models love, so
// the answer opens like a person talking, not a search engine reporting.
function _humanize(s) {
  let out = String(s || '').replace(
    /^\s*(based on (your|the) notes[,:]?\s*|according to (your|the) (notes|records)[,:]?\s*|(the user's|your) notes (indicate|show|say|suggest|mention)( that)?[,:]?\s*|from (your|the) notes[,:]?\s*|here(?:'s| is) what i (know|found)[,:]?\s*)/i,
    '',
  ).trim();
  if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

// ── ambient context: not just notes ─────────────────────────────────────────
// The answer machine is conscious of everything Symphonee knows: notes + memory
// (relevance retrieval above) PLUS the live signals - recent git history, recent
// checkpoints (what the user just did), and the recent conversation.

function _gitLog(repoPath, n = 6) {
  return new Promise((resolve) => {
    if (!repoPath) return resolve([]);
    execFile('git', ['-C', repoPath, 'log', '--oneline', '-n', String(n)], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve((err || !stdout) ? [] : stdout.trim().split('\n').filter(Boolean).slice(0, n));
    });
  });
}

function _gitStatus(repoPath) {
  return new Promise((resolve) => {
    if (!repoPath) return resolve({ count: 0, files: [] });
    execFile('git', ['-C', repoPath, 'status', '--porcelain'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve({ count: 0, files: [] });
      const files = stdout.trim().split('\n').filter(Boolean).map(l => l.slice(3).trim()).filter(Boolean);
      resolve({ count: files.length, files });
    });
  });
}

function _recentCheckpoints(repo, n = 3) {
  try {
    return (require('../lib/checkpoint').list({ repo, limit: n }) || [])
      .slice(0, n).map(c => c.label).filter(Boolean);
  } catch (_) { return []; }
}

function _recentConversation(graph, n = 3) {
  return (graph && graph.nodes ? graph.nodes : [])
    .filter(node => node.kind === 'drawer' || node.kind === 'conversation')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, n)
    .map(t => ({
      role: t.role || t.createdBy || t.kind,
      text: String(t.content || t.answer || t.body || t.label || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }))
    .filter(t => t.text);
}

function _buildMessages(question, sources, activity) {
  const sys = [
    'You are Symphonee - the user\'s own assistant. Answer a person about THEIR work using everything you have access to: their notes, their memory cards, your recent conversation with them, the recent checkpoints (things they just did), the git history, and any recent dispatched-task failures.',
    '',
    'Answer like a sharp, warm colleague who has read everything they wrote AND remembers what just happened.',
    'Rules:',
    '  - Lead with the answer. No "based on your notes" preamble.',
    '  - Use WHATEVER is relevant: a topic question leans on notes + memory; a "what did I just do / what changed / where are we" question leans on the git history, checkpoints, and recent conversation.',
    '  - Be specific and concrete: name the projects, decisions, files, commits.',
    '  - 2 to 5 sentences. End by offering to go deeper if it helps.',
    '  - Plain, human language. No node IDs, no bullet-dump unless it genuinely helps.',
    '  - If you genuinely have nothing relevant, say so in one line and suggest sending it to the agent for a deeper search.',
    '  - Plain ASCII only. No emojis, em dashes, or smart quotes.',
  ].join('\n');

  const blocks = [];
  if (sources.length) {
    blocks.push('What you know (the user\'s notes, memory, and past Q&A on this topic):\n' +
      sources.map((s, i) => `[${i + 1}] ${s.label} (${s.kind})\n${s.content}`).join('\n\n'));
  }
  const act = [];
  if (activity.git && activity.git.length) act.push('Recent commits:\n' + activity.git.map(l => '- ' + l).join('\n'));
  if (activity.checkpoints && activity.checkpoints.length) act.push('Recent checkpoints (things you just did):\n' + activity.checkpoints.map(l => '- ' + l).join('\n'));
  if (activity.conversation && activity.conversation.length) act.push('Recently discussed:\n' + activity.conversation.map(t => `- ${t.role}: ${t.text}`).join('\n'));
  if (activity.failures && activity.failures.length) {
    act.push('Recent task failures (a dispatched CLI task did not finish - use this for "what went wrong / why did it fail / how do I fix it" questions):\n' +
      activity.failures.map(f => `- ${f.cli}${f.model ? ' (' + f.model + ')' : ''} ${f.state}: ${f.error || 'no error text'}${f.prompt ? `  [task was: ${f.prompt}]` : ''}`).join('\n'));
  }
  if (activity.successes && activity.successes.length) {
    act.push('Recently finished tasks (a dispatched CLI task just completed - use this for "what did my task produce / what is the next step" questions; when asked for a next step, propose ONE concrete continuation and offer to draft the prompt for it):\n' +
      activity.successes.map(s => `- ${s.cli}${s.model ? ' (' + s.model + ')' : ''} finished${s.prompt ? ` [task was: ${s.prompt}]` : ''}${s.result ? `\n  result: ${s.result}` : ''}`).join('\n'));
  }
  if (act.length) blocks.push('Recent activity (use this for "what just happened / changed / where are we" questions):\n' + act.join('\n\n'));

  const user = `Question: ${question}\n\n${blocks.join('\n\n')}\n\nAnswer the question directly and humanly, using whatever above is relevant.`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/**
 * Answer a question locally and humanly from the user's knowledge.
 * @returns { grounded:true, answer, citedNodeIds, sources, model }
 *       OR { grounded:false, reason }
 */
async function localAnswer({ repoRoot, space = '_global', question, activeRepoPath, activeRepo }) {
  if (!question || typeof question !== 'string') return { grounded: false, reason: 'no-question' };
  const { graph, sources } = await retrieveSources(repoRoot, space, question, MAX_SOURCES);
  // Be conscious of more than notes: pull the live context too.
  const activity = {
    git: await _gitLog(activeRepoPath || repoRoot, 6),
    checkpoints: _recentCheckpoints(activeRepo, 3),
    conversation: graph ? _recentConversation(graph, 3) : [],
    failures: _recentFailures(repoRoot),
    successes: _recentSuccesses(repoRoot),
  };
  const hasContext = sources.length || activity.git.length || activity.checkpoints.length || activity.conversation.length || activity.failures.length || activity.successes.length;
  if (!hasContext) return { grounded: false, reason: 'no-context' };
  let res;
  try {
    res = await llm.chatOllama(_buildMessages(question, sources, activity), {
      model: SYNTH_MODEL,
      format: null,        // PLAIN PROSE - chatOllama defaults to JSON otherwise
      temperature: 0.4,
      numPredict: 700,
      timeoutMs: SYNTH_TIMEOUT_MS,
    });
  } catch (e) {
    return { grounded: false, reason: 'synth-error', error: e.message };
  }
  const answer = _humanize((res && typeof res.text === 'string') ? res.text.trim() : '');
  if (!answer) return { grounded: false, reason: 'empty-synthesis' };
  return {
    grounded: true,
    answer,
    citedNodeIds: sources.map(s => s.id),
    sources: sources.map(s => ({ id: s.id, kind: s.kind, label: s.label })),
    usedActivity: { git: activity.git.length, checkpoints: activity.checkpoints.length, conversation: activity.conversation.length },
    model: (res && res.model) || SYNTH_MODEL,
  };
}

// Recent orchestrator task failures, read straight from disk - the same
// low-coupling pattern as git/checkpoints (no orchestrator instance needed in
// the brain). The orchestrator writes tasks.json BEFORE it broadcasts a
// task-update, so by the time a failure event reaches us the file is current.
// Only genuinely recent failures (default 15 min) so the whisper reacts to
// "this just broke", not ancient history.
function _readTasks(repoRoot) {
  try {
    const f = path.join(repoRoot, '.ai-workspace', 'orchestrator', 'tasks.json');
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function _recentFailures(repoRoot, withinMs = 15 * 60 * 1000, max = 3) {
  const now = Date.now();
  return _readTasks(repoRoot)
    .filter(t => (t.state === 'failed' || t.state === 'timeout') && (now - (t.completedAt || t.createdAt || 0) <= withinMs))
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, max)
    .map(t => ({
      id: t.id,
      cli: t.cli || 'task',
      model: t.model || null,
      state: t.state,
      error: typeof t.error === 'string' ? t.error.slice(0, 300) : '',
      classification: t.errorClassification || null,
      prompt: typeof t.prompt === 'string' ? t.prompt.slice(0, 160) : '',
      completedAt: t.completedAt || null,
    }));
}

// Recent task SUCCESSES - the other half of the loop. A finished task is the
// moment a colleague would lean over: "that landed - here's the thread to pull
// next". Same disk read as failures; only fresh completions (default 15 min).
function _recentSuccesses(repoRoot, withinMs = 15 * 60 * 1000, max = 3) {
  const now = Date.now();
  return _readTasks(repoRoot)
    .filter(t => t.state === 'completed' && (now - (t.completedAt || t.createdAt || 0) <= withinMs))
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, max)
    .map(t => ({
      id: t.id,
      cli: t.cli || 'task',
      model: t.model || null,
      result: typeof t.result === 'string' ? t.result.slice(0, 400) : '',
      prompt: typeof t.prompt === 'string' ? t.prompt.slice(0, 160) : '',
      completedAt: t.completedAt || null,
    }));
}

// Fresh memory cards in the shared brain - "Mind just learned something".
// createdAt on memory nodes is an ISO string; only genuinely new cards
// (default 30 min) so the whisper reacts to a delta, not the archive.
function _recentMemories(graph, withinMs = 30 * 60 * 1000, max = 3) {
  const now = Date.now();
  return (graph && graph.nodes ? graph.nodes : [])
    .filter(n => {
      if (n.kind !== 'memory') return false;
      const t = Date.parse(n.createdAt || '');
      return Number.isFinite(t) && (now - t <= withinMs);
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, max)
    .map(n => ({
      id: n.id,
      title: String(n.label || '').slice(0, 120),
      kindOfMemory: n.kindOfMemory || null,
      createdBy: n.createdBy || null,
      createdAt: n.createdAt || null,
    }));
}

// Notes the user touched recently (by file mtime) - an open thread worth
// offering to pick back up when they go quiet.
function _recentNotes(repoRoot, ns = '_global', withinMs = 30 * 60 * 1000, max = 3) {
  try {
    const dir = path.join(repoRoot, 'notes', ns);
    const now = Date.now();
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try { return { name: f.replace(/\.md$/i, ''), editedAt: fs.statSync(path.join(dir, f)).mtimeMs }; }
        catch (_) { return null; }
      })
      .filter(n => n && (now - n.editedAt <= withinMs))
      .sort((a, b) => b.editedAt - a.editedAt)
      .slice(0, max);
  } catch (_) { return []; }
}

// Assemble the live context - the whisper's single context bus. Everything the
// second mind is conscious of flows through here: git + checkpoints + recent
// conversation + task failures AND successes + fresh Mind memory + recently
// edited notes.
async function gatherContext({ repoRoot, space = '_global', activeRepoPath, activeRepo, notesNs = '_global', graph = null } = {}) {
  const g = graph || store.loadGraph(repoRoot, space);
  const repoPath = activeRepoPath || repoRoot;
  const [git, uncommitted] = await Promise.all([_gitLog(repoPath, 6), _gitStatus(repoPath)]);
  return {
    git,
    uncommitted,
    checkpoints: _recentCheckpoints(activeRepo, 3),
    conversation: g ? _recentConversation(g, 4) : [],
    failures: _recentFailures(repoRoot),
    successes: _recentSuccesses(repoRoot),
    mindNew: g ? _recentMemories(g) : [],
    notesEdited: _recentNotes(repoRoot, notesNs),
  };
}

module.exports = {
  localAnswer, retrieveSources, gatherContext, nodeContent, KNOWLEDGE_KINDS,
  _keyTerms, _humanize, _recentSuccesses, _recentMemories, _recentNotes,
};
