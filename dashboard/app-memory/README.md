# App Memory

Per-app knowledge files written and read by the Apps-tab agent.

One markdown file per target application, named after the lowercased
process executable (no `.exe`): `notepad.md`, `blender.md`, `winword.md`,
`powerpnt.md`, and so on.

The agent appends short bullets under conventional sections
(`Summary`, `UI map`, `Keybindings that work`, `Successful workflows`,
`Known failure modes`, `Calibration`) as it learns, and reads the file
back into its system prompt at session start. You can edit these files
by hand if you want to seed the agent with specific guidance.

Files in this directory are gitignored (this README is the exception)
because their contents are runtime state and can contain context
specific to your machine.
