from typing import Annotated, Literal

import magpylib as magpy
import numpy as np

from magpylib_studio import Angle, Count, Length, derived, duplicate_around, scene

TITLE = "Halbach stack"


@scene
def halbach_stack(
    n: Annotated[int, Count(2, 60, slider=(4, 20))] = 10,
    radius: Annotated[float, Length(0.005, 0.08, slider=(0.016, 0.04))] = 0.023,
    gap: Annotated[float, Length(0, 0.06, slider=(0.01, 0.03))] = 0.015,
    tilt: Annotated[float, Angle(-180, 180, slider=(-90, 90))] = 0.0,
    tilt_axis: Literal["x", "y", "z"] = "z",
):
    """Two Halbach rings stacked on one axis, the upper one turned by half a
    step.

    Each ring is one magnet and one circular pattern, so changing `n`
    rebuilds both rings, and the stagger follows, being half a step by
    definition. The whole stack can be tilted about any axis.

    Two rings of `n` cubes on a radius `radius`, `gap` apart, and a sensor
    along the bore.
    """
    stagger = derived("stagger", 360 / (2 * n), unit="angle")
    halbach = magpy.Collection(style_label="Halbach stack")
    ring1 = magpy.Collection(style_label="Ring 1")
    halbach.add(ring1)
    r1 = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.01),
        polarization=(1, 0, 0),
        position=(radius, 0, 0.0),
        style_label="Magnet 1",
    )
    ring1.add(r1)
    ring2 = magpy.Collection(style_label="Ring 2")
    halbach.add(ring2)
    r2 = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.01),
        polarization=(1, 0, 0),
        position=(radius, 0, gap),
        style_label="Magnet 2",
    )
    ring2.add(r2)
    sensor = magpy.Sensor(
        position=np.linspace((0.0, 0.0, -0.015), (0.0, 0.0, 0.03), 25),
        style_label="Sensor",
    )
    duplicate_around(r1, n, axis="z", anchor=(0, 0, 0), spin=360 / n)
    duplicate_around(r2, n, axis="z", anchor=(0, 0, 0), spin=360 / n)
    ring2.rotate_from_angax(stagger, "z", anchor=0)
    halbach.rotate_from_angax(tilt, tilt_axis, anchor=0)
    return halbach, sensor
