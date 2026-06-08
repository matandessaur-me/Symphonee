// apps-chat-tools -- the desktop-automation tool schemas (click/type/key/
// screenshot/UIA/...) the apps agent exposes to the LLM. Pure data, split
// from apps-agent-chat.js. Edit here.
module.exports = [
  { name: 'screenshot',
    description: 'Capture a JPEG screenshot of the currently targeted application window. Use as fallback when describe_window does not surface a UIA element you need (custom-rendered canvas, game UI, web canvas).',
    parameters: { type: 'object', properties: {} } },
  { name: 'describe_window',
    description: 'Return a flat list of UI elements in the current target window from the Windows UIA (UI Automation) tree. Each element has stable identity (name, type, automationId) that survives resize, theme changes, and DPI. ALWAYS prefer this over screenshot when planning your next click — coordinates from screenshots drift, UIA selectors do not. Falls back to screenshot if the window is non-automatable (canvas / game / unknown framework).',
    parameters: { type: 'object', properties: {
      maxNodes: { type: 'number', description: 'Cap on returned elements (default 400, max 2000). Bigger trees mean more tokens.' }
    } } },
  { name: 'click_element',
    description: 'Click a UI element by stable selector. The driver invokes the element directly via UIA Invoke pattern when possible (zero mouse movement, deterministic), and falls back to a center-coordinate click otherwise. Prefer this over click(x,y) for any normal control — buttons, menu items, list items.',
    parameters: { type: 'object', properties: {
      selector: { type: 'object', description: 'Object with optional fields { name, type, id (automationId), class, ancestors }. Provide as many as needed to disambiguate.', properties: {
        name: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' }, class: { type: 'string' },
        ancestors: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' } } } }
      } }
    }, required: ['selector'] } },
  { name: 'type_into_element',
    description: 'Focus a UIA editable element by selector and type the given text into it. Use this for text inputs, address bars, search boxes — more robust than clicking-then-typing because it sets focus via UIA.',
    parameters: { type: 'object', properties: {
      selector: { type: 'object' }, text: { type: 'string' }
    }, required: ['selector', 'text'] } },
  { name: 'wait_for_element',
    description: 'Block until a UIA selector resolves (a dialog appears, a button becomes visible, a list populates) or timeoutMs elapses. Returns { hit, waitedMs }. Replaces brittle wait_ms("guess how long the dialog takes").',
    parameters: { type: 'object', properties: {
      selector: { type: 'object' }, timeoutMs: { type: 'number', description: 'Default 5000, max 30000.' }
    }, required: ['selector'] } },
  { name: 'read_element',
    description: 'Read the text/value of a UIA element by selector. Returns the input contents, button label, status bar text, or any TextPattern/ValuePattern/Name property. Lets you verify state without spending a screenshot.',
    parameters: { type: 'object', properties: {
      selector: { type: 'object' }
    }, required: ['selector'] } },
  { name: 'list_windows',
    description: 'Return the list of currently visible top-level windows on the desktop with process name, title, HWND, and bounding rect.',
    parameters: { type: 'object', properties: {} } },
  { name: 'focus_window',
    description: 'Bring a window to the foreground and make it the active target for subsequent actions. Use the hwnd from list_windows.',
    parameters: { type: 'object', properties: { hwnd: { type: 'number', description: 'The window handle (integer) returned by list_windows.' } }, required: ['hwnd'] } },
  { name: 'click',
    description: 'Click at a window-relative pixel coordinate inside the current target window. Coordinates are relative to the top-left of the window.',
    parameters: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default: left.' },
      double: { type: 'boolean', description: 'Double-click when true.' }
    }, required: ['x', 'y'] } },
  { name: 'mouse_move',
    description: 'Move the mouse to a window-relative coordinate without clicking. Useful for hover states and calibration.',
    parameters: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
      smooth: { type: 'boolean', description: 'If true, move gradually along a path rather than teleporting.' }
    }, required: ['x', 'y'] } },
  { name: 'drag',
    description: 'Press, move, and release the left mouse button from one window-relative coordinate to another.',
    parameters: { type: 'object', properties: {
      fromX: { type: 'number' }, fromY: { type: 'number' },
      toX: { type: 'number' }, toY: { type: 'number' }
    }, required: ['fromX', 'fromY', 'toX', 'toY'] } },
  { name: 'scroll',
    description: 'Scroll inside the current window using mouse-wheel ticks. Pick the axis carefully:\n' +
      '  - dy is VERTICAL: positive dy scrolls DOWN the page (reveals content below), negative dy scrolls UP.\n' +
      '  - dx is HORIZONTAL: positive dx scrolls RIGHT (reveals content to the right), negative dx scrolls LEFT.\n' +
      'NEVER set both dx and dy at once. Choose a single axis per call.\n' +
      'Typical magnitudes: 3 ticks = small nudge, 6 = one "page" on most apps, 15 = long jump. ' +
      'If a horizontal scrollbar is visible and you need to see content hidden on the right, use positive dx, NOT positive dy.',
    parameters: { type: 'object', properties: {
      dx: { type: 'number', description: 'Horizontal ticks. Positive = right, negative = left. Leave out for vertical scrolls.' },
      dy: { type: 'number', description: 'Vertical ticks. Positive = down, negative = up. Leave out for horizontal scrolls.' }
    } } },
  { name: 'type_text',
    description: 'Type a literal string of characters into the focused window. Does NOT interpret special keys like Enter or Tab; use key for those.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'key',
    description: 'Send a single keyboard combo like "Enter", "Ctrl+S", "Alt+F4", "F11", "Escape".',
    parameters: { type: 'object', properties: { combo: { type: 'string' } }, required: ['combo'] } },
  { name: 'wait_ms',
    description: 'Pause for N milliseconds to let the UI settle after an action. Capped at 60000.',
    parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
  { name: 'calibrate_mouse_look',
    description: 'For 3D / FPS games: move the mouse by a known pixel delta and screenshot before and after, so you can figure out how many pixels per camera degree this game uses.',
    parameters: { type: 'object', properties: { testDeltaPx: { type: 'number', description: 'How far to move the mouse in x. Default 200.' } } } },
  { name: 'declare_stuck',
    description: 'END the session and hand off to the user. Call this exactly once, only after you have genuinely exhausted your options. Give a specific reason (what you tried, what is blocking you, and what the user should do next). After this call the session stops — you will NOT get another turn, so make the reason actionable.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  { name: 'ask_user',
    description: 'Ask the human user a question when you truly cannot decide what to do next — e.g. credentials, an ambiguous choice, or domain knowledge only they have. Use sparingly: only as a last resort after trying at least two different approaches. Returns their answer as the tool result.',
    parameters: { type: 'object', properties: {
      question: { type: 'string', description: 'The specific question the user needs to answer. Be concrete.' }
    }, required: ['question'] } },
  { name: 'web_research',
    description: 'Search the web for ground-truth information about the target application — keyboard shortcuts, menu paths, concrete setup steps, version-specific quirks. Use this BEFORE you get stuck, not only after. Good queries: "How to add a uniform to vertex shader in KodeLife", "Figma keyboard shortcut for frame". The result is a short summary you can act on.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Specific question. Include the app name and the exact feature you need.' }
    }, required: ['query'] } },
  { name: 'write_memory',
    description: 'Append a short, durable note (<= 2000 bytes) about the current app under a named section (e.g. "UI map", "Keybindings that work", "Known failure modes", "Successful workflows", "Calibration"). Use this to persist anything future sessions on this app would benefit from knowing. Do not dump the screen here; write in terse, decision-useful bullets.',
    parameters: { type: 'object', properties: {
      section: { type: 'string' },
      note: { type: 'string' }
    }, required: ['section', 'note'] } },
  { name: 'read_memory',
    description: 'Re-read the full memory file for the current app if the truncated system-prompt slice is not enough.',
    parameters: { type: 'object', properties: {} } },
  { name: 'set_subgoal',
    description: 'Add or update a subgoal on the plan. Use this to revise the plan when you discover the original decomposition was wrong. If you omit status, new subgoals start as pending. Only one subgoal can be active at a time.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Stable id to edit an existing subgoal. Omit to create a new one.' },
      title: { type: 'string' },
      completionCheck: { type: 'string', description: 'Describe what the screenshot should show when this subgoal is complete.' },
      parentId: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'skipped'] }
    }, required: ['title'] } },
  { name: 'complete_subgoal',
    description: 'Mark a subgoal done and promote the next pending subgoal to active. Call this only after the visual completionCheck is satisfied.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'The subgoal id to mark done. If omitted, the currently active subgoal is used.' },
      evidence: { type: 'string', description: 'One short sentence describing what you saw on screen that confirms completion.' }
    } } },
  { name: 'finish',
    description: 'Stop the loop and return a final summary.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];
