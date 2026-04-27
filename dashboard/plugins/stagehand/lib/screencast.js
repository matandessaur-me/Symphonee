'use strict';

/**
 * CDP screencast streamer for the Stagehand session.
 *
 * Stagehand v3 doesn't expose Playwright's BrowserContext, it ships its own
 * V3Context + V3Page where the CDP connection lives at `page.mainSession`.
 * That session already has `.send(method, params)` / `.on(event, cb)` from
 * the underlying transport, so we attach Page.startScreencast there and pump
 * the resulting frames into the dashboard broadcast channel. The Browser tab
 * subscribes to `stagehand-screencast` events and renders the JPEG frames.
 *
 * One streamer per Stagehand session. Idempotent: starting twice is a no-op.
 */

let _state = null;     // { session, off, broadcast, frameCount, page }
let _starting = null;  // in-flight start promise

async function startScreencast(sh, { broadcast, format = 'jpeg', quality = 60, everyNthFrame = 1, maxWidth = 1280 } = {}) {
  if (_state) return { ok: true, alreadyRunning: true };
  if (_starting) return _starting;

  _starting = (async () => {
    if (!sh) throw new Error('Stagehand session not initialised');
    const page = sh.page;
    if (!page) throw new Error('Stagehand page not ready -- call /goto first');
    const session = page.mainSession;
    if (!session || typeof session.send !== 'function') throw new Error('Stagehand mainSession unavailable');

    let frameCount = 0;
    const onFrame = async (ev) => {
      frameCount += 1;
      try {
        if (typeof broadcast === 'function') {
          broadcast({
            type: 'stagehand-screencast',
            sessionId: ev.sessionId,
            data: ev.data,                 // base64 JPEG payload
            metadata: ev.metadata || null, // { offsetTop, pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY, timestamp }
            url: typeof page.url === 'function' ? page.url() : null,
            frame: frameCount,
            at: Date.now(),
          });
        }
      } finally {
        try { await session.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch (_) {}
      }
    };
    session.on('Page.screencastFrame', onFrame);

    const off = () => {
      try {
        if (typeof session.off === 'function') session.off('Page.screencastFrame', onFrame);
        else if (typeof session.removeListener === 'function') session.removeListener('Page.screencastFrame', onFrame);
      } catch (_) {}
    };

    await session.send('Page.startScreencast', { format, quality, everyNthFrame, maxWidth });
    _state = { session, off, broadcast, frameCount: 0, page };
    return { ok: true, started: true, format, quality };
  })().catch((e) => { _starting = null; throw e; });

  const r = await _starting;
  _starting = null;
  return r;
}

async function stopScreencast() {
  if (!_state) return { ok: true, alreadyStopped: true };
  const { session, off } = _state;
  _state = null;
  try { await session.send('Page.stopScreencast'); } catch (_) {}
  try { off(); } catch (_) {}
  return { ok: true, stopped: true };
}

function isStreaming() { return !!_state; }

module.exports = { startScreencast, stopScreencast, isStreaming };
