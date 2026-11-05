"""The designs of `examples/marimo/halbach_ring.py` and `coil_pair.py`, as
the example gallery offers them: a Halbach ring to tune and a coil pair to flip.

The notebooks write their functions out where they use them, because a design
being a plain function is what they show. These are the same functions, and a
test builds both and compares the documents, so the two cannot drift apart.
"""

from typing import Annotated

import magpylib as magpy

from magpylib_studio import (
    Bounds,
    Count,
    Length,
    duplicate_along,
    duplicate_around,
    grid,
    scene,
)


@scene(
    model_unit="mm",
    field_unit="mT",
    variants={
        "compact": {"n": 8, "radius": 0.02},
        "wide": {"n": 16, "radius": 0.035},
    },
)
def halbach(
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


_amperes = Bounds(-100, 100, slider=(-50, 50), unit="current")


@scene(
    model_unit="mm",
    field_unit="mT",
    variants={
        "Helmholtz": {"lower": 20.0, "upper": 20.0, "spacing": 0.04},
        "anti-Helmholtz": {"lower": 20.0, "upper": -20.0, "spacing": 0.04},
    },
)
def coils(
    radius: Annotated[float, Length(0.01, 0.1, slider=(0.02, 0.06))] = 0.04,
    spacing: Annotated[float, Length(0.005, 0.15, slider=(0.01, 0.1))] = 0.04,
    lower: Annotated[float, _amperes] = 20.0,
    upper: Annotated[float, _amperes] = 20.0,
    turns: Annotated[int, Count(1, 20, slider=(1, 12))] = 6,
):
    """Two coils of `turns` loops, `spacing` apart centre to centre, and
    a probe across the gap between them, in the plane of the axis."""
    pitch = 0.002
    pair = magpy.Collection(style_label="coil pair")
    for name, current, centre in (
        ("lower", lower, -spacing / 2),
        ("upper", upper, spacing / 2),
    ):  # literals
        coil = magpy.Collection(style_label=f"{name} coil")
        pair.add(coil)
        loop = magpy.current.Circle(
            current=current,
            diameter=2 * radius,
            position=(0, 0, centre - (turns - 1) * pitch / 2),
            style_label=f"{name} loop",
        )
        coil.add(loop)
        duplicate_along(loop, count=turns, step=(0, 0, pitch))
    probe = magpy.Sensor(
        pixel=grid(0.6 * radius, 9, plane="xz"),
        style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
    )
    return pair, probe
