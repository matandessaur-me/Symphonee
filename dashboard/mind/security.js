/**
 * Security helpers for Mind ingestion.
 *
 * Adapted in spirit (not code) from graphify/security.py. We ingest URLs and
 * render labels into a webview, so skipping these is how XSS and SSRF land.
 */

const { URL } = require('url');

const LABEL_MAX = 256;
// Strip C0 control chars (0x00-0x1F) and DEL (0x7F). Built via String.fromCharCode
// so the source file never contains literal non-printing bytes that get lost on
// copy-paste or text-tool round-trips.
const CONTROL_CHARS = (() => {
  const start = String.fromCharCode(0);
  const end = String.fromCharCode(0x1F);
  const del = String.fromCharCode(0x7F);
  return new RegExp(`[${start}-${end}${del}]`, 'g');
})();
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function sanitizeLabel(s) {
  if (typeof s !== 'string') return '';
  let out = s.replace(CONTROL_CHARS, '');
  if (out.length > LABEL_MAX) out = out.slice(0, LABEL_MAX);
  return out.replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function isPrivateOrLoopback(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true; // cloud metadata
  return false;
}

function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https allowed');
  if (isPrivateOrLoopback(u.hostname)) throw new Error('private/loopback/metadata urls blocked');
  return u.toString();
}

const SAFE_PATH = /^[A-Za-z0-9 _\-.\/\\:]+$/;
function validateRelativePath(p) {
  if (typeof p !== 'string' || !p) throw new Error('path required');
  if (p.includes('..')) throw new Error('path traversal blocked');
  if (!SAFE_PATH.test(p)) throw new Error('unsafe characters in path');
  return p;
}

module.exports = { sanitizeLabel, validateUrl, validateRelativePath, isPrivateOrLoopback };
