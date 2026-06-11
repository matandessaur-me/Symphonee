'use strict';
// Streaming chat: chatOllamaStream parses Ollama's NDJSON stream into token
// callbacks + a final text. Run against a local mock server (OLLAMA_URL is
// read at module load, so it is set before the require).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let server;
let llm;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/chat') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const j = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        if (j.stream) {
          // three fragments + the terminal frame, split mid-line to exercise buffering
          const frames = [
            JSON.stringify({ message: { content: 'Hello' }, done: false }) + '\n',
            JSON.stringify({ message: { content: ' liquid' }, done: false }) + '\n',
            JSON.stringify({ message: { content: ' world.' }, done: false }) + '\n',
            JSON.stringify({ message: { content: '' }, done: true }) + '\n',
          ].join('');
          res.write(frames.slice(0, 30));
          setTimeout(() => { res.end(frames.slice(30)); }, 20);
        } else {
          res.end(JSON.stringify({ message: { content: 'non-stream' } }));
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = 'http://127.0.0.1:' + server.address().port;
  llm = require('./llm');
});

test.after(() => { server && server.close(); });

test('chatOllamaStream emits tokens in order and resolves the full text', async () => {
  const tokens = [];
  const r = await llm.chatOllamaStream(
    [{ role: 'user', content: 'hi' }],
    { model: 'mock-model', timeoutMs: 5000 },
    t => tokens.push(t),
  );
  assert.deepEqual(tokens, ['Hello', ' liquid', ' world.']);
  assert.equal(r.text, 'Hello liquid world.');
  assert.equal(r.model, 'mock-model');
});

test('chatOllamaStream survives a throwing token listener', async () => {
  const r = await llm.chatOllamaStream(
    [{ role: 'user', content: 'hi' }],
    { model: 'mock-model', timeoutMs: 5000 },
    () => { throw new Error('listener bug'); },
  );
  assert.equal(r.text, 'Hello liquid world.');
});
