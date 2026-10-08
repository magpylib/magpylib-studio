"""Scenes the tasks start from, in the form each condition gets them: a studio
scene for "studio", the same scene as plain magpylib for "plain"."""

import json
from typing import Annotated

import magpylib as magpy
import numpy as np

from magpylib_studio import Length, name, scene
from magpylib_studio.session import MagpylibStudioSession


def halbach():
    """The studio's own Halbach example: two rings of ten 10 mm cubes."""
    session = MagpylibStudioSession()
    session.load_example("halbach")
    return session


def pair(distance=0.002):
    """Two cylinder magnets stacked on z, `gap` apart, a probe midway."""

    @scene
    def design(gap: Annotated[float, Length(0.0005, 0.02)] = distance):
        for label, sign in (("lower", -1), ("upper", 1)):
            name(
                magpy.magnet.Cylinder(
                    dimension=(0.01, 0.005),
                    polarization=(0, 0, 1.3),
                    position=(0, 0, sign * (gap / 2 + 0.0025)),
                    style_label=f"{label.capitalize()} magnet",
                ),
                label,
            )
        name(magpy.Sensor(position=(0, 0, 0), style_label="Probe"), "probe")

    return design.build().session


def as_files(session, stem, condition):
    """The scene as the file a condition starts from."""
    if condition == "studio":
        return {f"{stem}.magpy.json": json.dumps(session.to_dict(), indent=2) + "\n"}
    # As anyone would keep it: runnable, and drawing nothing when run.
    lines = session.to_script().splitlines()
    kept = [line for line in lines if not line.startswith("magpy.show(")]
    return {f"{stem}.py": "\n".join(kept).rstrip() + "\n"}


def field(sources, points):
    """B, in tesla, of `sources` at `points`."""
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    return np.asarray(magpy.getB(sources, points, sumup=True)).reshape(-1, 3)


def halbach_ring(n, radius, edge, polarization=1.2, z=0.0):
    """A Halbach dipole ring the plain way: magnet i at angle a = 360 i / n,
    turned 2a about z, so the field inside points one way."""
    magnets = []
    for i in range(n):
        angle = 360 * i / n
        magnet = magpy.magnet.Cuboid(
            dimension=(edge, edge, edge),
            polarization=(polarization, 0, 0),
            position=(radius, 0, z),
        )
        magnet.rotate_from_angax(angle, "z", anchor=None)
        magnet.rotate_from_angax(angle, "z", anchor=0)
        magnets.append(magnet)
    return magnets
