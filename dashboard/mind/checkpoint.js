/**
 * Per-space build checkpoint.
 *
 * Engine writes a small JSON file after each batch of an extractor source so
 * that an interrupted build resumes from where it left off instead of starting
 * over. The manifest already records per-file SHA hashes for skip-on-resume;
 * this layer records *which source/batch we got to* so progress reporting and
 * resume logic can be coarse-grained.
 *
 * Path: <repoRoot>/.symphonee/mind/spaces/<space>/checkpoint.json
 */

const fs = require('fs');
const path = require('path');
const { spaceDir, ensureDirs } = require('./store');

function checkpointPath(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'checkpoint.json');
}

function read(repoRoot, space) {
  try {
    const raw = fs.readFileSync(checkpointPath(repoRoot, space), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function write(repoRoot, space, payload) {
  ensureDirs(repoRoot, space);
  const file = checkpointPath(repoRoot, space);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const body = JSON.stringify({ ...payload, ts: Date.now() }, null, 2);
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) {
    // best-effort - never fail the build because checkpointing failed
  }
}

function clear(repoRoot, space) {
  try { fs.unlinkSync(checkpointPath(repoRoot, space)); } catch (_) { /* nothing to clear */ }
}

module.exports = { read, write, clear, checkpointPath };
