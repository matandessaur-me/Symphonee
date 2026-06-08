/**
 * Apps goal planner.
 *
 * At session start, asks the provider to decompose the user's goal into
 * 3-7 subgoals with visual completion checks. Tracks subgoal state on
 * the session (pending | active | done | blocked | skipped) and
 * auto-declares stuck after repeated failed attempts on the active
 * subgoal.
 *
 * Tools the agent can call inside runSession:
 *   set_subgoal({ id, title, completionCheck?, parentId?, status? })
 *   complete_subgoal({ id, evidence? })
 */

const https = require('https');

const MAX_ATTEMPTS_PER_SUBGOAL = 3;

function _makeId(title) {
  return 'sg-' + String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '-' + Math.random().toString(36).slice(2, 6);
}

function createEmptyPlan(goal) {
  return {
    goal: String(goal || ''),
    subgoals: [],     // [{ id, title, completionCheck?, parentId?, status, evidence?, attempts }]
    activeId: null,
    createdAt: Date.now(),
  };
}

function addSubgoal(plan, { id, title, completionCheck, parentId, status = 'pending' }) {
  if (!title) throw new Error('title required');
  const realId = id || _makeId(title);
  // Replace if same id already exists (idempotent update).
  const existing = plan.subgoals.findIndex(s => s.id === realId);
  const record = {
    id: realId, title: String(title).slice(0, 160),
    completionCheck: completionCheck ? String(completionCheck).slice(0, 260) : null,
    parentId: parentId || null,
    status: ['pending', 'active', 'done', 'blocked', 'skipped'].includes(status) ? status : 'pending',
    evidence: null,
    attempts: 0,
  };
  if (existing >= 0) {
    // Preserve attempts + evidence across re-adds; let title/check update.
    const prev = plan.subgoals[existing];
    record.attempts = prev.attempts;
    record.evidence = prev.evidence;
    record.status = record.status === 'pending' ? prev.status : record.status;
    plan.subgoals[existing] = record;
  } else {
    plan.subgoals.push(record);
  }
  if (!plan.activeId && record.status === 'pending') {
    record.status = 'active';
    plan.activeId = record.id;
  }
  return record;
}

function completeSubgoal(plan, id, evidence) {
  const sg = plan.subgoals.find(s => s.id === id);
  if (!sg) throw new Error('unknown subgoal: ' + id);
  sg.status = 'done';
  sg.evidence = evidence ? String(evidence).slice(0, 400) : null;
  if (plan.activeId === id) {
    const next = plan.subgoals.find(s => s.status === 'pending');
    plan.activeId = next ? next.id : null;
    if (next) next.status = 'active';
  }
  return { ok: true, activeId: plan.activeId, subgoal: sg };
}

// Count a FAILED attempt against the active subgoal. Successful tool
// calls are progress, not attempts, so they do not count.
function bumpAttempt(plan, { failed = false } = {}) {
  if (!plan || !plan.activeId) return { attempts: 0, overBudget: false };
  const sg = plan.subgoals.find(s => s.id === plan.activeId);
  if (!sg) return { attempts: 0, overBudget: false };
  if (!failed) return { attempts: sg.attempts || 0, overBudget: false, subgoal: sg };
  sg.attempts = (sg.attempts || 0) + 1;
  return {
    attempts: sg.attempts,
    overBudget: sg.attempts >= MAX_ATTEMPTS_PER_SUBGOAL,
    subgoal: sg,
  };
}

function summarizeForPrompt(plan) {
  if (!plan || !plan.subgoals.length) return '';
  const lines = plan.subgoals.map(s => {
    const mark = s.status === 'done' ? '[x]' :
                 s.status === 'active' ? '[>]' :
                 s.status === 'blocked' ? '[!]' :
                 s.status === 'skipped' ? '[-]' : '[ ]';
    return `- ${mark} ${s.title}` + (s.completionCheck ? `  (done when: ${s.completionCheck})` : '');
  });
  return '\n\n## Plan\n' + lines.join('\n') +
    `\n\nThe currently active subgoal is the one marked [>]. Focus on it. Call complete_subgoal when its visual check is satisfied; add or revise subgoals with set_subgoal if the plan needs to change.`;
}

// ---- Decomposition -----------------------------------------------------------

