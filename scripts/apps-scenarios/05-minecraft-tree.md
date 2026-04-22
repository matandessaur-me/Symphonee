# Minecraft: chop a tree

app: javaw (or minecraft)
difficulty: tier3
setup: Launch Minecraft Java Edition, start a new creative or
survival world on flat-ish terrain with a few trees visible. Empty
inventory. Mouse should not be captured yet (ESC to the pause menu,
then Back to Game; the agent will take focus).

goal:
Walk up to a tree. Punch the wood blocks until a log pops out and
enters your inventory. Stop when you can see at least one wood log
in the hotbar. This is a stress test; cloud LLM latency (1-4 s per
tool call) is way too slow for real gameplay. Expect the agent to
die, fall in water, or get lost repeatedly. That is the demo.

watch-for:
The agent will try calibrate_mouse_look to figure out how sensitive
the camera is. It will screenshot often, reason about where the tree
is, and try to press W to walk. Most attempts fail charmingly. If it
actually lands a punch on a log block, celebrate. The value of this
demo is the commentary in the right rail -- the agent narrating what
it sees and why it cannot keep up.
