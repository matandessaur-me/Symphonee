# Notepad: write a haiku

app: notepad
difficulty: tier1
setup: Open Notepad. Any document content is fine.

goal:
Write a 5-7-5 syllable haiku about Tuesday on a fresh line at the end
of this document. Do not overwrite anything that is already there.

watch-for:
First iteration, the agent takes a screenshot and reasons about where
the cursor currently is. Second iteration it decides on Ctrl+End,
then types the haiku and calls finish. This is the canonical "it
works" demo and should land cleanly every time.