async function decompose({ goal, app, providerEntry, model }) {
  if (!goal || !providerEntry) return null;
  const adapter = providerEntry.adapter;
  const prompt = [
    `You are an AI agent that drives a Windows application called "${app || 'the target app'}" via pixel-level mouse and keyboard control.`,
    `Break this goal into 2-6 concrete subgoals with a visual completion check for each:`,
    ``,
    `GOAL: ${goal}`,
    ``,
    `Respond ONLY as compact JSON of the form:`,
    `[{"title":"...","completionCheck":"..."}, ...]`,
    `Titles should be short actionable phrases. completionCheck should describe what the screenshot should show when this subgoal is done (e.g. "the File menu is open", "the word 'Tuesday' appears in the document"). Do NOT wrap the JSON in markdown.`,
  ].join('\n');

  try {
    // Use a direct provider call with a tiny token budget. We reuse the
    // adapter's call() path but with no tools so it returns plain text.
    const resp = await _callJson(adapter, providerEntry, model, prompt);
    const text = (resp && resp.text ? resp.text : '').trim();
    const json = _extractJsonArray(text);
    if (!Array.isArray(json)) return null;
    const subgoals = json.slice(0, 7)
      .map(s => s && typeof s === 'object' ? { title: s.title || s.name, completionCheck: s.completionCheck || s.check || null } : null)
      .filter(Boolean)
      .filter(s => s.title && typeof s.title === 'string');
    return subgoals.length ? subgoals : null;
  } catch (_) {
    return null;
  }
}

function _extractJsonArray(text) {
  if (!text) return null;
  // Most providers should return raw JSON; some may wrap in ```json.
  const stripped = text.replace(/```json\s*|```/gi, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  // Last-resort: find the first [ ... ] in the response.
  const m = /\[[\s\S]*\]/.exec(stripped);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// Minimal provider call without tools. Not every adapter has a "plain"
// path, so we construct the request per-kind here.
async function _callJson(adapter, providerEntry, model, prompt) {
  const key = providerEntry.apiKey;
  if (adapter.kind === 'anthropic') {
    return _httpJson({
      hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: {
        model: model || adapter.defaultModel, max_tokens: 512,
        system: 'You are a brief task-decomposer. Respond in raw JSON only.',
        messages: [{ role: 'user', content: prompt }],
      },
    }).then(r => ({ text: (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') }));
  }
  if (adapter.kind === 'gemini') {
    return _httpJson({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model || adapter.defaultModel}:generateContent?key=${encodeURIComponent(key)}`,
      body: {
        systemInstruction: { parts: [{ text: 'You are a brief task-decomposer. Respond in raw JSON only.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 512 },
      },
    }).then(r => {
      const parts = (r.candidates && r.candidates[0] && r.candidates[0].content && r.candidates[0].content.parts) || [];
      return { text: parts.filter(p => p.text).map(p => p.text).join('\n') };
    });
  }
  // OpenAI-compatible family.
  const baseHost = _openaiHost(adapter);
  const basePath = _openaiPath(adapter);
  return _httpJson({
    hostname: baseHost, path: basePath,
    headers: { Authorization: 'Bearer ' + key },
    body: {
      model: model || adapter.defaultModel, max_tokens: 512,
      messages: [
        { role: 'system', content: 'You are a brief task-decomposer. Respond in raw JSON only.' },
        { role: 'user', content: prompt },
      ],
    },
  }).then(r => ({ text: (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '' }));
}

function _openaiHost(adapter) {
  // Adapter doesn't expose its host; we have to re-derive from label.
  const label = (adapter.label || '').toLowerCase();
  if (label.includes('grok')) return 'api.x.ai';
  if (label.includes('qwen')) return 'dashscope-intl.aliyuncs.com';
  return 'api.openai.com';
}
function _openaiPath(adapter) {
  const label = (adapter.label || '').toLowerCase();
  if (label.includes('qwen')) return '/compatible-mode/v1/chat/completions';
  return '/v1/chat/completions';
}

function _httpJson({ hostname, path, headers = {}, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      method: 'POST', hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`${hostname} ${res.statusCode}: ${data.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(hostname + ' request timed out')));
    req.write(payload); req.end();
  });
}

module.exports = {
  MAX_ATTEMPTS_PER_SUBGOAL,
  createEmptyPlan,
  addSubgoal,
  completeSubgoal,
  bumpAttempt,
  summarizeForPrompt,
  decompose,
};
