/**
 * Browser Agent - AI-controlled browser automation via Playwright
 *
 * Enables the AI to perform web tasks: account creation, authentication,
 * form filling, email verification, and session persistence.
 *
 * Uses playwright-core (lightweight, no bundled browsers) with system Edge.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lazy-load playwright-core (optional dependency)
let chromium;
try {
  chromium = require('playwright-core').chromium;
} catch (_) {
  chromium = null;
}

// ── Encryption helpers for session/credential storage ───────────────────────
const ALGO = 'aes-256-gcm';
const os = require('os');

function deriveKey() {
  // Derive a machine-specific key (not truly secure, prevents casual reading)
  const seed = `symphonee:${os.hostname()}:${os.userInfo().username}`;
  return crypto.pbkdf2Sync(seed, 'dp-salt-v1', 100000, 32, 'sha256');
}

function encrypt(text) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

function decrypt(data) {
  const key = deriveKey();
  const [ivHex, tagHex, encrypted] = data.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ── BrowserAgent class ──────────────────────────────────────────────────────
class BrowserAgent {
  constructor({ sessionsDir, getConfig }) {
    this.sessionsDir = sessionsDir;
    this.getConfig = getConfig || (() => ({}));
    this.browser = null;
    this.context = null;
    this.page = null;

    // Ensure sessions directory exists
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
  }

  _ensurePlaywright() {
    if (!chromium) {
      throw new Error('playwright-core is not installed. Run: npm install playwright-core');
    }
  }

  /**
   * Launch a browser instance.
   * @param {Object} opts
   * @param {boolean} [opts.headless=false] - Run headless (user cannot see)
   * @param {string}  [opts.session='default'] - Session name for cookie persistence
   */
  async launch({ headless = false, session = 'default' } = {}) {
    this._ensurePlaywright();

    if (this.browser) {
      await this.close();
    }

    // Try system Edge first, fall back to Chromium
    const launchOpts = { headless };
    try {
      this.browser = await chromium.launch({ ...launchOpts, channel: 'msedge' });
    } catch (_) {
      // Edge not available, try default Chromium
      this.browser = await chromium.launch(launchOpts);
    }

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    // Restore session cookies if available
    await this.loadSession(session);

    this.page = await this.context.newPage();
    this._sessionName = session;

    return { ok: true, session };
  }

  /**
   * Navigate to a URL.
   */
  async navigate(url) {
    this._ensurePage();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: true, url: this.page.url(), title: await this.page.title() };
  }

  /**
   * Fill a form field.
   */
  async fill(selector, value) {
    this._ensurePage();
    await this.page.fill(selector, value);
    return { ok: true };
  }

  /**
   * Click an element.
   */
  async click(selector) {
    this._ensurePage();
    await this.page.click(selector);
    // Wait for navigation or network idle briefly
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { ok: true, url: this.page.url() };
  }

  /**
   * Type text (for inputs that don't work with fill).
   */
  async type(selector, text) {
    this._ensurePage();
    await this.page.type(selector, text);
    return { ok: true };
  }

  /**
   * Take a screenshot, return base64 PNG.
   */
  async screenshot() {
    this._ensurePage();
    const buf = await this.page.screenshot({ type: 'png', fullPage: false });
    return { ok: true, base64: buf.toString('base64'), mimeType: 'image/png' };
  }

  /**
   * Extract text content from the page.
   * @param {Object} opts
   * @param {string} [opts.selector] - CSS selector to extract from (default: body)
   */
  async readPage({ selector } = {}) {
    this._ensurePage();

    const content = await this.page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : document.body;
      if (!el) return '';
      // Remove script and style elements for clean text
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, svg').forEach(e => e.remove());
      return clone.innerText || clone.textContent || '';
    }, selector || null);

    // Cap at 10KB to keep AI context manageable
    const trimmed = content.substring(0, 10240);
    return {
      ok: true,
      url: this.page.url(),
      title: await this.page.title(),
      content: trimmed,
      truncated: content.length > 10240,
    };
  }

  /**
   * Get all elements matching a selector (for AI to understand page structure).
   */
  async queryAll(selector) {
    this._ensurePage();
    const elements = await this.page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).slice(0, 50).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').substring(0, 100),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        href: el.href || null,
        placeholder: el.placeholder || null,
      }));
    }, selector);
    return { ok: true, count: elements.length, elements };
  }

  /**
   * Wait for a selector to appear.
   */
  async waitFor(selector, { timeout = 10000 } = {}) {
    this._ensurePage();
    await this.page.waitForSelector(selector, { timeout });
    return { ok: true };
  }

  /**
   * Get current cookies.
   */
  async getCookies() {
    if (!this.context) return { ok: false, error: 'No browser context' };
    const cookies = await this.context.cookies();
    return { ok: true, count: cookies.length, cookies };
  }

  /**
   * Save current session cookies to disk.
   */
  async saveSession(name) {
    if (!this.context) return { ok: false, error: 'No browser context' };
    name = name || this._sessionName || 'default';
    const cookies = await this.context.cookies();
    const data = encrypt(JSON.stringify(cookies));
    const filePath = path.join(this.sessionsDir, `${name}.session`);
    fs.writeFileSync(filePath, data);
    return { ok: true, session: name, cookies: cookies.length };
  }

  /**
   * Load session cookies from disk.
   */
  async loadSession(name) {
    if (!this.context) return { ok: false, error: 'No browser context' };
    name = name || 'default';
    const filePath = path.join(this.sessionsDir, `${name}.session`);
    if (!fs.existsSync(filePath)) return { ok: true, session: name, restored: 0 };
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const cookies = JSON.parse(decrypt(data));
      await this.context.addCookies(cookies);
      return { ok: true, session: name, restored: cookies.length };
    } catch (e) {
      return { ok: false, error: `Failed to restore session: ${e.message}` };
    }
  }

  /**
   * List available saved sessions.
   */
  listSessions() {
    try {
      const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.session'));
      return { ok: true, sessions: files.map(f => f.replace('.session', '')) };
    } catch (_) {
      return { ok: true, sessions: [] };
    }
  }

  /**
   * Check email for a verification link/code.
   * Navigates to webmail, logs in, and searches for a matching email.
   */
  async checkEmail({ provider = 'gmail', email, password, subjectPattern }) {
    this._ensurePage();
    if (!email || !password) throw new Error('email and password are required');

    if (provider === 'gmail') {
      await this.page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Fill email
      await this.page.waitForSelector('input[type="email"]', { timeout: 10000 });
      await this.page.fill('input[type="email"]', email);
      await this.page.click('#identifierNext');
      await this.page.waitForTimeout(2000);
      // Fill password
      await this.page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await this.page.fill('input[type="password"]', password);
      await this.page.click('#passwordNext');
      await this.page.waitForTimeout(3000);
      // Read inbox
      const content = await this.readPage();
      if (subjectPattern) {
        const regex = new RegExp(subjectPattern, 'i');
        const found = regex.test(content.content);
        return { ok: true, found, content: content.content.substring(0, 5000) };
      }
      return { ok: true, content: content.content.substring(0, 5000) };
    }

    throw new Error(`Email provider "${provider}" is not supported yet. Supported: gmail`);
  }

  /**
   * Press a keyboard key.
   */
  async pressKey(key) {
    this._ensurePage();
    await this.page.keyboard.press(key);
    return { ok: true };
  }

  /**
   * Close the browser.
   */
  async close() {
    // Auto-save session before closing
    if (this.context && this._sessionName) {
      try { await this.saveSession(this._sessionName); } catch (_) {}
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    return { ok: true };
  }

  _ensurePage() {
    if (!this.page) throw new Error('No browser page. Call /api/browser/launch first.');
  }
}

