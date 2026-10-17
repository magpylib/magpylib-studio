"""Tests for overlap detection: which magnets interpenetrate.

What matters is the line between touching and overlapping. A Halbach ring, a
stack or a shaft in its bore touches on purpose and must never be flagged;
a magnet pushed a micrometre into its neighbour must always be. Each case
below sits on one side of that line, for one kind of shape or contact.
"""

from __future__ import annotations

import warnings

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio.collisions import find_overlaps
from magpylib_studio.session import MagpylibStudioSession

MM = 1e-3
POL = (0, 0, 1)


def cuboid(dim, position=(0, 0, 0), angles=None):
    obj = magpy.magnet.Cuboid(
        dimension=np.multiply(dim, MM),
        polarization=POL,
        position=np.multiply(position, MM),
    )
    if angles:
        obj.rotate_from_euler(angles, "xyz", degrees=True, anchor=None)
    return obj


def cylinder(d, h, position=(0, 0, 0), angles=None):
    obj = magpy.magnet.Cylinder(
        dimension=(d * MM, h * MM), polarization=POL, position=np.multiply(position, MM)
    )
    if angles:
        obj.rotate_from_euler(angles, "xyz", degrees=True, anchor=None)
    return obj


def ring(r1, r2, h, p1=0, p2=360, angle=0):
    obj = magpy.magnet.CylinderSegment(
        dimension=(r1 * MM, r2 * MM, h * MM, p1, p2), polarization=POL
    )
    if angle:
        obj.rotate_from_angax(angle, "z", anchor=0)
    return obj


def sphere(d, position=(0, 0, 0)):
    return magpy.magnet.Sphere(
        diameter=d * MM, polarization=POL, position=np.multiply(position, MM)
    )


def l_prism(position=(0, 0, 0)):
    """An L-shaped prism 20 mm across and 8 mm tall: a mesh that is not convex."""
    outline = np.array(
        [(-10, -10), (10, -10), (10, -3), (-3, -3), (-3, 10), (-10, 10)], float
    )
    vertices = (
        np.vstack([np.c_[outline, np.full(6, -4.0)], np.c_[outline, np.full(6, 4.0)]])
        * MM
    )
    caps = [(0, 1, 2), (0, 2, 3), (0, 3, 5), (3, 4, 5)]
    faces = [(i + 6, j + 6, k + 6) for i, j, k in caps] + [
        (i, k, j) for i, j, k in caps
    ]
    for i in range(6):
        j = (i + 1) % 6
        faces += [(i, j, j + 6), (i, j + 6, i + 6)]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return magpy.magnet.TriangularMesh(
            vertices=vertices,
            faces=faces,
            polarization=POL,
            position=np.multiply(position, MM),
        )


def halbach(n):
    return [ring(10, 16, 8, 0, 360 / n, angle=i * 360 / n) for i in range(n)]


CASES = {
    # touching, every kind of contact
    "cubes face to face": (
        [cuboid((10, 10, 10)), cuboid((10, 10, 10), (10, 0, 0))],
        [],
    ),
    "turned cubes face to face": (
        [
            cuboid((10, 10, 10), angles=(20, 30, 40)),
            cuboid((10, 10, 10), angles=(20, 30, 40)),
        ],
        "shift",
    ),
    "stacked discs": ([cylinder(14, 10), cylinder(14, 10, (0, 0, 10))], []),
    "cylinders side by side": ([cylinder(14, 10), cylinder(14, 10, (14, 0, 0))], []),
    "spheres": ([sphere(12), sphere(12, (12, 0, 0))], []),
    "shaft in the bore": ([ring(10, 16, 8), cylinder(20, 30)], []),
    "tilted shaft clearing the bore": (
        [ring(10, 16, 8), cylinder(16, 30, angles=(15, 0, 0))],
        [],
    ),
    "halbach neighbours": ([ring(10, 16, 8, -60, 60), ring(10, 16, 8, 60, 180)], []),
    "halbach ring of eight": (halbach(8), []),
    "pie slices making a disc": (
        [ring(0, 16, 8, 0, 90, angle=90 * i) for i in range(4)],
        [],
    ),
    "ring round a ring": ([ring(10, 16, 8), ring(16, 20, 8)], []),
    "coil on a core": (
        [magpy.current.Circle(diameter=24 * MM, current=1), cylinder(24, 20)],
        [],
    ),
    "wire wound through a ring": (
        [
            ring(10, 16, 8),
            magpy.current.Polyline(
                vertices=np.multiply(
                    [(4, 0, -12), (4, 0, 12), (21, 0, 12), (21, 0, -12), (4, 0, -12)],
                    MM,
                ),
                current=1,
            ),
        ],
        [],
    ),
    "cube in the mesh's notch": ([l_prism(), cuboid((13, 13, 8), (3.5, 3.5, 0))], []),
    "meshes side by side": ([l_prism(), l_prism((20, 0, 0))], []),
    "sensor inside a magnet": ([cuboid((10, 10, 10)), magpy.Sensor()], []),
    # overlapping
    "cube pushed 0.1 mm in": (
        [cuboid((10, 10, 10)), cuboid((10, 10, 10), (9.9, 0, 0))],
        [(0, 1)],
    ),
    "spheres 1 um in": ([sphere(12), sphere(12, (11.999, 0, 0))], [(0, 1)]),
    "shaft too big for the bore": ([ring(10, 16, 8), cylinder(21.6, 30)], [(0, 1)]),
    "bars crossed edge to edge": (
        [
            cuboid((32, 4, 4), angles=(45, 0, 0)),
            cuboid((4, 32, 4), (0, 0, 5.4), angles=(0, 45, 0)),
        ],
        [(0, 1)],
    ),
    "halbach segments sharing a degree": (
        [ring(10, 16, 8, -60, 60), ring(10, 16, 8, 59, 180)],
        [(0, 1)],
    ),
    "coil through a cube": (
        [magpy.current.Circle(diameter=8 * MM, current=1), cuboid((10, 10, 10))],
        [(0, 1)],
    ),
    "magnet inside the mesh": ([l_prism(), cuboid((4, 4, 4), (-6.5, 3, 0))], [(0, 1)]),
    "meshes interlocking": ([l_prism(), l_prism((5, 5, 0))], [(0, 1)]),
}


@pytest.mark.parametrize("name", CASES)
def test_overlaps(name):
    objects, expected = CASES[name]
    if expected == "shift":
        # the second cube one edge along its own turned x: faces exactly shared
        objects[1].move(objects[0].orientation.apply((10 * MM, 0, 0)))
        expected = []
    assert find_overlaps(objects) == expected


def test_the_scene_says_which_objects_overlap():
    session = MagpylibStudioSession()
    session.add_object(
        "a",
        "magnet.Cuboid",
        params={"dimension": [0.01, 0.01, 0.01], "polarization": [0, 0, 1]},
    )
    session.add_object(
        "b",
        "magnet.Cuboid",
        params={
            "dimension": [0.01, 0.01, 0.01],
            "polarization": [0, 0, 1],
            "position": [0.01, 0, 0],
        },
    )
    session.add_object(
        "c",
        "magnet.Cuboid",
        params={
            "dimension": [0.01, 0.01, 0.01],
            "polarization": [0, 0, 1],
            "position": [0, 0.0099, 0],
        },
    )
    assert session.get_overlaps() == [["a", "c"]]
    assert session.get_scene()["overlaps"] == [["a", "c"]]
