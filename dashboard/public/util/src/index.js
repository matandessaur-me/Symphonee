// util -- shared, dependency-free renderer helpers, exposed on `window` for the
// still-flat app.js parts to call by bare name. Loaded before app.js.
//
// `escapeHtml` previously lived in parts/mcp.js and was used by five OTHER parts
// (browser-tools, browser-views, command-palette, notes-search, permissions) via
// global hoisting -- an accidental dependency on mcp.js that blocked extracting
// it. Promoting it to a real shared module removes that coupling and is the
// home for future cross-part helpers as more parts are modularized.
//
// (mind-ui has its own private escapeHtml inside its bundle -- unrelated.)
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

window.escapeHtml = escapeHtml;
