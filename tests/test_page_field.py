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

    glue, wasm = KERNELS
    (tmp_path / "mmr_kernels.js").write_text(glue, encoding="utf-8")
    (tmp_path / "mmr_kernels_bg.wasm").write_bytes(wasm)
    asked = tmp_path / "cases.json"
    asked.write_text(json.dumps({"field": field, "key": key, "cases": cases}))
    answered = tmp_path / "answers.json"
    node = shutil.which("node")
    subprocess.run(  # noqa: S603 - node on our own driver and files
        [node, str(DRIVER), str(tmp_path), str(asked), str(answered)],
        check=True,
        timeout=120,
    )
    answers = json.loads(answered.read_text())

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
