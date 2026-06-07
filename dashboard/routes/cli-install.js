'use strict';
// Prerequisites + CLI install routes - extracted from server.js (behavior-preserving).
// ctx: { configPath }

const fs = require('fs');
const { exec } = require('child_process');
const { detectCli, detectPwsh, CLI_INSTALL_COMMANDS, PWSH_WINGET_CMD } = require('../lib/detect-cli');

function mountCliInstall(addRoute, json, ctx) {
  const { configPath } = ctx;

  function handlePrerequisites(res) {
    const result = {
      cliTools: {},
      nodeJs: { installed: true, version: process.version },
      config: { exists: false, complete: false },
    };

    for (const id of ['claude', 'gemini', 'copilot', 'codex', 'grok', 'qwen']) {
      result.cliTools[id] = detectCli(id);
    }

    result.pwsh = detectPwsh();

    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      result.config.exists = true;
      // "Complete" no longer means ADO is configured - the shell ships plugin-first, so
      // a DefaultUser + at least one configured repo is enough to be a usable install.
      result.config.complete = !!(cfg.DefaultUser && cfg.Repos && Object.keys(cfg.Repos).length > 0);
    } catch (_) {}

    const anyCliInstalled = Object.values(result.cliTools).some(c => c.installed);
    result.ready = anyCliInstalled && result.config.complete;

    json(res, result);
  }

  function handleCliInstall(req, res) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { cli } = JSON.parse(body);

        // PowerShell 7 needs admin elevation - handle separately
        if (cli === 'pwsh') return handlePwshInstall(res);

        const installCmd = CLI_INSTALL_COMMANDS[cli];
        if (!installCmd) return json(res, { error: `Unknown CLI: ${cli}` }, 400);

        // Run install asynchronously
        exec(installCmd, { timeout: 120000, encoding: 'utf8' }, (err, stdout, stderr) => {
          // After install, re-check using detectCli (checks PATH + common npm global dirs)
          const result = detectCli(cli);

          if (result.installed) {
            json(res, {
              ok: true, cli, installed: true, path: result.path,
              // If found via fallback (not in PATH), the user may need to restart the app
              needsRestart: !result.inPath,
            });
          } else {
            json(res, {
              ok: false, cli, installed: false,
              error: err ? err.message : 'Installation failed. Please try the manual command below.',
              fallbackCmd: installCmd,
            });
          }
        });
      } catch (e) {
        json(res, { error: 'Invalid request' }, 400);
      }
    });
  }

  function handlePwshInstall(res) {
    // Attempt elevated install via Start-Process -Verb RunAs (triggers UAC prompt)
    const elevatedCmd = `powershell.exe -NoProfile -Command "Start-Process -FilePath 'winget' -ArgumentList 'install Microsoft.PowerShell --accept-source-agreements --accept-package-agreements' -Verb RunAs -Wait -PassThru | Select-Object -ExpandProperty ExitCode"`;
    exec(elevatedCmd, { timeout: 180000, encoding: 'utf8' }, (err, stdout, stderr) => {
      // Check if pwsh is now available (detectPwsh checks common paths too, not just PATH)
      const result = detectPwsh();
      if (result.installed) {
        json(res, { ok: true, cli: 'pwsh', installed: true, path: result.path });
      } else {
        json(res, {
          ok: false, cli: 'pwsh', installed: false,
          error: 'Installation requires administrator privileges.',
          fallbackCmd: PWSH_WINGET_CMD,
        });
      }
    });
  }

  // ── Route registrations ─────────────────────────────────────────────────
  addRoute('GET',  '/api/prerequisites', (req, res) => handlePrerequisites(res));
  addRoute('POST', '/api/cli/install',   (req, res) => handleCliInstall(req, res));
}

module.exports = { mountCliInstall };
