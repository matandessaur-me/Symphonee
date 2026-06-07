'use strict';
// Mind build orchestration: full build / incremental update / lock introspection
// / checkpoint / single-file patch. Jobs run async; the in-memory job table and
// build sources are passed in via deps.

const path = require('path');
const lock = require('./lock');
const engine = require('./engine');
const checkpoint = require('./checkpoint');
const { Manifest } = require('./manifest');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, getUiContext, readBody, broadcast, ctx, jobs, makeJobId, DEFAULT_BUILD_SOURCES } = deps;

  // ── Builds ───────────────────────────────────────────────────────────────
  addRoute('POST', '/api/mind/build', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const sources = body.sources || DEFAULT_BUILD_SOURCES;

    // Concurrency guard - if a build is already running, return 409 instead of
    // racing two builds against the same graph.json.
    const existing = lock.status(space, 'graph');
    if (existing.locked) {
      return json(res, {
        error: 'build already running',
        holderPid: existing.holderPid,
        ageMs: existing.ageMs,
      }, 409);
    }

    const jobId = makeJobId();
    const job = { id: jobId, kind: 'build', space, sources, status: 'running', startedAt: Date.now(), progress: [] };
    jobs.set(jobId, job);
    if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-start', jobId, space, sources } });
    json(res, { jobId, space, sources });
    // Run async so the response returns immediately
    Promise.resolve().then(() => engine.runBuild({
      repoRoot, space, sources, ctx,
      onProgress: (msg) => {
        job.progress.push({ ts: Date.now(), msg });
        if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-progress', jobId, msg } });
      },
    })).then((result) => {
      job.status = 'completed';
      job.completedAt = Date.now();
      job.result = result;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-complete', jobId, result } });
      if (broadcast && result && result.validationWarningCount) {
        broadcast({
          type: 'notification',
          title: 'Mind build completed with skipped graph data',
          body: `${result.validationWarningCount} invalid graph item(s) were skipped. The rest of the graph was saved.`,
          level: 'warning',
          icon: 'alert-triangle',
        });
      }
    }).catch((err) => {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = err.message;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-failed', jobId, error: err.message } });
    });
  });

  addRoute('POST', '/api/mind/update', async (req, res) => {
    // Incremental: same engine, but engine consults manifest to skip unchanged
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const sources = body.sources || DEFAULT_BUILD_SOURCES;

    const existing = lock.status(space, 'graph');
    if (existing.locked) {
      return json(res, { error: 'update already running', holderPid: existing.holderPid, ageMs: existing.ageMs }, 409);
    }

    const jobId = makeJobId();
    const job = { id: jobId, kind: 'update', space, sources, status: 'running', startedAt: Date.now(), progress: [] };
    jobs.set(jobId, job);
    json(res, { jobId, space, sources });
    Promise.resolve().then(() => engine.runBuild({
      repoRoot, space, sources, incremental: true, ctx,
      onProgress: (msg) => job.progress.push({ ts: Date.now(), msg }),
    })).then((result) => {
      job.status = 'completed'; job.completedAt = Date.now(); job.result = result;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'update-complete', jobId, result } });
      if (broadcast && result && result.validationWarningCount) {
        broadcast({
          type: 'notification',
          title: 'Mind update completed with skipped graph data',
          body: `${result.validationWarningCount} invalid graph item(s) were skipped. The rest of the graph was saved.`,
          level: 'warning',
          icon: 'alert-triangle',
        });
      }
    }).catch((err) => {
      job.status = 'failed'; job.completedAt = Date.now(); job.error = err.message;
    });
  });

  // ── Lock + checkpoint introspection ──────────────────────────────────────
  addRoute('GET', '/api/mind/lock', (req, res) => {
    const space = getSpace();
    return json(res, {
      space,
      build: lock.status(space, 'build'),
      update: lock.status(space, 'update'),
      graph: lock.status(space, 'graph'),
      watch: lock.status(space, 'watch'),
      all: lock.listAll(),
    });
  });

  addRoute('POST', '/api/mind/lock/clear', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const op = body.op || 'graph';
    const r = lock.terminateHolder(space, op);
    return json(res, { space, op, ...r });
  });

  addRoute('GET', '/api/mind/checkpoint', (req, res) => {
    const space = getSpace();
    const cp = checkpoint.read(repoRoot, space);
    return json(res, { space, checkpoint: cp });
  });


  // ── Per-file patch (incremental update for a single saved file) ─────────
  // Cheaper than /api/mind/update for the common "user just saved one file"
  // case. Invalidates the manifest entry for that file so the next
  // incremental build re-extracts it. The actual re-extraction still goes
  // through engine.runBuild incremental=true so all the plumbing
  // (sources, dedup, locks, save) stays in one place.
  addRoute('POST', '/api/mind/patch-file', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const file = body.file;
    if (!file) return json(res, { error: 'file required' }, 400);
    const space = getSpace();

    const ui = getUiContext ? getUiContext() : {};
    const repoPath = ui.activeRepoPath;
    if (!repoPath) return json(res, { error: 'no active repo' }, 400);
    const rel = path.isAbsolute(file)
      ? path.relative(repoPath, file).replace(/\\/g, '/')
      : file.replace(/\\/g, '/');

    // Drop the file from the manifest so the next incremental build
    // re-extracts it from disk.
    try {
      const m = new Manifest(repoRoot, space);
      m.delete(rel);
      m.flushSync();
    } catch (e) {
      return json(res, { error: 'manifest update failed: ' + e.message }, 500);
    }

    const acq = lock.acquire(space, 'patch-file');
    if (!acq.ok) return json(res, { error: 'patch-file already running', holderPid: acq.holderPid }, 409);
    const jobId = makeJobId();
    json(res, { jobId, ok: true, file: rel });

    Promise.resolve().then(() => engine.runBuild({
      repoRoot, space, sources: ['repo-code'], incremental: true, ctx,
      onProgress: () => {},
    })).then((result) => {
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'patch-file-complete', jobId, file: rel, result } });
    }).catch((err) => {
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'patch-file-failed', jobId, file: rel, error: err.message } });
    }).finally(() => {
      lock.release(space, 'patch-file');
    });
  });
}

module.exports = { register };
