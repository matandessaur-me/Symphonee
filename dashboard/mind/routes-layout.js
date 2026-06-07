'use strict';
// Mind layout cache: persisted force-graph node positions per space+mode.

const fs = require('fs');
const path = require('path');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, readBody } = deps;

  // ── Layout cache (per space + mode) ──────────────────────────────────────
  // The 3D / 2D force-graph simulation pins Intel iGPUs at 80%+ CPU/GPU on
  // every load when there are thousands of nodes. We solve it by computing
  // the layout ONCE and persisting (x, y, z) per node id. Subsequent loads
  // place nodes at the cached positions and skip physics entirely. The
  // cache is invalidated when the node set changes (different ids → re-layout).
  //
  // Storage: <repoRoot>/.symphonee/mind/spaces/<space>/layout-<mode>.json
  // Shape: { computedAt, nodeCount, nodeHash, positions: {nodeId: [x,y,z]} }
  const layoutPath = (space, mode) => path.join(repoRoot, '.symphonee', 'mind', 'spaces', space, `layout-${(mode || '3d').replace(/[^a-z0-9_-]/gi, '')}.json`);

  addRoute('GET', '/api/mind/layout', (req, res) => {
    const space = getSpace();
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('mode') || '3d';
    const p = layoutPath(space, mode);
    if (!fs.existsSync(p)) return json(res, { cached: false });
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return json(res, { cached: true, ...data });
    } catch (e) {
      return json(res, { cached: false, error: e.message });
    }
  });

  addRoute('POST', '/api/mind/layout', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.positions || typeof body.positions !== 'object') {
      return json(res, { error: 'positions object required' }, 400);
    }
    const space = getSpace();
    const mode = body.mode || '3d';
    const p = layoutPath(space, mode);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const payload = {
        computedAt: new Date().toISOString(),
        nodeCount: Object.keys(body.positions).length,
        nodeHash: body.nodeHash || null,
        mode,
        positions: body.positions,
      };
      fs.writeFileSync(p, JSON.stringify(payload));
      return json(res, { ok: true, cachedAt: payload.computedAt, nodeCount: payload.nodeCount });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  });

  addRoute('DELETE', '/api/mind/layout', (req, res) => {
    const space = getSpace();
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('mode') || '3d';
    const p = layoutPath(space, mode);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return json(res, { ok: true });
    } catch (e) { return json(res, { error: e.message }, 500); }
  });
}

module.exports = { register };
