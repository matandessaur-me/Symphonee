# Blender: render the default cube in red

app: blender
difficulty: tier2
setup: Open Blender with the default startup scene (the familiar
cube, camera, and light). Any recent version is fine.

goal:
Give the default cube a red material and render a single frame with
F12. The render window should appear with the cube visible as a red
shape. You may need to calibrate_mouse_look if the 3D viewport feels
off; keyboard-first is safer (Shift+A for add menu, F12 for render,
etc.).

watch-for:
First session on Blender, the agent has to discover the Material
Properties panel by trial. This is a great place to call
write_memory with what it learned: "To change the active object's
material, click the red sphere icon on the right properties panel,
then Surface -> Base Color." Second run reads that memory and goes
straight there.
