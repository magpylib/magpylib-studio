"""Field lines through a sensor's pixels (#45): where they are drawn, in what
colours, and that the switch is the document's."""

from __future__ import annotations

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio import rpc
from magpylib_studio.widget import SceneWidget

PIXELS = np.linspace(-0.02, 0.02, 5)


def view(plane="y=0", source="B", colormap=None, tilt=0):
    """A cube polarized along z and a sensor of 5 x 5 pixels: in y = 0, a
    plane of the cube's symmetry -- or tilted out of it by `tilt` degrees --
    or 12 mm above it, which the field crosses."""
    cube = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01))
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
