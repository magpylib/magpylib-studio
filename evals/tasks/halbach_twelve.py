"""An edit to a scene that is given, where what must not change matters as
much as what must: the rings' radius, the magnets, and the upper ring's turn
of half a step, which follows the count only if it was written that way.

Twelve is the most that fit: on the example's 23 mm ring, a thirteenth 10 mm
cube overlaps its neighbours. (Asked for sixteen, the first run's studio agent
saw the overlap and widened the ring, and failed a check that wanted the old
radius; the plain agent kept it and passed with magnets inside each other.)"""

import json
import pathlib

import numpy as np

from evals import kit
from evals.tasks import _scenes

TITLE = "Two Halbach rings, ten magnets each made twelve"
KIND = "edit"
CONDITIONS = ("plain", "studio")

# Along the stack's axis, where its sensor reads, and off it at mid height.
POINTS = [(0, 0, z) for z in np.linspace(-0.015, 0.03, 10)] + [
    (0.005, 0, 0.0075),
    (0, 0.005, 0.0075),
    (-0.004, 0.004, 0.0),
]


def prompt(condition):
    if condition == "plain":
        return (
            "The script `halbach.py` builds a stack of two Halbach rings, ten "
            "magnets each. Make it twelve magnets per ring, with everything else "
            "as it was meant to be: the ring radius, the magnets, and the upper "
            "ring turned half a magnet's step from the lower one.\n\n"
            "Edit `halbach.py` in place. It must still leave the whole assembly in "
            "the variable `halbach`."
        )
    return (
        "The Magpylib Studio scene `halbach.magpy.json` is a stack of two Halbach "
        "rings, ten magnets each. Make it twelve magnets per ring, with "
        "everything else as it was meant to be: the ring radius, the magnets, and "
        "the upper ring turned half a magnet's step from the lower one.\n\n"
        "Save the result over `halbach.magpy.json`."
    )


def inputs(condition):
    return _scenes.as_files(_scenes.halbach(), "halbach", condition)


def _truth():
    session = _scenes.halbach()
    session.set_variable("n", 12)  # the half step follows: it is 360 / (2 n)
    return _scenes.field(session._leaf_sources(), POINTS)


def check(work, condition):
    built = kit.design(work, condition, name="halbach", points=POINTS, overlaps=True)
    cuboids = kit.of_type(built, "Cuboid")
    notes = [f"{len(cuboids)} magnets"]
    if len(cuboids) != 24:
        return kit.Verdict(False, [*notes, "24 wanted"])
    if built["overlaps"]:
        return kit.Verdict(False, [*notes, f"overlapping: {built['overlaps'][:5]}"])
    truth = _truth()
    error = np.max(np.abs(np.asarray(built["B"]) - truth)) / np.max(np.abs(truth))
    notes.append(f"field off by {error:.2%} of its largest component")
    extras = {}
    if condition == "studio":
        document = built["document"]
        counts = [
            e.get("count")
            for e in document.get("events", [])
            if e.get("op") == "duplicate_around"
        ]
        extras["kept_parametric"] = document.get("variables", {}).get(
            "n"
        ) == 12 and counts == ["=n", "=n"]
    return kit.Verdict(error <= 0.005, notes, extras)


def reference(work, condition):
    path = pathlib.Path(work)
    if condition == "plain":
        script = path / "halbach.py"
        text = script.read_text(encoding="utf-8")
        script.write_text(text.replace("n = 10 ", "n = 12 ", 1), encoding="utf-8")
        return
    session = _scenes.halbach()
    session.set_variable("n", 12)
    (path / "halbach.magpy.json").write_text(
        json.dumps(session.to_dict(), indent=2), encoding="utf-8"
    )
