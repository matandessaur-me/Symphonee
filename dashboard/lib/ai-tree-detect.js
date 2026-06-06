'use strict';
// AI CLI detection via the OS process tree. Given a shell PID, find whether a
// known AI CLI is running as a descendant - lets the UI decide "Launch AI" vs
// "Restart Shell" reliably even after a refresh. Pure detection logic; the
// HTTP route (which needs the terminal map) stays in server.js.

const { spawn } = require('child_process');

const AI_CLI_PROCESS_NAMES = {
  claude:  ['claude.exe', 'claude'],
  codex:   ['codex.exe',  'codex'],
  gemini:  ['gemini.exe', 'gemini'],
  copilot: ['copilot.exe','copilot'],
  grok:    ['grok.exe',   'grok'],
  qwen:    ['qwen.exe',   'qwen'],
};
// Some CLIs are Node.js scripts wrapped in a .cmd shim, so their OS process
// name is node.exe. These substrings match against node.exe CommandLine.
const AI_CLI_NODE_MARKERS = {
  gemini:  ['@google/gemini-cli', 'gemini-cli', 'gemini.js'],
  copilot: ['@github/copilot-cli', 'copilot-cli'],
  codex:   ['@openai/codex', 'codex.js'],
  qwen:    ['qwen-code', 'qwen.js'],
};

let _cache = { ts: 0, tree: null };

async function readProcessTree() {
  // Cache for ~1s so multiple terminals polling back-to-back share one snapshot.
  if (Date.now() - _cache.ts < 1000 && _cache.tree) return _cache.tree;
  // wmic was removed in Windows 11 24H2; Get-CimInstance is on every supported SKU.
  return await new Promise((resolve) => {
    try {
      const psCmd = '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress';
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true });
      let out = '';
      ps.stdout.on('data', (b) => { out += b.toString('utf8'); });
      ps.on('error', () => resolve(null));
      ps.on('close', () => {
        try {
          const arr = JSON.parse(out || '[]');
          const list = Array.isArray(arr) ? arr : [arr];
          const byParent = new Map();
          for (const p of list) {
            const pid = Number(p && p.ProcessId);
            const ppid = Number(p && p.ParentProcessId);
            const name = String((p && p.Name) || '').trim().toLowerCase();
            const cmdline = String((p && p.CommandLine) || '').toLowerCase();
            if (!pid || !name) continue;
            if (!byParent.has(ppid)) byParent.set(ppid, []);
            byParent.get(ppid).push({ pid, name, cmdline });
          }
          _cache = { ts: Date.now(), tree: byParent };
          resolve(byParent);
        } catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
  });
}

function detectAiUnder(tree, rootPid) {
  if (!tree || !rootPid) return null;
  const visited = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const kids = tree.get(pid) || [];
    for (const k of kids) {
      // Direct name match (compiled binaries like claude.exe).
      for (const cli of Object.keys(AI_CLI_PROCESS_NAMES)) {
        if (AI_CLI_PROCESS_NAMES[cli].includes(k.name)) return cli;
      }
      // Node.js-based CLIs: match via CommandLine when process is node.exe.
      if ((k.name === 'node.exe' || k.name === 'node') && k.cmdline) {
        for (const cli of Object.keys(AI_CLI_NODE_MARKERS)) {
          if (AI_CLI_NODE_MARKERS[cli].some(m => k.cmdline.includes(m))) return cli;
        }
      }
      stack.push(k.pid);
    }
  }
  return null;
}

module.exports = { readProcessTree, detectAiUnder, AI_CLI_PROCESS_NAMES, AI_CLI_NODE_MARKERS };
