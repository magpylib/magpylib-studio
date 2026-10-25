"""Field lines through a sensor's pixels (#45): where they are drawn, in what
colours, and that the switch is the document's."""

from __future__ import annotations

import magpylib as magpy
import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from magpylib_studio import fieldlines, rpc
from magpylib_studio.widget import SceneWidget

PIXELS = np.linspace(-0.02, 0.02, 5)


def view(plane="y=0", source="B", colormap=None, tilt=0, sealed=False):
    """A cube polarized along z and a sensor of 5 x 5 pixels: in y = 0, a
    plane of the cube's symmetry -- or tilted out of it by `tilt` degrees --
    or 12 mm above it, which the field crosses. `sealed`, the cube is a
    sealed collection of its two halves, as a meshed body is of its cells."""
    cube = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01))
    if sealed:
        cube = magpy.Collection(
            *(
                magpy.magnet.Cuboid(
                    polarization=(0, 0, 1),
                    dimension=(0.005, 0.01, 0.01),
                    position=(x, 0, 0),
                )
                for x in (-0.0025, 0.0025)
            ),
            style_label="cube",
        )
        cube.sealed = True
    if plane == "y=0":
        pixel = [(x, 0, z) for x in PIXELS for z in PIXELS]
    else:
        pixel = [(x, y, 0.012) for x in PIXELS for y in PIXELS]
    probe = magpy.Sensor(pixel=pixel, style_label="probe")
    probe.rotate_from_angax(tilt, "x")
    probe.style.pixel.field.source = source
    if colormap:
        probe.style.pixel.field.colormap = colormap
    return SceneWidget(cube, probe, field_lines=True)


@pytest.mark.parametrize(
    ("plane", "source", "tilt", "drawn"),
    [
        ("y=0", "B", 0, "flat"),  # a symmetry plane: the lines keep to it
        ("y=0", "B", 1, "3d"),  # a degree out of it is not one
        ("z=12mm", "B", 0, "3d"),  # the field crosses it: the lines leave it
        ("y=0", "H", 0, "flat"),  # H lines for an H sensor
        ("y=0", "J", 0, None),  # J is nothing outside a magnet: no lines
    ],
)
def test_where_the_lines_are_drawn(plane, source, tilt, drawn):
    items = view(plane, source, tilt=tilt).payload.get("fieldlines") or []
    if drawn is None:
        assert items == []
        return
    (item,) = items
    assert ("flat" if item["shape"][2] == 1 else "3d") == drawn


@pytest.mark.parametrize("colormap", ["Viridis", "Inferno"])
def test_a_line_takes_the_sensor_colours(colormap):
    from magpylib.graphics.backend import colors_from_colorscale

    (item,) = view(colormap=colormap).payload["fieldlines"]
    # the weakest and strongest the pixels read: the colormap's two ends
    ends = colors_from_colorscale([0.0, 1.0], colormap, cmin=0, cmax=1)
    assert [item["lut"][0], item["lut"][-1]] == list(ends)


def test_the_switch_is_the_documents(tmp_path):
    widget = view()
    session = widget._session
    # asked for when the view was made: where editing starts, not an edit
    assert session.doc["field_lines"] is True
    assert session.get_history()["undo"] == []
    assert session.get_scene()["field_lines"] is True

    widget.field_lines = False  # the view's button, or code
    assert "field_lines" not in session.doc
    assert "fieldlines" not in widget.payload
    session.undo()
    widget._show({"by": "undo"})
    assert widget.field_lines is True
    assert widget.payload["fieldlines"]

    # through the script tab, which writes only what code can say
    script = tmp_path / "scene.py"
    script.write_text(session.to_builder_script(), encoding="utf-8")
    assert session.apply_builder_script(str(script))["ok"]
    assert session.field_lines

    # over RPC, as the studio's panel switches it
    answer = rpc.handle(session, {"method": "set_field_lines", "params": {"on": False}})
    assert answer["result"]["ok"]
    assert "fieldlines" not in session.get_scene()


