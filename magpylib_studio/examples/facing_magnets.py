"""Two magnets facing each other across a gap, the second a mirror image of the
first.

The second magnet is not written out: it is the first, mirrored through the
plane between them. Resize or move the first and the second follows. The sensor
runs through the gap along the axis.
"""

from typing import Annotated

import magpylib as magpy
import numpy as np

from magpylib_studio import Length, mirror, scene

TITLE = "Facing magnet pair"
SUMMARY = (
    "A magnet and its mirror image across a gap, which stays a mirror image as "
    "the first is edited"
)


@scene
def facing_magnets(
    gap: Annotated[float, Length(0.001, 0.2, slider=(0.005, 0.06))] = 0.02,
    size: Annotated[float, Length(0.0005, 0.05, slider=(0.005, 0.02))] = 0.01,
):
    """A cube of side `size` `gap / 2` above the plane, its mirror below,
    and a sensor through the gap."""
    pair = magpy.Collection(style_label="Facing pair")
    upper = magpy.magnet.Cuboid(
        dimension=(size, size, size),
        polarization=(0, 0, -1),
        position=(0, 0, gap / 2),
        style_label="Upper",
    )
    pair.add(upper)
    sensor = magpy.Sensor(
        position=np.linspace((0.0, 0.0, -0.03), (0.0, 0.0, 0.03), 25),
        style_label="Through the gap",
    )
    mirror(upper, plane="xy", anchor=0)
    return pair, sensor
