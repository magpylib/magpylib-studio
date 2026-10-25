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
from scipy.spatial.transform import Rotation

from magpylib_studio import collisions
from magpylib_studio.collisions import find_overlaps, overlaps_along, separation
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


def tube(facets, r_in=5, r_out=10, h=8):
    """A tube faceted `facets` times round: a mesh that is not convex, whose
    outer corners sit on the circle a coil wound on it would follow."""
    t = np.arange(facets) * 2 * np.pi / facets
    rings = [
        np.c_[r * np.cos(t), r * np.sin(t), np.full(facets, z)]
        for r in (r_out, r_in)
        for z in (-h / 2, h / 2)
    ]
    vertices = np.vstack(rings) * MM
    out_lo, out_hi, in_lo, in_hi = (k * facets for k in range(4))
    faces = []
    for i in range(facets):
        j = (i + 1) % facets
        faces += [
            (out_lo + i, out_lo + j, out_hi + j),
            (out_lo + i, out_hi + j, out_hi + i),
        ]
        faces += [(in_lo + i, in_hi + j, in_lo + j), (in_lo + i, in_hi + i, in_hi + j)]
        faces += [
            (out_hi + i, out_hi + j, in_hi + j),
            (out_hi + i, in_hi + j, in_hi + i),
        ]
        faces += [
            (out_lo + i, in_lo + j, out_lo + j),
            (out_lo + i, in_lo + i, in_lo + j),
        ]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return magpy.magnet.TriangularMesh(
            vertices=vertices, faces=faces, polarization=POL
        )


def hull(corners, position=(0, 0, 0)):
    """A convex mesh round `corners` (mm)."""
    return magpy.magnet.TriangularMesh.from_ConvexHull(
        points=np.multiply(corners, MM),
        polarization=POL,
        position=np.multiply(position, MM),
    )


def box_corners(lo, hi):
    return [
        (x, y, z)
        for x in (lo[0], hi[0])
        for y in (lo[1], hi[1])
        for z in (lo[2], hi[2])
    ]


def wire(*steps):
    """A wire whose vertices are given for each step of its path (mm)."""
    vertices = np.multiply(steps, MM)
    if len(steps) == 1:
        return magpy.current.Polyline(vertices=vertices[0], current=1)
    return magpy.current.Polyline(vertices=vertices, current=1)


def against_bore(r1, depth, angle):
    """A 10 mm sphere inside a ring's bore, `depth` mm into its wall at `angle`."""
    centre = (r1 - 5 + depth) * np.array(
        [np.cos(np.radians(angle)), np.sin(np.radians(angle)), 0]
    )
    return [ring(r1, r1 + 10, 10), sphere(10, centre)]


L_OUTLINE = [
    (-10, -10, 0),
    (10, -10, 0),
    (10, -3, 0),
    (-3, -3, 0),
    (-3, 10, 0),
    (-10, 10, 0),
    (-10, -10, 0),
]


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
    "tetrahedron in the mesh's notch, its position in the arm": (
        [
            l_prism(),
            magpy.magnet.Tetrahedron(
                vertices=np.multiply(
                    [(8, 2, -2), (12, 2, -2), (8, 6, -2), (9, 3, 3)], MM
                ),
                polarization=POL,
                position=(-6 * MM, 0, 0),
            ),
        ],
        [],
    ),
    "wire wound round the mesh from a corner": ([l_prism(), wire(L_OUTLINE)], []),
    "coil on a faceted core": (
        [tube(16), magpy.current.Circle(diameter=20 * MM, current=1)],
        [],
    ),
    # made when the test runs, so that it can be skipped
    "wire whose path ends clear of a cube": (
        lambda: [
            cuboid((10, 10, 10)),
            wire([(-20, 0, 0), (20, 0, 0)], [(-20, 0, 30), (20, 0, 30)]),
        ],
        [],
    ),
    "convex plates half a nanometre in": (
        [
            hull(box_corners((0, 0, 0), (20, 20, 0.01))),
            hull(box_corners((0, 0, 0), (20, 20, 0.01)), (0, 0, 0.01 - 0.5e-6)),
        ],
        [],
    ),
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
    "spheres in the same place": (
        [sphere(10, (10, 0, 0)), sphere(10, (10, 0, 0))],
        [(0, 1)],
    ),
    "sphere inside a sphere": ([sphere(10), sphere(4)], [(0, 1)]),
    "convex mesh inside the mesh, its position outside": (
        [l_prism(), hull(box_corners((-8, 1.5, -1.5), (-5, 4.5, 1.5)))],
        [(0, 1)],
    ),
    "sphere 2 nm into a wide bore's wall": (against_bore(300, 2e-6, 21), [(0, 1)]),
}


@pytest.mark.parametrize("name", CASES)
def test_overlaps(name):
    objects, expected = CASES[name]
    if callable(objects):
        objects = objects()
    if expected == "shift":
        # the second cube one edge along its own turned x: faces exactly shared
        objects[1].move(objects[0].orientation.apply((10 * MM, 0, 0)))
        expected = []
    assert find_overlaps(objects) == expected


def three_cubes():
    """Cubes a and b side by side, touching, and c pushed 0.1 mm into a."""
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
    # a wire not yet given its vertices, which overlaps nothing
    session.add_object("w", "current.Polyline", params={"current": 1})
    return session


def test_the_session_says_which_objects_overlap():
    session = three_cubes()
    assert session.get_overlaps() == [["a", "c"]]

    # a pattern of a group: the magnets in its copies have no id of their
    # own, and overlap under the copy that holds them
    session.add_object("outer", "Collection")
    session.add_object("g", "Collection", parent="outer")
    session.add_object(
        "m",
        "magnet.Cuboid",
        params={
            "dimension": [0.01, 0.01, 0.01],
            "polarization": [0, 0, 1],
            "position": [0, 0, 0.05],
        },
        parent="g",
    )
    session.duplicate_along("g", 3, [0.005, 0, 0])
    assert session.get_overlaps() == [["a", "c"], ["m", "g#1"], ["g#1", "g#2"]]


