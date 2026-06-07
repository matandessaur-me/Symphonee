// Small, dependency-free HTTP helpers shared by the server dispatch, the route
// modules (passed in via mount(addRoute, json, deps)), and plugins. Extracted
// from server.js so the bootstrap file is not the home for generic utilities.
// (sanitizeText stays in server.js: it holds non-ASCII regex literals that are
// risky to relocate by hand.)

// Read and JSON-parse a request body. Rejects on invalid JSON.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Write a JSON response with a status code.
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Human-readable "N ago" for a timestamp.
function formatAge(date) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = ms / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${hrs.toFixed(1)}h ago`;
  return `${(hrs / 24).toFixed(1)}d ago`;
}

module.exports = { readBody, json, formatAge };
