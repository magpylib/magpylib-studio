"""Every kind of magpylib object in one scene, round a Möbius band whose current
runs over both its faces.

Each object is named by its magpylib class in the legend: the magnets (Cuboid,
Cylinder, CylinderSegment, Sphere, Tetrahedron, TriangularMesh), the currents
(Circle, Polyline, TriangleSheet, TriangleStrip), a Triangle, a Dipole, and a
Sensor at the centre. `radius` sets the ring they stand on.
In the studio each takes the handles: R on a magnet's faces resizes it, a
sphere and a loop resize by the rim, and a shape made of points has a dot on
each point to drag.
"""

from typing import Annotated

import magpylib as magpy
import numpy as np

from magpylib_studio import Length, scene

TITLE = "Every kind of object"
SUMMARY = (
    "One of every magpylib magnet, current and source round a Möbius band, "
    "each named by its class — and each takes the handles"
)

MM = 1e-3


def _band(round_twice, w):
    """The Möbius band's points `w` out from its middle line."""
    reach = 1 + w * np.cos(round_twice / 2)
    return np.column_stack(
        [
            reach * np.cos(round_twice),
            reach * np.sin(round_twice),
            w * np.sin(round_twice / 2),
        ]
    )


def _sheet():
    """A square sheet, as magpylib's docs build one: its current circulating,
    the stronger the further out."""
    side = np.linspace(-5, 5, 11) * MM
    points = np.array([(x, y, 0) for x in side for y in side])
    faces = [
        face
        for i in range(10)
        for j in range(10)
        for face in (
            (j + 11 * i, j + 11 * i + 11, j + 11 * i + 12),
            (j + 11 * i, j + 11 * i + 12, j + 11 * i + 1),
        )
    ]
    centres = points[np.array(faces)].mean(axis=1)
    current = np.column_stack(
        [centres[:, 1], -centres[:, 0], np.zeros(len(centres))]
    ) / (5 * MM)
    return points, faces, current


@scene
def every_kind(radius: Annotated[float, Length(0.03, 0.08)] = 0.037):
    """A Möbius band, round it on a ring of `radius` one object of every
    other kind, each made with its magnetization along the ring, and a
    sensor at the centre."""
    # vertices from the band's middle line out to its edge, twice round, which
    # covers both halves of it; turned so that its twist shows at first look
    round_twice = np.linspace(0, 4 * np.pi, 160)
    strip = np.empty((320, 3))
    strip[0::2], strip[1::2] = _band(round_twice, 0), _band(round_twice, 0.36)
    moebius = magpy.current.TriangleStrip(
        current=20, vertices=strip * 16 * MM, style_label="TriangleStrip - Möbius band"
    )
    moebius.rotate_from_angax(-51, "z", anchor=0)

    sheet, sheet_faces, sheet_current = _sheet()
    kinds = {
        "mesh": lambda p: magpy.magnet.TriangularMesh.from_ConvexHull(
            polarization=p, points=np.vstack([np.eye(3), -np.eye(3)]) * 7.5 * MM
        ),
        "sphere": lambda p: magpy.magnet.Sphere(polarization=p, diameter=11 * MM),
        "cuboid": lambda p: magpy.magnet.Cuboid(
            polarization=p, dimension=(11 * MM,) * 3
        ),
        "cylinder": lambda p: magpy.magnet.Cylinder(
            polarization=p, dimension=(11 * MM, 13 * MM)
        ),
        "segment": lambda p: magpy.magnet.CylinderSegment(
            polarization=p, dimension=(5 * MM, 11 * MM, 10 * MM, -42, 42)
        ),
        "tetrahedron": lambda p: magpy.magnet.Tetrahedron(
            polarization=p,
            vertices=(np.array([(0, 0, 0), (10, 0, 0), (0, 10, 0), (0, 0, 10)]) - 2.5)
            * 1.3
            * MM,
        ),
        "triangle": lambda p: magpy.misc.Triangle(
            polarization=(0, 0, 1),
            vertices=np.array([(-5, -4, 0), (5, -4, 0), (0, 5, 0)]) * 1.3 * MM,
        ),
        "loop": lambda p: magpy.current.Circle(current=10, diameter=13 * MM),
        "sheet": lambda p: magpy.current.TriangleSheet(
            current_densities=sheet_current, vertices=sheet, faces=sheet_faces
        ),
        "wire": lambda p: magpy.current.Polyline(
            current=10,
            vertices=np.array([(-6, -4, 0), (-2, 4, 0), (2, -4, 0), (6, 4, 0)])
            * 1.3
            * MM,
        ),
        "dipole": lambda p: magpy.misc.Dipole(
            moment=0.4 * np.array(p), style_size=12 * MM, style_sizemode="absolute"
        ),
    }
    # round the band from 47 degrees: the magnets behind it, as the view first
    # looks, polarized round the ring; the flat ones in front, stood up to face it
    ring = []
    for k, name in enumerate(kinds):
        angle = np.deg2rad(47 + k * 360 / len(kinds))
        outward = np.array([np.cos(angle), np.sin(angle), 0])
        around = np.array([-np.sin(angle), np.cos(angle), 0])
        made = kinds[name](around)
        made.style.label = type(made).__name__
        reach = radius
        if name == "segment":
            # its arc bulging outward, and its own y round the ring
            made.rotate_from_angax(np.rad2deg(angle), "z", anchor=0)
            made.polarization = (0, 1, 0)
            reach = radius - 8 * MM
        elif name in ("triangle", "loop", "sheet", "wire"):
            # facing that first look: 51 degrees below x, 29 above the floor
            made.rotate_from_angax(61, "x", anchor=0)
            made.rotate_from_angax(39, "z", anchor=0)
        # a component at a time: the radius is a variable, the direction is not
        made.move((reach * outward[0], reach * outward[1], 0))
        ring.append(made)
    sensor = magpy.Sensor(style_label="Sensor")
    return (moebius, *ring, sensor)
