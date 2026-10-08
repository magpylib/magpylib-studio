"""Plain magpylib made parametric: what studio is for, asked of an agent that
has a plain script in front of it."""

import pathlib

import magpylib as magpy
import numpy as np

from evals import kit
from evals.tasks import _scenes
from magpylib_studio.build import Scene

TITLE = "A plain magpylib ring turned into a scene with sliders"
KIND = "studio"
CONDITIONS = ("studio",)
POINTS = [(0, 0, 0), (0, 0, 0.005), (0.01, 0, 0.002), (0, -0.012, -0.003)]

PLAIN = """\
import magpylib as magpy

ring = magpy.Collection()
for i in range(8):
    magnet = magpy.magnet.Cuboid(
        dimension=(0.006, 0.006, 0.006),
        polarization=(0, 0, 1.0),
        position=(0.02, 0, 0),
    )
    magnet.rotate_from_angax(360 * i / 8, "z", anchor=0)
    ring.add(magnet)
"""


def prompt(condition):
    return (
        "`ring.py` builds a ring of 8 magnets with plain magpylib. Turn it into a "
        "Magpylib Studio scene in which the number of magnets and the ring's "
        "radius are sliders -- call them `n` and `radius`; n from 4 to 24, radius "
        "from 15 to 40 mm -- and the ring follows them. Save it to "
        "`ring.magpy.json`."
    )


def inputs(condition):
    return {"ring.py": PLAIN}


def _truth(n, radius):
    magnets = []
    for i in range(n):
        magnet = magpy.magnet.Cuboid(
            dimension=(0.006, 0.006, 0.006),
            polarization=(0, 0, 1.0),
            position=(radius, 0, 0),
        )
        magnet.rotate_from_angax(360 * i / n, "z", anchor=0)
        magnets.append(magnet)
    return _scenes.field(magnets, POINTS)


def _ranged(limits, low, high):
    """Whether the limits run from `low` to `high`, as bounds or as a slider."""
    return any(
        kit.close(limits.get(a), low, abs_=1e-9)
        and kit.close(limits.get(b), high, abs_=1e-9)
        for a, b in (("min", "max"), ("soft_min", "soft_max"))
    )


def check(work, condition):
    built = kit.design(work, condition, scene="ring", points=POINTS)
    document = built["document"]
    variables = document.get("variables", {})
    limits = document.get("variable_bounds", {})
    notes = [f"variables {variables}"]
    if variables.get("n") != 8 or not kit.close(
        variables.get("radius"), 0.02, abs_=1e-12
    ):
        return kit.Verdict(False, notes)
    ranged = _ranged(limits.get("n", {}), 4, 24) and _ranged(
        limits.get("radius", {}), 0.015, 0.04
    )
    if not ranged:
        return kit.Verdict(False, [*notes, f"ranges {limits}"])
    ok = True
    for n, radius in ((8, 0.02), (12, 0.02), (8, 0.03)):
        again = kit.design(
            work,
            condition,
            scene="ring",
            points=POINTS,
            sets={"n": n, "radius": radius},
        )
        truth = _truth(n, radius)
        error = np.max(np.abs(np.asarray(again["B"]) - truth)) / np.max(np.abs(truth))
        count = len(kit.of_type(again, "Cuboid"))
        good = count == n and error <= 0.005
        ok &= good
        notes.append(
            f"n = {n}, radius = {radius * 1e3:g} mm: {count} magnets, field off by "
            f"{error:.2%}" + ("" if good else " ✗")
        )
    return kit.Verdict(ok, notes)


def reference(work, condition):
    s = Scene()
    n = s.variable("n", 8, bounds=(4, 24), integer=True)
    radius = s.variable("radius", 0.02, bounds=(0.015, 0.04), unit="length")
    ring = s.Collection(id="ring")
    magnet = s.magnet.Cuboid(
        id="magnet",
        dimension=(0.006, 0.006, 0.006),
        polarization=(0, 0, 1.0),
        position=(radius, 0, 0),
    )
    ring.add(magnet)
    magnet.duplicate_around(count=n, axis="z")
    s.save(pathlib.Path(work) / "ring.magpy.json")
