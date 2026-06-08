// browser-chat-util -- tiny pure helpers shared between browser-agent-chat.js
// (tool-result/telemetry formatting) and browser-chat-providers.js (adapters).
// Lives in its own module so the two can both import it without a require cycle.
function shortenContent(text, n = 4000) {
  if (!text) return '';
  const s = String(text);
  return s.length <= n ? s : s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}

module.exports = { shortenContent };
