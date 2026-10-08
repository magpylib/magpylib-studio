"""A number found by searching rather than read off: where the field falls to
a given value."""

import json
import pathlib

import magpylib as magpy
import numpy as np

from evals import kit

TITLE = "Where on a magnet's axis |B| is 50 mT"
KIND = "analysis"
CONDITIONS = ("plain", "studio")
TARGET_MT = 50.0


def prompt(condition):
    return (
        "A cylinder magnet of diameter 10 mm and height 5 mm, its axis along z, "
        "is centred at the origin and polarized along +z with 1.3 T. At what "
        "height z above the magnet, on its axis, is |B| exactly 50 mT?\n\n"
        'Write the answer to `answer.json` as `{"z_mm": <number>}`: the height '
        "in millimetres, measured from the origin."
    )


def inputs(condition):
    return {}


def _field_mT(z_mm):
    magnet = magpy.magnet.Cylinder(dimension=(0.01, 0.005), polarization=(0, 0, 1.3))
    return float(np.linalg.norm(magnet.getB((0, 0, z_mm / 1000)))) * 1e3


def check(work, condition):
    z = kit.answer(work, "z_mm")["z_mm"]
    if not isinstance(z, int | float) or z <= 2.5:
        return kit.Verdict(False, [f"z = {z} mm is not above the magnet's top face"])
    there = _field_mT(z)
    return kit.Verdict(
        kit.close(there, TARGET_MT, rel=0.01),
        [f"|B| at z = {z} mm is {there:.4g} mT; {TARGET_MT} mT ± 1 %"],
    )


def reference(work, condition):
    low, high = 2.6, 50.0  # |B| falls from far above 50 mT to far below it
    for _ in range(60):
        middle = (low + high) / 2
        low, high = (middle, high) if _field_mT(middle) > TARGET_MT else (low, middle)
    path = pathlib.Path(work) / "answer.json"
    path.write_text(json.dumps({"z_mm": (low + high) / 2}), encoding="utf-8")
