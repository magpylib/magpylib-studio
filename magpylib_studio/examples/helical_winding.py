from typing import Annotated

import magpylib as magpy
import numpy as np

from magpylib_studio import Bounds, Count, Length, derived, sampled, scene, tau

TITLE = "Helical winding"


@scene
def helical_winding(
    radius: Annotated[float, Length(0.0005, 0.1, slider=(0.005, 0.03))] = 0.012,
    turns: Annotated[float, Bounds(0.25, 40, slider=(1, 8))] = 3.0,
    height: Annotated[float, Length(0.0002, 0.4, slider=(0.004, 0.04))] = 0.015,
    per_turn: Annotated[int, Count(3, 400, slider=(8, 40))] = 20,
):
    """One wire spiralling through space: a helical winding, written as the
    curve it is.

    A solenoid of separate loops is a pattern, but a continuous helix is a
    single object, and what it is is a formula. Its vertices are sampled
    from that formula, so `radius`, `turns` and `height` reshape the
    winding, and `per_turn` sets how finely it is drawn. `pitch` is
    derived: a coil is wound to a length and a number of turns, and the
    space left between turns follows.

    A helix of `turns` turns, `height` long, drawn with `per_turn` points a
    turn, and a sensor along its axis.
    """
    derived("pitch", height / turns, unit="length")
    winding = magpy.current.Polyline(
        current=400,
        vertices=sampled(
            lambda t: (
                radius * np.cos(tau * turns * t),
                radius * np.sin(tau * turns * t),
                height * t - height / 2,
            ),
            count=round(per_turn * turns) + 1,
        ),
        style_label="Helical winding",
    )
    sensor = magpy.Sensor(
        position=np.linspace((0.0, 0.0, -0.02), (0.0, 0.0, 0.02), 25),
        style_label="On axis",
    )
    return winding, sensor
