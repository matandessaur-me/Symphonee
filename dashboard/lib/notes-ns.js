'use strict';
// Notes namespace helper - shared by server.js (UI-context) and routes/notes.js.
// A namespace is a filesystem-safe slug derived from the active space name.

function namespaceFromName(name) {
  // Keep a reversible, filesystem-safe slug that avoids collisions with
  // other subdirs.
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || '_global';
}

module.exports = { namespaceFromName };
