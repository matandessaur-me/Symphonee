# Apps Automation Skill (Background / Stealth / Headless)

**This is a SKILL every AI bootstrapped into Symphonee has.** When the user
asks you to edit a document, populate a spreadsheet, draft an email, fill a
form, or run a desktop app workflow, you have first-class tools to do it
WITHOUT taking over the user's screen.

## When to use this skill

Match the user's request against these triggers:

- "edit / update / write / populate / fill / generate ... in Word / Excel /
  PowerPoint / Outlook / Office" → **COM path** (no window paints).
- "open the spreadsheet and ..." / "make me an invoice / report / proposal
  / budget / sales sheet / PDF source / .docx / .xlsx" → **COM path**.
- "draft a note / email / TODO / agenda / standup / release notes in
  Notepad / WordPad / a text editor" → **stealth path** (off-screen UIA).
- "fill out the form in <line-of-business app>" / "click through <native
  Win32 app>" → **stealth path**.
- "do this every morning / week / sprint" → wrap any of the above in the
  scheduler at `POST /api/jobs`.
- "run X in the background while I keep working" / "in parallel" / "without
  disturbing me" → **always sandbox**, never the foreground path.

When you've matched a trigger, **state in one short sentence** that you'll
use the headless / stealth path so the user sees the modal isn't a foreground
takeover, then proceed. Do not ask the user "should I use stealth?" — the
default answer is yes.

## Decision tree

```
Office app (Word/Excel/PowerPoint/Outlook)?
  └─ YES → /api/apps/com/* (headless COM, no window paints)
  └─ NO  → next

Chromium / Electron app (Spotify, Slack, Discord, browsers)?
  └─ YES → prefer /api/browser/agent or /api/browser/router
  └─ FALLBACK → stealth /api/apps/launch + UIA, but accept that
                HTML buttons without UIA Invoke patterns may fail.
                For browsers specifically use the browser stack.
  └─ NO  → next

UIA-friendly native app (Notepad, ERP, line-of-business, custom Win32)?
  └─ YES → stealth /api/apps/launch { sandbox: true } + agent
  └─ NO  → fall back to recipes/run-recipe.js or ask user
```

## Office (Word / Excel) — `/api/apps/com/*`

Office canvases are NOT exposed via UIA. Driving Word or Excel through the
agent's UIA tools (`type_into_element`, `click_element`) WILL fail
silently or report "no document element". Use COM instead — it spins up
`Word.Application` / `Excel.Application` with `Visible = $false`, drives
deterministically, saves the file, quits. No window paints at all.

```bash
# Word: write a .docx
curl -s -X POST http://127.0.0.1:3800/api/apps/com/word/write \
  -H "Content-Type: application/json" \
  -d '{ "filePath": "C:/Users/.../proposal.docx",
        "content": "Title\n\nFirst paragraph.\nSecond paragraph." }'
# -> { ok: true, path, words }

# Word: read a .docx back (text only)
curl -s -X POST http://127.0.0.1:3800/api/apps/com/word/read \
  -H "Content-Type: application/json" \
  -d '{ "filePath": "C:/Users/.../proposal.docx" }'
# -> { ok: true, text, chars }

# Excel: write a .xlsx (2D array, '=...' for formulas, autoFit by default)
curl -s -X POST http://127.0.0.1:3800/api/apps/com/excel/write \
  -H "Content-Type: application/json" \
  -d '{ "filePath": "C:/Users/.../sales.xlsx",
        "sheetName": "Q2",
        "values": [
          ["Customer", "Deal Value"],
          ["ACME", 12500],
          ["Globex", 8400],
          ["TOTAL", "=SUM(B2:B3)"]
        ] }'
# -> { ok: true, path, rows, sheet }

# Excel: read a .xlsx back (formulas evaluated to values)
curl -s -X POST http://127.0.0.1:3800/api/apps/com/excel/read \
  -H "Content-Type: application/json" \
  -d '{ "filePath": "C:/Users/.../sales.xlsx", "sheetName": "Q2" }'
# -> { ok: true, rows: [[...], ...] }
```

Implementation in `dashboard/apps-com.js`. PowerPoint / Outlook follow the
same COM pattern if ever needed — extend that module.

**Cross-app workflow proven**: Excel write → Excel read (pull SUM result) →
Word write quoting that result → end-to-end PASS in 35 seconds with zero
visible windows. See `.ai-workspace/demo-cross-app.js` for the reference
script.

## Stealth mode for UIA-friendly apps — `/api/apps/launch { sandbox: true }`