def test_every_scene_says_which_objects_overlap():
    session = three_cubes()
    deep = [pytest.approx(1e-4, abs=1e-8)]
    assert session.get_scene()["overlaps"] == [["a", "c"]]
    assert session.get_scene()["overlap_depths"] == deep
    # mid-drag, which pairs; how deep, once the drag ends
    session.begin_interaction()
    assert session.get_scene()["overlap_depths"] == [None]
    session.end_interaction()
    assert session.get_scene()["overlap_depths"] == deep


def tilted_shaft_gap():
    """From the bore's rim, at the ring's top face, to the surface of a 16 mm
    shaft through the origin tilted 15 degrees about x: the rim point facing
    the tilt is nearest."""
    rim = np.array([0, -10, 4])
    axis = np.array([0, -np.sin(np.radians(15)), np.cos(np.radians(15))])
    return np.linalg.norm(np.cross(rim, axis)) - 8


SEPARATIONS = {
    "cubes 2 mm apart": (
        cuboid((10, 10, 10)),
        cuboid((10, 10, 10), (12, 0, 0)),
        "gap",
        2,
    ),
    "cubes touching": (
        cuboid((10, 10, 10)),
        cuboid((10, 10, 10), (10, 0, 0)),
        "touch",
        0,
    ),
    "a cube 0.1 mm in": (
        cuboid((10, 10, 10)),
        cuboid((10, 10, 10), (9.9, 0, 0)),
        "overlap",
        0.1,
    ),
    "bars crossed edge to edge": (
        *CASES["bars crossed edge to edge"][0],
        "overlap",
        4 * np.sqrt(2) - 5.4,  # each edge 2*sqrt(2) from its bar's axis, 5.4 apart
    ),
    "a shaft 0.5 mm clear of its bore": (ring(10, 16, 8), cylinder(19, 30), "gap", 0.5),
    "a tilted shaft in its bore": (
        ring(10, 16, 8),
        cylinder(16, 30, angles=(15, 0, 0)),
        "gap",
        tilted_shaft_gap(),
    ),
    "a coil 1 mm round its core": (
        magpy.current.Circle(diameter=26 * MM, current=1),
        cylinder(24, 20),
        "gap",
        1,
    ),
    "a cube 2 mm off the mesh's notch": (
        l_prism(),
        cuboid((4, 4, 4), (1, 1, 0)),
        "gap",
        2,
    ),
}


@pytest.mark.parametrize("name", SEPARATIONS)
def test_how_far_apart_and_how_deep(name):
    a, b, state, mm = SEPARATIONS[name]
    found, value = separation(a, b)
    assert found == state
    assert value == pytest.approx(mm * MM, rel=1e-4, abs=1e-8)


def test_a_path_is_checked_at_every_step():
    passing = cuboid((10, 10, 10))
    passing.position = np.multiply(
        [(30, 0, 0), (15, 0, 0), (5, 0, 0), (-15, 0, 0), (-30, 0, 0)], MM
    )
    assert overlaps_along([passing, cuboid((10, 10, 10))]) == [[], [], [(0, 1)], [], []]


def test_an_overlap_meant_as_a_cut_out_is_not_warned_about(tmp_path):
    session = three_cubes()
    assert session.set_overlap_intended("a", "c")["ok"]
    assert session.get_overlaps() == []
    assert session.get_overlaps(intended=True) == [["a", "c"]]
    assert session.doc["intended_overlaps"] == [["a", "c"]]
    assert not any("overlaps" in entry for entry in session.list_objects())
    # through the script tab, which writes only what code can say
    script = tmp_path / "scene.py"
    script.write_text(session.to_builder_script(), encoding="utf-8")
    assert session.apply_builder_script(str(script))["ok"]
    assert session.get_overlaps(intended=True) == [["a", "c"]]
    # and back, one step to undo
    session.undo()
    session.undo()
    assert session.get_overlaps() == [["a", "c"]]
    partners = {entry["id"]: entry.get("overlaps") for entry in session.list_objects()}
    assert (partners["a"], partners["b"], partners["c"]) == (["c"], None, ["a"])
    assert session.get_gap("a", "b") == {
        "ok": True,
        "state": "touch",
        "shown": session.get_units()["shown"]["length"],
    }


def test_a_view_nobody_edits_says_what_overlaps():
    from magpylib_studio.widget import SceneWidget

    a, c = cuboid((10, 10, 10)), cuboid((10, 10, 10), (9.9, 0, 0))
    view = SceneWidget(a, c)
    assert view.payload["overlaps"] == [[str(id(a)), str(id(c))]]


@pytest.mark.parametrize("apart", [3.0, 0.9, 0.0])
def test_nearest_is_the_nearest_pair(apart):
    """Measured only where boxes could be nearer, the nearest pair of two
    groups is the one measuring every pair finds: a gap, a touch, an
    overlap."""
    rng = np.random.default_rng(7)

    def group(at):
        return [
            magpy.magnet.Cuboid(
                polarization=(0, 0, 1),
                dimension=rng.uniform(0.2, 1, 3),
                position=at + rng.normal(0, 0.8, 3),
                orientation=Rotation.random(random_state=rng),
            )
            for _ in range(8)
        ]

    a, b = group(np.zeros(3)), group(np.array([apart, 0, 0]))
    every = min(
        (collisions.separation(x, y) for x in a for y in b), key=collisions._rank
    )
    assert collisions.nearest(a, b) == pytest.approx(every)
