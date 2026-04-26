/**
 * Browser watchdogs - small services that run alongside a Playwright page
 * to handle out-of-band events (popups, downloads, blank-page redirects)
 * the way browser-use does it.
 *
 * Pattern: each watchdog returns a `{ snapshot(), detach() }` pair. snapshot()
 * gives the caller (browser-agent's API surface) a current view of recent
 * events. detach() removes the listeners on close().
 *
 * Design note: ported from github.com/browser-use/browser-use
 * browser_use/browser/watchdogs/. Their implementation uses a bubus EventBus
 * and runs against raw CDP. We wire the same behaviors directly to
 * Playwright's high-level events because Symphonee already commits to PW.
 */

'use strict';

const path = require('path');

const MAX_HISTORY = 50;
function _push(arr, item) {
  arr.push(item);
  if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
}

/**
 * Popups watchdog
 *
 * Auto-dismisses JavaScript dialogs (alert/confirm/prompt/beforeunload). Many
 * pages stall the agent forever otherwise - Playwright's default is to leave
 * them open. We auto-accept by default and log every dialog so the LLM still
 * sees what happened. Configurable per call via `defaultAction`.
 */
function attachPopupsWatchdog(page, opts = {}) {
  // Per-type policy. Default is conservative: alert is harmless to dismiss,
  // but confirm/prompt/beforeunload could approve destructive actions or
  // discard the user's unsaved work, so we DISMISS those by default. Callers
  // who specifically want auto-accept (form-flow agents) opt in with
  // { policy: { confirm: 'accept', prompt: 'accept', beforeunload: 'accept' } }
  // or pass { defaultAction: 'accept' } to force the old behavior wholesale.
  const blanket = opts.defaultAction === 'accept' ? 'accept' : opts.defaultAction === 'dismiss' ? 'dismiss' : null;
  const policy = Object.assign({
    alert: 'dismiss',
    confirm: 'dismiss',
    prompt: 'dismiss',
    beforeunload: 'dismiss',
  }, opts.policy || {});
  const promptAnswer = typeof opts.promptAnswer === 'string' ? opts.promptAnswer : '';
  const dialogs = [];
  const handler = async (dialog) => {
    const type = dialog.type();
    const action = blanket || policy[type] || 'dismiss';
    _push(dialogs, {
      at: Date.now(),
      type,
      message: dialog.message(),
      defaultValue: typeof dialog.defaultValue === 'function' ? dialog.defaultValue() : null,
      action,
    });
    try {
      if (action === 'accept') {
        if (type === 'prompt') await dialog.accept(promptAnswer);
        else await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    } catch (_) {}
  };
  page.on('dialog', handler);
  return {
    snapshot() { return dialogs.slice(); },
    detach() { try { page.off('dialog', handler); } catch (_) {} },
  };
}

/**
 * Aboutblank watchdog
 *
 * Tracks navigations that land on about:blank or settle on an empty document.
 * Some SPAs briefly point at about:blank between routes; LLMs that screenshot
 * mid-transition get confused. We don't auto-fix - we just record the
 * transition so the caller can wait/retry intelligently.
 */
function attachAboutBlankWatchdog(page) {
  const transitions = [];
  const handler = (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url === 'about:blank' || url === '' || url.startsWith('about:')) {
      _push(transitions, { at: Date.now(), url, kind: 'mainframe-blank' });
    }
  };
  page.on('framenavigated', handler);
  return {
    snapshot() { return transitions.slice(); },
    detach() { try { page.off('framenavigated', handler); } catch (_) {} },
  };
}

/**
 * Downloads watchdog
 *
 * Captures every Download object Playwright emits, saves the file under the
 * provided dir (defaulting to OS temp), and exposes the resolved file path so
 * the agent can read/upload it next.
 */
function attachDownloadsWatchdog(page, opts = {}) {
  const downloadDir = opts.downloadDir || require('os').tmpdir();
  const downloads = [];
  const handler = async (download) => {
    const suggested = download.suggestedFilename ? download.suggestedFilename() : 'download.bin';
    const safeName = suggested.replace(/[^\w.\-]+/g, '_').slice(0, 200) || 'download.bin';
    const target = path.join(downloadDir, `${Date.now()}_${safeName}`);
    let savedPath = null;
    let error = null;
    try {
      await download.saveAs(target);
      savedPath = target;
    } catch (e) { error = e && e.message ? e.message : String(e); }
    _push(downloads, {
      at: Date.now(),
      url: typeof download.url === 'function' ? download.url() : null,
      suggestedFilename: suggested,
      savedPath,
      error,
    });
  };
  page.on('download', handler);
  return {
    snapshot() { return downloads.slice(); },
    detach() { try { page.off('download', handler); } catch (_) {} },
  };
}

/**
 * Composite helper - attach all three to a page in one call. Returns a single
 * `{ snapshot(), detach() }` pair the caller can stash on the driver instance.
 */
function attachAll(page, opts = {}) {
  const popups = attachPopupsWatchdog(page, opts.popups || {});
  const aboutBlank = attachAboutBlankWatchdog(page);
  const downloads = attachDownloadsWatchdog(page, opts.downloads || {});
  return {
    snapshot() {
      return {
        popups: popups.snapshot(),
        aboutBlank: aboutBlank.snapshot(),
        downloads: downloads.snapshot(),
      };
    },
    detach() {
      popups.detach();
      aboutBlank.detach();
      downloads.detach();
    },
  };
}

module.exports = {
  attachPopupsWatchdog,
  attachAboutBlankWatchdog,
  attachDownloadsWatchdog,
  attachAll,
};
