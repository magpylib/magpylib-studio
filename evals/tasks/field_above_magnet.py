"""One number off one magnet: the baseline, where studio has nothing to add,
so whatever it costs here is what having it costs."""

import json
import pathlib

import magpylib as magpy
import numpy as np

from evals import kit

TITLE = "The field 3 mm above a block magnet"
KIND = "analysis"
CONDITIONS = ("plain", "studio")


def prompt(condition):
    return (
        "A block magnet measuring 10 × 10 × 5 mm, its 5 mm side along z, is "
        "centred at the origin and polarized along +z with a polarization of "
        "1.2 T. What is the magnitude of the magnetic flux density B at the point "
        "3 mm above the centre of its top face?\n\n"
        'Write the answer to `answer.json` as `{"B_mT": <number>}`, in '
        "millitesla."
    )


def inputs(condition):
    return {}


def _truth():
    magnet = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.005), polarization=(0, 0, 1.2)
    )
    return float(np.linalg.norm(magnet.getB((0, 0, 0.0055)))) * 1e3


def check(work, condition):
    got = kit.answer(work, "B_mT")["B_mT"]
    truth = _truth()
    return kit.Verdict(
        kit.close(got, truth, rel=0.005), [f"B = {got} mT; {truth:.4g} mT ± 0.5 %"]
    )


def reference(work, condition):
    path = pathlib.Path(work) / "answer.json"
    path.write_text(json.dumps({"B_mT": _truth()}), encoding="utf-8")
