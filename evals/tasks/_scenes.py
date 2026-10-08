"""Scenes the tasks start from, in the form each condition gets them: a studio
scene for "studio", the same scene as plain magpylib for "plain"."""

import json

import magpylib as magpy
import numpy as np

from magpylib_studio.build import Scene
from magpylib_studio.session import MagpylibStudioSession


def halbach():
    """The studio's own Halbach example: two rings of ten 10 mm cubes."""
    session = MagpylibStudioSession()
    session.load_example("halbach")
    return session


def pair(gap=0.002):
    """Two cylinder magnets stacked on z, `gap` apart, a probe midway."""
    s = Scene()
    g = s.variable("gap", gap, bounds=(0.0005, 0.02), unit="length")
    for name, sign in (("lower", -1), ("upper", 1)):
        s.magnet.Cylinder(
            id=name,
            style_label=f"{name.capitalize()} magnet",
            dimension=(0.01, 0.005),
            polarization=(0, 0, 1.3),
            position=(0, 0, sign * (g / 2 + 0.0025)),
        )
    s.Sensor(id="probe", style_label="Probe", position=(0, 0, 0))
    return s.session


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
