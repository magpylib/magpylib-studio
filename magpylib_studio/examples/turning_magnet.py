"""A magnet turning through a revolution under a grid of field arrows, each
coloured and scaled by what it reads: magpylib's animated quiver, as a scene.

The magnet's orientation is a path, so the scene is a run: press play, or drag
the slider along the foot of the view. The arrows are the pixels of one sensor,
so `lift` moves them all at once, and `density` decides how many there are.
"""

from typing import Annotated

import magpylib as magpy
import numpy as np

from magpylib_studio import Count, Length, sampled, scene

TITLE = "Turning magnet, field arrows"
SUMMARY = (
    "A magnet rotating through a revolution under a grid of arrows coloured by "
    "what they read — press Animate paths"
)


@scene
def turning_magnet(
    lift: Annotated[float, Length(0.001, 0.1, slider=(0.005, 0.03))] = 0.01,
    width: Annotated[float, Length(0.001, 0.1, slider=(0.01, 0.05))] = 0.03,
    density: Annotated[int, Count(2, 40, slider=(4, 20))] = 12,
):
    """A magnet `width` wide turning once about y, and `density` by
    `density` arrows `lift` above it."""
    magnet = magpy.magnet.Cuboid(
        polarization=(0, 0, 1),
        dimension=(0.01, width, 0.01),
        style_label="Turning magnet",
    )
    field = magpy.Sensor(
        position=(0, 0, lift),
        pixel=sampled(
            lambda t: (
                -0.02 + 0.04 * (t % density) / (density - 1),
                -0.02 + 0.04 * (t // density) / (density - 1),
                0,
            ),
            count=density**2,
            over=(0, density**2 - 1),
        ),
        style={
            "label": "Field arrows",
            "pixel": {
                "field": {"source": "B", "symbol": "arrow3d", "colormap": "Viridis"}
            },
        },
    )
    magnet.rotate_from_angax(np.linspace(0.0, 360.0, 51), "y", start=0)
    return magnet, field
