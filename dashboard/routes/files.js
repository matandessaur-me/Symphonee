'use strict';
// File-browser + project-scripts routes - extracted from server.js (behavior-preserving).
// Registered via addRoute so they match before the legacy if-chain.
//
// ctx: { getRepoPath, broadcast }

const fs = require('fs');
const path = require('path');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const FILE_BROWSER_SKIP = new Set([
  '.git',
  '.ai-workspace',
  '.symphonee',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'bin',
  'obj'
]);

function resolveRepoSubPath(repoPath, subPath = '') {
  const repoRoot = path.resolve(repoPath);
  const targetPath = path.resolve(path.join(repoRoot, subPath || ''));
  if (targetPath !== repoRoot && !targetPath.startsWith(repoRoot + path.sep)) return null;
  return targetPath;
}

function mountFiles(addRoute, json, ctx) {
  const { getRepoPath, broadcast } = ctx;

  function handleFileTree(url, res) {
    const repoName = url.searchParams.get('repo');
    const subPath = url.searchParams.get('path') || '';
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    const resolved = resolveRepoSubPath(repoPath, subPath);
    if (!resolved) return json(res, { error: 'Invalid path' }, 403);

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => !FILE_BROWSER_SKIP.has(e.name))
        .map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: subPath ? `${subPath}/${e.name}` : e.name,
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      json(res, { entries, currentPath: subPath, repoName });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  // ── File name search (recursive, returns matching paths) ──────────────────
  function handleFileSearch(url, res) {
    const repoName = url.searchParams.get('repo');
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const scopePath = (url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
    if (!query) return json(res, { results: [] });

    const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock']);
    const results = [];
    const MAX = 80;
    const rootDir = resolveRepoSubPath(repoPath, scopePath);
    if (!rootDir) return json(res, { error: 'Invalid path' }, 403);

    try {
      if (!fs.statSync(rootDir).isDirectory()) return json(res, { error: 'Search path must be a directory' }, 400);
    } catch (_) {
      return json(res, { error: 'Search path not found' }, 404);
    }

    function walk(dir, rel) {
      if (results.length >= MAX) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (results.length >= MAX) return;
        if (FILE_BROWSER_SKIP.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(path.join(dir, e.name), childRel);
        } else {
          const ext = path.extname(e.name).slice(1).toLowerCase();
          if (BINARY_EXTS.has(ext)) continue;
          if (e.name.toLowerCase().includes(query)) {
            results.push({ path: childRel, name: e.name, isDir: false });
          }
        }
      }
    }
    walk(rootDir, scopePath);
    json(res, { results });
  }

  // ── Content grep (search inside files, returns matches with line numbers) ──
  function handleFileGrep(url, res) {
    const repoName = url.searchParams.get('repo');
    const query = url.searchParams.get('q') || '';
    const scopePath = (url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);
    if (!query || query.length < 2) return json(res, { results: [] });

    const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf','lock','map']);
    const results = [];
    const MAX_FILES = 50;
    const MAX_MATCHES = 150;
    let fileCount = 0;
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const rootDir = resolveRepoSubPath(repoPath, scopePath);
    if (!rootDir) return json(res, { error: 'Invalid path' }, 403);

    try {
      if (!fs.statSync(rootDir).isDirectory()) return json(res, { error: 'Search path must be a directory' }, 400);
    } catch (_) {
      return json(res, { error: 'Search path not found' }, 404);
    }

    function lineMatches(lineLower) {
      if (queryWords.length <= 1) return lineLower.includes(queryLower);
      return queryWords.every(w => lineLower.includes(w));
    }

    function walk(dir, rel) {
      if (results.length >= MAX_MATCHES) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (results.length >= MAX_MATCHES) return;
        if (FILE_BROWSER_SKIP.has(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(path.join(dir, e.name), childRel);
        } else {
          const ext = path.extname(e.name).slice(1).toLowerCase();
          if (BINARY_EXTS.has(ext)) continue;
          if (fileCount >= MAX_FILES && results.length > 0) return;
          try {
            const fullPath = path.join(dir, e.name);
            const stat = fs.statSync(fullPath);
            if (stat.size > 512 * 1024) continue; // skip files > 512KB
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            fileCount++;
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= MAX_MATCHES) break;
              if (lineMatches(lines[i].toLowerCase())) {
                results.push({ path: childRel, name: e.name, line: i + 1, text: lines[i].substring(0, 200) });
              }
            }
          } catch (_) {}
        }
      }
    }
    walk(rootDir, scopePath);
    json(res, { results });
  }

  function handleFileRead(url, res) {
    const repoName = url.searchParams.get('repo');
    const filePath = url.searchParams.get('path') || '';
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    const fullPath = path.join(repoPath, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

    try {
      const st = fs.statSync(resolved);
      const ext = path.extname(resolved).slice(1).toLowerCase();

      // Check for binary files
      const binaryExts = ['png','jpg','jpeg','gif','webp','ico','bmp','mp4','webm','ogg','mov','avi','zip','tar','gz','exe','dll','woff','woff2','ttf','eot','pdf'];
      if (binaryExts.includes(ext)) {
        return json(res, { content: `[Binary file: ${path.basename(resolved)} - ${st.size} bytes]`, name: path.basename(resolved), path: filePath, size: st.size, lines: 1, ext, isBinary: true });
      }

      const content = fs.readFileSync(resolved, 'utf8');
      json(res, {
        content,
        name: path.basename(resolved),
        path: filePath,
        size: st.size,
        lines: content.split('\n').length,
        ext,
      });
    } catch (e) {
      json(res, { error: e.message }, 404);
    }
  }

  async function handleFileSave(req, res) {
    const { repo, path: filePath, content } = await readBody(req);
    const repoPath = getRepoPath(repo);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    const fullPath = path.join(repoPath, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(repoPath))) return json(res, { error: 'Invalid path' }, 403);

    try {
      fs.writeFileSync(resolved, content, 'utf8');
      broadcast({ type: 'ui-action', action: 'file-changed', repo, path: filePath });
      json(res, { ok: true });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  // ── Project Scripts ──────────────────────────────────────────────────────────
  function handleProjectScripts(url, res) {
    const repoName = url.searchParams.get('repo');
    const repoPath = getRepoPath(repoName);
    if (!repoPath) return json(res, { error: 'Repo not found' }, 400);

    const pkgPath = path.join(repoPath, 'package.json');
    try {
      if (!fs.existsSync(pkgPath)) return json(res, { scripts: {}, type: 'none' });
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const hasNodeModules = fs.existsSync(path.join(repoPath, 'node_modules'));

      // Detect project type
      let type = 'node';
      if (deps['next']) type = 'nextjs';
      else if (deps['react-scripts']) type = 'cra';
      else if (deps['vite']) type = 'vite';
      else if (deps['gatsby']) type = 'gatsby';
      else if (deps['nuxt']) type = 'nuxt';

      json(res, { scripts, type, name: pkg.name || '', hasNodeModules });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  }

  // ── Serve repo file (for images/media) ──────────────────────────────────────
  function handleServeFile(url, res) {
    const repoName = url.searchParams.get('repo');
    const filePath = url.searchParams.get('path');
    const repoPath = getRepoPath(repoName);
    if (!repoPath || !filePath) { res.writeHead(400); return res.end('Missing params'); }

    const fullPath = path.join(repoPath, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(repoPath))) { res.writeHead(403); return res.end('Forbidden'); }
    if (!fs.existsSync(resolved)) { res.writeHead(404); return res.end('Not found'); }

    const ext = path.extname(resolved).slice(1).toLowerCase();
    const mimeTypes = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
      mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'max-age=60' });
    fs.createReadStream(resolved).pipe(res);
  }

  // ── Route registrations ─────────────────────────────────────────────────
  addRoute('GET',  '/api/files/tree',     (req, res, url) => handleFileTree(url, res));
  addRoute('GET',  '/api/files/read',     (req, res, url) => handleFileRead(url, res));
  addRoute('POST', '/api/files/save',     (req, res) => handleFileSave(req, res));
  addRoute('GET',  '/api/files/search',   (req, res, url) => handleFileSearch(url, res));
  addRoute('GET',  '/api/files/grep',     (req, res, url) => handleFileGrep(url, res));
  addRoute('GET',  '/api/files/serve',    (req, res, url) => handleServeFile(url, res));
  addRoute('GET',  '/api/project/scripts',(req, res, url) => handleProjectScripts(url, res));

  return { resolveRepoSubPath, FILE_BROWSER_SKIP };
}

module.exports = { mountFiles, resolveRepoSubPath, FILE_BROWSER_SKIP };
