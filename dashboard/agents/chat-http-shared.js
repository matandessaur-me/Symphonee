// chat-http-shared -- the pure, transport-agnostic helpers shared by the apps
// and browser LLM transports. The two transports themselves stay deliberately
// separate (apps does http/port/protocol switching with a keep-alive agent;
// browser is https-only with different default timeouts) -- ONLY these
// behaviour-identical pure helpers live here, so a fix to abort/transient
// detection lands in both at once instead of drifting.

// Wire an AbortSignal to a request: destroy the request and reject on abort.
// Returns a cleanup fn that detaches the listener (call it on 'close').
function bindAbort(req, signal, reject, label) {
  if (!signal) return () => {};
  const onAbort = () => {
    try { req.destroy(new Error(label || 'Request aborted')); } catch (_) {}
    try { reject(new Error(label || 'Request aborted')); } catch (_) {}
  };
  if (signal.aborted) { onAbort(); return () => {}; }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { try { signal.removeEventListener('abort', onAbort); } catch (_) {} };
}

function isAbortError(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('request aborted') || msg.includes('stream aborted') || msg.includes('aborted');
}

// Transient = safe to retry (rate limit, TLS hiccup, dropped socket, timeout).
function isTransientError(e) {
  const msg = (e && e.message) || '';
  return msg.includes('429') || msg.includes('SSL') || msg.includes('BAD_RECORD_MAC') ||
    msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
    msg.includes('socket hang up') || msg.includes('timed out');
}

module.exports = { bindAbort, isAbortError, isTransientError };
