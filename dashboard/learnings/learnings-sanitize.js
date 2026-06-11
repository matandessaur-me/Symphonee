// learnings-sanitize -- the scrub layer for shared learnings. Strips emails,
// API keys/tokens, external URLs (keeps the localhost API), absolute paths, and
// inline secrets; and flags text that still looks company/project-specific.
// Split from learnings.js so the redaction rules are unit-tested directly.
// SECURITY-RELEVANT: these patterns are what keep secrets and client names out
// of the public shared-learnings registry -- change them with care.
//
// The user's own client/brand names are themselves private, so they are NOT
// hardcoded here. They load once from `.symphonee/sanitize-terms.json` (a
// gitignored array of strings local to this machine), so the committed code
// stays free of any company-identifying content.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Sanitization patterns (strip before sharing) ────────────────────────────
const SANITIZE_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,                // emails
  /\b(ghp_|bpk-|sk-|xai-|gsk_|pat-|token-)[A-Za-z0-9_-]+/g,             // API keys/tokens
  /\b(https?:\/\/(?!127\.0\.0\.1:3800)[^\s"'`]+)/g,                       // external URLs (keep localhost API)
  /[A-Z]:\\[^\s"'`]+/g,                                                    // Windows absolute paths
  /\/(?:home|Users|mnt)\/[^\s"'`]+/g,                                     // Unix home paths
  /\b(?:password|secret|credential|passwd)\s*[:=]\s*\S+/gi,               // inline secrets
];

// Generic words that indicate company/project-specific content. The PRIVATE
// term list (actual client/brand names) is layered on from local config.
const COMPANY_INDICATORS = [
  /\b(client|customer|our company|our team|our project)\b/gi,
  /\b(internal|proprietary|confidential)\b/gi,
];

// ── Private terms (local, gitignored) ────────────────────────────────────────
const PRIVATE_TERMS_FILE = path.join(__dirname, '..', '..', '.symphonee', 'sanitize-terms.json');
let _privateRegex;   // undefined = not loaded yet; null = none configured

function _escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _loadPrivateRegex() {
  if (_privateRegex !== undefined) return _privateRegex;
  _privateRegex = null;
  try {
    const terms = JSON.parse(fs.readFileSync(PRIVATE_TERMS_FILE, 'utf8'));
    const clean = (Array.isArray(terms) ? terms : []).map(t => String(t).trim()).filter(Boolean);
    if (clean.length) _privateRegex = new RegExp('\\b(' + clean.map(_escapeRe).join('|') + ')\\b', 'gi');
  } catch (_) { /* no local term list - generic indicators still apply */ }
  return _privateRegex;
}

/** Test hook: inject private terms without touching the filesystem. */
function _setPrivateTerms(terms) {
  _privateRegex = (Array.isArray(terms) && terms.length)
    ? new RegExp('\\b(' + terms.map(_escapeRe).join('|') + ')\\b', 'gi')
    : null;
}

/** Strip sensitive data from text */
function sanitize(text) {
  let clean = text;
  for (const pattern of SANITIZE_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED]');
  }
  // Remove runs of redacted markers
  clean = clean.replace(/(\[REDACTED\]\s*){2,}/g, '[REDACTED] ');
  return clean.trim();
}

/** Extra paranoia check before pushing to shared */
function isSuspicious(text) {
  const lower = text.toLowerCase();
  // Reject if it still contains potential secrets after sanitization
  if (/\[REDACTED\]/.test(text)) return true;
  // Reject if it names one of the user's own clients/brands (local list)
  const priv = _loadPrivateRegex();
  if (priv && priv.test(lower)) { priv.lastIndex = 0; return true; }
  // Reject if it mentions company/project-specific content generically
  for (const pattern of COMPANY_INDICATORS) {
    if (pattern.test(lower)) { pattern.lastIndex = 0; return true; }
  }
  return false;
}

module.exports = { sanitize, isSuspicious, SANITIZE_PATTERNS, COMPANY_INDICATORS, _setPrivateTerms };
