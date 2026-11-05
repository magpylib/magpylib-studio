"""A solenoid: one current loop and a linear pattern, rather than a stack of
loops written out one by one.

`turns` and `pitch` reshape the whole coil, and its length is derived from
them.
"""

from typing import Annotated

import magpylib as magpy
import numpy as np

from magpylib_studio import Bounds, Count, Length, derived, duplicate_along, scene

TITLE = "Solenoid"
SUMMARY = "One current loop patterned along an axis, and a sensor along the bore"


@scene
def solenoid(
    turns: Annotated[int, Count(1, 200, slider=(4, 40))] = 12,
    coil_radius: Annotated[float, Length(0.0005, 0.1, slider=(0.003, 0.03))] = 0.01,
    pitch: Annotated[float, Length(0.0001, 0.02, slider=(0.001, 0.006))] = 0.0025,
    amps: Annotated[
        float, Bounds(-10000, 10000, slider=(0, 500), unit="current")
    ] = 100,
):
    """`turns` loops of radius `coil_radius`, `pitch` apart, carrying
    `amps`, and a sensor along the axis."""
    height = derived("height", pitch * (turns - 1), unit="length")
    coil = magpy.Collection(style_label="Solenoid")
    turn = magpy.current.Circle(
        current=amps,
        diameter=2 * coil_radius,
        position=(0, 0, -height / 2),
        style_label="Turn",
    )
    coil.add(turn)
    sensor = magpy.Sensor(
        position=np.linspace((0.0, 0.0, -0.025), (0.0, 0.0, 0.025), 25),
        style_label="On axis",
    )
    duplicate_along(turn, turns, (0, 0, pitch))
    return coil, sensor
