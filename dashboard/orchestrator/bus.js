'use strict';
// Bus / messaging methods, mixed into Orchestrator.prototype via Object.assign.
// They run with the Orchestrator instance as `this` (this.inboxes, this.workspaceDir,
// this.broadcast, this._id). Extracted from orchestrator.js (behavior-preserving).

const fs = require('fs');
const path = require('path');

module.exports = {
  sendMessage({ to, from, content, metadata }) {
    if (!this.inboxes.has(to)) this.inboxes.set(to, []);

    const msg = {
      id: this._id(),
      from: from || 'system',
      to,
      content,
      metadata: metadata || {},
      timestamp: Date.now(),
      read: false,
    };

    this.inboxes.get(to).push(msg);

    // Also persist to disk for durability
    const inboxFile = path.join(this.workspaceDir, 'inboxes', `${to}.json`);
    try {
      const existing = fs.existsSync(inboxFile)
        ? JSON.parse(fs.readFileSync(inboxFile, 'utf8'))
        : [];
      existing.push(msg);
      fs.writeFileSync(inboxFile, JSON.stringify(existing, null, 2));
    } catch (_) {}

    this.broadcast({
      type: 'orchestrator-event',
      event: 'message',
      from: msg.from,
      to,
      preview: content.substring(0, 200),
      timestamp: msg.timestamp,
    });

    return msg;
  },

  /**
   * Read messages from a terminal's inbox.
   * @param {string} termId
   * @param {boolean} [markRead=true]
   */
  readInbox(termId, markRead = true) {
    const msgs = this.inboxes.get(termId) || [];
    if (markRead) {
      for (const m of msgs) m.read = true;
    }
    return msgs;
  },

  /**
   * Read only unread messages from a terminal's inbox.
   */
  readUnread(termId) {
    const msgs = this.inboxes.get(termId) || [];
    const unread = msgs.filter(m => !m.read);
    for (const m of unread) m.read = true;
    return unread;
  },

  /**
   * Clear a terminal's inbox.
   */
  clearInbox(termId) {
    this.inboxes.set(termId, []);
    const inboxFile = path.join(this.workspaceDir, 'inboxes', `${termId}.json`);
    try { if (fs.existsSync(inboxFile)) fs.unlinkSync(inboxFile); } catch (_) {}
  },

  // ── Broadcast / Announce ─────────────────────────────────────────────────

  /**
   * Broadcast a message to ALL terminal inboxes.
   */
  broadcastMessage({ from, content, metadata }) {
    const results = [];
    for (const [termId] of this.terminals) {
      if (termId === from) continue; // don't send to self
      results.push(this.sendMessage({ to: termId, from, content, metadata }));
    }
    return results;
  },
};
