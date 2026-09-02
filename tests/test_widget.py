"""Tests for the 3D view drawn in a notebook cell.

The view itself is JavaScript and is checked where the panel's is, by
`vscode-extension/harness/check-widget.js`. What is testable from here is the
half that is python: the payload the widget is built from, the identity that
turns a click back into a magpylib object, and the frames it serves.
"""

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio import threejs

widget = pytest.importorskip("magpylib_studio.widget")

needs_scene_graph = pytest.mark.skipif(
    not threejs.available(),
    reason="the installed magpylib has no display-backend API",
)


@pytest.fixture
def scene_objects():
    """A magnet and a sensor, which is enough to have two of everything."""
    magnet = magpy.magnet.Cuboid(
        polarization=(0, 0, 1), dimension=(1, 1, 1), style_label="M1"
    )
    sensor = magpy.Sensor(position=(0, 0, 2), style_label="S1")
    return magnet, sensor


@pytest.fixture
def swept():
    """A sensor on a path, so there is a run to play."""
    magnet = magpy.magnet.Cylinder(polarization=(1, 0, 0), dimension=(2, 1))
    sensor = magpy.Sensor(position=np.linspace((-3, 0, 1), (3, 0, 1), 12))
    return magnet, sensor


@needs_scene_graph
def test_the_backend_draws_a_widget(scene_objects):
    """`backend="widget"` is registered by installing the package."""
    drawn = magpy.show(*scene_objects, backend="widget", return_fig=True)
    assert isinstance(drawn, widget.SceneWidget)
    assert len(drawn.payload["meshes"]) == 2


@needs_scene_graph
def test_nothing_is_displayed_where_there_is_no_notebook(scene_objects):
    """A script drawing with this backend gets no output and no error."""
    assert magpy.show(*scene_objects, backend="widget") is None


@needs_scene_graph
def test_height_is_said_the_way_every_other_backend_option_is(scene_objects):
    assert (
        magpy.show(*scene_objects, backend="widget", height=600, return_fig=True).height
        == 600
    )


@needs_scene_graph
def test_a_click_resolves_to_the_object_that_was_clicked(scene_objects):
    """The payload keys traces by `id(obj)`; `identify` makes that an identity."""
    magnet, sensor = scene_objects
    view = widget.view(magnet, sensor)
    assert set(view.labels.values()) == {"M1", "S1"}

    view.selected = [str(id(sensor))]
    assert view.picked == [sensor]
    # In the order they were clicked, which is what the view reports.
    view.selected = [str(id(sensor)), str(id(magnet))]
    assert view.picked == [sensor, magnet]


@needs_scene_graph
def test_a_collections_children_are_what_a_click_lands_on():
    """A collection is drawn as its children, and they carry the trace ids."""
    child = magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=1)
    view = widget.view(magpy.Collection(child, style_label="pack"))
    assert view.picked == []
    view.selected = [str(id(child))]
    assert view.picked == [child]


@needs_scene_graph
def test_ids_alone_are_left_alone_when_nobody_said_what_they_are(scene_objects):
    """`magpy.show` has no objects to hand over, so a click stays an id."""
    drawn = magpy.show(*scene_objects, backend="widget", return_fig=True)
    drawn.selected = [str(id(scene_objects[0]))]
    assert drawn.labels == {}
    assert drawn.picked == []


@needs_scene_graph
def test_a_static_scene_keeps_no_run(scene_objects):
    """One frame is not a run: nothing to hold, and nothing to play."""
    view = widget.view(*scene_objects)
    assert view.frames == 1
    assert view._scene is None


@needs_scene_graph
def test_a_view_is_re_pointed_rather_than_remade(scene_objects, swept):
    """What keeps a slider smooth: the element, and the camera, stay put."""
    view = widget.SceneWidget()
    assert view.payload == {}

    view.update(*scene_objects)
    assert len(view.payload["meshes"]) == 2
    assert view.picked == []
    view.selected = [str(id(scene_objects[0]))]
    assert view.picked == [scene_objects[0]]

    # A run arrives and is kept; a scene without one lets it go again.
    view.update(*swept, animation=True)
    assert view.frames > 1
    assert view._scene is not None
    view.update(*scene_objects)
    assert view.frames == 1
    assert view._scene is None


@needs_scene_graph
def test_a_selection_does_not_survive_the_objects_it_named(scene_objects):
    """Ids are addresses: kept, they name nothing -- or someone else."""
    magnet, sensor = scene_objects
    view = widget.view(magnet, sensor)
    view.selected = [str(id(magnet)), str(id(sensor))]

    view.update(magnet)  # the sensor is no longer in the scene
    assert view.selected == [str(id(magnet))]
    assert view.picked == [magnet]

    view.update(magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=1))
    assert view.selected == []


@needs_scene_graph
def test_updating_a_view_is_not_itself_a_view(scene_objects):
    """A cell's value is its last expression, and this is the last line of one.

    Returning the widget would draw a second live view of the same scene under
    the one being updated, with a second WebGL context — which is what the
    demo notebook did until it was counted.
    """
    assert widget.SceneWidget().update(*scene_objects) is None


@needs_scene_graph
def test_frames_are_served_one_at_a_time(swept):
    """The whole run is megabytes; the payload carries one frame of it."""
    view = widget.view(*swept, animation=True)
    assert view.frames > 1
    assert view.payload["ranges"] is not None  # the envelope, once

    sent = []
    view.send = lambda content, buffers=None: sent.append(content)

    view._on_message(view, {"kind": "frame", "index": 3}, None)
    assert sent[-1]["kind"] == "frame"
    assert sent[-1]["frame"] == 3
    assert sent[-1]["meshes"]
    # A frame carries only what changes; the axes are already drawn.
    assert "ranges" not in sent[-1]

    view._on_message(view, {"kind": "frame", "index": 10**6}, None)
    assert sent[-1]["frame"] == view.frames - 1

    view._on_message(view, {"kind": "something-else"}, None)
    view._on_message(view, "not a message at all", None)
    assert len(sent) == 2


@needs_scene_graph
def test_one_frame_is_drawn_rather_than_all_of_them(swept):
    """Every frame at once is right for a static scene and a smear for a run."""
    scene = threejs._capture(swept, animation=True)
    everything = threejs.view_payload(scene)
    one = threejs.view_payload(scene, index=0)
    assert len(everything["meshes"]) > len(one["meshes"])
    assert len(one["meshes"]) == len(threejs.view_frame_payload(scene, 0)["meshes"])


def test_the_view_is_shipped_with_the_package():
    """A wheel that lost `static/` draws an empty cell and says nothing.

    The files themselves rather than the traitlets: anywidget turns a path
    into its contents at class definition, so by the time there is a
    `SceneWidget` at all a missing one has already been read.
    """
    bundle = widget.STATIC / "widget.js"
    assert (widget.STATIC / "widget.css").exists()
    assert bundle.exists()
    # Built from what is in the tree -- which `harness/check-widget.js` is the
    # check for; this only asks that the stamp it looks for is there at all.
    assert "sources-sha256:" in bundle.read_text()[:500]
