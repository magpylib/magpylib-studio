"""A design to one target within limits: a coil, where the turns, the current
and the radius trade against each other."""

import pathlib

import magpylib as magpy
import numpy as np

from evals import kit
from evals.tasks import _scenes
from magpylib_studio import Bounds, duplicate_along, name, scene

TITLE = "A coil giving 1 mT on its axis, 50 mm out"
KIND = "design"
CONDITIONS = ("plain", "studio")
POINT, TARGET = (0.0, 0.0, 0.05), 1e-3


def prompt(condition):
    deliverable = kit.PLAIN_DESIGN if condition == "plain" else kit.STUDIO_DESIGN
    return (
        "Using circular current loops coaxial with the z axis, make the field at "
        "the point (0, 0, 50 mm) Bz = 1.00 mT, to within 1 %. Constraints: at "
        "most 100 loops; at most 5 A in any loop; loop diameters at most 100 mm; "
        "every loop's centre on the z axis, within 20 mm of the origin.\n\n"
        + deliverable
    )


def inputs(condition):
    return {}


def check(work, condition):
    built = kit.design(work, condition, points=[POINT])
    loops = kit.of_type(built, "Circle")
    others = sorted({s["type"] for s in built["sources"]} - {"Circle"})
    notes = [f"{len(loops)} loops"]
    if others or not 0 < len(loops) <= 100:
        return kit.Verdict(False, [*notes, f"other sources: {others}"])
    worst = max(float(np.max(np.abs(loop["current"]))) for loop in loops)
    widest = max(float(np.max(loop["diameter"])) for loop in loops)
    off_axis = [
        loop
        for loop in loops
        if np.hypot(*loop["position"][:2]) > 1e-9
        or abs(loop["position"][2]) > 0.02 + 1e-9
        or abs(abs(loop["axis"][2]) - 1) > 1e-9
    ]
    notes += [f"largest current {worst:g} A", f"widest loop {widest * 1e3:g} mm"]
    if worst > 5 + 1e-9 or widest > 0.1 + 1e-12 or off_axis:
        return kit.Verdict(
            False, [*notes, f"{len(off_axis)} loops off the axis or too far out"]
        )
    bz = built["B"][0][2]
    notes.append(f"Bz = {bz * 1e3:.4g} mT")
    return kit.Verdict(kit.close(bz, TARGET, rel=0.01), notes)


def reference(work, condition):
    """A hundred 100 mm loops spread over 20 mm, the current set to hit 1 mT."""
    zs = np.linspace(-0.01, 0.01, 100)
    per_amp = sum(
        _scenes.field(
            [magpy.current.Circle(diameter=0.1, current=1, position=(0, 0, z))], POINT
        )[0, 2]
        for z in zs
    )
    current = TARGET / per_amp
    path = pathlib.Path(work)
    if condition == "plain":
        (path / "design.py").write_text(
            "import magpylib as magpy\n"
            "import numpy as np\n\n"
            "design = magpy.Collection()\n"
            "for z in np.linspace(-0.01, 0.01, 100):\n"
            f"    design.add(magpy.current.Circle(diameter=0.1, current={current!r}, "
            "position=(0, 0, z)))\n",
            encoding="utf-8",
        )
        return
    from typing import Annotated

    @scene
    def design(amps: Annotated[float, Bounds(0, 5, unit="current")] = current):
        coil = name(magpy.Collection(), "coil")
        loop = name(
            magpy.current.Circle(diameter=0.1, current=amps, position=(0, 0, -0.01)),
            "loop",
        )
        coil.add(loop)
        duplicate_along(loop, count=100, step=(0, 0, 0.02 / 99))
        return coil

    design.save(path / "design.magpy.json")
