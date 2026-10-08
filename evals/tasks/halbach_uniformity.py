"""Reading a given scene well enough to measure it: where the rings are, so
where the plane between them is, then a field over a grid."""

import json
import pathlib

import numpy as np

from evals import kit
from evals.tasks import _scenes

TITLE = "Centre field and spread between the rings of a Halbach stack"
KIND = "analysis"
CONDITIONS = ("plain", "studio")


def prompt(condition):
    where = (
        "The script `halbach.py` builds"
        if condition == "plain"
        else "The Magpylib Studio scene `halbach.magpy.json` is"
    )
    return (
        f"{where} a stack of two Halbach rings. In the plane midway between the "
        "two rings, what is |B| on the stack's axis, and by how much does |B| "
        "vary over a 5 × 5 grid of points spanning −5 mm to +5 mm in both x and y "
        "in that plane? Give the variation as (max − min) / mean, in percent.\n\n"
        "Write the answer to `answer.json` as "
        '`{"B_center_mT": <number>, "spread_percent": <number>}`.'
    )


def inputs(condition):
    return _scenes.as_files(_scenes.halbach(), "halbach", condition)


def _truth():
    session = _scenes.halbach()
    variables = session.get_variables()["variables"]
    # the lower ring sits at z = 0 and the upper one at z = gap
    gap = next(v["value"] for v in variables if v["name"] == "gap")
    sources = session._leaf_sources()
    centre = np.linalg.norm(_scenes.field(sources, (0, 0, gap / 2))[0]) * 1e3
    xy = np.linspace(-0.005, 0.005, 5)
    grid = [(x, y, gap / 2) for x in xy for y in xy]
    magnitude = np.linalg.norm(_scenes.field(sources, grid), axis=1)
    spread = (magnitude.max() - magnitude.min()) / magnitude.mean() * 100
    return float(centre), float(spread)


def check(work, condition):
    got = kit.answer(work, "B_center_mT", "spread_percent")
    centre, spread = _truth()
    centre_ok = kit.close(got["B_center_mT"], centre, rel=0.01)
    spread_ok = kit.close(got["spread_percent"], spread, rel=0.05, abs_=0.1)
    return kit.Verdict(
        centre_ok and spread_ok,
        [
            f"centre {got['B_center_mT']} mT; {centre:.4g} mT ± 1 %",
            f"spread {got['spread_percent']} %; {spread:.3g} % ± 5 % of it",
        ],
    )


def reference(work, condition):
    centre, spread = _truth()
    path = pathlib.Path(work) / "answer.json"
    path.write_text(
        json.dumps({"B_center_mT": centre, "spread_percent": spread}), encoding="utf-8"
    )
