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

// Lazy-load playwright-core (only used by the fallback driver). This is the
// single heaviest require on the boot path (~370ms), and the fallback driver
// is rarely used (the in-app webview driver is the default), so defer the
// require to first use instead of paying it at module-eval.
let _chromium;
let _chromiumLoaded = false;
function getChromium() {
  if (!_chromiumLoaded) {
    _chromiumLoaded = true;
    try { _chromium = require('playwright-core').chromium; }
    catch (_) { _chromium = null; }
  }
  return _chromium;
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

const BROWSER_DOM_HELPERS = require('../../lib/browser-dom-helpers');

// ── Playwright driver (fallback when not in Electron) ──────────────────────
const watchdogsModule = require('../../lib/browser-watchdogs');
function makePlaywrightDriver() {
  let browser = null;
  let context = null;
  let page = null;
  let launchedVia = null;
  let watchdogs = null;
  let networkEvents = [];
  let consoleEvents = [];
  let requestSeq = 0;
  let responseBodies = new Map();
  let requestIds = new WeakMap();

  function _ensurePlaywright() {
    if (!getChromium()) {
      throw new Error('playwright-core is not installed. Run: npm install playwright-core');
    }
  }

  function _ensurePage() {
    if (!page) throw new Error('No browser page. Call /api/browser/launch first.');
  }

  function _pushNetworkEvent(event) {
    networkEvents.push(event);
    if (networkEvents.length > 200) networkEvents.splice(0, networkEvents.length - 200);
  }

  function _pushConsoleEvent(event) {
    consoleEvents.push(event);
    if (consoleEvents.length > 200) consoleEvents.splice(0, consoleEvents.length - 200);
  }

  function _getRequestId(request) {
    if (requestIds.has(request)) return requestIds.get(request);
    const id = 'pw_' + (++requestSeq);
    requestIds.set(request, id);
    return id;
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
      const launchOpts = {
        headless,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      };
      const candidates = _resolveBrowserCandidates();
      let lastErr = null;
      for (const c of candidates) {
        try {
          const opts = { ...launchOpts };
          if (c.channel) opts.channel = c.channel;
          if (c.executablePath) opts.executablePath = c.executablePath;
          browser = await getChromium().launch(opts);
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
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });
      page = await context.newPage();
      // Remove automation fingerprints that trigger CAPTCHA.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        window.chrome = { runtime: {} };
      });
      networkEvents = [];
      consoleEvents = [];
      responseBodies = new Map();
      requestIds = new WeakMap();
      requestSeq = 0;
      page.on('request', (request) => {
        const requestId = _getRequestId(request);
        _pushNetworkEvent({
          kind: 'request',
          requestId,
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          startedAt: Date.now(),
        });
      });
      page.on('response', async (response) => {
        const request = response.request();
        const requestId = _getRequestId(request);
        let preview = null;
        try {
          const ctype = String(response.headers()['content-type'] || '');
          if (/json|text|javascript|xml|html|x-www-form-urlencoded/i.test(ctype)) {
            const bodyText = await response.text();
            preview = bodyText.slice(0, 20000);
            responseBodies.set(requestId, {
              requestId,
              url: response.url(),
              status: response.status(),
              contentType: ctype || null,
              body: preview,
              truncated: bodyText.length > 20000,
            });
          }
        } catch (_) {}
        _pushNetworkEvent({
          kind: 'response',
          requestId,
          method: request.method(),
          url: response.url(),
          status: response.status(),
          statusText: response.statusText(),
          resourceType: request.resourceType(),
          hasBodyPreview: !!preview,
          receivedAt: Date.now(),
        });
      });
      page.on('requestfailed', (request) => {
        const requestId = _getRequestId(request);
        const failure = request.failure();
        _pushNetworkEvent({
          kind: 'failed',
          requestId,
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          errorText: failure && failure.errorText ? failure.errorText : 'Request failed',
          failedAt: Date.now(),
        });
      });
      page.on('console', (msg) => {
        _pushConsoleEvent({
          kind: 'console',
          type: msg.type(),
          text: msg.text(),
          url: page.url(),
          at: Date.now(),
        });
      });
      page.on('pageerror', (err) => {
        _pushConsoleEvent({
          kind: 'exception',
          type: 'pageerror',
          text: err && err.message ? err.message : String(err),
          url: page ? page.url() : '',
          at: Date.now(),
        });
      });
      // Attach popups/aboutblank/downloads watchdogs (ported from
      // browser-use's watchdog architecture).
      try {
        if (watchdogs) watchdogs.detach();
        // Use the conservative default popups policy (dismiss confirm/prompt/
        // beforeunload, dismiss alert). Callers that need auto-accept can
        // re-attach a watchdog with explicit policy via getWatchdogEvents API
        // extension or pass through a future driver option.
        watchdogs = watchdogsModule.attachAll(page, { popups: {}, downloads: {} });
      } catch (e) {
        watchdogs = null;
        _pushConsoleEvent({ kind: 'exception', type: 'watchdog-init', text: e && e.message ? e.message : String(e), url: page ? page.url() : '', at: Date.now() });
      }
      return { launchedVia };
    },
    async navigate(url) {
      _ensurePage();
      networkEvents = [];
      consoleEvents = [];
      responseBodies = new Map();
      requestIds = new WeakMap();
      requestSeq = 0;
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
    async clickText(text, { exact = false } = {}) {
      _ensurePage();
      const result = await page.evaluate(({ targetText, exactOnly, helpers }) => {
        eval(helpers);
        var wanted = normalizeText(targetText);
        if (!wanted) throw new Error('clickText requires non-empty text');
        var selectors = 'button, a[href], input[type="button"], input[type="submit"], input[type="reset"], summary, [role="button"], [role="link"], [aria-label]';
        var ranked = walkDocuments(4).filter(function(entry) { return entry.accessible; }).flatMap(function(entry) {
          return Array.from(entry.doc.querySelectorAll(selectors))
          .filter(isVisible)
          .map(function(el) {
            var best = { score: 0, text: '' };
            candidateTexts(el).forEach(function(candidate) {
              var normalized = normalizeText(candidate);
              var score = scoreText(wanted, normalized, exactOnly);
              if (score > best.score) best = { score: score, text: candidate };
            });
            return { el: el, framePath: entry.framePath, score: best.score, text: best.text };
          });
        })
          .filter(function(item) { return item.score > 0; })
          .sort(function(a, b) { return b.score - a.score; });
        if (!ranked.length) throw new Error('No clickable element matched text "' + targetText + '"');
        var chosen = ranked[0];
        var clickResult = clickElement(chosen.el, chosen.framePath);
        clickResult.matchedText = chosen.text || clickResult.clickedText || '';
        clickResult.score = chosen.score;
        return clickResult;
      }, { targetText: String(text || ''), exactOnly: !!exact, helpers: BROWSER_DOM_HELPERS });
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return { url: page.url(), ...(result || {}) };
    },
    async clickHandle(handle) {
      _ensurePage();
      const result = await page.evaluate(({ handleValue, helpers }) => {
        eval(helpers);
        var el = getElementByHandle(handleValue);
        if (!el) throw new Error('No element found for handle');
        var parsed = parseHandle(handleValue) || {};
        return clickElement(el, parsed.framePath || []);
      }, { handleValue: handle, helpers: BROWSER_DOM_HELPERS });
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return { url: page.url(), ...(result || {}) };
    },
    async type(selector, text) {
      _ensurePage(); await page.type(selector, text);
    },
    async fillByLabel(label, value, { exact = false } = {}) {
      _ensurePage();
      return await page.evaluate(({ labelText, nextValue, exactOnly, helpers }) => {
        eval(helpers);
        var wanted = normalizeText(labelText);
        var selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select';
        var ranked = walkDocuments(4).filter(function(entry) { return entry.accessible; }).flatMap(function(entry) {
          return Array.from(entry.doc.querySelectorAll(selector))
          .filter(function(el) { return !el.disabled; })
          .map(function(el) {
            var best = { score: 0, text: '' };
            candidateTexts(el).forEach(function(candidate) {
              var normalized = normalizeText(candidate);
              var score = scoreText(wanted, normalized, exactOnly);
              if (score > best.score) best = { score: score, text: candidate };
            });
            return { el: el, framePath: entry.framePath, score: best.score, text: best.text };
          });
        })
          .filter(function(item) { return item.score > 0; })
          .sort(function(a, b) { return b.score - a.score; });
        if (!ranked.length) throw new Error('No field matched label "' + labelText + '"');
        var chosen = ranked[0];
        var fillResult = assignElementValue(chosen.el, nextValue, chosen.framePath);
        fillResult.matchedLabel = chosen.text || fillResult.filledLabel || '';
        fillResult.score = chosen.score;
        return fillResult;
      }, { labelText: String(label || ''), nextValue: String(value == null ? '' : value), exactOnly: !!exact, helpers: BROWSER_DOM_HELPERS });
    },
    async fillHandle(handle, value) {
      _ensurePage();
      return await page.evaluate(({ handleValue, nextValue, helpers }) => {
        eval(helpers);
        var el = getElementByHandle(handleValue);
        if (!el) throw new Error('No field found for handle');
        var parsed = parseHandle(handleValue) || {};
        return assignElementValue(el, nextValue, parsed.framePath || []);
      }, { handleValue: handle, nextValue: String(value == null ? '' : value), helpers: BROWSER_DOM_HELPERS });
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
    async evaluate(code) {
      _ensurePage();
      return await page.evaluate(async (src) => {
        const fn = new Function('return (async function(){' + src + '})();');
        return await fn();
      }, String(code));
    },
    async removeElement(selector, { all = false } = {}) {
      _ensurePage();
      return await page.evaluate(({ sel, removeAll }) => {
        const nodes = removeAll ? document.querySelectorAll(sel) : [document.querySelector(sel)].filter(Boolean);
        let removed = 0;
        nodes.forEach((n) => { if (n && n.parentNode) { n.parentNode.removeChild(n); removed++; } });
        return { removed, matched: nodes.length };
      }, { sel: selector, removeAll: all });
    },
    async setStyle(selector, styles, { all = false } = {}) {
      _ensurePage();
      return await page.evaluate(({ sel, styleMap, applyAll }) => {
        const nodes = applyAll ? Array.from(document.querySelectorAll(sel)) : [document.querySelector(sel)].filter(Boolean);
        if (!nodes.length) throw new Error('No element matched ' + sel);
        const toKebab = (k) => String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        const appliedKeys = [];
        Object.keys(styleMap || {}).forEach((key) => {
          const prop = toKebab(key);
          const raw = styleMap[key];
          const val = raw == null ? '' : String(raw);
          // Strip a user-supplied trailing !important; we always set with
          // priority=important so the inline style beats the site's CSS
          // cascade. Empty string clears, mirroring removeProperty.
          const cleaned = val.replace(/\s*!important\s*$/i, '');
          nodes.forEach((n) => {
            try {
              if (cleaned === '') n.style.removeProperty(prop);
              else n.style.setProperty(prop, cleaned, 'important');
            } catch (_) {}
          });
          appliedKeys.push(prop);
        });
        // Verify: read back computed styles for each applied prop on the
        // first matched node so the agent can detect when the page fought
        // our change (shadow DOM, iframe, higher-specificity inline rules).
        const verify = {};
        try {
          const cs = getComputedStyle(nodes[0]);
          appliedKeys.forEach((p) => { verify[p] = cs.getPropertyValue(p).trim(); });
        } catch (_) {}
        return { applied: appliedKeys.length, matched: nodes.length, computed: verify };
      }, { sel: selector, styleMap: styles || {}, applyAll: all });
    },
    async setAttribute(selector, name, value) {
      _ensurePage();
      return await page.evaluate(({ sel, attrName, attrValue }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('No element matched ' + sel);
        if (attrValue == null || attrValue === '') el.removeAttribute(attrName);
        else el.setAttribute(attrName, String(attrValue));
        return { matched: 1 };
      }, { sel: selector, attrName: name, attrValue: value });
    },
    async setText(selector, text) {
      _ensurePage();
      return await page.evaluate(({ sel, t }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('No element matched ' + sel);
        el.textContent = t;
        return { matched: 1 };
      }, { sel: selector, t: String(text == null ? '' : text) });
    },
    async setHtml(selector, html) {
      _ensurePage();
      return await page.evaluate(({ sel, h }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('No element matched ' + sel);
        el.innerHTML = h;
        return { matched: 1 };
      }, { sel: selector, h: String(html == null ? '' : html) });
    },
    async scrollTo(selector, { block = 'center' } = {}) {
      _ensurePage();
      return await page.evaluate(({ sel, b }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('No element matched ' + sel);
        el.scrollIntoView({ behavior: 'smooth', block: b });
        return { matched: 1 };
      }, { sel: selector, b: block });
    },
    async getComputedStyle(selector, properties) {
      _ensurePage();
      return await page.evaluate(({ sel, props }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('No element matched ' + sel);
        const cs = getComputedStyle(el);
        const keys = (Array.isArray(props) && props.length) ? props : [
          'color', 'background-color', 'background-image', 'font-family', 'font-size',
          'font-weight', 'line-height', 'letter-spacing', 'text-transform',
          'border-color', 'border-radius', 'box-shadow', 'opacity',
          'padding', 'margin', 'width', 'height', 'display', 'position',
        ];
        const out = {};
        keys.forEach((k) => { try { out[k] = cs.getPropertyValue(k); } catch (_) {} });
        return { properties: out };
      }, { sel: selector, props: properties });
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
    async getPageSource() {
      _ensurePage();
      return { url: page.url(), title: await page.title(), html: await page.content() };
    },
    async inspectDom({ limit = 120 } = {}) {
      _ensurePage();
      return await page.evaluate(({ maxItems, helpers }) => {
        eval(helpers);
        var fieldSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select';
        var docs = walkDocuments(4);
        var fields = [];
        var forms = [];
        var interactives = [];
        var frames = [];
        docs.forEach(function(entry) {
          if (!entry.accessible) {
            frames.push({ framePath: entry.framePath, frameName: entry.frameName || null, frameSrc: entry.frameSrc || null, accessible: false });
            return;
          }
          frames.push({ framePath: entry.framePath, frameName: getFrameMeta(entry.doc, entry.framePath).frameName, frameSrc: getFrameMeta(entry.doc, entry.framePath).frameSrc, accessible: true });
          fields = fields.concat(Array.from(entry.doc.querySelectorAll(fieldSelector)).slice(0, maxItems).map(function(el) { return describeField(el, entry.framePath); }));
          forms = forms.concat(Array.from(entry.doc.forms || []).slice(0, 20).map(function(form) { return describeForm(form, entry.framePath); }));
          interactives = interactives.concat(Array.from(entry.doc.querySelectorAll('button, a[href], input, textarea, select, summary, [role="button"], [role="link"]'))
            .filter(isVisible)
            .slice(0, maxItems)
            .map(function(el) { return describeInteractive(el, entry.framePath); }));
        });
        return { url: location.href, title: document.title, frames: frames, forms: forms.slice(0, maxItems), fields: fields.slice(0, maxItems), interactives: interactives.slice(0, maxItems) };
      }, { maxItems: Math.max(10, Math.min(Number(limit) || 120, 400)), helpers: BROWSER_DOM_HELPERS });
    },
    async getForms({ limit = 50 } = {}) {
      _ensurePage();
      return await page.evaluate(({ maxItems, helpers }) => {
        eval(helpers);
        var docs = walkDocuments(4);
        var forms = [];
        docs.forEach(function(entry) {
          if (!entry.accessible) return;
          forms = forms.concat(Array.from(entry.doc.forms || []).slice(0, maxItems).map(function(form) { return describeForm(form, entry.framePath); }));
        });
        return { url: location.href, title: document.title, forms: forms.slice(0, maxItems) };
      }, { maxItems: Math.max(1, Math.min(Number(limit) || 50, 100)), helpers: BROWSER_DOM_HELPERS });
    },
    async listInteractive({ limit = 200, includeHidden = false, maxFrameDepth = 4, maxIframes = 100 } = {}) {
      _ensurePage();
      return await page.evaluate(({ opts, helpers }) => {
        eval(helpers);
        return {
          url: location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          elements: enumerateInteractive(opts)
        };
      }, {
        opts: {
          limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
          includeHidden: !!includeHidden,
          maxFrameDepth: Math.max(0, Math.min(Number(maxFrameDepth) || 4, 8)),
          maxIframes: Math.max(1, Math.min(Number(maxIframes) || 100, 500))
        },
        helpers: BROWSER_DOM_HELPERS
      });
    },
    async queryAll(selector) {
      _ensurePage();
      const elements = await page.evaluate(({ sel, helpers }) => {
        eval(helpers);
        var out = [];
        walkDocuments(4).forEach(function(entry) {
          if (!entry.accessible) return;
          var found = [];
          try { found = Array.from(entry.doc.querySelectorAll(sel)); } catch (_) { found = []; }
          found.slice(0, 50).forEach(function(el) {
            var desc = describeInteractive(el, entry.framePath);
            desc.placeholder = el.placeholder || null;
            out.push(desc);
          });
        });
        return out.slice(0, 50);
      }, { sel: selector, helpers: BROWSER_DOM_HELPERS });
      return { elements };
    },
    async getNetworkLog({ limit = 50 } = {}) {
      _ensurePage();
      const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
      return { events: networkEvents.slice(-maxItems) };
    },
    async getNetworkBody(requestId) {
      _ensurePage();
      if (!requestId) throw new Error('requestId is required');
      const body = responseBodies.get(String(requestId));
      if (!body) throw new Error('No captured body for requestId: ' + requestId);
      return body;
    },
    async getConsoleLog({ limit = 50 } = {}) {
      _ensurePage();
      const maxItems = Math.max(1, Math.min(Number(limit) || 50, 200));
      return { events: consoleEvents.slice(-maxItems) };
    },
    async getCookies() {
      if (!context) return { cookies: [] };
      return { cookies: await context.cookies() };
    },
    async setCookies(cookies) {
      if (!context) return;
      await context.addCookies(cookies);
    },
    async getWatchdogEvents() {
      if (!watchdogs) return { popups: [], aboutBlank: [], downloads: [] };
      return watchdogs.snapshot();
    },
    async close() {
      try { if (watchdogs) watchdogs.detach(); } catch (_) {}
      watchdogs = null;
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

  async clickText(text, opts = {}) {
    const r = await this._driver().clickText(text, opts);
    return { ok: true, ...(r || {}) };
  }

  async clickHandle(handle) {
    const r = await this._driver().clickHandle(handle);
    return { ok: true, ...(r || {}) };
  }

  async type(selector, text) {
    await this._driver().type(selector, text);
    return { ok: true };
  }

  async fillByLabel(label, value, opts = {}) {
    const r = await this._driver().fillByLabel(label, value, opts);
    return { ok: true, ...(r || {}) };
  }

  async fillHandle(handle, value) {
    const r = await this._driver().fillHandle(handle, value);
    return { ok: true, ...(r || {}) };
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

  async executeJs(code) {
    if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'code is required' };
    try {
      const value = await this._driver().evaluate(code);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async removeElement(selector, opts = {}) {
    if (!selector) return { ok: false, error: 'selector is required' };
    try {
      const r = await this._driver().removeElement(selector, opts);
      return { ok: true, ...(r || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async setStyle(selector, styles, opts = {}) {
    if (!selector) return { ok: false, error: 'selector is required' };
    if (!styles || typeof styles !== 'object') return { ok: false, error: 'styles must be an object' };
    try {
      const r = await this._driver().setStyle(selector, styles, opts);
      return { ok: true, ...(r || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async setAttribute(selector, name, value) {
    if (!selector || !name) return { ok: false, error: 'selector and name are required' };
    try {
      const r = await this._driver().setAttribute(selector, name, value);
      return { ok: true, ...(r || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async setText(selector, text) {
    if (!selector) return { ok: false, error: 'selector is required' };
    try {
      const r = await this._driver().setText(selector, String(text == null ? '' : text));
      return { ok: true, ...(r || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async setHtml(selector, html) {
    if (!selector) return { ok: false, error: 'selector is required' };
    try {
      const r = await this._driver().setHtml(selector, String(html == null ? '' : html));
      return { ok: true, ...(r || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async scrollTo(selector, opts = {}) {
    if (!selector) return { ok: false, error: 'selector is required' };
    try {
      const r = await this._driver().scrollTo(selector, opts);
      return { ok: true, ...(r || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async getComputedStyle(selector, properties) {
    if (!selector) return { ok: false, error: 'selector is required' };
    try {
      const r = await this._driver().getComputedStyle(selector, properties);
      return { ok: true, ...(r || {}) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async readPage(opts = {}) {
    const r = await this._driver().readPage(opts);
    const content = (r && r.content) || '';
    const trimmed = content.substring(0, 10240);
    return { ok: true, url: r.url, title: r.title, content: trimmed, truncated: content.length > 10240 };
  }

  async getPageSource(opts = {}) {
    const r = await this._driver().getPageSource(opts);
    const html = (r && r.html) || '';
    const trimmed = html.substring(0, 200000);
    return { ok: true, url: r.url, title: r.title, html: trimmed, truncated: html.length > 200000 };
  }

  async inspectDom(opts = {}) {
    const r = await this._driver().inspectDom(opts);
    return { ok: true, ...(r || {}) };
  }

  async getForms(opts = {}) {
    const r = await this._driver().getForms(opts);
    return { ok: true, ...(r || {}) };
  }

  async listInteractive(opts = {}) {
    const drv = this._driver();
    if (typeof drv.listInteractive !== 'function') {
      return { ok: false, error: 'listInteractive not supported by current driver' };
    }
    const r = await drv.listInteractive(opts);
    return { ok: true, ...(r || {}) };
  }

  async getWatchdogEvents() {
    const drv = this._driver();
    if (typeof drv.getWatchdogEvents !== 'function') {
      return { ok: true, popups: [], aboutBlank: [], downloads: [] };
    }
    const r = await drv.getWatchdogEvents();
    return { ok: true, ...(r || {}) };
  }

  async queryAll(selector) {
    const r = await this._driver().queryAll(selector);
    const elements = (r && r.elements) || [];
    return { ok: true, count: elements.length, elements };
  }

  async getNetworkLog(opts = {}) {
    const r = await this._driver().getNetworkLog(opts);
    const events = (r && r.events) || [];
    return { ok: true, count: events.length, events };
  }

  async getNetworkBody(requestId) {
    const r = await this._driver().getNetworkBody(requestId);
    return { ok: true, ...(r || {}) };
  }

  async getConsoleLog(opts = {}) {
    const r = await this._driver().getConsoleLog(opts);
    const events = (r && r.events) || [];
    return { ok: true, count: events.length, events };
  }

  async getCookies() {
    const r = await this._driver().getCookies();
    const cookies = (r && r.cookies) || [];
    return { ok: true, count: cookies.length, cookies };
  }

  async evaluate(expression) {
    const d = this._driver();
    if (typeof d.evaluate !== 'function') throw new Error('Active browser driver does not support evaluate');
    return await d.evaluate(expression);
  }

  async applyCss(css) {
    const d = this._driver();
    if (typeof d.applyCss !== 'function') throw new Error('Active browser driver does not support applyCss');
    return await d.applyCss(css);
  }

  async setStyle(selector, styles) {
    const d = this._driver();
    if (typeof d.setStyle !== 'function') throw new Error('Active browser driver does not support setStyle');
    return await d.setStyle(selector, styles);
  }

  async inspectElement(selector) {
    const d = this._driver();
    if (typeof d.inspectElement !== 'function') throw new Error('Active browser driver does not support inspectElement');
    return await d.inspectElement(selector);
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

  function browserRoute(method, routePath, handler) {
    addRoute(method, routePath, async (req, res) => {
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
  browserRoute('POST', '/api/browser/click-text', (body) => agent.clickText(body.text, body));
  browserRoute('POST', '/api/browser/click-handle', (body) => agent.clickHandle(body.handle));
  browserRoute('POST', '/api/browser/type', (body) => agent.type(body.selector, body.text));
  browserRoute('POST', '/api/browser/fill-by-label', (body) => agent.fillByLabel(body.label, body.value, body));
  browserRoute('POST', '/api/browser/fill-handle', (body) => agent.fillHandle(body.handle, body.value));
  browserRoute('POST', '/api/browser/press-key', (body) => agent.pressKey(body.key));
  browserRoute('POST', '/api/browser/wait-for', (body) => agent.waitFor(body.selector, body));
  browserRoute('POST', '/api/browser/save-session', (body) => agent.saveSession(body.name));
  browserRoute('POST', '/api/browser/close', () => agent.close());
  browserRoute('POST', '/api/browser/check-email', (body) => agent.checkEmail(body));

  browserRoute('GET', '/api/browser/screenshot', () => agent.screenshot());
  browserRoute('GET', '/api/browser/read-page', (_, url) => agent.readPage({ selector: url.searchParams.get('selector') }));
  browserRoute('GET', '/api/browser/source', () => agent.getPageSource());
  browserRoute('GET', '/api/browser/dom', (_, url) => agent.inspectDom({ limit: Number(url.searchParams.get('limit') || 120) }));
  browserRoute('GET', '/api/browser/forms', (_, url) => agent.getForms({ limit: Number(url.searchParams.get('limit') || 50) }));
  browserRoute('GET', '/api/browser/watchdogs', () => agent.getWatchdogEvents());
  browserRoute('GET', '/api/browser/interactive', (_, url) => agent.listInteractive({
    limit: Number(url.searchParams.get('limit') || 200),
    includeHidden: url.searchParams.get('includeHidden') === 'true' || url.searchParams.get('includeHidden') === '1',
    maxFrameDepth: Number(url.searchParams.get('maxFrameDepth') || 4),
    maxIframes: Number(url.searchParams.get('maxIframes') || 100)
  }));
  browserRoute('GET', '/api/browser/query-all', (_, url) => agent.queryAll(url.searchParams.get('selector') || '*'));
  browserRoute('GET', '/api/browser/network', (_, url) => agent.getNetworkLog({ limit: Number(url.searchParams.get('limit') || 50) }));
  browserRoute('GET', '/api/browser/network-body', (_, url) => agent.getNetworkBody(url.searchParams.get('requestId') || ''));
  browserRoute('GET', '/api/browser/console', (_, url) => agent.getConsoleLog({ limit: Number(url.searchParams.get('limit') || 50) }));
  browserRoute('GET', '/api/browser/cookies', () => agent.getCookies());
  browserRoute('GET', '/api/browser/sessions', () => agent.listSessions());

  // AI DevTools surface: read/drive the visited page the same way the drawer
  // UI does. eval is the universal primitive; style/inspect are conveniences.
  browserRoute('POST', '/api/browser/eval', (body) => agent.evaluate(body.expression != null ? body.expression : body.code));
  browserRoute('POST', '/api/browser/style', (body) => (body.selector ? agent.setStyle(body.selector, body.styles || {}) : agent.applyCss(body.css || '')));
  browserRoute('POST', '/api/browser/inspect', (body) => agent.inspectElement(body.selector || '*'));

  browserRoute('GET', '/api/browser/accounts', () => {
    const cfg = getConfig();
    const creds = cfg.BrowserCredentials || {};
    const accounts = Object.entries(creds).map(([name, data]) => ({
      name,
      email: data.email,
      hasPassword: !!data.password,
    }));
    return { ok: true, count: accounts.length, accounts };
  });

  return agent;
}

module.exports = { BrowserAgent, mountBrowserRoutes, setActiveBrowserDriver };
