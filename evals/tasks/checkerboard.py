"""Structure the patterns do not hand you: alternating magnets, which a pattern
of one magnet cannot make by itself."""

import pathlib

import magpylib as magpy
import numpy as np

from evals import kit
from magpylib_studio import name, scene

TITLE = "A 4 × 4 checkerboard of alternating cubes"
KIND = "design"
CONDITIONS = ("plain", "studio")
EDGE, PITCH, POLARIZATION = 0.005, 0.006, 1.2
STEPS = (np.arange(4) - 1.5) * PITCH  # -9, -3, 3, 9 mm


def prompt(condition):
    deliverable = kit.PLAIN_DESIGN if condition == "plain" else kit.STUDIO_DESIGN
    return (
        "Build a 4 × 4 checkerboard of cube magnets with 5 mm edges, on a 6 mm "
        "pitch in the xy plane, centred on the origin. Neighbouring magnets are "
        "polarized opposite ways along z, ±1.2 T, and the magnet with the most "
        "negative x and y is polarized +z.\n\n" + deliverable
    )


def inputs(condition):
    return {}


def _sign(x, y):
    """+1 where the magnet should point up: the corner at -x, -y, and every
    second one from it."""
    i, j = (round(v / PITCH + 1.5) for v in (x, y))
    return 1 if (i + j) % 2 == 0 else -1


def check(work, condition):
    built = kit.design(work, condition)
    cuboids = kit.of_type(built, "Cuboid")
    others = sorted({s["type"] for s in built["sources"]} - {"Cuboid"})
    if others or len(cuboids) != 16:
        return kit.Verdict(False, [f"{len(cuboids)} cubes", f"other sources: {others}"])
    wanted = {(round(x, 6), round(y, 6)) for x in STEPS for y in STEPS}
    placed, wrong = set(), []
    for cube in cuboids:
        x, y, z = cube["position"]
        where = (round(x, 6), round(y, 6))
        placed.add(where)
        polarization = np.asarray(cube["polarization"])
        upright = np.allclose(polarization[:2], 0, atol=1e-6)
        if (
            where not in wanted
            or abs(z) > 1e-9
            or not np.allclose(cube["dimension"], EDGE, atol=1e-9)
            or not upright
            or not kit.close(polarization[2], _sign(x, y) * POLARIZATION, rel=1e-6)
        ):
            wrong.append(f"({x * 1e3:.1f}, {y * 1e3:.1f}, {z * 1e3:.1f}) mm")
    if placed != wanted:
        wrong.append(f"{len(wanted - placed)} of the 16 places empty")
    return kit.Verdict(not wrong, wrong[:6] or ["16 cubes, alternating, in place"])


def reference(work, condition):
    path = pathlib.Path(work)
    if condition == "plain":
        (path / "design.py").write_text(
            "import magpylib as magpy\n\n"
            "design = magpy.Collection()\n"
            "for i in range(4):\n"
            "    for j in range(4):\n"
            "        sign = 1 if (i + j) % 2 == 0 else -1\n"
            "        design.add(magpy.magnet.Cuboid(\n"
            "            dimension=(0.005, 0.005, 0.005),\n"
            "            polarization=(0, 0, sign * 1.2),\n"
            "            position=((i - 1.5) * 0.006, (j - 1.5) * 0.006, 0),\n"
            "        ))\n",
            encoding="utf-8",
        )
        return

    @scene
    def design():
        board = name(magpy.Collection(), "board")
        for x in STEPS:
            for y in STEPS:  # fixed places: a loop over literals is plain Python
                board.add(
                    magpy.magnet.Cuboid(
                        dimension=(EDGE, EDGE, EDGE),
                        polarization=(0, 0, _sign(x, y) * POLARIZATION),
                        position=(float(x), float(y), 0),
                    )
                )
        return board

    design.save(path / "design.magpy.json")
