# Apps tab demo scenarios

Each file in this folder describes a short manual demo for the Apps
tab. Run Symphonee, open the Apps tab, pick the target window from
the picker, paste the goal into the input, and press Start. These are
the same scenarios the project pitch materials should record.

Honest expectations per tier (see `docs/apps-limits.md` if you wrote
one, or the original implementation plan):

- Tier 1 (dialogs, menus): high success. Notepad, Paint, Settings.
- Tier 2 (dense productivity UIs): slow and fumbly. Word, Blender,
  Photoshop.
- Tier 3 (games with cursor-capture or fast physics): demo-grade
  only. Minecraft will be entertaining and mostly fail.

Scenario files use this format:

```
# Title
app: <exe-name>
difficulty: tier1|tier2|tier3
setup: what the user should have on screen before starting
goal: one-paragraph goal the agent receives via the Apps input
watch-for: the moment in the run that makes the demo memorable
```
