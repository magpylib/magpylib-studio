from typing import Annotated

import magpylib as magpy
import numpy as np
from magpylib_material_response import solve_face_charge
from magpylib_material_response.face_charge import ChargeSheet

from magpylib_studio import Bounds, Length, grid, scene

TITLE = "A run over a solved plate"


def _solved():
    """The plate solved once, before the scene, under the magnet's first
    pose: a solve inside a scene function is refused, as its result is made
    of objects of its own."""
    start = magpy.magnet.Cuboid(
        polarization=(0, 0, 1.2), dimension=(0.01, 0.01, 0.005), position=(0, 0, 0.0085)
    )
    iron = magpy.magnet.Cuboid(polarization=(0, 0, 0), dimension=(0.06, 0.03, 0.004))
    iron.susceptibility = 1000
    return solve_face_charge(magpy.Collection(start, iron), level=1)


SOLVED = _solved()
_SHEETS = [s for s in SOLVED.sources_all if isinstance(s, ChargeSheet)]
_PARTS = [s.part for s in _SHEETS]  # read here: each read makes a magnet


@scene(
    model_unit="mm",
    field_unit="mT",
    solve_level=1,
    variants={
        "low": {"height": 0.006, "strength": 1.2},
        "high": {"height": 0.016, "strength": 1.2},
        "reversed": {"height": 0.006, "strength": -1.2},
    },
)
def solved_plate_run(
    height: Annotated[float, Length(0.005, 0.03)] = 0.006,
    strength: Annotated[float, Bounds(-1.5, 1.5, unit="field")] = 1.2,
):
    """A magnet sliding across a solved soft-iron plate in thirteen steps,
    with variants, and the plate solved again at every step of the run.

    The scene's path is the run, played by the transport at the foot of the
    view. The plate is solved by face charge, sheets of charge on its
    surfaces, and keeps the part it was solved from, so the studio solves
    it again when the magnet's height or strength changes, and at each step
    of the run: every step of every variant has its own solve and its own
    field lines. The low, high and reversed variants are a click each,
    beside the transport. It needs magpylib-material-response.

    A magnet `height` above a solved plate, polarized `strength` tesla up,
    sliding across it in thirteen steps, and a probe in the plane of the
    slide, drawn as its field lines.
    """
    magnet = magpy.magnet.Cuboid(
        polarization=(0, 0, strength),
        dimension=(0.01, 0.01, 0.005),
        position=(-0.024, 0, height),
        style_label="magnet",
    )
    magnet.move(np.linspace((0, 0, 0), (0.048, 0, 0), 13), start=0)
    plate = magpy.Collection(
        *(
            ChargeSheet(
                vertices=s.vertices,
                faces=s.faces,
                charge_densities=s.charge_densities,
                panels=s.panels,
                mean_polarization=s.mean_polarization,
                part=part,
                position=s.position,
                style={
                    "label": s.style.label,
                    "charge": {"level": s.style.charge.level},
                },
            )
            for s, part in zip(_SHEETS, _PARTS, strict=True)
        ),
        style_label="plate",
    )
    probe = magpy.Sensor(
        position=(0, 0, 0.004),
        pixel=grid(0.04, 13, plane="xz"),
        style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
    )
    return plate, magnet, probe
