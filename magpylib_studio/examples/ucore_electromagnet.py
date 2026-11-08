from typing import Annotated

import magpylib as magpy
import numpy as np
from magpylib_material_response import solve_face_charge
from magpylib_material_response.face_charge import ChargeSheet
from magpylib_material_response.polyline import (
    create_polyline_fillet,
    move_grid_along_polyline,
)

from magpylib_studio import Bounds, Count, grid, scene

TITLE = "U-core electromagnet, solved"

#: The level the core's panels are solved at, and solved again at.
LEVEL = 2

#: The core's parts, each its label and its dimension, in the order solved.
_A = 0.02
_PARTS = {
    "yoke": (0.10, _A, _A),
    "left leg": (_A, _A, 0.06),
    "right leg": (_A, _A, 0.06),
}
#: Where they start: the yoke, and a leg standing on each end of it.
_POSES = [((0, 0, 0), None), ((-0.04, 0, 0.04), None), ((0.04, 0, 0.04), None)]


def _windings():
    """Four turns of a filleted square round the yoke, where
    material-response's docs wind sixteen, at the same 400 ampere-turns: a
    solve computes the coil's field on every panel again, and 400 segments
    made it 167 ms a step."""
    h = 0.014
    square = np.array(
        [[0, h, 0], [0, h, h], [0, -h, h], [0, -h, -h], [0, h, -h], [0, h, 0]]
    )
    turn = create_polyline_fillet(square, max_radius=0.006, N=2)
    # the winding pack across the turn at its start: along the coil's axis,
    # 1.1 mm outward (material-response 0.12 takes it in the turn's frame)
    pack = np.array([(x, 0.0011) for x in (np.arange(4) - 1.5) * 0.0044])
    return move_grid_along_polyline(turn, pack)


WINDINGS = _windings()


def _solved():
    """The core solved once, before the scene: a solve inside a scene
    function is refused, as its result is made of objects of its own."""
    core = magpy.Collection(
        *(
            magpy.magnet.Cuboid(
                dimension=dimension,
                position=position,
                orientation=orientation,
                style_label=label,
            )
            for (label, dimension), (position, orientation) in zip(
                _PARTS.items(), _POSES, strict=True
            )
        ),
        style_label="U-core",
    )
    core.susceptibility = 999
    coil = magpy.Collection(
        *(magpy.current.Polyline(current=100, vertices=v) for v in WINDINGS)
    )
    # reuse=True keeps the factorization for the first step of a drag
    return solve_face_charge(magpy.Collection(core, coil), level=LEVEL, reuse=True)


SOLVED = _solved()
_SHEETS = [s for s in SOLVED.sources_all if isinstance(s, ChargeSheet)]
_PARTS_SOLVED = [s.part for s in _SHEETS]  # read here: each read makes a magnet


@scene(model_unit="mm", field_unit="mT", solve_level=LEVEL)
def ucore_electromagnet(
    current: Annotated[float, Bounds(-200, 200, unit="current")] = 100,
    density: Annotated[int, Count(4, 40, slider=(5, 25))] = 15,
):
    """A U-core electromagnet, solved while it is dragged: three soft-iron
    cuboids (χ = 999) wound with a coil of 400 ampere-turns.

    The core is solved by face charge, magpylib-material-response's sheets
    of charge on its surfaces, with no volume mesh. Each sheet keeps the
    part it was solved from, so the studio solves the core again at every
    step of a drag, with nothing in the scene asking for it. Drag the coil,
    or slide `current`: the solve keeps its factorization, so a new load
    costs milliseconds. Drag a leg off the yoke and each step factors the
    matrix again. One undo takes back a move and its solve together. It
    needs magpylib-material-response.

    The solved core, the coil at `current` amperes, and a probe in the
    core's plane of symmetry, `density` by `density` points across 140 mm,
    drawn as its field lines.
    """
    coil = magpy.Collection(
        *(magpy.current.Polyline(current=current, vertices=v) for v in WINDINGS),
        style_label="coil",
    )
    probe = magpy.Sensor(
        position=(0, 0, 0.0325),
        pixel=grid(0.07, density, plane="xz"),
        style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
    )
    iron = magpy.Collection(
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
            for s, part in zip(_SHEETS, _PARTS_SOLVED, strict=True)
        ),
        style_label="U-core",
    )
    return iron, coil, probe
