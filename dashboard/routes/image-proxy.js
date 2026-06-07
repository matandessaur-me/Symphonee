'use strict';
// Image proxy + open-external routes - extracted from server.js (behavior-preserving).
// Image proxy fetches remote images with plugin-contributed auth (e.g. ADO).
//
// ctx: { getConfig, getPlugins, host, port }

const http = require('http');
const https = require('https');
const { exec } = require('child_process');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function mountImageProxy(addRoute, json, ctx) {
  const { getConfig, getPlugins, host, port } = ctx;

  async function handleOpenExternal(req, res) {
    const { url: extUrl } = await readBody(req);
    if (!extUrl) return json(res, { error: 'url required' }, 400);
    try { new URL(extUrl); } catch (_) { return json(res, { error: 'Invalid URL' }, 400); }
    // rundll32 reliably opens URLs in the default browser on Windows
    exec(`rundll32 url.dll,FileProtocolHandler "${extUrl}"`);
    json(res, { ok: true });
  }

  // Plugins contribute contributions.imageAuth: { hostnamePattern, authType, authConfigKey }.
  //   'basic-pat' -> 'Basic ' + base64(':' + secret); 'bearer' -> 'Bearer ' + secret; 'token' -> 'token ' + secret
  function resolveImageAuth(hostname, cfg) {
    for (const p of (getPlugins ? getPlugins() : [])) {
      const rules = (p.contributions && p.contributions.imageAuth) || [];
      for (const rule of rules) {
        if (!rule || !rule.hostnamePattern || !rule.authConfigKey) continue;
        if (!hostname.includes(rule.hostnamePattern)) continue;
        const secret = cfg[rule.authConfigKey];
        if (!secret) continue;
        switch (rule.authType) {
          case 'bearer':    return 'Bearer ' + secret;
          case 'token':     return 'token ' + secret;
          case 'basic-pat':
          default:          return 'Basic ' + Buffer.from(':' + secret).toString('base64');
        }
      }
    }
    return null;
  }

  function handleImageProxy(url, res) {
    const imageUrl = url.searchParams.get('url');
    if (!imageUrl) { res.writeHead(400); return res.end('Missing url param'); }

    const cfg = getConfig();
    const parsedUrl = new URL(imageUrl);

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'Accept': '*/*' },
    };
    const authHeader = resolveImageAuth(parsedUrl.hostname, cfg);
    if (authHeader) options.headers['Authorization'] = authHeader;

    const proto = parsedUrl.protocol === 'https:' ? https : http;
    const proxyReq = proto.request(options, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        // Follow redirect
        const redirectUrl = new URL(proxyRes.headers.location, imageUrl);
        const newUrl = new URL(`http://${host}:${port}/api/image-proxy`);
        newUrl.searchParams.set('url', redirectUrl.href);
        return handleImageProxy(newUrl, res);
      }
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'image/png',
        'Cache-Control': 'max-age=3600',
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => { res.writeHead(502); res.end(e.message); });
    proxyReq.end();
  }

  addRoute('GET',  '/api/image-proxy',   (req, res, url) => handleImageProxy(url, res));
  addRoute('POST', '/api/open-external', (req, res) => handleOpenExternal(req, res));
}

module.exports = { mountImageProxy };
