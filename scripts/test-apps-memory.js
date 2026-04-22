// Phase 5 test: per-app memory persists across sessions.
//
// Session A: run against Notepad, explicitly ask the agent to write a
// unique marker to memory via write_memory.
// Session B: same app, ask the agent to read memory and repeat the
// marker. Assert it sees the marker (either in the system prompt or
// via read_memory).
//
// Run: node scripts/test-apps-memory.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const driver = require(path.join(__dirname, '..', 'dashboard', 'apps-driver.js'));
const chat = require(path.join(__dirname, '..', 'dashboard', 'apps-agent-chat.js'));
const memory = require(path.join(__dirname, '..', 'dashboard', 'apps-memory.js'));

function log(...a) { console.log('[test-memory]', ...a); }

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

async function runGoal({ provider, hwnd, title, goal }) {
  const sessionId = 'mem-test-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const session = chat.getSession(sessionId);
  session.hwnd = hwnd;
  session.title = title;
  session.app = 'notepad';
  session.goal = goal;

  const events = [];
  const broadcast = (msg) => {
    events.push(msg);
    if (msg.type !== 'apps-agent-step') return;
    if (msg.kind === 'action') log('ACT', msg.summary);
    else if (msg.kind === 'observation' && msg.ok === false) log('ERR', msg.tool, msg.error);
    else if (msg.kind === 'done') log('DONE', msg.summary && msg.summary.slice(0, 100));
    else if (msg.kind === 'error') log('ERROR', msg.message);
  };

  const task = [
    `Goal: ${goal}`,
    '',
    `Target window: "${title}" (hwnd=${hwnd})`,
    'The window is already focused.',
  ].join('\n');

  return { events, result: await chat.runSession({
    session, task, driver, providerEntry: provider,
    model: provider.adapter.defaultModel, broadcast,
  }) };
}

(async () => {
  const aiKeys = loadAiKeys();
  const registry = chat.buildProviderRegistry(aiKeys);
  const provider = chat.pickProvider(registry);
  if (!provider) { console.error('no provider'); process.exit(2); }
  log('provider:', provider.adapter.label);

  // Fresh memory file so this test is deterministic.
  const memPath = memory.filePath('notepad');
  if (fs.existsSync(memPath)) fs.unlinkSync(memPath);

  const np = await launchNotepad();
  log('hwnd', np.hwnd);

  const marker = 'MEM-MARKER-' + Math.random().toString(36).slice(2, 8).toUpperCase();

  // Session A: explicitly save the marker.
  log('=== Session A: store marker', marker, '===');
  const goalA = `Call write_memory with section="Calibration" and a note that contains the literal string "${marker}" (plus a couple of explanatory words). Do not type anything into the window. After writing memory, call finish.`;
  const a = await runGoal({ provider, hwnd: np.hwnd, title: np.title, goal: goalA });
  log('A ok:', a.result.ok);

  const persisted = memory.loadMemory('notepad');
  log('memory file size:', persisted.length);
  const sawMarkerInFile = persisted.includes(marker);
  log('marker persisted to file:', sawMarkerInFile);

  // Session B: fresh agent thread, ask for the marker without giving
  // the marker in the user task.
  log('=== Session B: recall marker ===');
  const goalB = 'Look at your prior notes for this app. Report the MEM-MARKER string you find there. Call finish with a summary that includes that marker literally. Do NOT type into the window, do NOT click anything. Use read_memory if needed.';
  const b = await runGoal({ provider, hwnd: np.hwnd, title: np.title, goal: goalB });

  // The agent's finish summary should contain the marker.
  const doneEvent = b.events.find(e => e.kind === 'done');
  const summaryHasMarker = !!(doneEvent && String(doneEvent.summary || '').includes(marker));
  log('session B summary references marker:', summaryHasMarker);

  log('cleaning up');
  await closeNotepad(np.hwnd);

  const ok = sawMarkerInFile && summaryHasMarker;
  console.log('');
  console.log('summary:');
  console.log('  provider           :', provider.adapter.label);
  console.log('  marker             :', marker);
  console.log('  stored by agent    :', sawMarkerInFile ? 'yes' : 'no');
  console.log('  recalled in next   :', summaryHasMarker ? 'yes' : 'no');
  console.log('  memory file path   :', memPath);
  console.log('');
  console.log(ok ? 'OK' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('crash:', e.stack || e.message); process.exit(1); });