def test_field_in_chunks_matches_one_call(monkeypatch):
    """B, H and the inside of many sources, in slices of the sources and the
    grid, on threads, are what one magpylib call gives at the last step of
    every path -- on an upright cube's faces and corners too, which the
    inside is tested on without magpylib; a turned one's, to rounding, just
    within and just without."""
    cells = [
        magpy.magnet.Cuboid(
            dimension=(1, 1, 1), polarization=(0, 0.3, 1), position=(i, 0, 0)
        )
        for i in range(7)
    ]
    turned = magpy.magnet.Cuboid(
        dimension=(1, 2, 0.5),
        polarization=(1, 0, 0),
        position=(3, 3, 0),
        orientation=Rotation.from_rotvec((0.3, -0.7, 1.1)),
    )
    travels = magpy.magnet.Cuboid(
        dimension=(1, 1, 1), polarization=(0, 0, 1), position=[(0, 4, 0), (2, 4, 0)]
    )
    cells += [
        turned,
        travels,
        magpy.magnet.Cuboid(dimension=(1, 1, 1), polarization=(0, 0, 0)),
        magpy.current.Polyline(current=2, vertices=[(0, -2, 0), (6, -2, 0), (6, 4, 1)]),
    ]
    near_faces = [(0.49, 0.99, 0.24), (-0.49, 0, 0.24), (0.51, 1.01, 0.26)]
    points = np.concatenate(
        [
            np.random.default_rng(0).uniform(-2, 8, size=(50, 3)),
            [(0.5, 0.5, 0.5), (1.5, 0, 0), (6.5, 0.5, -0.5), (2.5, 4.5, 0.5)],
            turned.position + turned.orientation.apply(near_faces),
        ]
    )
    monkeypatch.setattr(fieldlines, "PAIRS_PER_CALL", 30)  # several calls each way
    for kind, get in (("B", magpy.getB), ("H", magpy.getH)):
        np.testing.assert_allclose(
            fieldlines.field(cells, points, kind), get(cells, points, sumup=True)[-1]
        )
    inside = np.linalg.norm(magpy.getJ(cells, points, sumup=True)[-1], axis=1) > 0
    np.testing.assert_array_equal(fieldlines.inside(cells, points), inside)


def test_a_sensor_let_go_far_off_takes_its_grid_along(monkeypatch):
    """Let go past the room its grid kept round it, a sensor's grid moves
    with it by whole steps: the field it had is kept where the two meet,
    computed only where the moved one is new -- and is the field there."""
    widget = view()
    session = widget._session
    before = session._rest_lines["probe"]["grid"]
    computed = []
    field = fieldlines.field
    monkeypatch.setattr(
        fieldlines,
        "field",
        lambda sources, points, kind="B": (
            computed.append(len(points)) or field(sources, points, kind)
        ),
    )
    edit = {"objectId": "probe", "position": [0.004, 0, 0]}
    widget._reply({"method": "begin_interaction"})
    widget._reply({"method": "apply_edits", "params": {"edits": [edit]}, "scene": True})
    widget._reply({"method": "end_interaction"})
    computed.clear()
    session.get_scene()
    after = session._rest_lines["probe"]
    points = fieldlines.points_of(after["grid"])
    assert not np.allclose(after["grid"]["origin"], before["origin"])
    assert 0 < sum(computed) < len(points) / 2  # the strip it moved onto
    np.testing.assert_allclose(
        after["values"], field(fieldlines.sources_of(session.scene), points), atol=1e-15
    )


