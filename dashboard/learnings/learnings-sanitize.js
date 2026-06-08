// learnings-sanitize -- the scrub layer for shared learnings. Strips emails,
// API keys/tokens, external URLs (keeps the localhost API), absolute paths, and
// inline secrets; and flags text that still looks company/project-specific.
// Pure + IO-free, split from learnings.js so the redaction rules are unit-tested
// directly. SECURITY-RELEVANT: these patterns are what keep secrets and client
// names out of the public shared-learnings registry -- change them with care.

// ── Sanitization patterns (strip before sharing) ────────────────────────────
const SANITIZE_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,                // emails
  /\b(ghp_|bpk-|sk-|xai-|gsk_|pat-|token-)[A-Za-z0-9_-]+/g,             // API keys/tokens
  /\b(https?:\/\/(?!127\.0\.0\.1:3800)[^\s"'`]+)/g,                       // external URLs (keep localhost API)
  /[A-Z]:\\[^\s"'`]+/g,                                                    // Windows absolute paths
  /\/(?:home|Users|mnt)\/[^\s"'`]+/g,                                     // Unix home paths
  /\b(?:password|secret|credential|passwd)\s*[:=]\s*\S+/gi,               // inline secrets
];

// Words that indicate company/project-specific content
const COMPANY_INDICATORS = [
  /\b(bathfitter|bath fitter|ontheweb|webcity|aleoresto)\b/gi,
  /\b(client|customer|our company|our team|our project)\b/gi,
  /\b(internal|proprietary|confidential)\b/gi,
];

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
  // Reject if it mentions specific companies/projects
  for (const pattern of COMPANY_INDICATORS) {
    if (pattern.test(lower)) { pattern.lastIndex = 0; return true; }
  }
  return false;
}

module.exports = { sanitize, isSuspicious, SANITIZE_PATTERNS, COMPANY_INDICATORS };
