'use strict';
// Orchestrator runtime tuning constants.
// Shared across the spawn/escalation mixins so the values live in one place.

module.exports = {
  MAX_HEADLESS_OUTPUT: 512 * 1024,  // 512 KB stdout cap per headless task
  RESULT_POLL_MS: 500,              // result-file poll interval (file-mailbox pattern)
  MAX_CONCURRENT_SPAWNS: 5,         // max simultaneous headless tasks in a fan-out
  SPAWN_STAGGER_MS: 200,            // delay between parallel spawns (avoid thundering herd)
};
