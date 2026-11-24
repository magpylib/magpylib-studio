"""A sensor dragged on a saved page (#176): the page lays its grid, tests
what is inside and computes the field as python does, by
`magpylib_studio/static/pagefield.mjs` and material-response's compiled
kernels -- held here to `fieldlines.py`, through node (`page_field.mjs`).

Skipped where node or the kernels are not to be had: see
`fieldlines.page_kernels`."""

from __future__ import annotations

import json
import shutil
import subprocess
import warnings
from pathlib import Path

import magpylib as magpy
import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from magpylib_studio import fieldlines

pytest.importorskip("magpylib_material_response")
KERNELS = fieldlines.page_kernels()
pytestmark = pytest.mark.skipif(
    KERNELS is None or shutil.which("node") is None,
    reason="needs node and material-response's compiled kernels",
)
DRIVER = Path(__file__).with_name("page_field.mjs")

#: Poses of the solved plate example's probe, from where it was saved: as
#: saved, slid in its plane, lifted off it (a box), and turned.
POSES = {
    "saved": ((0, 0, 0), None, None),
    "slid in its plane": ((0.005, 0, 0.003), None, None),
    "off its plane": ((0, 0.004, 0), None, False),
    "turned": ((0.002, 0, 0), (0, 0, 0.5), None),
}


def _in_node(folder, asked):
    """What `page_field.mjs` answers to `asked`, run by node on the kernels
    written to `folder`."""
    glue, wasm = KERNELS
    (folder / "mmr_kernels.js").write_text(glue, encoding="utf-8")
    (folder / "mmr_kernels_bg.wasm").write_bytes(wasm)
    (folder / "cases.json").write_text(json.dumps(asked))
    node = shutil.which("node")
    subprocess.run(  # noqa: S603 - node on our own driver and files
        [
            node,
            str(DRIVER),
            str(folder),
            str(folder / "cases.json"),
            str(folder / "answers.json"),
        ],
        check=True,
        timeout=120,
    )
    return json.loads((folder / "answers.json").read_text())


def _plate():
    from magpylib_studio.examples.solved_plate_run import solved_plate_run
    from magpylib_studio.widget import SceneWidget

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        view = SceneWidget(solved_plate_run.build(), field_lines=True)
    return view._session


def test_the_page_lays_grids_and_computes_the_field_as_python(tmp_path, monkeypatch):
    monkeypatch.setattr(fieldlines, "MATRIX_MEMORY", 0)  # every bit, no float32
    session = _plate()
    field = session.page_field()
    assert field is not None
    (key,) = field["sensors"]
    sensor = session._objs[key]
    sources = fieldlines.sources_of(session.scene)
    saved = sensor.position.copy()

    cases, expected = [], []
    for name, (shift, rotvec, flat) in POSES.items():
        posed = sensor.copy(position=saved + shift)
        if rotvec is not None:
            posed.orientation = Rotation.from_rotvec(rotvec)
        pose = {
            "position": posed.position.tolist(),
            "orientation": posed.orientation.as_quat().tolist(),
        }
        seeds = fieldlines.seeds_of(posed)
        grid = fieldlines.grid_around(sources, seeds, fieldlines.DRAG_POINTS, flat=flat)
        points = fieldlines.points_of(grid)
        start = fieldlines.seeds_of(sensor)
        cases.append(
            {
                "pose": pose,
                "points": fieldlines.DRAG_POINTS,
                "flat": flat,
                "from": {
                    "position": sensor.position.tolist(),
                    "orientation": sensor.orientation.as_quat().tolist(),
                },
            }
        )
        expected.append(
            {
                "name": name,
                "seeds": seeds,
                "grid": grid,
                "points": points,
                "inside": fieldlines.inside(sources, points),
                "field": fieldlines.field(sources, points, "B"),
                "holds": fieldlines.holds(grid, start, fieldlines.HELD_MARGIN),
                "slid": fieldlines.slide(grid, seeds, start),
            }
        )

    answers = _in_node(tmp_path, {"field": field, "key": key, "cases": cases})

    for want, got in zip(expected, answers, strict=True):
        name = want["name"]
        np.testing.assert_allclose(
            got["seeds"], want["seeds"], atol=1e-15, err_msg=name
        )
        grid = want["grid"]
        assert got["grid"]["shape"] == grid["shape"], name
        np.testing.assert_allclose(got["grid"]["axes"], grid["axes"], atol=1e-15)
        np.testing.assert_allclose(got["grid"]["origin"], grid["origin"], atol=1e-15)
        np.testing.assert_allclose(got["grid"]["step"], grid["step"], rtol=1e-14)
        points = np.reshape(got["points"], (-1, 3))
        np.testing.assert_allclose(points, want["points"], atol=1e-15, err_msg=name)
        # in or out alike, but where rounding puts a point on a face either way
        differ = np.flatnonzero(np.asarray(got["inside"], bool) != want["inside"])
        assert len(differ) == 0, (name, points[differ])
        # the field to the kernels' agreement, against the largest on the grid
        B, page = want["field"], np.reshape(got["field"], (-1, 3))
        size = np.linalg.norm(B, axis=1)
        error = np.linalg.norm(page - B, axis=1)
        assert np.all(error <= 1e-10 * size + 1e-12 * size.max()), (
            name,
            float((error / np.maximum(size, 1e-300)).max()),
        )
        assert got["holds"] == want["holds"], name
        if want["slid"] is None:
            assert got["slid"] is None, name
        else:
            slid, was = want["slid"]
            np.testing.assert_allclose(
                got["slid"]["grid"]["origin"], slid["origin"], atol=1e-15
            )
            np.testing.assert_array_equal(got["slid"]["was"], was, err_msg=name)


