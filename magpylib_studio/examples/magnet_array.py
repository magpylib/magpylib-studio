"""A magnet array: one magnet patterned into a row, the row into a layer, and the
layer into a stack.

Three linear patterns, each count a variable. The stack starts one layer high,
so the scene opens as a flat grid; all three counts at the top of their sliders
make a thousand magnets. The sensor runs above the top layer.
"""

from typing import Annotated

import magpylib as magpy

from magpylib_studio import Count, Length, duplicate_along, sampled, scene

TITLE = "Magnet array"
SUMMARY = (
    "A magnet patterned into a row, the row into a layer, the layer into a "
    "stack — three linear steps, every count editable"
)


@scene
def magnet_array(
    nx: Annotated[int, Count(1, 40, slider=(2, 10))] = 4,
    ny: Annotated[int, Count(1, 40, slider=(2, 10))] = 3,
    nz: Annotated[int, Count(1, 20, slider=(1, 10))] = 1,
    pitch: Annotated[float, Length(0.002, 0.1, slider=(0.01, 0.04))] = 0.015,
    lift: Annotated[float, Length(0.001, 0.1, slider=(0.005, 0.04))] = 0.02,
):
    """`nx` by `ny` by `nz` cubes `pitch` apart, and a sensor `lift` above
    the top layer."""
    array = magpy.Collection(style_label="Magnet array")
    layer = magpy.Collection(style_label="Layer")
    array.add(layer)
    row = magpy.Collection(style_label="Row")
    layer.add(row)
    tile = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.01), polarization=(0, 0, 1), style_label="Tile"
    )
    row.add(tile)
    sensor = magpy.Sensor(
        position=sampled(
            lambda t: (-0.01 + 0.06 * t, 0.015, lift + pitch * (nz - 1)), count=25
        ),
        style_label="Above the array",
    )
    duplicate_along(tile, nx, (pitch, 0, 0))
    duplicate_along(row, ny, (0, pitch, 0))
    duplicate_along(layer, nz, (0, 0, pitch))
    return array, sensor
