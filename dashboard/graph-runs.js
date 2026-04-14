/**
 * DevOps Pilot -- Graph Runs (BETA)
 *
 * Durable multi-step workflow engine. Lets you define a graph of nodes,
 * each with typed inputs and outputs, that flow state through the run.
 * Runs persist to disk so a multi-hour investigation survives app
 * restarts, circuit-breaker trips, and laptop sleeps.
 *
 * One-shot spawns (/api/orchestrator/spawn) are unchanged and do not
 * use this engine.
 *
 * Scope for v1 (BETA):
 *   - Node types: worker, approval, branch
 *   - Storage: per-run JSON snapshot + append-only events WAL
 *   - Reducer: deep-merge (state writes merge into existing state)
 *   - NOT in v1: parallel/reduce, MCP tool nodes, crash-mid-node replay
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');

const STATES = ['pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'paused'];

class GraphRunsEngine extends EventEmitter {
  constructor({ repoRoot, apiHost = '127.0.0.1', apiPort = 3800, injectToTerminal = null }) {
    super();
    this.repoRoot = repoRoot;
    this.apiHost = apiHost;
    this.apiPort = apiPort;
    this.injectToTerminal = injectToTerminal;
    this.runsDir = path.join(repoRoot, '.devops-pilot', 'graph-runs');
    this.walPath = path.join(this.runsDir, 'events.jsonl');
    this.runs = new Map(); // runId -> run object (in memory + persisted)
    this.approvalWaiters = new Map(); // `${runId}:${nodeId}` -> resolver
    this._ensureDir();
    this._loadPersisted();
  }

  _ensureDir() {
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  _loadPersisted() {
    let entries = [];
    try { entries = fs.readdirSync(this.runsDir); } catch (_) { return; }
    const toResume = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const run = JSON.parse(fs.readFileSync(path.join(this.runsDir, f), 'utf8'));
        // Runs that were mid-flight (running) or mid-approval when the app
        // stopped need their in-memory state rebuilt. The on-disk approval
        // waiter is gone, so we reset those nodes to pending and re-enter the
        // scheduler — it will recreate the waiter, the modal will surface
        // again, and Approve / Reject will work as expected.
        const needsResume = run.status === 'running' || run.status === 'awaiting_approval';
        if (needsResume) run.status = 'pending';
        for (const n of run.nodes) {
          if (n.status === 'running' || n.status === 'awaiting_approval') n.status = 'pending';
        }
        this.runs.set(run.id, run);
        if (needsResume) toResume.push(run.id);
      } catch (_) {}
    }
    // Kick the scheduler for any resumed run. Defer so constructor finishes.
    for (const id of toResume) {
      setImmediate(() => this._executeNextBatch(id).catch(err => this._failRun(id, err.message)));
    }
  }

  _persist(run) {
    const file = path.join(this.runsDir, `${run.id}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  _wal(event) {
    try {
      fs.appendFileSync(this.walPath, JSON.stringify({ ts: Date.now(), ...event }) + '\n', 'utf8');
    } catch (_) {}
  }

  _newId() {
    return 'gr_' + crypto.randomBytes(6).toString('hex');
  }

  _newNodeRunId() {
    return 'n_' + crypto.randomBytes(4).toString('hex');
  }

  // ── Public API ────────────────────────────────────────────────────────
  async createRun({ name, nodes, state = {}, from = 'user', originTermId = null }) {
    if (!Array.isArray(nodes) || !nodes.length) throw new Error('nodes array required');
    const id = this._newId();
    const now = Date.now();
    const run = {
      id,
      name: name || 'Unnamed graph run',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      from,
      originTermId,
      state,
      nodes: nodes.map(n => ({
        ...n,
        status: 'pending',
        attempts: 0,
        startedAt: null,
        endedAt: null,
        output: null,
        error: null,
      })),
      events: [],
    };
    this.runs.set(id, run);
    this._wal({ kind: 'run_created', runId: id, name: run.name });
    this._persist(run);
    this.emit('run-created', run);
    // Kick off execution async
    setImmediate(() => this._executeNextBatch(id).catch(err => {
      this._failRun(id, err.message);
    }));
    return run;
  }

  listRuns() {
    return Array.from(this.runs.values()).map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      nodeCount: r.nodes.length,
      completedNodes: r.nodes.filter(n => n.status === 'completed').length,
    })).sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(id) { return this.runs.get(id); }

  listPendingApprovals() {
    const out = [];
    for (const run of this.runs.values()) {
      for (const node of run.nodes) {
        if (node.status === 'awaiting_approval') {
          out.push({
            runId: run.id,
            runName: run.name,
            nodeId: node.id,
            title: node.title || `Approve node ${node.id}`,
            requestedAt: node.startedAt,
            state: run.state,
          });
        }
      }
    }
    return out.sort((a, b) => a.requestedAt - b.requestedAt);
  }

  pauseRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    if (!['running', 'pending', 'awaiting_approval'].includes(run.status)) return run;
    run.status = 'paused';
    run.updatedAt = Date.now();
    this._wal({ kind: 'paused', runId: id });
    this._persist(run);
    return run;
  }

  async resumeRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    if (run.status !== 'paused') return run;
    run.status = 'pending';
    run.updatedAt = Date.now();
    this._wal({ kind: 'resumed', runId: id });
    this._persist(run);
    setImmediate(() => this._executeNextBatch(id).catch(err => {
      this._failRun(id, err.message);
    }));
    return run;
  }

  cancelRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    run.status = 'cancelled';
    run.updatedAt = Date.now();
    for (const n of run.nodes) if (n.status === 'pending' || n.status === 'awaiting_approval') n.status = 'cancelled';
    // Unblock any waiting approval
    for (const n of run.nodes) {
      const key = `${id}:${n.id}`;
      if (this.approvalWaiters.has(key)) {
        this.approvalWaiters.get(key)({ approved: false, note: 'run cancelled' });
        this.approvalWaiters.delete(key);
      }
    }
    this._wal({ kind: 'cancelled', runId: id });
    this._persist(run);
    return run;
  }

  approveNode(id, nodeId, { approved, note } = { approved: true }) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    const node = run.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error('no such node');
    if (node.status !== 'awaiting_approval') throw new Error(`node is ${node.status}, not awaiting_approval`);
    const key = `${id}:${nodeId}`;
    const resolver = this.approvalWaiters.get(key);
    if (resolver) {
      this.approvalWaiters.delete(key);
      resolver({ approved: !!approved, note: note || '' });
    }
    return { ok: true };
  }

  updateState(id, patch) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    run.state = deepMerge(run.state, patch);
    run.updatedAt = Date.now();
    this._wal({ kind: 'state_interrupt', runId: id, patch });
    this._persist(run);
    return run.state;
  }

  // ── Scheduler ─────────────────────────────────────────────────────────
  async _executeNextBatch(runId) {
    const run = this.runs.get(runId);
    if (!run) return;
    if (['paused', 'cancelled', 'completed', 'failed'].includes(run.status)) return;

    run.status = 'running';
    run.updatedAt = Date.now();

    while (true) {
      // Re-check status each iteration (external pause/cancel can happen)
      if (['paused', 'cancelled'].includes(run.status)) break;

      // First, cancel any skipped nodes whose dependencies are already
      // terminal. This unblocks merge nodes downstream.
      let cancelledSomething = false;
      for (const n of run.nodes) {
        if (n.status === 'pending' && this._isSkipped(run, n) && this._areDepsComplete(run, n)) {
          n.status = 'cancelled';
          n.endedAt = Date.now();
          cancelledSomething = true;
        }
      }
      if (cancelledSomething) this._persist(run);

      const ready = run.nodes.filter(n => n.status === 'pending' && this._areDepsComplete(run, n) && !this._isSkipped(run, n));
      if (!ready.length) break;
      // Execute ready nodes sequentially for v1 (parallel is phase 2)
      for (const node of ready) {
        if (['paused', 'cancelled'].includes(run.status)) break;
        await this._executeNode(run, node);
        this._persist(run);
      }
    }

    // Terminal state decision
    if (!['paused', 'cancelled'].includes(run.status)) {
      const unfinished = run.nodes.find(n => n.status === 'pending' || n.status === 'running' || n.status === 'awaiting_approval');
      if (!unfinished) {
        const anyFailed = run.nodes.some(n => n.status === 'failed');
        run.status = anyFailed ? 'failed' : 'completed';
        run.updatedAt = Date.now();
        this._wal({ kind: 'run_ended', runId, status: run.status });
        this._deliverResult(run);
      }
    }
    this._persist(run);
    this.emit('run-updated', run);
  }

  // Inject a one-line summary into the terminal that started this run,
  // so the supervisor agent knows to pick up where it left off. Mirrors
  // the orchestrator's OrchestrateResultDelivery=inject pattern.
  _deliverResult(run) {
    if (!this.injectToTerminal || !run.originTermId) return;
    const ran = run.nodes.filter(n => n.status === 'completed').length;
    const cancelled = run.nodes.filter(n => n.status === 'cancelled').length;
    const failed = run.nodes.filter(n => n.status === 'failed').length;
    const duration = Math.round((run.updatedAt - run.createdAt) / 1000);
    const lastCompleted = [...run.nodes].reverse().find(n => n.status === 'completed');
    const snippet = lastCompleted && lastCompleted.output && lastCompleted.output.result
      ? String(lastCompleted.output.result).replace(/\n/g, ' ').substring(0, 400)
      : '(no result from last node)';
    const line = `[GRAPH RUN ${run.id}] ${run.status} — ${run.name} | ${ran} done, ${cancelled} skipped, ${failed} failed | ${duration}s | last: ${snippet}`;
    try { this.injectToTerminal(run.originTermId, line + '\r'); } catch (_) {}
  }

  _areDepsComplete(run, node) {
    const deps = node.dependsOn || [];
    for (const depId of deps) {
      const dep = run.nodes.find(n => n.id === depId);
      if (!dep) return false;
      if (!['completed', 'cancelled'].includes(dep.status)) return false;
    }
    return true;
  }

  _isSkipped(run, node) {
    const skipList = (run.state._skipNodes || []);
    return skipList.includes(node.id);
  }

  async _executeNode(run, node) {
    node.status = 'running';
    node.startedAt = Date.now();
    node.attempts += 1;
    this._wal({ kind: 'node_started', runId: run.id, nodeId: node.id, type: node.type });
    run.updatedAt = Date.now();

    try {
      let output;
      if (node.type === 'worker') {
        output = await this._runWorkerNode(run, node);
      } else if (node.type === 'approval') {
        output = await this._runApprovalNode(run, node);
      } else if (node.type === 'branch') {
        output = await this._runBranchNode(run, node);
      } else {
        throw new Error(`Unknown node type: ${node.type}`);
      }
      node.output = output;
      node.status = 'completed';
      node.endedAt = Date.now();
      // Merge node output into state under state.results[nodeId]
      if (output !== undefined) {
        run.state = deepMerge(run.state, { results: { [node.id]: output } });
      }
      this._wal({ kind: 'node_completed', runId: run.id, nodeId: node.id });
    } catch (err) {
      node.error = err.message;
      node.status = 'failed';
      node.endedAt = Date.now();
      this._wal({ kind: 'node_failed', runId: run.id, nodeId: node.id, error: err.message });
    }
  }

  async _runWorkerNode(run, node) {
    const prompt = renderTemplate(node.prompt || '', { state: run.state });
    const body = {
      cli: node.cli || 'claude',
      prompt,
      cwd: node.cwd,
      from: `graph-run:${run.id}`,
      model: node.model,
      effort: node.effort,
      autoPermit: !!node.autoPermit,
    };
    const spawnRes = await apiRequest(this.apiHost, this.apiPort, 'POST', '/api/orchestrator/spawn', body);
    if (!spawnRes || !spawnRes.id) throw new Error('spawn failed: ' + JSON.stringify(spawnRes));
    // Poll the task until completion
    const taskId = spawnRes.id;
    while (true) {
      await sleep(1500);
      if (['paused', 'cancelled'].includes(run.status)) throw new Error('run paused/cancelled');
      const task = await apiRequest(this.apiHost, this.apiPort, 'GET', `/api/orchestrator/task?id=${taskId}`);
      if (!task) throw new Error('task disappeared');
      if (task.state === 'completed') return { taskId, result: task.result };
      if (['failed', 'cancelled', 'timeout'].includes(task.state)) throw new Error(`worker ${task.state}: ${task.error || ''}`);
    }
  }

  async _runApprovalNode(run, node) {
    node.status = 'awaiting_approval';
    run.status = 'awaiting_approval';
    this._persist(run);
    this._wal({ kind: 'approval_requested', runId: run.id, nodeId: node.id, title: node.title });
    const key = `${run.id}:${node.id}`;
    return new Promise((resolve, reject) => {
      this.approvalWaiters.set(key, (outcome) => {
        run.status = 'running';
        if (outcome.approved) resolve(outcome);
        else reject(new Error(`rejected: ${outcome.note || 'no reason given'}`));
      });
    });
  }

  async _runBranchNode(run, node) {
    const expr = node.expr || 'false';
    let result;
    try {
      result = !!evalSafe(expr, run.state);
    } catch (e) {
      throw new Error(`branch expression failed: ${e.message}`);
    }
    // thenNext + elseNext are node ids; the branch not taken gets skipped.
    // Only propagate the skip forward to descendants whose EVERY dependency
    // is already skipped — merge nodes with an alternate reachable parent
    // must still run.
    const skipTarget = result ? node.elseNext : node.thenNext;
    if (skipTarget) {
      const existing = Array.isArray(run.state._skipNodes) ? run.state._skipNodes : [];
      const toSkip = unreachableFrom(run.nodes, skipTarget, existing);
      run.state = deepMerge(run.state, { _skipNodes: toSkip });
    }
    return { taken: result ? 'then' : 'else' };
  }

  _failRun(id, message) {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'failed';
    run.updatedAt = Date.now();
    run.error = message;
    this._wal({ kind: 'run_errored', runId: id, error: message });
    this._persist(run);
  }
}

// ── Utilities ───────────────────────────────────────────────────────────
function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (b === null || typeof b !== 'object') return b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
    try { return String(readPath(vars, path) ?? ''); } catch (_) { return ''; }
  });
}

function readPath(obj, p) {
  const parts = String(p).split('.').map(s => s.trim()).filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function evalSafe(expr, state) {
  // Evaluate a simple JS expression against `state`. Expression is untrusted
  // (it came from the graph definition), so we use Function constructor with
  // a minimal scope. This is BETA; a proper sandbox (vm.Script) will replace
  // this in a follow-up.
  const fn = new Function('state', `"use strict"; return (${expr});`);
  return fn(state);
}

// Compute the set of nodes that become unreachable when `startId` is skipped,
// given that `alreadySkipped` is the running skip set. A node is unreachable
// only if it has at least one dependency AND every dependency is in the skip
// set. Iterated to a fixed point so chained merges work too.
function unreachableFrom(nodes, startId, alreadySkipped = []) {
  const skip = new Set([...alreadySkipped, startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (skip.has(n.id)) continue;
      const deps = n.dependsOn || [];
      if (!deps.length) continue; // root nodes are never skipped by propagation
      if (deps.every(d => skip.has(d))) {
        skip.add(n.id);
        changed = true;
      }
    }
  }
  return Array.from(skip);
}

function apiRequest(host, port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host, port, path: pathname, method,
      headers: Object.assign({ Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { body: parsed, statusCode: res.statusCode }));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { GraphRunsEngine, STATES, deepMerge, renderTemplate };
