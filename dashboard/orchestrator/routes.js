'use strict';
// Orchestrator HTTP routes - extracted from orchestrator.js (mountOrchestrator).
// registerOrchestratorRoutes(addRoute, json, orch, { getConfig, broadcast, getUiContext })

const fs = require('fs');
const path = require('path');
const permissions = require('../permissions');
const { CLI_MODELS, CLI_CONFIG } = require('./cli-config');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function registerOrchestratorRoutes(addRoute, json, orch, { getConfig, broadcast, getUiContext, repoRoot }) {
  const resolveSpace = (passed) => {
    if (passed !== undefined && passed !== null && passed !== '') return passed;
    try { return (getUiContext && getUiContext().activeSpace) || null; } catch (_) { return null; }
  };

  // Permission gate for spawn-style routes. configPath is derived from repoRoot
  // (falls back to a path relative to this file's grandparent dir) so it reads
  // the SAME config.json the rest of the server uses. This was previously a
  // free-standing helper in orchestrator.js; when the routes moved into this
  // module it was left behind, leaving gateSpawn undefined -> every gated spawn
  // route threw and hung. Defined here now, fed the real repoRoot.
  const configPath = path.join(repoRoot || path.join(__dirname, '..', '..'), 'config', 'config.json');
  async function gateSpawn(res, { cli, cwd, label, wait = true }) {
    return permissions.gate(res, { type: 'cli', value: `${cli}:spawn` }, {
      configPath,
      wait,
      ctx: { worktree: !!cwd && cwd.includes('worktree') },
      actionLabel: label || `Spawn ${cli} worker`,
    });
  }

  // ── GET /api/orchestrator/status ──────────────────────────────────────
  addRoute('GET', '/api/orchestrator/status', (req, res) => {
    const running = [...orch.tasks.values()].filter(t => t.state === 'running' || t.state === 'pending');
    json(res, {
      orchestrating: orch.orchestrating,
      runningTasks: running.length,
      tasks: running.map(t => orch._serializeTask(t)),
    });
  });

  // ── GET /api/orchestrator/agents ──────────────────────────────────────
  addRoute('GET', '/api/orchestrator/agents', (req, res) => {
    json(res, orch.getAgents());
  });

  // ── GET /api/orchestrator/terminal-output ────────────────────────────
  // Lets the AI read what's on a spawned terminal's screen (ANSI-stripped)
  addRoute('GET', '/api/orchestrator/terminal-output', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const termId = url.searchParams.get('termId');
    const lines = parseInt(url.searchParams.get('lines')) || 50;
    if (!termId) return json(res, { error: 'termId required' }, 400);
    const output = orch.termOutput.get(termId) || '';
    // Return last N lines
    const allLines = output.split('\n');
    const lastLines = allLines.slice(-lines).join('\n');
    json(res, { termId, output: lastLines, totalLines: allLines.length });
  });

  // ── POST /api/orchestrator/inject ─────────────────────────────────────
  addRoute('POST', '/api/orchestrator/inject', async (req, res) => {
    const { termId, text } = await readBody(req);
    if (!termId || !text) return json(res, { error: 'termId and text required' }, 400);
    const result = orch.inject(termId, text);
    json(res, result, result.ok ? 200 : 404);
  });

  // ── POST /api/orchestrator/dispatch ───────────────────────────────────
  addRoute('POST', '/api/orchestrator/dispatch', async (req, res) => {
    const { targetTermId, prompt, from, timeout } = await readBody(req);
    if (!targetTermId || !prompt) return json(res, { error: 'targetTermId and prompt required' }, 400);
    try {
      const task = orch.dispatch({ targetTermId, prompt, from, timeout });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── GET /api/orchestrator/cli-models ──────────────────────────────────
  // Returns available models per CLI, enriched with which API keys are configured
  addRoute('GET', '/api/orchestrator/cli-models', (req, res) => {
    const aiKeys = getConfig ? getConfig().AiApiKeys || {} : {};
    const enriched = {};
    for (const [cli, meta] of Object.entries(CLI_MODELS)) {
      enriched[cli] = { ...meta };
      // Indicate which API keys are set (boolean, not the actual key)
      const keyMap = { claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', codex: 'OPENAI_API_KEY', grok: 'XAI_API_KEY', qwen: 'DASHSCOPE_API_KEY' };
      enriched[cli].hasApiKey = !!(keyMap[cli] && aiKeys[keyMap[cli]]);
      // If API key is set, merge apiKeyOnlyModels into available models
      if (enriched[cli].hasApiKey && enriched[cli].apiKeyOnlyModels) {
        enriched[cli].models = [...enriched[cli].models, ...enriched[cli].apiKeyOnlyModels];
      }
      if (enriched[cli].hasApiKey && enriched[cli].paidModels) {
        enriched[cli].models = [...enriched[cli].models, ...enriched[cli].paidModels];
      }
    }
    json(res, enriched);
  });

  // ── POST /api/orchestrator/spawn ──────────────────────────────────────
  addRoute('POST', '/api/orchestrator/spawn', async (req, res) => {
    let { cli, prompt, cwd, timeout, from, taskId, visible, model, effort, autoPermit, space } = await readBody(req);
    if (!prompt) return json(res, { error: 'prompt required' }, 400);
    // Symphonee brain consultation: when cli is omitted, the brain tries
    // to answer locally FIRST (Mind recall or gemma synthesis). Frontier
    // dispatch only happens if the brain says source === 'escalate'.
    // This is the local-first answering path - the user-visible
    // productivity / token-saving win. Pass cli explicitly to bypass.
    let brainPickedCli = null;
    let brainDecision = null;
    let brainAnswered = null;     // populated when source != 'escalate'
    if (!cli && orch.brain && typeof orch.brain.answer === 'function') {
      try {
        const result = await orch.brain.answer(prompt, { source: 'orchestrator/spawn' });
        brainDecision = result && result.decision || null;
        if (result && result.source && result.source !== 'escalate') {
          // Local handled it - return the answer directly. No worker spawn,
          // no frontier tokens spent. Shape mirrors a successful task so
          // callers can treat it uniformly.
          return json(res, {
            ok: true,
            handledLocally: true,
            source: result.source,
            answer: result.answer || null,
            citedNodeIds: result.citedNodeIds || [],
            confidence: result.confidence,
            model: result.model,
            decision: brainDecision,
            tookMs: result.tookMs,
            reason: result.reason || null,
          });
        }
        // Escalate path: use the brain's primary_cli pick to fill in.
        const pick = brainDecision && brainDecision.primary_cli;
        if (pick && pick !== 'none') {
          cli = pick;
          brainPickedCli = pick;
        }
      } catch (_) { /* fall through to the standard error below */ }
    }
    if (!cli) {
      return json(res, {
        error: 'cli is required (the brain classified this input as not needing a worker; pass cli explicitly to override)',
        brainAvailable: !!(orch.brain && typeof orch.brain.answer === 'function'),
        brainDecision,
      }, 400);
    }
    // Check if this CLI is allowed by the user's settings. When the brain
    // picked this CLI in active mode we surface a richer error so the user
    // knows exactly which decision led here and how to unblock it.
    if (getConfig) {
      const cfg = getConfig();
      const allowList = cfg.OrchestrateCliList;
      if (Array.isArray(allowList) && allowList.length > 0 && !allowList.includes(cli)) {
        const errPayload = {
          error: `CLI "${cli}" is not enabled for orchestration. Enable it in Settings > Other.`,
          cli,
          allowList,
          settingsPath: 'Settings > Other > Orchestrate CLI List',
        };
        if (brainPickedCli) {
          errPayload.error = `Symphonee brain picked "${cli}" for this task but that CLI is not in OrchestrateCliList. Add "${cli}" to Settings > Other > Orchestrate CLI List, or pass a different cli explicitly to override the brain pick.`;
          errPayload.brainPickedCli = brainPickedCli;
          errPayload.brainDecision = brainDecision;
          errPayload.howToFix = [
            `Quickest: open Settings > Other and add "${cli}" to the Orchestrate CLI List`,
            `Or pass an explicit cli in the request body to override the brain pick`,
          ];
        }
        return json(res, errPayload, 403);
      }
    }
    if (!await gateSpawn(res, { cli, cwd, label: `Spawn ${cli} worker`, wait: !autoPermit })) return;
    try {
      // Auto-select best mode: pipe mode for CLIs that support it (fast, reliable),
      // visible PTY for interactive CLIs that need a terminal.
      // The 'visible' param can override: visible=true forces PTY, visible=false forces headless.
      const cliCfg = CLI_CONFIG[cli];
      const useVisible = visible === true || (visible !== false && cliCfg && !cliCfg.pipeMode);
      const resolvedSpace = resolveSpace(space);
      const task = useVisible
        ? orch.spawnVisible({ cli, prompt, cwd, timeout, from, taskId, space: resolvedSpace })
        : orch.spawnHeadless({ cli, prompt, cwd, timeout, from, taskId, model, effort, autoPermit, space: resolvedSpace });
      const payload = orch._serializeTask(task);
      if (brainPickedCli) {
        payload.brainPickedCli = brainPickedCli;
        payload.brainDecision = brainDecision;
      }
      json(res, payload);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/followup ───────────────────────────────────
  // Spawn a NEW task that includes the parent task's prompt + result as
  // context, so the user can reply to an AI's question without losing the
  // thread. Each task is still one-shot (stdin closes after write), so the
  // "conversation" is recreated by replaying the prior Q/A inline.
  addRoute('POST', '/api/orchestrator/followup', async (req, res) => {
    const { parentTaskId, prompt, cli: cliOverride, autoPermit, space } = await readBody(req);
    if (!parentTaskId || !prompt) return json(res, { error: 'parentTaskId and prompt required' }, 400);
    const parent = orch.getTask(parentTaskId);
    if (!parent) return json(res, { error: 'Parent task not found' }, 404);
    const cli = cliOverride || parent.cli;
    if (!cli) return json(res, { error: 'Could not resolve CLI for follow-up' }, 400);
    const priorPrompt = String(parent.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim();
    const priorResult = String(parent.result || parent.error || '').trim();
    const combined =
      'This is a follow-up to an earlier conversation.\n\n' +
      '--- EARLIER PROMPT ---\n' + priorPrompt + '\n\n' +
      '--- EARLIER RESPONSE ---\n' + priorResult + '\n\n' +
      '--- USER REPLY ---\n' + String(prompt);
    if (!await gateSpawn(res, { cli, label: `Follow-up to ${parentTaskId.slice(0, 8)}`, wait: !autoPermit })) return;
    try {
      const cliCfg = CLI_CONFIG[cli];
      const useVisible = cliCfg && !cliCfg.pipeMode;
      const inheritedSpace = space !== undefined ? space : ((parent && parent.space) || resolveSpace());
      let task;
      if (useVisible) {
        // Visible PTY spawn types the prompt into a live terminal character-by-character.
        // Embedded newlines in the combined context get interpreted as Enter keypresses
        // and submit partial content, so the worker loses the prior conversation.
        // Fix: write the full context to a file and give the worker a short single-line
        // prompt that points at it.
        const fs = require('fs');
        const path = require('path');
        const contextsDir = path.join(orch.workspaceDir, 'contexts');
        try { fs.mkdirSync(contextsDir, { recursive: true }); } catch (_) {}
        const contextFile = path.join(contextsDir, `followup-${parentTaskId}-${Date.now()}.md`);
        fs.writeFileSync(contextFile, combined, 'utf8');
        const contextPath = contextFile.replace(/\\/g, '/');
        const singleLinePrompt =
          `You have a follow-up reply from the user. Read the full prior conversation from ${contextPath} ` +
          `(it contains the earlier prompt, your earlier response, and the user's new reply under --- USER REPLY ---), ` +
          `then answer the user's reply.`;
        task = orch.spawnVisible({ cli, prompt: singleLinePrompt, from: 'followup', space: inheritedSpace });
      } else {
        task = orch.spawnHeadless({ cli, prompt: combined, from: 'followup', autoPermit, space: inheritedSpace });
      }
      // Tag the parent so clients can display the thread.
      try { task.parentTaskId = parentTaskId; } catch (_) {}
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── GET /api/orchestrator/tasks ───────────────────────────────────────
  addRoute('GET', '/api/orchestrator/tasks', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const state = url.searchParams.get('state');
    const from = url.searchParams.get('from');
    const cli = url.searchParams.get('cli');
    const space = url.searchParams.get('space');
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    json(res, orch.listTasks({ state, from, cli, space, limit }));
  });

  // ── GET /api/orchestrator/tasks/:id ───────────────────────────────────
  addRoute('GET', '/api/orchestrator/task', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) return json(res, { error: 'id query param required' }, 400);
    const task = orch.getTask(id);
    if (!task) return json(res, { error: 'Task not found' }, 404);
    json(res, task);
  });

  // ── POST /api/orchestrator/cancel ─────────────────────────────────────
  addRoute('POST', '/api/orchestrator/cancel', async (req, res) => {
    const { taskId } = await readBody(req);
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    const result = orch.cancelTask(taskId);
    json(res, result, result.ok ? 200 : 400);
  });

  // ── DELETE /api/orchestrator/task ──────────────────────────────────────
  addRoute('DELETE', '/api/orchestrator/task', async (req, res) => {
    const body = await readBody(req);
    const taskId = body.taskId;
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    const result = orch.deleteTask(taskId);
    json(res, result, result.ok ? 200 : 400);
  });

  // ── POST /api/orchestrator/message ────────────────────────────────────
  addRoute('POST', '/api/orchestrator/message', async (req, res) => {
    const { to, from, content, metadata } = await readBody(req);
    if (!to || !content) return json(res, { error: 'to and content required' }, 400);
    const msg = orch.sendMessage({ to, from, content, metadata });
    json(res, msg);
  });

  // ── POST /api/orchestrator/broadcast ──────────────────────────────────
  addRoute('POST', '/api/orchestrator/broadcast', async (req, res) => {
    const { from, content, metadata } = await readBody(req);
    if (!content) return json(res, { error: 'content required' }, 400);
    const msgs = orch.broadcastMessage({ from, content, metadata });
    json(res, { sent: msgs.length, messages: msgs });
  });

  // ── GET /api/orchestrator/inbox ───────────────────────────────────────
  addRoute('GET', '/api/orchestrator/inbox', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const termId = url.searchParams.get('termId');
    const unreadOnly = url.searchParams.get('unread') === '1';
    if (!termId) return json(res, { error: 'termId query param required' }, 400);
    const msgs = unreadOnly ? orch.readUnread(termId) : orch.readInbox(termId);
    json(res, msgs);
  });

  // ── POST /api/orchestrator/inbox/clear ────────────────────────────────
  addRoute('POST', '/api/orchestrator/inbox/clear', async (req, res) => {
    const { termId } = await readBody(req);
    if (!termId) return json(res, { error: 'termId required' }, 400);
    orch.clearInbox(termId);
    json(res, { ok: true });
  });

  // ── POST /api/orchestrator/cleanup ────────────────────────────────────
  addRoute('POST', '/api/orchestrator/cleanup', async (req, res) => {
    const body = await readBody(req);
    // Default: clean all non-running tasks (maxAgeMs=0). Pass maxAgeMs>0 for age-based cleanup.
    // Pass maxAgeMs=-1 to also cancel running tasks.
    const maxAge = body.maxAgeMs !== undefined ? body.maxAgeMs : 0;
    const cleaned = orch.cleanup(maxAge);
    json(res, { cleaned });
  });

  // ── GET /api/orchestrator/circuit-breaker ──────────────────────────────
  addRoute('GET', '/api/orchestrator/circuit-breaker', (req, res) => {
    json(res, orch.circuitBreaker.getStatus());
  });

  // ── POST /api/orchestrator/circuit-breaker/reset ─────────────────────
  addRoute('POST', '/api/orchestrator/circuit-breaker/reset', async (req, res) => {
    const { cli } = await readBody(req);
    if (cli) { orch.circuitBreaker.reset(cli); json(res, { ok: true, cli }); }
    else { json(res, { error: 'cli required' }, 400); }
  });

  // ── GET /api/orchestrator/heartbeats ─────────────────────────────────
  addRoute('GET', '/api/orchestrator/heartbeats', (req, res) => {
    json(res, orch.getHeartbeats());
  });

  // ── POST /api/orchestrator/handoff ───────────────────────────────────
  // Blocking handoff: spawns worker, waits for result, returns it
  addRoute('POST', '/api/orchestrator/handoff', async (req, res) => {
    const { cli, prompt, cwd, from, handoffTimeout } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    // Check CLI allowlist
    if (getConfig) {
      const cfg = getConfig();
      const allowList = cfg.OrchestrateCliList;
      if (Array.isArray(allowList) && allowList.length > 0 && !allowList.includes(cli)) {
        return json(res, { error: `CLI "${cli}" is not enabled for orchestration.` }, 403);
      }
    }
    if (!await gateSpawn(res, { cli, cwd, label: `Handoff to ${cli}` })) return;
    const result = await orch.handoff({ cli, prompt, cwd, from, handoffTimeout });
    json(res, result, result.ok ? 200 : 500);
  });

  // ── POST /api/orchestrator/spawn-with-deps ───────────────────────────
  // Spawn a task that waits for dependencies to complete first
  addRoute('POST', '/api/orchestrator/spawn-with-deps', async (req, res) => {
    const { cli, prompt, cwd, from, dependsOn } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    if (!Array.isArray(dependsOn) || !dependsOn.length) return json(res, { error: 'dependsOn must be a non-empty array of task IDs' }, 400);
    if (!await gateSpawn(res, { cli, cwd, label: `Spawn ${cli} with dependencies` })) return;
    try {
      const task = orch.spawnWithDependencies({ cli, prompt, cwd, from, dependsOn });
      json(res, task);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/spawn-worktree ────────────────────────────
  // Spawn a task in an isolated git worktree
  addRoute('POST', '/api/orchestrator/spawn-worktree', async (req, res) => {
    const { cli, prompt, repoPath, branch, from } = await readBody(req);
    if (!cli || !prompt || !repoPath) return json(res, { error: 'cli, prompt, and repoPath required' }, 400);
    if (!await gateSpawn(res, { cli, cwd: 'worktree', label: `Spawn ${cli} in worktree` })) return;
    try {
      const task = orch.spawnInWorktree({ cli, prompt, repoPath, branch, from });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/cleanup-worktree ──────────────────────────
  addRoute('POST', '/api/orchestrator/cleanup-worktree', async (req, res) => {
    const { taskId } = await readBody(req);
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    json(res, orch.cleanupWorktree(taskId));
  });

  // ── GET /api/orchestrator/checkpoints ────────────────────────────────
  addRoute('GET', '/api/orchestrator/checkpoints', (req, res) => {
    const checkpoints = {};
    for (const [taskId, cp] of orch.checkpoints) {
      checkpoints[taskId] = { ...cp, partial: cp.partial.substring(0, 200) + '...' };
    }
    json(res, checkpoints);
  });

  // ── POST /api/orchestrator/spawn-escalate ──────────────────────────────
  // Spawn with auto-escalation: tries cheapest CLI, escalates on failure
  addRoute('POST', '/api/orchestrator/spawn-escalate', async (req, res) => {
    const { preferCli, prompt, cwd, from } = await readBody(req);
    if (!prompt) return json(res, { error: 'prompt required' }, 400);
    if (!await gateSpawn(res, { cli: preferCli || 'escalation', cwd, label: `Spawn with escalation (prefer ${preferCli || 'auto'})` })) return;
    try {
      const task = orch.spawnWithEscalation({ preferCli, prompt, cwd, from });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/fan-out ───────────────────────────────────
  // Spawn multiple tasks in parallel with staggered starts
  addRoute('POST', '/api/orchestrator/fan-out', async (req, res) => {
    const { tasks: taskConfigs, maxConcurrent, staggerMs, aggregate } = await readBody(req);
    if (!Array.isArray(taskConfigs) || !taskConfigs.length) return json(res, { error: 'tasks array required' }, 400);
    if (!await gateSpawn(res, { cli: 'fan-out', label: `Fan out ${taskConfigs.length} workers` })) return;
    try {
      const result = orch.fanOut(taskConfigs, { maxConcurrent, staggerMs, aggregate });
      json(res, { tasks: result.tasks, aggregate: !!aggregate });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/spawn-lineage ─────────────────────────────
  // Spawn with sibling/parent awareness
  addRoute('POST', '/api/orchestrator/spawn-lineage', async (req, res) => {
    const { cli, prompt, cwd, from, parentTaskId, siblingTaskIds } = await readBody(req);
    if (!cli || !prompt) return json(res, { error: 'cli and prompt required' }, 400);
    if (!await gateSpawn(res, { cli, cwd, label: `Spawn ${cli} with lineage` })) return;
    try {
      const task = orch.spawnWithLineage({ cli, prompt, cwd, from, parentTaskId, siblingTaskIds });
      json(res, orch._serializeTask(task));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ── POST /api/orchestrator/pause ─────────────────────────────────────
  addRoute('POST', '/api/orchestrator/pause', (req, res) => { json(res, orch.pauseAll()); });

  // ── POST /api/orchestrator/resume ────────────────────────────────────
  addRoute('POST', '/api/orchestrator/resume', (req, res) => { json(res, orch.resumeAll()); });

  // ── POST /api/orchestrator/wait-for ──────────────────────────────────
  // Promise-based wait for a task to complete (blocking HTTP call)
  addRoute('POST', '/api/orchestrator/wait-for', async (req, res) => {
    const { taskId, timeoutMs } = await readBody(req);
    if (!taskId) return json(res, { error: 'taskId required' }, 400);
    try {
      const task = await orch.waitFor(taskId, timeoutMs);
      json(res, task);
    } catch (err) {
      json(res, { error: err.message }, 408);
    }
  });

  // ── GET /api/orchestrator/aggregate ──────────────────────────────────
  // Aggregate and rank results from multiple tasks
  addRoute('GET', '/api/orchestrator/aggregate', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const taskIds = (url.searchParams.get('taskIds') || '').split(',').filter(Boolean);
    if (!taskIds.length) return json(res, { error: 'taskIds query param required (comma-separated)' }, 400);
    json(res, orch._aggregateResults(taskIds));
  });

  // ── Heartbeat monitor: detect stale agents and trigger reactions ──────
  setInterval(() => {
    const beats = orch.getHeartbeats();
    for (const beat of beats) {
      if (beat.status === 'stale') {
        orch.broadcast({ type: 'orchestrator-event', event: 'agent-stale', taskId: beat.taskId, cli: beat.cli, idleMs: beat.idleMs, timestamp: Date.now() });
      }
    }
  }, 30000);


}

module.exports = { registerOrchestratorRoutes };
