'use strict';

/**
 * CDP screencast streamer for the Stagehand session.
 *
 * Stagehand spawns its own Chromium via Playwright. The Electron <webview>
 * cannot adopt that Chromium, so to make the Stagehand session "feel the same"
 * as the in-app browser we relay CDP Page.startScreencast frames over the
 * dashboard broadcast channel. The Browser tab subscribes to
 * "stagehand-screencast" events and renders the JPEG frames into a canvas.
 *
 * One streamer per session. Idempotent: starting twice is a no-op.
 */

let _state = null;     // { client, page, frameCount, broadcast }
let _starting = null;  // in-flight start promise

async function startScreencast(sh, { broadcast, format = 'jpeg', quality = 60, everyNthFrame = 1, maxWidth = 1280 } = {}) {
  if (_state) return { ok: true, alreadyRunning: true };
  if (_starting) return _starting;

  _starting = (async () => {
    if (!sh || !sh.context) throw new Error('Stagehand session not initialised');
    const page = sh.context.pages()[0] || await sh.context.newPage();
    const client = await sh.context.newCDPSession(page);

    let frameCount = 0;
    client.on('Page.screencastFrame', async (ev) => {
      frameCount += 1;
      try {
        if (typeof broadcast === 'function') {
          broadcast({
            type: 'stagehand-screencast',
            sessionId: ev.sessionId,
            data: ev.data,                 // base64 JPEG
            metadata: ev.metadata || null, // { offsetTop, pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY, timestamp }
            url: page.url(),
            frame: frameCount,
            at: Date.now(),
          });
        }
      } finally {
        try { await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch (_) {}
      }
    });

    await client.send('Page.startScreencast', { format, quality, everyNthFrame, maxWidth });
    _state = { client, page, frameCount: 0, broadcast };
    return { ok: true, started: true, format, quality };
  })().catch((e) => { _starting = null; throw e; });

  const r = await _starting;
  _starting = null;
  return r;
}

async function stopScreencast() {
  if (!_state) return { ok: true, alreadyStopped: true };
  const { client } = _state;
  _state = null;
  try { await client.send('Page.stopScreencast'); } catch (_) {}
  try { await client.detach(); } catch (_) {}
  return { ok: true, stopped: true };
}

function isStreaming() { return !!_state; }

module.exports = { startScreencast, stopScreencast, isStreaming };
