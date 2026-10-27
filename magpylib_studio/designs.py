"""The two designs of `examples/marimo_demo.py`, as the example gallery offers
them: a Halbach ring to tune and a coil pair to flip.

The notebook writes its functions out where it uses them, because a design
being a plain function is what it shows. These are the same functions, and a
test builds both and compares the documents, so the two cannot drift apart.
"""

from typing import Annotated, Literal

import magpylib as magpy

from magpylib_studio import (
    Angle,
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
        "compact": {"n": 8, "radius": 0.02, "gap": 0.012},
        "wide": {"n": 16, "radius": 0.035, "gap": 0.014},
    },
)
def halbach(
    n: Annotated[int, Count(4, 48, slider=(6, 24))] = 12,
    radius: Annotated[float, Length(0.01, 0.1, slider=(0.018, 0.04))] = 0.025,
    gap: Annotated[float, Length(0.006, 0.05, slider=(0.009, 0.03))] = 0.012,
    twist: Annotated[float, Angle(-180, 180, slider=(-180, 180))] = 0.0,
    tilt: Annotated[float, Angle(-180, 180, slider=(-90, 90))] = 0.0,
    tilt_axis: Literal["x", "y", "z"] = "z",
    density: Annotated[int, Count(2, 25, slider=(3, 15))] = 7,
    layers: Annotated[int, Count(1, 9, slider=(1, 5))] = 1,
):
    """Two concentric rings of magnets, the outer `gap` further out, each
    polarization turning twice per revolution: in step their fields add
    up across the bore, and `twist` turns the inner ring against the
    outer. A grid of field arrows across the bore, `layers` of it."""
    rings = magpy.Collection(style_label="Halbach rings")
    ring = {}
    for name, r in (("Inner", radius), ("Outer", radius + gap)):  # literals
        ring[name] = magpy.Collection(style_label=f"{name} ring")
        rings.add(ring[name])
        magnet = magpy.magnet.Cuboid(
            dimension=(0.008, 0.008, 0.008),
            polarization=(1, 0, 0),
            position=(r, 0, 0),
            style_label=f"{name} magnet",
        )
        ring[name].add(magnet)
        duplicate_around(magnet, count=n, axis="z", spin=360 / n)
    ring["Inner"].rotate_from_angax(twist, "z", anchor=0)
    rings.rotate_from_angax(tilt, tilt_axis, anchor=0)

    bore = magpy.Sensor(
        pixel=grid(radius / 2, density, layers=layers),
        style={
            "label": "bore",
            "size": 0.004,
            "pixel": {
                "field": {
                    "source": "B",
                    "symbol": "arrow3d",
                    "colormap": "Viridis",
                }
            },
        },
    )
    return rings, bore


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
        style={
            "label": "probe",
            "size": 0.004,
            "pixel": {"field": {"source": "B", "symbol": "arrow3d"}},
        },
    )
    return pair, probe