def _solved_apart():
    """The plate example's magnet and solved sheets, apart: fresh copies."""
    from magpylib_material_response.face_charge import ChargeSheet

    from magpylib_studio.examples.solved_plate_run import _solved

    solved = _solved()
    (sheet,) = [s for s in solved.sources_all if isinstance(s, ChargeSheet)]
    (magnet,) = [s for s in solved.sources_all if not isinstance(s, ChargeSheet)]
    return magnet, sheet


def _turned_about_three_axes():
    # a sheet moved and turned after its solve, the magnet turned too
    magnet, sheet = _solved_apart()
    magnet.rotate_from_rotvec((0.3, -0.5, 0.7), anchor=None)
    sheet.move((0.003, -0.002, 0.001)).rotate_from_rotvec((-0.2, 0.4, 0.1))
    return [magnet, sheet]


def _a_turned_collection_with_a_turned_child():
    magnet, sheet = _solved_apart()
    magnet.rotate_from_rotvec((0.1, 0.2, -0.4), anchor=None)
    together = magpy.Collection(magnet, sheet, override_parent=True)
    together.rotate_from_rotvec((0.5, -0.1, 0.3), anchor=(0.01, 0, 0)).move(
        (0, 0.004, -0.002)
    )
    return [together]


def _a_magnet_on_a_path():
    # a page draws a source at its last step
    magnet, sheet = _solved_apart()
    magnet.move(np.linspace((0, 0, 0), (0.02, 0.005, 0.003), 5), start=0)
    return [magnet, sheet]


def _a_cylinder_beside_them():
    # a cylinder magnet turned and moved, where the kernels have cylinders
    if "function cylinder_field(" not in KERNELS[0]:
        pytest.skip("the kernels have no cylinders")
    magnet, sheet = _solved_apart()
    cylinder = magpy.magnet.Cylinder(
        polarization=(0.3, -0.5, 0.9),
        dimension=(0.008, 0.005),
        position=(-0.012, -0.006, 0.01),
    )
    cylinder.rotate_from_rotvec((0.5, -0.2, 0.7))
    return [magnet, sheet, cylinder]


def _balls_and_a_dipole_beside_them():
    # a sphere and a dipole, each turned and moved
    magnet, sheet = _solved_apart()
    ball = magpy.magnet.Sphere(
        polarization=(0.3, -0.2, 1.0), diameter=0.008, position=(-0.02, 0.01, 0.01)
    )
    ball.rotate_from_rotvec((0.2, 0.5, -0.3))
    dipole = magpy.misc.Dipole(moment=(0.1, 0.4, -0.2), position=(0.015, -0.012, 0.02))
    dipole.rotate_from_rotvec((-0.4, 0.1, 0.6))
    return [magnet, sheet, ball, dipole]


