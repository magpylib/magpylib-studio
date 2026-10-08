"""A design to two targets that pull against each other. A single ring of these
cubes cannot give 0.1 T and 3 % at once -- the strong ones are small, and a
short ring's field bulges -- so it takes the idea of stacking rings."""

import pathlib

import magpylib as magpy
import numpy as np

from evals import kit
from magpylib_studio import duplicate_around, name, scene

TITLE = "A Halbach assembly: 0.1 T, uniform to 3 %, from 10 mm cubes"
KIND = "design"
CONDITIONS = ("plain", "studio")
EDGE, POLARIZATION, MOST = 0.01, 1.2, 32

# The disc it is judged on: the centre, and five circles out to 5 mm.
DISC = [(0.0, 0.0, 0.0)] + [
    (r * np.cos(t), r * np.sin(t), 0.0)
    for r in np.linspace(0.001, 0.005, 5)
    for t in np.linspace(0, 2 * np.pi, 12, endpoint=False)
]


def prompt(condition):
    deliverable = kit.PLAIN_DESIGN if condition == "plain" else kit.STUDIO_DESIGN
    return (
        "Design a Halbach dipole magnet assembly from cube magnets of 10 mm edge "
        "and 1.2 T polarization. Centre it on the origin, with its axis along z. "
        "Requirements:\n\n"
        "- |B| at the origin is at least 0.1 T;\n"
        "- over the disc of radius 5 mm centred on the origin in the plane z = 0, "
        "|B| varies by no more than 3 % (max − min, relative to the mean);\n"
        "- at most 32 magnets;\n"
        "- no two magnets overlap.\n\n" + deliverable
    )


def inputs(condition):
    return {}


def check(work, condition):
    built = kit.design(work, condition, points=DISC, overlaps=True)
    cuboids = kit.of_type(built, "Cuboid")
    others = sorted({s["type"] for s in built["sources"]} - {"Cuboid"})
    notes = [f"{len(cuboids)} cubes"]
    if others or not 0 < len(cuboids) <= MOST:
        return kit.Verdict(False, [*notes, f"other sources: {others}"])
    if not all(np.allclose(c["dimension"], EDGE, atol=1e-9) for c in cuboids):
        return kit.Verdict(False, [*notes, "not every magnet is a 10 mm cube"])
    if not all(
        kit.close(np.linalg.norm(c["polarization"]), POLARIZATION, rel=1e-6)
        for c in cuboids
    ):
        return kit.Verdict(False, [*notes, "not every magnet is polarized 1.2 T"])
    if built["overlaps"]:
        return kit.Verdict(False, [*notes, f"overlapping: {built['overlaps'][:5]}"])
    magnitude = kit.magnitudes(built)
    centre = magnitude[0]
    spread = (magnitude.max() - magnitude.min()) / magnitude.mean()
    notes += [f"|B| at the origin {centre * 1e3:.1f} mT", f"spread {spread:.2%}"]
    return kit.Verdict(centre >= 0.1 and spread <= 0.03, notes)


def reference(work, condition):
    """Three rings of eight, 22 mm out, 12 mm apart: about 220 mT, 2.2 %."""
    path = pathlib.Path(work)
    if condition == "plain":
        (path / "design.py").write_text(
            "import magpylib as magpy\n\n"
            "design = magpy.Collection()\n"
            "for z in (-0.012, 0.0, 0.012):\n"
            "    for i in range(8):\n"
            "        angle = 360 * i / 8\n"
            "        cube = magpy.magnet.Cuboid(\n"
            "            dimension=(0.01, 0.01, 0.01),\n"
            "            polarization=(1.2, 0, 0),\n"
            "            position=(0.022, 0, z),\n"
            "        )\n"
            "        cube.rotate_from_angax(angle, 'z', anchor=None)\n"
            "        cube.rotate_from_angax(angle, 'z', anchor=0)\n"
            "        design.add(cube)\n",
            encoding="utf-8",
        )
        return

    @scene
    def design():
        stack = name(magpy.Collection(), "stack")
        for number, z in enumerate((-0.012, 0.0, 0.012)):
            ring = name(magpy.Collection(), f"ring{number}")
            stack.add(ring)
            cube = name(
                magpy.magnet.Cuboid(
                    dimension=(EDGE, EDGE, EDGE),
                    polarization=(POLARIZATION, 0, 0),
                    position=(0.022, 0, z),
                ),
                f"cube{number}",
            )
            ring.add(cube)
            duplicate_around(cube, count=8, axis="z", spin=45)
        return stack

    design.save(path / "design.magpy.json")
