import typing
from typing import Annotated

import magpylib as magpy

from magpylib_studio import Bounds, Length, choose, duplicate_along, grid, scene

TITLE = "Two versions of a unit"


@scene(
    model_unit="mm",
    field_unit="mT",
    variants={
        "v1": {"version": "v1"},
        "v1 wide": {"version": "v1", "spacing": 0.018},
        "v2": {"version": "v2"},
        "v2 reversed": {"version": "v2", "current": -2000.0},
    },
)
def unit_versions(
    version: typing.Literal["v1", "v2"] = "v1",
    spacing: Annotated[float, Length(0.008, 0.024)] = 0.012,
    current: Annotated[float, Bounds(-3000, 3000, unit="current")] = 2000.0,
):
    """Two versions of a test unit that differ in structure, not only in a
    value: a narrow core with two inlay pieces, and a wide one with three
    and a notch.

    A choice can pick what a scene is made of: `versions =
    choose(version)`, then `versions.add("v2", ...)`. One document holds
    both versions, and the one `version` names is the one in the scene:
    drawn, listed, in the field. A piece moved in one version is still
    where it was left when the scene comes back to it. The other variables
    mix in as before: `spacing` spreads v1's two pieces, and only v1 reads
    it; `current` is the coil's, in both versions. A variant sets what it
    names: "v2 reversed" sets the version and the current at once, and "v1"
    then sets only the version, so the current stays reversed.
    """
    versions = choose(version, style_label="versions")
    core1 = magpy.magnet.Cuboid(
        dimension=(0.03, 0.01, 0.01), polarization=(0, 0, 1), style_label="core"
    )
    piece1 = magpy.magnet.Cuboid(
        dimension=(0.006, 0.008, 0.004),
        polarization=(0.8, 0, 0),
        position=(-spacing / 2, 0, 0.008),
        style_label="inlay",
    )
    inlay1 = magpy.Collection(piece1, style_label="inlay")
    versions.add("v1", core1, inlay1)
    duplicate_along(piece1, count=2, step=(spacing, 0, 0))
    core2 = magpy.magnet.Cuboid(
        dimension=(0.044, 0.012, 0.01), polarization=(0, 0, 1), style_label="core"
    )
    piece2 = magpy.magnet.Cuboid(
        dimension=(0.006, 0.008, 0.004),
        polarization=(0.8, 0, 0),
        position=(-0.014, 0, 0.008),
        style_label="inlay",
    )
    notch = magpy.magnet.Cuboid(
        dimension=(0.008, 0.012, 0.003),
        polarization=(0, 0, -0.6),
        position=(0, 0, -0.0065),
        style_label="notch",
    )
    inlay2 = magpy.Collection(piece2, style_label="inlay")
    versions.add("v2", core2, inlay2, notch)
    duplicate_along(piece2, count=3, step=(0.014, 0, 0))
    coil = magpy.current.Circle(
        current=current, diameter=0.05, position=(0, 0, -0.016), style_label="coil"
    )
    probe = magpy.Sensor(
        pixel=grid(0.04, 11, plane="xz"),
        style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
    )
    return versions, coil, probe
