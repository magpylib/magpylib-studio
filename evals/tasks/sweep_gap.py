"""A parameter study on a scene that is given: a sweep, which studio has a
call for and plain magpylib writes as a loop."""

import json
import pathlib

import magpylib as magpy

from evals import kit
from evals.tasks import _scenes

TITLE = "Bz between two magnets, swept over the gap"
KIND = "analysis"
CONDITIONS = ("plain", "studio")
GAPS_MM = [1, 2, 3, 4, 5]


def prompt(condition):
    where = (
        "The script `pair.py` builds"
        if condition == "plain"
        else "The Magpylib Studio scene `pair.magpy.json` holds"
    )
    return (
        f"{where} two cylinder magnets stacked on the z axis with a gap between "
        "them, and a sensor midway between them. Report Bz at the sensor for gaps "
        "of 1, 2, 3, 4 and 5 mm, with everything else as it is.\n\n"
        "Write the answer to `answer.json` as "
        '`{"gap_mm": [1, 2, 3, 4, 5], "Bz_mT": [...]}`, Bz in millitesla.'
    )


def inputs(condition):
    return _scenes.as_files(_scenes.pair(), "pair", condition)


def _truth(gap_mm):
    gap = gap_mm / 1000
    magnets = [
        magpy.magnet.Cylinder(
            dimension=(0.01, 0.005),
            polarization=(0, 0, 1.3),
            position=(0, 0, sign * (gap / 2 + 0.0025)),
        )
        for sign in (-1, 1)
    ]
    return float(_scenes.field(magnets, (0, 0, 0))[0, 2]) * 1e3


def check(work, condition):
    got = kit.answer(work, "gap_mm", "Bz_mT")
    gaps, values = got["gap_mm"], got["Bz_mT"]
    if len(gaps) != len(GAPS_MM) or not all(
        kit.close(g, t, abs_=1e-6) for g, t in zip(gaps, GAPS_MM, strict=False)
    ):
        return kit.Verdict(False, [f"gaps {gaps}, asked for {GAPS_MM}"])
    if len(values) != len(GAPS_MM):
        return kit.Verdict(False, [f"{len(values)} values for {len(GAPS_MM)} gaps"])
    notes, ok = [], True
    for gap, value in zip(GAPS_MM, values, strict=True):
        truth = _truth(gap)
        good = kit.close(value, truth, rel=0.01)
        ok &= good
        notes.append(
            f"{gap} mm: {value} mT; {truth:.4g} mT ± 1 %" + ("" if good else " ✗")
        )
    return kit.Verdict(ok, notes)


def reference(work, condition):
    values = [_truth(gap) for gap in GAPS_MM]
    path = pathlib.Path(work) / "answer.json"
    path.write_text(json.dumps({"gap_mm": GAPS_MM, "Bz_mT": values}), encoding="utf-8")