// ── Route mounting ──────────────────────────────────────────────────────────

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

/**
 * Mount browser agent API routes.
 */
function mountBrowserRoutes(addRoute, json, { getConfig, repoRoot }) {
  const sessionsDir = path.join(repoRoot, 'config', 'browser-sessions');
  const agent = new BrowserAgent({ sessionsDir, getConfig });

  const isIncognito = () => (getConfig().IncognitoMode === true);

  // Helper: wrap handler with error handling and incognito guard
  function browserRoute(method, routePath, handler, { checkIncognito = true } = {}) {
    addRoute(method, routePath, async (req, res) => {
      if (checkIncognito && isIncognito()) {
        return json(res, { error: 'Blocked by Incognito Mode: browser automation interacts with external services', incognito: true }, 403);
      }
      try {
        const body = method === 'POST' ? await readBody(req) : {};
        const url = new URL(req.url, `http://${req.headers.host}`);
        const result = await handler(body, url);
        json(res, result);
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
    });
  }

  browserRoute('POST', '/api/browser/launch', (body) => agent.launch(body));
  browserRoute('POST', '/api/browser/navigate', (body) => agent.navigate(body.url));
  browserRoute('POST', '/api/browser/fill', (body) => agent.fill(body.selector, body.value));
  browserRoute('POST', '/api/browser/click', (body) => agent.click(body.selector));
  browserRoute('POST', '/api/browser/type', (body) => agent.type(body.selector, body.text));
  browserRoute('POST', '/api/browser/press-key', (body) => agent.pressKey(body.key));
  browserRoute('POST', '/api/browser/wait-for', (body) => agent.waitFor(body.selector, body));
  browserRoute('POST', '/api/browser/save-session', (body) => agent.saveSession(body.name));
  browserRoute('POST', '/api/browser/close', () => agent.close());
  browserRoute('POST', '/api/browser/check-email', (body) => agent.checkEmail(body));

  // Read-only endpoints (no incognito guard needed)
  browserRoute('GET', '/api/browser/screenshot', () => agent.screenshot(), { checkIncognito: false });
  browserRoute('GET', '/api/browser/read-page', (_, url) => agent.readPage({ selector: url.searchParams.get('selector') }), { checkIncognito: false });
  browserRoute('GET', '/api/browser/query-all', (_, url) => agent.queryAll(url.searchParams.get('selector') || '*'), { checkIncognito: false });
  browserRoute('GET', '/api/browser/cookies', () => agent.getCookies(), { checkIncognito: false });
  browserRoute('GET', '/api/browser/sessions', () => agent.listSessions(), { checkIncognito: false });

  // Dedicated endpoint for AI to check its saved accounts (no incognito guard, read-only)
  browserRoute('GET', '/api/browser/accounts', () => {
    const cfg = getConfig();
    const creds = cfg.BrowserCredentials || {};
    const accounts = Object.entries(creds).map(([name, data]) => ({
      name,
      email: data.email,
      hasPassword: !!data.password,
    }));
    return { ok: true, count: accounts.length, accounts };
  }, { checkIncognito: false });

  return agent;
}

module.exports = { BrowserAgent, mountBrowserRoutes };
