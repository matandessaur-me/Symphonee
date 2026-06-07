'use strict';
// Orchestrator task states + default reaction policy (shared consts).
// Extracted from orchestrator.js so the class and its method-group mixins
// (bus, task-store, etc.) can all import the same STATE enum.

// Default reactions to orchestration events (retry/nudge/escalate policy).
const DEFAULT_REACTIONS = {
  'task-failed':    { action: 'retry',    maxRetries: 2, escalateAfterMs: 5 * 60 * 1000 },
  'task-timeout':   { action: 'retry',    maxRetries: 1, escalateAfterMs: 3 * 60 * 1000 },
  'agent-stale':    { action: 'nudge',    maxRetries: 3, escalateAfterMs: 10 * 60 * 1000 },
  'circuit-open':   { action: 'escalate', maxRetries: 0, escalateAfterMs: 0 },
};

// Task states.
const STATE = {
  PENDING:   'pending',
  QUEUED:    'queued',      // waiting for dependencies
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
  TIMEOUT:   'timeout',
};

module.exports = { STATE, DEFAULT_REACTIONS };