Use this when you need to drive a UI (a real app's input fields, buttons,
menus) but the user shouldn't see it happen. The launched window goes to
`(-32000,-32000)` immediately, stays off-screen via a reapply timer, then
gets `WS_EX_NOACTIVATE` at T+8s so user keystrokes can't leak in. Agent
drives via UIA (no SendInput leakage to user's foreground app).

```bash
# Stealth-launch
curl -s -X POST http://127.0.0.1:3800/api/apps/launch \
  -H "Content-Type: application/json" \
  -d '{ "id": "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
        "name": "Notepad",
        "sandbox": true }'
# -> { ok, hwnd, title, processName, sandbox: true, originalRect }

# Then dispatch the agent against that hwnd:
curl -s -X POST http://127.0.0.1:3800/api/apps/session/start \
  -H "Content-Type: application/json" \
  -d '{ "goal": "...", "hwnd": <hwnd>, "app": "..." }'
```

Companion routes:
```
POST /api/apps/sandbox/peek    { hwnd }       # show on-screen briefly
POST /api/apps/sandbox/unpeek  { hwnd }       # send back off-screen
POST /api/apps/sandbox/release { hwnd, restore? }  # stop tracking
GET  /api/apps/sandbox/list                   # what's currently sandboxed
```

The Apps tab shows a live screenshot grid (one tile per session), a
chip strip for switching active session, a pulsing dot on the Automation
tab when any session runs, and a bell-panel notification on completion.
The user sees activity in the tab WITHOUT the apps painting on their
desktop.

### Stealth limitations to surface up-front

- **Pixel-level input is BLOCKED** on sandboxed hwnds — `click(x,y)`,
  `type` (raw), `key`, `scroll` all throw `sandboxed_pixel_input_blocked`.
  Use UIA tools: `click_element` (Invoke / PostMessage fallback),
  `type_into_element` (ValuePattern.SetValue), `invoke`. No SendInput.
- **Chromium HTML buttons** without a UIA Invoke pattern (e.g. Spotify
  Play button, web-app buttons in Electron shells) cannot be reached.
  PostMessage click is the auto-fallback and works for some, fails for
  others. Don't promise the agent will press Play in stealth Spotify;
  release the sandbox first if the user's goal needs it.
- **Office apps in stealth** — wrong tool. Use COM (above) instead. Word
  document and Excel grid are not UIA-reachable anywhere, including
  stealth.

## Parallel runs

The Apps tab supports multiple concurrent sessions. Just call
`/api/apps/launch { sandbox: true }` and `/api/apps/session/start`
multiple times — each returns a distinct `sessionId`. The viewport
splits into a grid (one live screenshot tile per session). Sessions
don't fight for foreground because they're all off-screen.

## Scheduling — `dashboard/jobs-scheduler.js`

When the user says "every Monday", "daily 8am", "weekly", etc., wrap the
above calls in a scheduled job:

```bash
curl -s -X POST http://127.0.0.1:3800/api/jobs \
  -H "Content-Type: application/json" \
  -d '{ "name": "Daily standup doc",
        "cli": "claude",
        "schedule": "daily 08:00",
        "prompt": "Use /api/apps/com/word/write to create today'"'"'s standup doc..." }'
```

Schedule strings: `every 30m`, `every 4h`, `hourly :15`, `daily HH:MM`,
`weekly DOW HH:MM` (DOW=0..6, 0=Sun). Tick is 60s. Fires via
`orchestrator.spawnHeadless()` so each run shows up in the Orchestrator
tab as a normal task.

This is what makes "every morning at 8am pull yesterday's commits and
draft my standup doc" actually possible — the COM/stealth call runs at
8am whether you're at the keyboard or not.

## What this skill is NOT for

- **Real OS-level isolation** (different filesystem / network / registry).
  Sandbox/stealth is "invisible to the user", not "isolated from the
  system". For true isolation use a VM. Tell the user this if they ask.
- **Browsers and web apps** — use `/api/browser/*` (browser-use,
  stagehand, in-app agent). Stealth on Chrome/Edge will partially work
  but you have a better-fit primitive.
- **Apps that lack both COM and a UIA tree** (some games, some custom
  rendered apps). These need recipe-based pixel automation in foreground
  mode, or no automation at all.

## Anti-patterns — never do these

1. Don't drive Office (Word, Excel, PowerPoint, Outlook) via UIA. The
   document/grid surfaces are DirectWrite canvases. Use COM.
2. Don't synthesize SendInput against a sandboxed window. It routes
   into the user's foreground app. Use UIA tools or PostMessage click.
3. Don't promise the user that stealth will press a Chromium HTML button
   without checking UIA Invoke first. Inspect the tree, fall back
   gracefully if Invoke isn't there.
4. Don't run a 5-minute foreground UI automation while the user is
   working. If the task is bigger than ~10 seconds, sandbox it.
5. Don't ask the user "should I use stealth?". The default is yes for
   any background / scheduled / parallel work.

## Self-check before answering

- "User asked me to do something with files / docs / spreadsheets" →
  did I check whether COM / stealth / scheduler is the right primitive
  before claiming I can't do it?
- "User asked for parallel / background / undisturbed runs" → did I
  pass `sandbox: true`?
- "User asked for a recurring task" → did I propose
  `POST /api/jobs` with a schedule string?

If you forgot, reload this section: `GET /api/instructions/apps-automation`.
