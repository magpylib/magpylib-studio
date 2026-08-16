"""Two figures from one script, drawn in the window the script was run from.

Run it from a terminal in a window where the extension is active — the Run
button, F5 and a plain `python` in the integrated terminal all carry the
address. Then run it again: the two panels update where they are, keeping the
camera you left them at, rather than a second pair appearing beside them.

Run it from a terminal outside VS Code and it says why it cannot draw.
"""

import magpylib as magpy

# One line, in the script, choosing where this script's figures go. The window
# stamped an address on the terminal; it did not ask for anything to be drawn
# (CONTINUE.md, design decision 8).
from magpylib_studio.viewer import draw_here

draw_here()

magnet = magpy.magnet.Cuboid(
    polarization=(0, 0, 1),
    dimension=(2, 2, 1),
    style={"label": "Magnet"},
)
sensor = magpy.Sensor(
    position=(0, 0, 3),
    pixel=[(x / 2, y / 2, 0) for x in range(-2, 3) for y in range(-2, 3)],
    style={"label": "Sensor grid"},
)

magpy.show(magnet, sensor, backend="plotly")
magpy.show(magnet, backend="plotly")