def _triangle_magnets_beside_them():
    # a closed mesh, a tetrahedron and an open triangle, each turned and moved
    magnet, sheet = _solved_apart()
    corners = 0.004 * np.array(
        [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1.5)]
    )
    mesh = magpy.magnet.TriangularMesh.from_ConvexHull(
        polarization=(0.2, 0.7, -0.4), points=corners, position=(-0.022, 0.012, 0.01)
    )
    mesh.rotate_from_rotvec((0.3, 0.2, -0.5))
    tetra = magpy.magnet.Tetrahedron(
        polarization=(-0.5, 0.1, 0.8),
        vertices=0.004 * np.array([(1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1)]),
        position=(0.02, -0.015, 0.012),
    )
    tetra.rotate_from_rotvec((-0.2, 0.6, 0.1))
    triangle = magpy.misc.Triangle(
        polarization=(0.3, 0.3, 1.0),
        vertices=[(0, 0, 0), (0.008, 0, 0), (0, 0.006, 0.002)],
        position=(0.0, 0.015, 0.02),
    )
    triangle.rotate_from_rotvec((0.5, -0.4, 0.2))
    return [magnet, sheet, mesh, tetra, triangle]


def _a_coil_beside_them():
    # a wire's straight segments, the loop turned and moved
    magnet, sheet = _solved_apart()
    loop = magpy.current.Polyline(
        current=5,
        vertices=[
            (-0.01, -0.01, 0),
            (0.01, -0.01, 0),
            (0.01, 0.01, 0),
            (-0.01, 0.01, 0),
            (-0.01, -0.01, 0),
        ],
        position=(0.005, -0.004, 0.012),
    )
    loop.rotate_from_rotvec((0.4, -0.3, 0.2))
    return [magnet, sheet, loop]


def _a_ring_beside_them():
    # a ring turned and moved, where the kernels have rings (MR #217)
    if "function circle_field(" not in KERNELS[0]:
        pytest.skip("the kernels have no rings")
    magnet, sheet = _solved_apart()
    ring = magpy.current.Circle(
        current=-3, diameter=0.012, position=(-0.01, 0.008, -0.006)
    )
    ring.rotate_from_rotvec((-0.3, 0.6, 0.1))
    return [magnet, sheet, ring]


@pytest.mark.parametrize(
    "scene",
    [
        _a_coil_beside_them,
        _a_ring_beside_them,
        _a_cylinder_beside_them,
        _balls_and_a_dipole_beside_them,
        _triangle_magnets_beside_them,
        _turned_about_three_axes,
        _a_turned_collection_with_a_turned_child,
        _a_magnet_on_a_path,
    ],
)
def test_the_page_computes_the_field_of_turned_and_moved_sources(
    scene, tmp_path, monkeypatch
):
    # #176, from MR's review: frames, collections and paths, B and H, at each
    # tolerance -- to the kernels' agreement at 0, and at 1e-6 and 1e-3 within
    # a hundredth of the tolerance of the largest field on the points (1.2e-9
    # and 3.7e-7 measured, near the large faces of the triangle magnets)
    monkeypatch.setattr(fieldlines, "MATRIX_MEMORY", 0)
    objects = scene()
    sources = fieldlines.sources_of(objects)
    probe = magpy.Sensor(pixel=[(0, 0, 0), (0.001, 0, 0), (0, 0, 0.001)])
    probe.style.pixel.field.source = "B"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        field = fieldlines.page_field(sources, {"probe": probe})
    assert field is not None
    rng = np.random.default_rng(176)
    points = rng.uniform((-0.04, -0.03, -0.02), (0.04, 0.03, 0.03), (300, 3))
    # and some within each ball and closed body, which few of those would hit
    bodies = (magpy.magnet.TriangularMesh, magpy.magnet.Tetrahedron)
    points = np.vstack(
        [points]
        + [
            x.position + rng.uniform(-0.25, 0.25, (10, 3)) * x.diameter
            for x in sources
            if isinstance(x, magpy.magnet.Sphere)
        ]
        + [
            x.position
            + x.orientation.apply(
                rng.uniform(-0.6, 0.6, (10, 3)) * x.dimension[[0, 0, 1]]
            )
            for x in sources
            if isinstance(x, magpy.magnet.Cylinder)
        ]
        + [
            x.position + rng.uniform(-0.001, 0.001, (10, 3))
            for x in sources
            if isinstance(x, bodies)
        ]
    )
    tolerances = [0, 1e-6, 1e-3]
    asked = [
        {
            "field": field,
            "points": points.ravel().tolist(),
            "kind": kind,
            "tolerances": tolerances,
        }
        for kind in ("B", "H")
    ]
    answers = _in_node(tmp_path, {"fields": asked})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        within = fieldlines.inside(sources, points)
    np.testing.assert_array_equal(np.asarray(answers[0]["inside"], bool), within)
    for kind, answer in zip(("B", "H"), answers, strict=True):
        at_each = answer["fields"]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # observers inside the solved part
            want = fieldlines.field(sources, points, kind)
        size = np.linalg.norm(want, axis=1)
        for tolerance, got in zip(tolerances, at_each, strict=True):
            error = np.linalg.norm(np.reshape(got, (-1, 3)) - want, axis=1)
            allowed = 1e-10 * size + (1e-12 + tolerance / 100) * size.max()
            assert np.all(error <= allowed), (
                kind,
                tolerance,
                float((error / size.max()).max()),
            )


