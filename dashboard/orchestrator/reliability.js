'use strict';
// Orchestrator reliability: per-CLI circuit breaker, error classification,
// retry backoff, and result scoring. Extracted from orchestrator.js.

// ── Circuit Breaker per CLI ──────────────────────────────────────────────────
// Tracks failures per CLI provider. After N transient failures, the CLI is
// disabled for a cooldown period to prevent wasting time on broken providers.
const CIRCUIT_BREAKER_THRESHOLD = 3;     // failures before opening
const CIRCUIT_BREAKER_COOLDOWN = 5 * 60 * 1000; // 5 min cooldown
const CIRCUIT_BREAKER_HALF_OPEN_AFTER = 2 * 60 * 1000; // 2 min before trying one request

class CircuitBreaker {
  constructor() {
    /** @type {Map<string, { state: 'closed'|'open'|'half-open', failures: number, lastFailure: number, lastSuccess: number }>} */
    this.circuits = new Map();
  }

  _get(cli) {
    if (!this.circuits.has(cli)) {
      this.circuits.set(cli, { state: 'closed', failures: 0, lastFailure: 0, lastSuccess: 0 });
    }
    return this.circuits.get(cli);
  }

  /** Check if a CLI is available (circuit not open) */
  isAvailable(cli) {
    const c = this._get(cli);
    if (c.state === 'closed') return true;
    if (c.state === 'open') {
      if (Date.now() - c.lastFailure > CIRCUIT_BREAKER_HALF_OPEN_AFTER) {
        c.state = 'half-open';
        return true; // allow one probe request
      }
      return false;
    }
    return true; // half-open: allow the probe
  }

  /** Record a success (resets the circuit) */
  recordSuccess(cli) {
    const c = this._get(cli);
    c.state = 'closed';
    c.failures = 0;
    c.lastSuccess = Date.now();
  }

  /** Record a failure. Returns true if circuit just opened. */
  recordFailure(cli, error) {
    const c = this._get(cli);
    if (this._isPermanent(error)) return false;
    c.failures++;
    c.lastFailure = Date.now();
    if (c.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      c.state = 'open';
      return true; // just opened
    }
    return false;
  }

  /** Get status of all circuits */
  getStatus() {
    const status = {};
    for (const [cli, c] of this.circuits) {
      status[cli] = { ...c };
    }
    return status;
  }

  /** Reset a specific CLI circuit */
  reset(cli) {
    this.circuits.delete(cli);
  }

  _isPermanent(error) {
    if (!error) return false;
    const msg = typeof error === 'string' ? error : (error.message || '');
    return /not installed|not found|not recognized|API key|not logged in|auth.*failed|invalid.*key|billing/i.test(msg);
  }
}

// ── Error Classification ────────────────────────────────────────────────────
function classifyError(error, cli) {
  const msg = typeof error === 'string' ? error : (error.message || String(error));
  const isTransient = /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|rate.?limit|429|500|502|503/i.test(msg);
  const isProviderOut = /credit|out of (?:credits|quota|tokens)|insufficient.*(?:fund|quota|credit)|payment required|402|quota exceeded|RESOURCE_EXHAUSTED|usage limit|monthly.*limit/i.test(msg);
  const isAuthError = /401|403|invalid.?api.?key|authentication.*failed|unauthorized|not logged in|auth.*failed/i.test(msg);
  const isFlagError = /unexpected argument|unrecognized option|unknown (flag|option)|bad flag/i.test(msg);
  const isModelError = /model.*not supported|not.*supported.*model|invalid.*model|unknown model|model.*not available|not supported when using.*account|requires.*api.?key/i.test(msg);
  const isPermanent = isProviderOut || isAuthError || isFlagError || isModelError ||
    /not installed|not found|not recognized|billing/i.test(msg);

  return {
    message: msg,
    cli,
    transient: isTransient,
    permanent: isPermanent,
    providerOut: isProviderOut,
    authError: isAuthError,
    flagError: isFlagError,
    modelError: isModelError,
    recoverable: !/not installed|not found|not recognized|billing/i.test(msg),
    retryable: isTransient && !isPermanent,
    failover: isProviderOut || isAuthError || isFlagError || isModelError,
    failoverReason: isProviderOut ? 'out of credits / quota'
                  : isAuthError ? 'authentication failed'
                  : isModelError ? 'model not supported'
                  : isFlagError ? 'flag mismatch' : null,
    timestamp: Date.now(),
  };
}

// ── Retry with Exponential Backoff ──────────────────────────────────────────
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 3000;

function retryDelay(attempt) {
  // Exponential backoff with jitter: base * 2^attempt + random(0..1000)
  return RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
}

// ── Quality Gates (State Machine) ───────────────────────────────────────────
const QUALITY_GATES = {
  IMPLEMENT: 'implement',
  VALIDATE:  'validate',
  REVIEW:    'review',
  DONE:      'done',
};

// ── Result Scoring ──────────────────────────────────────────────────────────
function scoreResult(result) {
  if (!result) return 0;
  let score = 0;
  score += Math.min(result.length / 500, 10);  // length (up to 10 points for 5KB+)
  if (/```/.test(result)) score += 3;           // contains code blocks
  if (/\n##?\s/.test(result)) score += 2;       // has headings (structured)
  if (/\d+\.\s/.test(result)) score += 1;       // has numbered lists
  if (/error|fail|cannot|unable/i.test(result)) score -= 3; // contains error language
  if (result.length < 50) score -= 5;           // very short (likely failure)
  return Math.max(0, score);
}

module.exports = {
  CircuitBreaker, classifyError, retryDelay, scoreResult,
  MAX_RETRIES, RETRY_BASE_MS, QUALITY_GATES,
  CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_COOLDOWN, CIRCUIT_BREAKER_HALF_OPEN_AFTER,
};
