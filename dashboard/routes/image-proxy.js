'use strict';
// Image proxy + open-external routes - extracted from server.js (behavior-preserving).
// Image proxy fetches remote images with plugin-contributed auth (e.g. ADO).
//
// ctx: { getConfig, getPlugins, host, port }

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { validateUrl } = require('../mind/security');

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
  // execFile is injectable so open-external can be unit-tested without spawning.
  const _execFile = ctx.execFile || execFile;

  async function handleOpenExternal(req, res) {
    const { url: extUrl } = await readBody(req);
    if (!extUrl) return json(res, { error: 'url required' }, 400);
    // open-external hands the URL to the OS default browser (rundll32); it does
    // NOT fetch server-side, so the SSRF private/loopback block in validateUrl
    // must NOT apply here -- localhost / 127.0.0.1 dev-server links (e.g. from
    // `npm run dev`) are the primary use case. Restrict to http/https only,
    // which still blocks file:/javascript:/other FileProtocolHandler schemes.
    let parsed;
    try { parsed = new URL(extUrl); } catch (_) { return json(res, { error: 'Invalid URL' }, 400); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json(res, { error: 'only http/https allowed' }, 400);
    }
    // rundll32 reliably opens URLs in the default browser on Windows
    _execFile('rundll32', ['url.dll,FileProtocolHandler', extUrl], (err) => {
      if (err) return json(res, { error: err.message }, 500);
      json(res, { ok: true });
    });
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
    try { validateUrl(imageUrl); } catch (e) { res.writeHead(400); return res.end(e.message); }

    const cfg = getConfig();
    const parsedUrl = new URL(imageUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      res.writeHead(400);
      return res.end('only http/https allowed');
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
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
        try { validateUrl(redirectUrl.href); } catch (e) { res.writeHead(400); return res.end(e.message); }
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
