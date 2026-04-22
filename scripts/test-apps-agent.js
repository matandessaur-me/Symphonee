// Phase 2 end-to-end test: drive the Apps agent in-process against Notepad.
//
// Launches Notepad, focuses it, spins up a session with a short goal,
// and streams every agent event to the console. Success = the agent
// calls screenshot, then type_text (or key) to place text in the
// window, then finish. We verify by re-reading the Notepad window
// title at the end.
//
// Requires ANTHROPIC_API_KEY (or OPENAI_API_KEY / GEMINI_API_KEY / ...)
// Reads from config/config.json AiApiKeys just like the server does.
//
// Run: node scripts/test-apps-agent.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const driver = require(path.join(__dirname, '..', 'dashboard', 'apps-driver.js'));
const chat = require(path.join(__dirname, '..', 'dashboard', 'apps-agent-chat.js'));

function log(...a) { console.log('[test-apps-agent]', ...a); }

function loadAiKeys() {
  const p = path.join(__dirname, '..', 'config', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  const keys = Object.assign({}, cfg.AiApiKeys || {});
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'DASHSCOPE_API_KEY', 'GEMINI_API_KEY']) {
    if (!keys[k] && process.env[k]) keys[k] = process.env[k];
  }
  return keys;
}

async function launchNotepad() {
  log('launching notepad');
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await driver.waitMs(200);
    const list = await driver.listWindows({ force: true });
    const np = list.find(w => w.processName.toLowerCase() === 'notepad' && !w.isMinimized);
    if (np) return np;
  }
  throw new Error('notepad did not appear');
}

async function closeNotepad(hwnd) {
  try {
    await driver.focusWindow(hwnd);
    await driver.key('Alt+F4', { hwnd });
    await driver.waitMs(250);
    await driver.key('Alt+N');
  } catch (_) {}
}

(async () => {
  const aiKeys = loadAiKeys();
  const registry = chat.buildProviderRegistry(aiKeys);
  const provider = chat.pickProvider(registry);
  if (!provider) {
    console.error('No AI provider configured. Set ANTHROPIC_API_KEY or another supported key.');
    process.exit(2);
  }
  log('provider:', provider.adapter.label, 'model:', provider.adapter.defaultModel);

  const np = await launchNotepad();
  log('notepad hwnd', np.hwnd, 'rect', np.rect);
  await driver.focusWindow(np.hwnd);

  const sessionId = 'test-' + Date.now().toString(36);
  const session = chat.getSession(sessionId);
  session.hwnd = np.hwnd;
  session.title = np.title;
  session.app = 'notepad';
  session.goal = 'Type a short haiku about Tuesday inside the Notepad window and stop.';

  const events = [];
  const broadcast = (msg) => {
    events.push(msg);
    if (msg.type !== 'apps-agent-step') return;
    if (msg.kind === 'action') log('ACTION', msg.summary);
    else if (msg.kind === 'observation') log('OBS', msg.tool, msg.ok ? msg.preview || 'ok' : `ERR ${msg.error}${msg.code ? ' ('+msg.code+')' : ''}`);
    else if (msg.kind === 'message' && msg.text) log('MSG', msg.text.slice(0, 160).replace(/\s+/g, ' '));
    else if (msg.kind === 'screenshot') log('SHOT', msg.width + 'x' + msg.height);
    else if (msg.kind === 'done') log('DONE', msg.summary);
    else if (msg.kind === 'stuck') log('STUCK', msg.reason);
    else if (msg.kind === 'error') log('ERROR', msg.message);
    else if (msg.kind === 'stopped') log('STOPPED');
  };

  const task = [
    `Goal: ${session.goal}`,
    '',
    `Target window: "${session.title}" (hwnd=${np.hwnd})`,
    'The window is already focused. Start with a screenshot and work toward the goal.',
    'This is a Notepad window. Just type the haiku directly with type_text; no clicking needed.',
  ].join('\n');

  const t0 = Date.now();
  const result = await chat.runSession({
    session, task, driver, providerEntry: provider,
    model: provider.adapter.defaultModel, broadcast,
  });
  const elapsed = Date.now() - t0;
  log('session result:', result, 'elapsed:', elapsed, 'ms', 'events:', events.length);

  // Verify: re-enumerate and check the notepad window title (Notepad updates
  // title to reflect the first line of content, e.g. "haiku... - Notepad").
  try {
    const finalList = await driver.listWindows({ force: true });
    const finalNp = finalList.find(w => String(w.hwnd) === String(np.hwnd));
    log('final notepad title:', finalNp && finalNp.title);
  } catch (e) { log('post-check failed:', e.message); }

  log('cleaning up');
  await closeNotepad(np.hwnd);

  const actionCount = events.filter(e => e.kind === 'action').length;
  const typed = events.some(e => e.kind === 'action' && /type|key/.test(e.tool || ''));
  const finished = events.some(e => e.kind === 'done' || (e.kind === 'action' && e.tool === 'finish'));

  console.log('');
  console.log('summary:');
  console.log('  provider   :', provider.adapter.label);
  console.log('  actions    :', actionCount);
  console.log('  typed/keyed:', typed);
  console.log('  finished   :', finished);
  console.log('  ok         :', result && result.ok ? 'yes' : 'no');
  console.log('');
  if (!result.ok || !typed || !finished) {
    console.log('FAIL');
    process.exit(1);
  }
  console.log('OK');
  process.exit(0);
})().catch(e => {
  console.error('crash:', e.stack || e.message);
  process.exit(1);
});