def test_the_page_lays_a_set_region_and_reads_a_map_as_python(tmp_path):
    """A region set on a turned, moved sensor: the box the page puts it at,
    back in the sensor's frame, the grids it lays over it -- flat, through
    it, with a step's room -- whether the pixels lie in it, and what a map on
    it shows, as `fieldlines.py` has them."""
    from magpylib_studio.examples import EXAMPLES
    from magpylib_studio.widget import SceneWidget

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        view = SceneWidget(
            EXAMPLES["helmholtz"].scene.build(), field_lines=True, field_map=True
        )
    session = view._session
    (rule,) = session.get_scene()["fieldlines"]
    sensor = session._objs[rule["object_id"]]
    sensor.position = (0.002, -0.001, 0.003)
    sensor.orientation = Rotation.from_rotvec([0.1, -0.2, 0.3])
    turned = Rotation.from_rotvec([0.0, 0.0, 0.4]).as_matrix()
    region = {
        "centre": [0.001, 0.002, 0.0],
        "axes": turned.tolist(),
        "size": [0.02, 0.03, 0.01],
    }
    pose = {
        "position": sensor.position.tolist(),
        "orientation": sensor.orientation.as_quat().tolist(),
    }
    seeds = fieldlines.seeds_of(sensor)
    session.set_field_region(rule["object_id"], None)
    session.set_field_region(
        rule["object_id"], fieldlines.region_in_world(sensor, region)
    )
    (regioned,) = session.get_scene()["fieldlines"]
    asked = [
        {
            "region": region,
            "pose": pose,
            "seeds": seeds.tolist(),
            "points": 2500,
            "item": item,
        }
        for item in (rule, regioned)
    ]
    answers = _in_node(tmp_path, {"regions": asked})

    box = fieldlines.region_in_world(sensor, region)
    for item, got in zip((rule, regioned), answers, strict=True):
        for key in ("centre", "axes", "size"):
            np.testing.assert_allclose(got["box"][key], box[key], atol=1e-15)
        back = fieldlines.region_of(sensor, box)
        for key in ("centre", "axes", "size"):
            np.testing.assert_allclose(got["back"][key], back[key], atol=2e-12)
        for name, grid in (
            ("flat", fieldlines.grid_in(box, 2500, flat=True)),
            ("deep", fieldlines.grid_in(box, 2500, flat=False)),
            ("rimmed", fieldlines.rimmed(box, 2500, flat=True)),
        ):
            assert got[name]["shape"] == grid["shape"], name
            np.testing.assert_allclose(got[name]["step"], grid["step"], rtol=1e-14)
            np.testing.assert_allclose(got[name]["origin"], grid["origin"], atol=1e-15)
        assert got["inPlane"] == fieldlines.in_plane_of(box, seeds)
        np.testing.assert_allclose(
            got["levels"], fieldlines.map_levels(item), rtol=1e-12
        )


def test_a_page_saved_without_its_map_draws_it_as_python(tmp_path):
    """A page saved with the map off, its eye clicked: the page draws the
    map with its own kernels, reading what python's map reads."""
    from magpylib_studio.examples import EXAMPLES
    from magpylib_studio.widget import SceneWidget, _page_field

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        view = SceneWidget(EXAMPLES["helmholtz"].scene.build(), field_lines=True)
    session = view._session
    payload = {**session.get_scene(), "page_field": _page_field(session)}
    (saved,) = payload["fieldlines"]
    assert saved["map"] is False
    got = _in_node(
        tmp_path, {"switched": {"payload": payload, "key": saved["object_id"]}}
    )

    view.field_map = True
    (python,) = view._session.get_scene()["fieldlines"]
    assert got["switched"] is True
    assert got["again"] is False
    assert got["map"] is True
    np.testing.assert_allclose(got["levels"], python["map_levels"], rtol=1e-3)
