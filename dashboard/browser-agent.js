/**
 * Browser Agent - AI-controlled browser automation
 *
 * Drives a browser for AI tasks: account creation, authentication, form
 * filling, email verification, session persistence.
 *
 * Driver model:
 *   - When running inside Electron, electron-main.js installs an
 *     "internal-webview" driver that routes every automation call through
 *     the <webview> in the Browser tab via webContents + CDP. Nothing opens
 *     an external browser window.
 *   - When running outside Electron (pure server, tests), falls back to
 *     playwright-core targeting a system Edge/Chrome install.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Lazy-load playwright-core (only used by the fallback driver)
let chromium;
try {
  chromium = require('playwright-core').chromium;
} catch (_) {
  chromium = null;
}

// ── Encryption helpers for session/credential storage ───────────────────────
const ALGO = 'aes-256-gcm';

function deriveKey() {
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

// ── Playwright driver (fallback when not in Electron) ──────────────────────
function makePlaywrightDriver() {
  let browser = null;
  let context = null;
  let page = null;
  let launchedVia = null;

  function _ensurePlaywright() {
    if (!chromium) {
      throw new Error('playwright-core is not installed. Run: npm install playwright-core');
    }
  }

  function _ensurePage() {
    if (!page) throw new Error('No browser page. Call /api/browser/launch first.');
  }

  function _resolveBrowserCandidates() {
    const list = [];
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    if (isWin) {
      const edgePaths = [
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter(Boolean);
      const chromePaths = [
        process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].filter(Boolean);
      for (const p of edgePaths) {
        if (fs.existsSync(p)) { list.push({ label: 'Microsoft Edge', executablePath: p }); break; }
      }
      for (const p of chromePaths) {
        if (fs.existsSync(p)) { list.push({ label: 'Google Chrome', executablePath: p }); break; }
      }
    } else if (isMac) {
      const macPaths = [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ];
      for (const p of macPaths) {
        if (fs.existsSync(p)) list.push({ label: path.basename(p), executablePath: p });
      }
    } else {
      const linuxBins = ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
      for (const p of linuxBins) {
        if (fs.existsSync(p)) list.push({ label: path.basename(p), executablePath: p });
      }
    }

    list.push({ label: 'Edge (channel)', channel: 'msedge' });
    list.push({ label: 'Chrome (channel)', channel: 'chrome' });
    list.push({ label: 'Playwright chromium' });
    return list;
  }

  return {
    kind: 'playwright',
    async launch({ headless = false } = {}) {
      _ensurePlaywright();
      if (browser) await this.close();
      const launchOpts = { headless };
      const candidates = _resolveBrowserCandidates();
      let lastErr = null;
      for (const c of candidates) {
        try {
          const opts = { ...launchOpts };
          if (c.channel) opts.channel = c.channel;
          if (c.executablePath) opts.executablePath = c.executablePath;
          browser = await chromium.launch(opts);
          launchedVia = c.label;
          break;
        } catch (err) { lastErr = err; }
      }
      if (!browser) {
        const hint = process.platform === 'win32'
          ? 'Install Microsoft Edge or Google Chrome, or run: npx playwright install chromium'
          : 'Install Google Chrome, or run: npx playwright install chromium';
        const err = new Error('Failed to launch a browser for automation. ' + hint +
          (lastErr ? ' (last error: ' + (lastErr.message || lastErr) + ')' : ''));
        err.code = 'BROWSER_NOT_FOUND';
        throw err;
      }
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      page = await context.newPage();
      return { launchedVia };
    },
    async navigate(url) {
      _ensurePage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { url: page.url(), title: await page.title() };
    },
    async fill(selector, value) {
      _ensurePage(); await page.fill(selector, value);
    },
    async click(selector) {
      _ensurePage();
      await page.click(selector);
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return { url: page.url() };
    },
    async type(selector, text) {
      _ensurePage(); await page.type(selector, text);
    },
    async pressKey(key) {
      _ensurePage(); await page.keyboard.press(key);
    },
    async waitFor(selector, { timeout = 10000 } = {}) {
      _ensurePage(); await page.waitForSelector(selector, { timeout });
    },
    async screenshot() {
      _ensurePage();
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      return { base64: buf.toString('base64'), mimeType: 'image/png' };
    },
    async readPage({ selector } = {}) {
      _ensurePage();
      const content = await page.evaluate((sel) => {
        const el = sel ? document.querySelector(sel) : document.body;
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg').forEach(e => e.remove());
        return clone.innerText || clone.textContent || '';
      }, selector || null);
      return { url: page.url(), title: await page.title(), content };
    },
    async queryAll(selector) {
      _ensurePage();
      const elements = await page.evaluate((sel) => {
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
      return { elements };
    },
    async getCookies() {
      if (!context) return { cookies: [] };
      return { cookies: await context.cookies() };
    },
    async setCookies(cookies) {
      if (!context) return;
      await context.addCookies(cookies);
    },
    async close() {
      if (browser) {
        await browser.close().catch(() => {});
        browser = null; context = null; page = null;
      }
    },
  };
}

// ── BrowserAgent ───────────────────────────────────────────────────────────
class BrowserAgent {
  constructor({ sessionsDir, getConfig, driver }) {
    this.sessionsDir = sessionsDir;
    this.getConfig = getConfig || (() => ({}));
    this.driver = driver || null;       // may be installed later by electron-main
    this._fallbackDriver = null;         // lazy playwright
    this._sessionName = null;
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  }

  setDriver(driver) { this.driver = driver; }

  _driver() {
    if (this.driver) return this.driver;
    if (!this._fallbackDriver) this._fallbackDriver = makePlaywrightDriver();
    return this._fallbackDriver;
  }

  async launch({ headless = false, session = 'default' } = {}) {
    const d = this._driver();
    const r = await d.launch({ headless });
    this._sessionName = session;
    await this.loadSession(session).catch(() => {});
    return { ok: true, session, launchedVia: (r && r.launchedVia) || d.kind };
  }

  async navigate(url) {
    const r = await this._driver().navigate(url);
    return { ok: true, ...(r || {}) };
  }

  async fill(selector, value) {
    await this._driver().fill(selector, value);
    return { ok: true };
  }

  async click(selector) {
    const r = await this._driver().click(selector);
    return { ok: true, ...(r || {}) };
  }

  async type(selector, text) {
    await this._driver().type(selector, text);
    return { ok: true };
  }

  async pressKey(key) {
    await this._driver().pressKey(key);
    return { ok: true };
  }

  async waitFor(selector, opts = {}) {
    await this._driver().waitFor(selector, opts);
    return { ok: true };
  }

  async screenshot() {
    const r = await this._driver().screenshot();
    return { ok: true, base64: r.base64, mimeType: r.mimeType || 'image/png' };
  }

  async readPage(opts = {}) {
    const r = await this._driver().readPage(opts);
    const content = (r && r.content) || '';
    const trimmed = content.substring(0, 10240);
    return { ok: true, url: r.url, title: r.title, content: trimmed, truncated: content.length > 10240 };
  }

  async queryAll(selector) {
    const r = await this._driver().queryAll(selector);
    const elements = (r && r.elements) || [];
    return { ok: true, count: elements.length, elements };
  }

  async getCookies() {
    const r = await this._driver().getCookies();
    const cookies = (r && r.cookies) || [];
    return { ok: true, count: cookies.length, cookies };
  }

  async saveSession(name) {
    const r = await this._driver().getCookies();
    const cookies = (r && r.cookies) || [];
    name = name || this._sessionName || 'default';
    const data = encrypt(JSON.stringify(cookies));
    fs.writeFileSync(path.join(this.sessionsDir, `${name}.session`), data);
    return { ok: true, session: name, cookies: cookies.length };
  }

  async loadSession(name) {
    name = name || 'default';
    const filePath = path.join(this.sessionsDir, `${name}.session`);
    if (!fs.existsSync(filePath)) return { ok: true, session: name, restored: 0 };
    try {
      const cookies = JSON.parse(decrypt(fs.readFileSync(filePath, 'utf8')));
      await this._driver().setCookies(cookies);
      return { ok: true, session: name, restored: cookies.length };
    } catch (e) {
      return { ok: false, error: `Failed to restore session: ${e.message}` };
    }
  }

  listSessions() {
    try {
      const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.session'));
      return { ok: true, sessions: files.map(f => f.replace('.session', '')) };
    } catch (_) {
      return { ok: true, sessions: [] };
    }
  }

  async checkEmail({ provider = 'gmail', email, password, subjectPattern }) {
    if (!email || !password) throw new Error('email and password are required');
    if (provider !== 'gmail') throw new Error(`Email provider "${provider}" is not supported yet. Supported: gmail`);
    const d = this._driver();
    await d.navigate('https://mail.google.com');
    await d.waitFor('input[type="email"]', { timeout: 10000 });
    await d.fill('input[type="email"]', email);
    await d.click('#identifierNext');
    await new Promise(r => setTimeout(r, 2000));
    await d.waitFor('input[type="password"]', { timeout: 10000 });
    await d.fill('input[type="password"]', password);
    await d.click('#passwordNext');
    await new Promise(r => setTimeout(r, 3000));
    const content = await this.readPage();
    if (subjectPattern) {
      const regex = new RegExp(subjectPattern, 'i');
      const found = regex.test(content.content);
      return { ok: true, found, content: content.content.substring(0, 5000) };
    }
    return { ok: true, content: content.content.substring(0, 5000) };
  }

  async close() {
    if (this._sessionName) {
      try { await this.saveSession(this._sessionName); } catch (_) {}
    }
    await this._driver().close();
    return { ok: true };
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

// Keep a reference to the active agent so electron-main can install its driver
// after the server is already running.
let _activeAgent = null;

function setActiveBrowserDriver(driver) {
  if (_activeAgent) _activeAgent.setDriver(driver);
}

function mountBrowserRoutes(addRoute, json, { getConfig, repoRoot, broadcast, driver }) {
  const sessionsDir = path.join(repoRoot, 'config', 'browser-sessions');
  const agent = new BrowserAgent({ sessionsDir, getConfig, driver });
  _activeAgent = agent;
  const notify = (title, body) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'notification', title, body, icon: 'globe', source: 'browser-agent' });
    }
  };

  const isIncognito = () => (getConfig().IncognitoMode === true);

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

  browserRoute('POST', '/api/browser/launch', async (body) => {
    try {
      const r = await agent.launch(body);
      notify('Browser automation launched', 'AI opened the in-app browser via ' + (r.launchedVia || 'default') + '.');
      return r;
    } catch (e) {
      notify('Browser automation failed', e.message || String(e));
      throw e;
    }
  });
  browserRoute('POST', '/api/browser/navigate', (body) => agent.navigate(body.url));
  browserRoute('POST', '/api/browser/fill', (body) => agent.fill(body.selector, body.value));
  browserRoute('POST', '/api/browser/click', (body) => agent.click(body.selector));
  browserRoute('POST', '/api/browser/type', (body) => agent.type(body.selector, body.text));
  browserRoute('POST', '/api/browser/press-key', (body) => agent.pressKey(body.key));
  browserRoute('POST', '/api/browser/wait-for', (body) => agent.waitFor(body.selector, body));
  browserRoute('POST', '/api/browser/save-session', (body) => agent.saveSession(body.name));
  browserRoute('POST', '/api/browser/close', () => agent.close());
  browserRoute('POST', '/api/browser/check-email', (body) => agent.checkEmail(body));

  browserRoute('GET', '/api/browser/screenshot', () => agent.screenshot(), { checkIncognito: false });
  browserRoute('GET', '/api/browser/read-page', (_, url) => agent.readPage({ selector: url.searchParams.get('selector') }), { checkIncognito: false });
  browserRoute('GET', '/api/browser/query-all', (_, url) => agent.queryAll(url.searchParams.get('selector') || '*'), { checkIncognito: false });
  browserRoute('GET', '/api/browser/cookies', () => agent.getCookies(), { checkIncognito: false });
  browserRoute('GET', '/api/browser/sessions', () => agent.listSessions(), { checkIncognito: false });

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

module.exports = { BrowserAgent, mountBrowserRoutes, setActiveBrowserDriver };
