"""Two figures from one script, drawn in the window the script was run from.

Run it from a terminal in a window where the extension is active — the Run
button, F5 and a plain `python` in the integrated terminal all carry the
address. Then run it again: the two panels update where they are, keeping the
camera you left them at, rather than a second pair appearing beside them.

Run it from a terminal outside VS Code and each says why it cannot draw.

The two panels are drawn by different things. `backend="studio"` builds the
same three.js scene graph the studio's own view uses — read only here, since
the objects live in this script and this script is about to exit. The plotly
one is the chart, for when that is what you want.
"""

import magpylib as magpy

# Nothing is imported for the scene graph: installing this package advertises
# `studio` to magpylib, which finds it on its own. The plotly route is a
# choice a script makes for itself -- the window stamped an address on the
# terminal, it did not ask for anything to be drawn (design decision 8).
from magpylib_studio.plotly_view import draw_here

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

magpy.show(magnet, sensor, backend="studio")
magpy.show(magnet, sensor, backend="plotly")