@pytest.mark.parametrize("sealed", [False, True])
def test_a_sensor_dragged_past_still_magnets_keeps_their_field(monkeypatch, sealed):
    """The field of magnets that stand still is the field at rest, kept for
    a drag of the sensor and after it, on a grid fixed in the world: its
    lines are traced from where the pixels are now, until the drag takes
    them off the grid's plane, or a magnet moves. A sealed collection's
    parts, which have no ids of their own, stand still with it."""
    widget = view(sealed=sealed)
    computed = []
    field = fieldlines.field
    monkeypatch.setattr(
        fieldlines, "field", lambda *a, **k: computed.append(1) or field(*a, **k)
    )

    def step(position):
        edit = {"objectId": "probe", "position": position}
        answer, _, _ = widget._reply(
            {"method": "apply_edits", "params": {"edits": [edit]}, "scene": True}
        )
        (item,) = answer["result"]["scene"]["fieldlines"]
        return item

    widget._reply({"method": "begin_interaction"})
    computed.clear()
    first = step([0.001, 0, 0])
    later = step([0.002, 0, 0])
    assert later["origin"] == first["origin"] and later["seeds"] != first["seeds"]
    widget._reply({"method": "end_interaction"})
    widget._session.get_scene()
    assert not computed  # the field at rest, from the drag's start to after it
    widget._reply({"method": "begin_interaction"})
    step([0.002, 0.001, 0])  # off the plane the grid lies in
    assert computed
    widget._reply({"method": "end_interaction"})
    widget._session.get_scene()
    computed.clear()
    edit = {"objectId": "cube", "position": [0, 0, 0.001]}
    widget._reply({"method": "apply_edits", "params": {"edits": [edit]}})
    widget._session.get_scene()
    assert computed  # a magnet moved


def test_a_variable_only_a_sensor_follows_keeps_the_field(monkeypatch):
    """The field of the sources is kept across a change of a variable that
    only a sensor follows -- its pixels' density -- and computed again for
    one a source follows."""
    from typing import Annotated

    from magpylib_studio import Count, Length, grid, scene

    @scene
    def lines(
        density: Annotated[int, Count(3, 9)] = 5,
        height: Annotated[float, Length(0.006, 0.02)] = 0.01,
    ):
        cube = magpy.magnet.Cuboid(
            polarization=(0, 0, 1), dimension=(0.01, 0.01, height), style_label="cube"
        )
        probe = magpy.Sensor(pixel=grid(0.02, density, plane="xz"), style_label="probe")
        probe.style.pixel.field.source = "B"
        return cube, probe

    session = SceneWidget(lines.build(), field_lines=True)._session
    computed = []
    field = fieldlines.field
    monkeypatch.setattr(
        fieldlines, "field", lambda *a, **k: computed.append(1) or field(*a, **k)
    )
    assert session.set_variable("density", 7)["ok"]
    (item,) = session.get_scene()["fieldlines"]
    assert not computed and len(item["seeds"]) > 0
    assert session.set_variable("height", 0.012)["ok"]
    session.get_scene()
    assert computed  # the cube changed


@pytest.mark.parametrize("density", [11, 12, 13])
def test_a_square_of_pixels_is_drawn_on_a_grid_along_the_world(density):
    """A square grid of pixels gives its plane, not a direction across it:
    the grid is laid along the world's axes, not turned by chance -- turned
    45°, it put points on a meshed core's cell edges."""
    from magpylib_studio import grid

    seeds = np.asarray(grid(0.07, density, plane="xz")) + np.array([0, 0, 0.0325])
    axes, planar = fieldlines.frame_of(seeds)
    assert planar
    np.testing.assert_allclose(np.abs(axes[:2]), [[1, 0, 0], [0, 0, 1]], atol=1e-12)


def test_a_point_on_a_cells_edge_reads_no_nan():
    """Within rounding of a cuboid's edge magpylib says NaN, where on it it
    says zero: the field lines' field says zero there too, and one point no
    longer makes the whole grid's scale NaN, and every line go."""
    cell = magpy.magnet.Cuboid(
        polarization=(0.25, 0, 0),
        dimension=(0.004545454545454546, 0.005, 0.005),
        position=(0.0022727272727272665, -0.0024999999999999996, -0.0075),
    )
    point = [[1.4414090374556621e-18, 0.0, -0.008453260901015891]]
    assert np.isfinite(fieldlines.field([cell], point)).all()
