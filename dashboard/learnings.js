/**
 * Learnings — Collective intelligence for DevOps Pilot
 *
 * Records generic technical learnings (CLI flags, shell quirks, platform issues)
 * and syncs them across installations via the plugin registry repo.
 *
 * SAFETY: Never stores company names, project names, secrets, URLs, file paths,
 * or any data that could identify a user or organization.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ── Categories ──────────────────────────────────────────────────────────────
const CATEGORIES = ['cli-flags', 'shell', 'platform', 'orchestration', 'api-pattern', 'general'];

// ── Sanitization patterns (strip before sharing) ────────────────────────────
const SANITIZE_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,                // emails
  /\b(ghp_|bpk-|sk-|xai-|gsk_|pat-|token-)[A-Za-z0-9_-]+/g,             // API keys/tokens
  /\b(https?:\/\/(?!127\.0\.0\.1:3800)[^\s"'`]+)/g,                       // external URLs (keep localhost API)
  /[A-Z]:\\[^\s"'`]+/g,                                                    // Windows absolute paths
  /\/(?:home|Users|mnt)\/[^\s"'`]+/g,                                     // Unix home paths
  /\b(?:password|secret|credential|passwd)\s*[:=]\s*\S+/gi,               // inline secrets
];

// Words that indicate company/project-specific content
const COMPANY_INDICATORS = [
  /\b(bathfitter|bath fitter|ontheweb|webcity|aleoresto)\b/gi,
  /\b(client|customer|our company|our team|our project)\b/gi,
  /\b(internal|proprietary|confidential)\b/gi,
];

class Learnings {
  /**
   * @param {Object} opts
   * @param {string} opts.dataDir  — directory for learnings.json (e.g., .ai-workspace/)
   * @param {Function} opts.getConfig — returns app config (for GitHub PAT)
   */
  constructor({ dataDir, getConfig }) {
    this.dataDir = dataDir;
    this.getConfig = getConfig;
    this.filePath = path.join(dataDir, 'learnings.json');
    this.learnings = [];
    this._load();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Get all learnings, optionally filtered */
  list({ category, cli, source } = {}) {
    let items = [...this.learnings];
    if (category) items = items.filter(l => l.category === category);
    if (cli) items = items.filter(l => l.cli === cli);
    if (source) items = items.filter(l => l.source === source);
    return items;
  }

  /** Add a learning. Returns the created entry or null if rejected by sanitization. */
  add({ category, cli, summary, detail, source }) {
    if (!summary || !category) return null;
    if (!CATEGORIES.includes(category)) category = 'general';

    // Sanitize: reject if it contains company-specific content
    const fullText = (summary + ' ' + (detail || '')).toLowerCase();
    for (const pattern of COMPANY_INDICATORS) {
      if (pattern.test(fullText)) {
        pattern.lastIndex = 0;
        return null; // Reject — contains company-specific content
      }
    }

    // Check for duplicates (same category + similar summary)
    const exists = this.learnings.some(l =>
      l.category === category && l.summary.toLowerCase() === summary.toLowerCase()
    );
    if (exists) return null;

    const cleanSummary = this._sanitize(summary);
    const cleanDetail = detail ? this._sanitize(detail) : null;

    // Reject if sanitization found sensitive content
    if (/\[REDACTED\]/.test(cleanSummary) || (cleanDetail && /\[REDACTED\]/.test(cleanDetail))) {
      return null;
    }

    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      category,
      cli: cli || null,
      summary: cleanSummary,
      detail: cleanDetail,
      source: source || 'manual',  // 'auto' = orchestrator detected, 'manual' = AI/user added
      addedAt: new Date().toISOString().split('T')[0],
      synced: false,
    };

    this.learnings.push(entry);
    this._save();
    // Auto-push to shared repo after recording (debounced, non-blocking)
    this._schedulePush();
    return entry;
  }

  /** Debounced auto-push: waits 10 seconds after last add, then pushes all unsynced */
  _schedulePush() {
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => {
      this.push().then(r => {
        if (r.pushed > 0) console.log(`  [learnings] Auto-pushed ${r.pushed} learning(s) to shared repo`);
      }).catch(() => {});
    }, 10000); // 10 second debounce
  }

  /** Delete a learning by ID */
  remove(id) {
    const idx = this.learnings.findIndex(l => l.id === id);
    if (idx === -1) return false;
    this.learnings.splice(idx, 1);
    this._save();
    return true;
  }

  // ── Auto-record from orchestrator failures ────────────────────────────────

  /** Called by the orchestrator when a headless spawn fails */
  recordFailure({ cli, args, error }) {
    if (!cli || !error) return;
    const errLower = error.toLowerCase();

    // Record generic CLI/platform errors AND model compatibility errors
    const isGeneric =
      /unexpected argument|unrecognized option|unknown (flag|option)|invalid option|bad flag|not a.*command/i.test(error) ||
      /cannot use both|mutually exclusive/i.test(error) ||
      /command not found|is not recognized|not installed/i.test(error) ||
      /ECONNREFUSED|ETIMEDOUT|ENOENT/i.test(error) ||
      /permission denied|access denied/i.test(error) ||
      /syntax error|parse error/i.test(error);

    const isModelError =
      /model.*not supported|not.*supported.*model|invalid.*model|unknown model|model.*not available/i.test(error) ||
      /not supported when using.*account/i.test(error) ||
      /requires.*api.?key|requires.*billing|requires.*paid/i.test(error) ||
      /rate.?limit|quota.*exceeded|insufficient.*credits/i.test(error);

    if (!isGeneric && !isModelError) return null;

    // Determine category
    let category = 'general';
    if (/unexpected argument|unrecognized|unknown.*flag|cannot use both/i.test(error)) category = 'cli-flags';
    else if (/command not found|not recognized|not installed/i.test(error)) category = 'platform';
    else if (/ECONNREFUSED|ETIMEDOUT/i.test(error)) category = 'api-pattern';
    else if (/syntax error|parse error/i.test(error)) category = 'shell';
    else if (isModelError) category = 'cli-flags'; // model errors go with CLI config issues

    const summary = `${cli}: ${error.substring(0, 120).replace(/[\r\n]+/g, ' ')}`;
    const detail = args ? `Failed args: ${JSON.stringify(args)}` : null;

    return this.add({ category, cli, summary, detail, source: 'auto' });
  }

  // ── Instruction injection ─────────────────────────────────────────────────

  /** Generate a markdown block to inject into instruction files */
  toMarkdown() {
    if (!this.learnings.length) return '';

    let md = '\n## Known Issues and Learnings\n\n';
    md += 'These are automatically collected technical learnings. Follow them to avoid known pitfalls.\n\n';

    // Group by category
    const groups = {};
    for (const l of this.learnings) {
      if (!groups[l.category]) groups[l.category] = [];
      groups[l.category].push(l);
    }

    const labels = {
      'cli-flags': 'CLI Flags and Invocations',
      'shell': 'Shell and Path Gotchas',
      'platform': 'Platform and Environment',
      'orchestration': 'Orchestration Patterns',
      'api-pattern': 'API Patterns',
      'general': 'General',
    };

    for (const [cat, items] of Object.entries(groups)) {
      md += `### ${labels[cat] || cat}\n`;
      for (const l of items) {
        md += `- ${l.summary}`;
        if (l.detail) md += ` -- ${l.detail}`;
        md += '\n';
      }
      md += '\n';
    }

    return md;
  }

  // ── Sync with shared registry ─────────────────────────────────────────────

  /** Pull learnings from the shared registry repo */
  async pull() {
    try {
      const data = await this._fetchSharedLearnings();
      if (!data || !Array.isArray(data.learnings)) return { pulled: 0 };

      let added = 0;
      for (const remote of data.learnings) {
        // Skip if we already have this (by summary match)
        const exists = this.learnings.some(l =>
          l.summary.toLowerCase() === remote.summary.toLowerCase()
        );
        if (exists) continue;

        // Validate before accepting
        if (!remote.summary || !remote.category) continue;
        if (!CATEGORIES.includes(remote.category)) continue;

        // Re-sanitize incoming data (trust no one)
        const clean = {
          id: crypto.randomBytes(4).toString('hex'),
          category: remote.category,
          cli: remote.cli || null,
          summary: this._sanitize(remote.summary),
          detail: remote.detail ? this._sanitize(remote.detail) : null,
          source: 'shared',
          addedAt: remote.addedAt || new Date().toISOString().split('T')[0],
          synced: true,
        };

        this.learnings.push(clean);
        added++;
      }

      if (added > 0) this._save();
      return { pulled: added };
    } catch (e) {
      return { pulled: 0, error: e.message };
    }
  }

  /** Push unsynced learnings to the shared registry repo */
  async push() {
    const cfg = this.getConfig();
    const pat = cfg.GitHubPAT;
    if (!pat) return { pushed: 0, error: 'No GitHub PAT configured' };

    const unsynced = this.learnings.filter(l => !l.synced && l.source !== 'shared');
    if (!unsynced.length) return { pushed: 0 };

    try {
      // Fetch current shared learnings
      const { content: existing, sha } = await this._fetchSharedFile();
      const shared = existing ? JSON.parse(existing) : { version: 1, learnings: [] };

      // Merge unsynced entries (skip duplicates)
      let added = 0;
      for (const local of unsynced) {
        const dup = shared.learnings.some(s =>
          s.summary.toLowerCase() === local.summary.toLowerCase()
        );
        if (dup) continue;

        // Final sanitization pass before pushing
        const safe = {
          category: local.category,
          cli: local.cli,
          summary: this._sanitize(local.summary),
          detail: local.detail ? this._sanitize(local.detail) : null,
          addedAt: local.addedAt,
        };

        // Final safety check: reject if sanitized text looks suspicious
        if (this._isSuspicious(safe.summary + ' ' + (safe.detail || ''))) continue;

        shared.learnings.push(safe);
        added++;
      }

      if (added === 0) return { pushed: 0 };

      shared.updated = new Date().toISOString().split('T')[0];

      // Push to GitHub
      await this._pushSharedFile(JSON.stringify(shared, null, 2) + '\n', sha, pat,
        `Add ${added} learning(s) from DevOps Pilot instance`);

      // Mark as synced
      for (const l of unsynced) l.synced = true;
      this._save();

      return { pushed: added };
    } catch (e) {
      return { pushed: 0, error: e.message };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.learnings = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {
      this.learnings = [];
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.learnings, null, 2));
    } catch (_) {}
  }

  /** Strip sensitive data from text */
  _sanitize(text) {
    let clean = text;
    for (const pattern of SANITIZE_PATTERNS) {
      clean = clean.replace(pattern, '[REDACTED]');
    }
    // Remove runs of redacted markers
    clean = clean.replace(/(\[REDACTED\]\s*){2,}/g, '[REDACTED] ');
    return clean.trim();
  }

  /** Extra paranoia check before pushing to shared */
  _isSuspicious(text) {
    const lower = text.toLowerCase();
    // Reject if it still contains potential secrets after sanitization
    if (/\[REDACTED\]/.test(text)) return true;
    // Reject if it mentions specific companies/projects
    for (const pattern of COMPANY_INDICATORS) {
      if (pattern.test(lower)) { pattern.lastIndex = 0; return true; }
    }
    return false;
  }

  /** Fetch learnings.json from the shared registry repo (public, no PAT needed) */
  async _fetchSharedLearnings() {
    const { content } = await this._fetchSharedFile();
    return content ? JSON.parse(content) : null;
  }

  /** Fetch the raw file + sha from GitHub */
  _fetchSharedFile() {
    const REPO_API = '/repos/matandessaur-me/devops-pilot-plugins/contents/learnings.json';
    return new Promise((resolve, reject) => {
      const cfg = this.getConfig();
      const headers = { 'User-Agent': 'DevOps-Pilot', 'Accept': 'application/vnd.github.v3+json' };
      if (cfg.GitHubPAT) headers['Authorization'] = 'token ' + cfg.GitHubPAT;
      https.get({ hostname: 'api.github.com', path: REPO_API, headers }, (resp) => {
        let d = '';
        resp.on('data', c => { d += c; });
        resp.on('end', () => {
          try {
            const file = JSON.parse(d);
            if (!file.content) { resolve({ content: null, sha: null }); return; }
            const decoded = Buffer.from(file.content, 'base64').toString();
            resolve({ content: decoded, sha: file.sha });
          } catch (e) { resolve({ content: null, sha: null }); }
        });
      }).on('error', () => resolve({ content: null, sha: null }));
    });
  }

  /** Push file content to GitHub */
  _pushSharedFile(content, sha, pat, message) {
    const REPO_API = '/repos/matandessaur-me/devops-pilot-plugins/contents/learnings.json';
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        message,
        content: Buffer.from(content).toString('base64'),
        sha: sha || undefined,
      });
      const req = https.request({
        hostname: 'api.github.com',
        path: REPO_API,
        method: 'PUT',
        headers: {
          'User-Agent': 'DevOps-Pilot',
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': 'token ' + pat,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (resp) => {
        let d = '';
        resp.on('data', c => { d += c; });
        resp.on('end', () => {
          if (resp.statusCode === 200 || resp.statusCode === 201) resolve();
          else reject(new Error('GitHub API ' + resp.statusCode + ': ' + d.substring(0, 200)));
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ── Mount API routes ────────────────────────────────────────────────────────

function mountLearnings(addRoute, json, { dataDir, getConfig, readBody }) {
  const learnings = new Learnings({ dataDir, getConfig });

  // GET /api/learnings — list all learnings
  addRoute('GET', '/api/learnings', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const category = url.searchParams.get('category');
    const cli = url.searchParams.get('cli');
    json(res, learnings.list({ category, cli }));
  });

  // GET /api/learnings/markdown — get learnings as markdown (for AI consumption)
  addRoute('GET', '/api/learnings/markdown', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(learnings.toMarkdown());
  });

  // POST /api/learnings — add a learning
  addRoute('POST', '/api/learnings', async (req, res) => {
    const body = await readBody(req);
    const entry = learnings.add(body);
    if (!entry) return json(res, { error: 'Rejected: duplicate or contains sensitive/company-specific content' }, 400);
    json(res, entry);
  });

  // DELETE /api/learnings — delete a learning
  addRoute('DELETE', '/api/learnings', async (req, res) => {
    const body = await readBody(req);
    if (!body.id) return json(res, { error: 'id required' }, 400);
    const ok = learnings.remove(body.id);
    json(res, { ok }, ok ? 200 : 404);
  });

  // POST /api/learnings/sync — pull from shared + push unsynced
  addRoute('POST', '/api/learnings/sync', async (req, res) => {
    const pullResult = await learnings.pull();
    const pushResult = await learnings.push();
    json(res, { pulled: pullResult.pulled, pushed: pushResult.pushed, errors: [pullResult.error, pushResult.error].filter(Boolean) });
  });

  // POST /api/learnings/pull — pull only (no push)
  addRoute('POST', '/api/learnings/pull', async (req, res) => {
    const result = await learnings.pull();
    json(res, result);
  });

  return learnings;
}

module.exports = { Learnings, mountLearnings };
