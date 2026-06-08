// request-firewall -- Origin / Host gate for the local API (anti-CSRF,
// anti-DNS-rebinding). SECURITY-RELEVANT and pure: split from server.js so the
// allow/deny rules can be unit-tested directly.
//
// The local API runs high-privilege actions (terminals, git, file I/O,
// automation, plugins) and has no auth token yet, so it MUST reject any request
// that didn't come from the app's own renderer or a local CLI. Rules:
//   - A browser cross-site request ALWAYS carries an Origin header; CLIs / curl
//     / server-to-server send NONE. So "no Origin" = trusted local caller.
//   - The renderer is same-origin (http://127.0.0.1:PORT) -> allowed.
//   - Any foreign Origin (a malicious page the user merely opens) -> 403.
//   - The Host header must be loopback; a DNS-rebinding page rebinds its domain
//     to 127.0.0.1 but still sends Host: attacker.com -> 403.
function createFirewall(host, port) {
  const ALLOWED_ORIGINS = new Set([
    `http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`,
  ]);
  const ALLOWED_HOSTS = new Set([
    `${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`,
    host, 'localhost', '127.0.0.1', `[::1]:${port}`, '[::1]',
  ]);
  function hostIsLoopback(h) {
    if (!h) return true; // HTTP/1.0 / some local clients omit Host
    return ALLOWED_HOSTS.has(String(h).toLowerCase());
  }
  function originAllowed(origin) {
    if (!origin) return true;            // not a browser cross-site request
    const o = String(origin).toLowerCase();
    if (o === 'null') return false;      // opaque/sandboxed origin -> reject
    return ALLOWED_ORIGINS.has(o);
  }
  // True if the request may proceed. Used for both HTTP and WS upgrades.
  function isRequestAllowed(req) {
    return hostIsLoopback(req.headers && req.headers.host) && originAllowed(req.headers && req.headers.origin);
  }
  return { isRequestAllowed, hostIsLoopback, originAllowed, ALLOWED_ORIGINS, ALLOWED_HOSTS };
}

module.exports = { createFirewall };
