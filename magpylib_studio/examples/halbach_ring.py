"""A Halbach ring: magnets round a bore, each polarization turning twice per
revolution, so that their fields add up across the bore and nearly cancel
outside.

The ring is one magnet and one circular pattern: `n` sets how many copies go
round, and each copy turns with its place, which is what makes it a Halbach
arrangement. The probe across the bore is a grid of hidden pixels, drawn as its
field lines. The two variants are a smaller ring of eight and a wider one of
sixteen.
"""

from typing import Annotated

import magpylib as magpy

from magpylib_studio import Count, Length, duplicate_around, grid, scene

TITLE = "Halbach ring"
SUMMARY = (
    "A ring of magnets, one magnet and a circular pattern, and the field lines "
    "across the bore — drag n or radius, or try the compact and wide variants"
)


@scene(
    model_unit="mm",
    field_unit="mT",
    variants={
        "compact": {"n": 8, "radius": 0.02},
        "wide": {"n": 16, "radius": 0.035},
    },
)
def halbach_ring(
    n: Annotated[int, Count(4, 48, slider=(6, 24))] = 12,
    radius: Annotated[float, Length(0.01, 0.1, slider=(0.018, 0.04))] = 0.025,
    density: Annotated[int, Count(2, 25, slider=(3, 15))] = 7,
):
    """A ring of `n` magnets, each polarization turning twice per
    revolution, so that their fields add up across the bore, and a probe
    across the bore, `density` by `density` points, drawn as its field
    lines."""
    ring = magpy.Collection(style_label="Halbach ring")
    magnet = magpy.magnet.Cuboid(
        dimension=(0.008, 0.008, 0.008),
        polarization=(1, 0, 0),
        position=(radius, 0, 0),
        style_label="magnet",
    )
    ring.add(magnet)
    duplicate_around(magnet, count=n, axis="z", spin=360 / n)

    bore = magpy.Sensor(
        pixel=grid(radius / 2, density),
        style={"label": "bore", "pixel": {"size": 0, "field": {"source": "B"}}},
    )
    return ring, bore
