"""A builder script the builder refuses: the agent has to read the refusal
and write what it names, rather than force a number out of a variable."""

import pathlib

import numpy as np

from evals import kit
from evals.tasks import _scenes
from magpylib_studio.build import Scene

TITLE = "Repair a builder script that loops over a variable"
KIND = "studio"
CONDITIONS = ("studio",)
EDGE, POLARIZATION = 0.008, 1.2
POINTS = [(0, 0, 0), (0.005, 0, 0), (0, 0.005, 0), (0.003, -0.003, 0.002)]

BROKEN = '''\
"""A Halbach dipole ring of n magnets, n and radius left as sliders.

The magnet at angle a round the ring is turned 2a about z, so the field
inside the ring points one way.
"""

from magpylib_studio.build import Scene

s = Scene()
n = s.variable("n", 12, bounds=(4, 36), integer=True)
radius = s.variable("radius", 0.03, bounds=(0.01, 0.1), unit="length")

ring = s.Collection(id="ring", style_label="Halbach ring")
for i in range(n):
    angle = 360 * i / n
    magnet = s.magnet.Cuboid(
        id=f"magnet{i}",
        dimension=(0.008, 0.008, 0.008),
        polarization=(1.2, 0, 0),
        position=(radius, 0, 0),
    )
    ring.add(magnet)
    magnet.rotate_from_angax(angle, "z", anchor=None)
    magnet.rotate_from_angax(angle, "z", anchor=0)

s.save("ring.magpy.json")
'''


def prompt(condition):
    return (
        "`ring.py` is meant to build a Halbach dipole ring of `n` magnets with "
        "Magpylib Studio's builder, with `n` and `radius` kept as variables -- "
        "sliders in the studio -- but it fails when it is run. Fix it so that it "
        "builds that ring, with `n` and `radius` still variables, and saves the "
        "scene to `ring.magpy.json`."
    )


def inputs(condition):
    return {"ring.py": BROKEN}


def _truth(n, radius):
    return _scenes.field(_scenes.halbach_ring(n, radius, EDGE, POLARIZATION), POINTS)


def _matches(built, n, radius):
    truth = _truth(n, radius)
    error = np.max(np.abs(np.asarray(built["B"]) - truth)) / np.max(np.abs(truth))
    count = len(kit.of_type(built, "Cuboid"))
    return (
        count == n and error <= 0.005,
        f"n = {n}, radius = {radius * 1e3:g} mm: {count} magnets, field off by {error:.2%}",
    )


def check(work, condition):
    built = kit.design(work, condition, scene="ring", points=POINTS)
    variables = built["document"].get("variables", {})
    if not (
        kit.close(variables.get("n"), 12, abs_=1e-12)
        and kit.close(variables.get("radius"), 0.03, abs_=1e-12)
    ):
        return kit.Verdict(False, [f"variables {variables}"])
    notes, ok = [], True
    for n, radius in ((12, 0.03), (16, 0.03), (12, 0.04)):
        changed = {"n": n, "radius": radius}
        again = kit.design(work, condition, scene="ring", points=POINTS, sets=changed)
        good, note = _matches(again, n, radius)
        ok &= good
        notes.append(note + ("" if good else " ✗"))
    return kit.Verdict(ok, notes)


def reference(work, condition):
    s = Scene()
    n = s.variable("n", 12, bounds=(4, 36), integer=True)
    radius = s.variable("radius", 0.03, bounds=(0.01, 0.1), unit="length")
    ring = s.Collection(id="ring", style_label="Halbach ring")
    magnet = s.magnet.Cuboid(
        id="magnet",
        dimension=(EDGE, EDGE, EDGE),
        polarization=(POLARIZATION, 0, 0),
        position=(radius, 0, 0),
    )
    ring.add(magnet)
    magnet.duplicate_around(count=n, axis="z", spin=360 / n)
    s.save(pathlib.Path(work) / "ring.magpy.json")
