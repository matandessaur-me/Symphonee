#!/usr/bin/env node
// Save a markdown note via the Symphonee API.
// Usage:
//   node scripts/save-note.js "Note Name" "Short content"
//   node scripts/save-note.js "Note Name" --file .ai-workspace/note.md

const http = require('http');
const fs = require('fs');

// Accepts both positional and named-flag forms:
//   node scripts/save-note.js "Name" "content"
//   node scripts/save-note.js "Name" --file path/to/file.md
//   node scripts/save-note.js --title "Name" --body "content"
//   node scripts/save-note.js --title "Name" --file path/to/file.md
const argv = process.argv.slice(2);
let name, content, filePath;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--title' || a === '--name') name = argv[++i];
  else if (a === '--body' || a === '--content') content = argv[++i];
  else if (a === '--file') filePath = argv[++i];
  else if (name === undefined) name = a;
  else if (content === undefined && a !== '--file') content = a;
}

if (!name) {
  console.error('Usage: node scripts/save-note.js "Name" "content"');
  console.error('       node scripts/save-note.js --title "Name" --body "content"');
  console.error('       node scripts/save-note.js "Name" --file path/to/file.md');
  process.exit(1);
}

if (filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
  content = fs.readFileSync(filePath, 'utf8');
}

if (!content) {
  console.error('Error: No content provided');
  process.exit(1);
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 3800, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(out); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  try {
    // /api/notes/save creates the file if it doesn't exist (atomic write).
    // Do NOT call /api/notes/create first - its name sanitizer differs from
    // save's, which produces two files when the title has dots, apostrophes,
    // parens, etc.
    const result = await post('/api/notes/save', { name, content });
    if (result.ok) {
      console.log(`Note "${name}" saved.`);
    } else {
      console.error(`Error: ${result.error || 'Unknown error'}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
})();
