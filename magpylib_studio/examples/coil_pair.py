from typing import Annotated

import magpylib as magpy

from magpylib_studio import Bounds, Count, Length, duplicate_along, grid, scene

TITLE = "Helmholtz coil pair"

_amperes = Bounds(-100, 100, slider=(-50, 50), unit="current")


@scene(
    model_unit="mm",
    field_unit="mT",
    variants={
        "Helmholtz": {"lower": 20.0, "upper": 20.0, "spacing": 0.04},
        "anti-Helmholtz": {"lower": 20.0, "upper": -20.0, "spacing": 0.04},
    },
)
def coil_pair(
    radius: Annotated[float, Length(0.01, 0.1, slider=(0.02, 0.06))] = 0.04,
    spacing: Annotated[float, Length(0.005, 0.15, slider=(0.01, 0.1))] = 0.04,
    lower: Annotated[float, _amperes] = 20.0,
    upper: Annotated[float, _amperes] = 20.0,
    turns: Annotated[int, Count(1, 20, slider=(1, 12))] = 6,
):
    """A pair of coils on one axis, each current a variable of its own.

    Run the same current through both, at a spacing equal to their radius,
    and the field between them is the flattest a pair of loops can make:
    the Helmholtz condition. Reverse one, and the field is zero at the
    centre and grows evenly away from it: the anti-Helmholtz pair of a
    magnetic trap. Both are variants. The probe across the gap, in the
    plane of the axis, is drawn as its field lines.

    Two coils of `turns` loops, `spacing` apart centre to centre, and a
    probe across the gap between them, in the plane of the axis.
    """
    pitch = 0.002
    pair = magpy.Collection(style_label="coil pair")
    for name, current, centre in (
        ("lower", lower, -spacing / 2),
        ("upper", upper, spacing / 2),
    ):
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
