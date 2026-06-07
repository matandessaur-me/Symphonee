'use strict';
// Stale-instance + port reclamation for the Electron main process (Windows only).
// Kills any process holding the app port or any other Electron instance of this
// exe, so a relaunch can bind cleanly. Extracted from electron-main.js.
const path = require('path');

/**
 * Kill anything holding port 3800 and/or any stale Electron instances.
 * Returns true if something was killed.
 */
function killStaleProcesses(port) {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  const myPid = process.pid;
  const pidsToKill = new Set();

  // Strategy 1: find PIDs holding port 3800 via netstat
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/\s(\d+)$/);
      if (m && Number(m[1]) !== myPid) pidsToKill.add(m[1]);
    }
  } catch (_) { /* no listeners on port -- fine */ }

  // Strategy 2: find other Electron instances by exe name
  try {
    const exeName = path.basename(process.execPath);
    const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/^"[^"]+","(\d+)"/);
      if (m && Number(m[1]) !== myPid) pidsToKill.add(m[1]);
    }
  } catch (_) {}

  if (pidsToKill.size) {
    try {
      execSync(`taskkill /F ${[...pidsToKill].map(p => '/PID ' + p).join(' ')}`, { encoding: 'utf8', timeout: 5000 });
      console.log('Killed stale process(es):', [...pidsToKill].join(', '));
      return true;
    } catch (_) {}
  }
  return false;
}

module.exports = { killStaleProcesses };
