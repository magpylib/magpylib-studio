"""Tests for the 3D view drawn in a notebook cell.

The view itself is JavaScript and is checked where the panel's is, by
`vscode-extension/harness/check-widget.js`. What is testable from here is the
half that is python: the payload the widget is built from, the identity that
turns a click back into a magpylib object, and the frames it serves.
"""

import base64
import dataclasses
import gzip
import io
import json
import re
import tempfile

import magpylib as magpy
import numpy as np
import pytest
import traitlets

from magpylib_studio import backend, threejs

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
    """A sensor on a path past a turning magnet: a run that only moves."""
    magnet = magpy.magnet.Cylinder(polarization=(1, 0, 0), dimension=(2, 1))
    magnet.rotate_from_angax(np.linspace(0, 90, 8), "z", start=0)
    sensor = magpy.Sensor(position=np.linspace((-3, 0, 1), (3, 0, 1), 12))
    return magnet, sensor


@pytest.fixture
def served(monkeypatch):
    """Nothing carried with the view: every changing run served a frame at a
    time, as one past `_CARRY_LIMIT` is."""
    monkeypatch.setattr(threejs, "_CARRY_LIMIT", 0)


@pytest.fixture
def morphing():
    """A magnet that grows along its path: a run no motion can play."""
    magnet = magpy.magnet.Cuboid(
        polarization=(0, 0, 1), dimension=np.linspace((1, 1, 1), (2, 2, 2), 10)
    )
    return (magnet,)


@needs_scene_graph
def test_the_backend_draws_a_widget(scene_objects):
    """`backend="widget"` is registered by installing the package."""
    drawn = magpy.show(*scene_objects, backend="widget", return_fig=True)
    assert isinstance(drawn, widget.SceneWidget)
    assert len(drawn.payload["meshes"]) == 2


@needs_scene_graph
def test_a_script_gets_the_view_in_a_page_of_its_own(
    scene_objects, tmp_path, monkeypatch, capsys
):
    """No notebook to draw in: the widget is saved as a page, opened in the
    browser -- not under a test runner -- and the script is told where."""
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    opened = []
    # says whether a browser took it, as webbrowser.open does
    monkeypatch.setattr(
        backend.webbrowser, "open", lambda url: opened.append(url) or True
    )
    assert magpy.show(*scene_objects, backend="widget") is None
    # in the temp directory itself, as Plotly's pages are
    (page,) = tmp_path.glob("magpylib-scene-*.html")
    assert "magpy-widget" in page.read_text(encoding="utf-8")
    assert str(page) in capsys.readouterr().err
    assert opened == []  # a test suite opens no tabs

    monkeypatch.setattr(backend, "_under_a_test_runner", lambda: False)
    magpy.show(*scene_objects, backend="widget")
    assert len(opened) == 1
    assert opened[0].startswith("file://")
    assert "opened in your browser" in capsys.readouterr().err


@needs_scene_graph
def test_a_script_in_a_studio_terminal_gets_the_view_in_the_panel(
    scene_objects, tmp_path, monkeypatch, capsys
):
    """Run from a studio window's terminal, the widget goes to the panel,
    which draws the same widget."""
    monkeypatch.setenv("MAGPYLIB_STUDIO_DROP", str(tmp_path))
    # Even in a process the window's setting did claim: this script asked
    # for the widget by name, which is no claim of the window's.
    monkeypatch.setattr(backend, "CLAIMED", True)
    magpy.show(*scene_objects, backend="widget")
    (written,) = list((tmp_path / "views").iterdir())
    figure = json.loads(written.read_text(encoding="utf-8"))
    assert figure["kind"] == "widget"
    assert figure["body"]["state"]["payload"]["meshes"]
    assert figure["claimed"] is False
    assert "panel" in capsys.readouterr().err


def test_a_terminal_ipython_is_no_notebook(monkeypatch):
    """`ipython script.py` has a shell but no cell to draw in: the widget is
    not handed to it, which would only print its name, and the script's way
    of showing it is taken instead."""
    getipython = pytest.importorskip("IPython.core.getipython")
    shown = []
    monkeypatch.setattr("IPython.display.display", shown.append)
    # what is shown is only handed on, so any object will do -- and one that
    # is not a real widget needs no display-backend API from magpylib
    view = object()

    class TerminalInteractiveShell:
        pass

    class ZMQInteractiveShell:
        pass

    monkeypatch.setattr(getipython, "get_ipython", TerminalInteractiveShell)
    assert widget.display(view) is False
    monkeypatch.setattr(getipython, "get_ipython", ZMQInteractiveShell)
    assert widget.display(view) is True
    assert shown == [view]


@needs_scene_graph
def test_a_run_too_big_to_hand_over_whole_is_shown_still(
    morphing, served, tmp_path, monkeypatch
):
    """With nothing behind the view to serve it a frame at a time -- the
    studio's panel, the page a script opens -- a run past `WHOLE_RUN_LIMIT`
    is its first step, still, and says so. A page saved by name has all of
    it: whoever asked for the file asked for its size."""
    monkeypatch.setattr(threejs, "WHOLE_RUN_LIMIT", 0)
    scene = threejs._capture(morphing, animation=True)
    with pytest.warns(UserWarning, match="first step"):
        body = threejs.widget_state(scene)
    assert body["run"] == []
    assert body["state"]["frames"] == 1

    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    with pytest.warns(UserWarning, match="first step"):
        magpy.show(*morphing, backend="widget", animation=True)
    (page,) = tmp_path.glob("magpylib-scene-*.html")
    saved = json.loads(_unpacked(page.read_text(encoding="utf-8"), "magpy-scene"))
    assert saved["run"] == []
    assert saved["state"]["frames"] == 1

    view = widget.SceneWidget(*morphing, animation=True)
    saved = json.loads(_unpacked(view.to_html(), "magpy-scene"))
    assert len(saved["run"]) == view.frames == 10


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
    view = widget.SceneWidget(magnet, sensor)
    assert [node["label"] for node in view.tree] == ["M1", "S1"]

    view.selected = [str(id(sensor))]
    assert view.picked == [sensor]
    # In the order they were clicked, which is what the view reports.
    view.selected = [str(id(sensor)), str(id(magnet))]
    assert view.picked == [sensor, magnet]


@needs_scene_graph
def test_a_collections_children_are_what_a_click_lands_on():
    """A collection is drawn as its children, and they carry the trace ids."""
    child = magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=1)
    view = widget.SceneWidget(magpy.Collection(child, style_label="pack"))
    assert view.picked == []
    view.selected = [str(id(child))]
    assert view.picked == [child]


def _hands_over_objects():
    """Whether this magpylib gives a backend the objects (`Panel.objects`)."""
    try:
        from magpylib.graphics.backend import Panel
    except ImportError:
        return False
    return "objects" in {f.name for f in dataclasses.fields(Panel)}


@needs_scene_graph
@pytest.mark.skipif(
    _hands_over_objects(), reason="this magpylib hands its backends the objects"
)
def test_ids_alone_are_left_alone_when_nobody_said_what_they_are(scene_objects):
    """`magpy.show` has no objects to hand over, so a click stays an id."""
    drawn = magpy.show(*scene_objects, backend="widget", return_fig=True)
    drawn.selected = [str(id(scene_objects[0]))]
    assert drawn.tree == []
    assert drawn.picked == []


@needs_scene_graph
@pytest.mark.skipif(
    not _hands_over_objects(), reason="this magpylib hands its backends no objects"
)
def test_a_bare_show_is_named_by_the_objects_magpylib_hands_over(nested):
    """With `Panel.objects`, the backend's view has the legend and `picked`."""
    outer, _, deep = nested
    probe = magpy.Sensor(style_label="probe")
    drawn = magpy.show(outer, probe, backend="widget", return_fig=True)
    assert _outline(drawn.tree) == [
        ("outer", [("inner", [("deep", [])]), ("ball", [])]),
        ("probe", []),
    ]
    drawn.selected = [str(id(deep))]
    assert drawn.picked == [deep]


@needs_scene_graph
def test_a_static_scene_keeps_no_run(scene_objects):
    """One frame is not a run: nothing to hold, and nothing to play."""
    view = widget.SceneWidget(*scene_objects)
    assert view.frames == 1
    assert view._scene is None


@needs_scene_graph
def test_a_view_is_re_pointed_rather_than_remade(scene_objects, morphing, served):
    """What keeps a slider smooth: the element, and the camera, stay put."""
    view = widget.SceneWidget()
    assert view.payload == {}

    view.update(*scene_objects)
    assert len(view.payload["meshes"]) == 2
    assert view.picked == []
    view.selected = [str(id(scene_objects[0]))]
    assert view.picked == [scene_objects[0]]

    # A run arrives and is kept; a scene without one lets it go again.
    view.update(*morphing, animation=True)
    assert view.frames > 1
    assert view._scene is not None
    view.update(*scene_objects)
    assert view.frames == 1
    assert view._scene is None


@needs_scene_graph
def test_a_keyword_is_the_widgets_if_it_names_a_trait(scene_objects, monkeypatch):
    """One call for both: how to draw, for magpylib, and how to show it."""
    given = {}
    capture = threejs._capture

    def spy(objects, animation=False, **kwargs):
        given.update(kwargs)
        return capture(objects, animation=animation, **kwargs)

    monkeypatch.setattr(threejs, "_capture", spy)
    view = widget.SceneWidget(
        *scene_objects, height=600, theme="dark", axes=False, zoom=2
    )
    assert (view.height, view.theme, view.axes) == (600, "dark", False)
    assert given == {"zoom": 2}

    given.clear()
    view.update(*scene_objects, height=300)
    assert view.height == 300
    assert given == {}


@needs_scene_graph
def test_a_trait_given_to_the_constructor_outlives_the_scene(swept):
    """Drawing a run sets its pace from magpylib; a `repeat` given is kept."""
    view = widget.SceneWidget(*swept, animation=True, repeat=True, duration=2.5)
    assert view.frames > 1
    assert (view.repeat, view.duration) == (True, 2.5)


@needs_scene_graph
def test_the_capture_is_no_backend_to_choose(scene_objects):
    """Studio's internal capture stays out of magpylib's registry, and what
    magpylib warns about during one is said in the widget's name."""
    from magpylib.graphics.backend import DisplayBackend

    assert threejs._BACKEND not in DisplayBackend.backends
    with pytest.warns(UserWarning) as caught:
        widget.SceneWidget(*scene_objects, typo=1)
    said = " ".join(str(w.message) for w in caught)
    assert "typo" in said
    assert "'widget'" in said or "widget backend" in said
    assert threejs._BACKEND not in said
    assert threejs._BACKEND not in DisplayBackend.backends


@needs_scene_graph
def test_a_missing_extra_is_named(scene_objects, monkeypatch):
    """The name is advertised by installing the package; anywidget is not."""
    import sys

    monkeypatch.setitem(sys.modules, "anywidget", None)
    monkeypatch.delitem(sys.modules, "magpylib_studio.widget")
    with pytest.raises(ModuleNotFoundError, match=r"magpylib-studio\[widget\]"):
        magpy.show(*scene_objects, backend="widget", return_fig=True)


def test_options_for_magpylib_need_something_to_draw():
    """Dropped quietly, they would seem ignored once the objects came."""
    assert widget.SceneWidget(theme="dark").payload == {}
    with pytest.raises(TypeError, match="zoom"):
        widget.SceneWidget(zoom=2)


@needs_scene_graph
def test_a_selection_goes_with_the_objects_it_named(scene_objects):
    """An object passed again keeps its place; one gone takes its entry."""
    magnet, sensor = scene_objects
    view = widget.SceneWidget(magnet, sensor)
    view.selected = [str(id(magnet)), str(id(sensor))]

    view.update(magnet)  # the sensor is no longer in the scene
    assert view.selected == [str(id(magnet))]
    assert view.picked == [magnet]


@needs_scene_graph
def test_a_rebuild_keeps_what_was_chosen_where_it_was(nested):
    """A slider rebuilds the objects; "the lower ring" is still the one below."""

    def build():
        rings = [
            magpy.Collection(
                *(
                    magpy.magnet.Cuboid(
                        polarization=(0, 0, 1),
                        dimension=(1, 1, 1),
                        position=(i, 0, z),
                        style_label=f"{name} {i}",
                    )
                    for i in range(3)
                ),
                style_label=f"{name} ring",
            )
            for name, z in (("upper", 1), ("lower", -1))
        ]
        return magpy.Collection(*rings, style_label="stack")

    view = widget.SceneWidget()
    stack = build()
    view.update(stack)
    lower = stack.children[1]
    view.hidden = [str(id(child)) for child in lower.children]
    view.selected = [str(id(stack.children[0].children[2]))]

    rebuilt = build()
    view.update(rebuilt)
    assert view.hidden == [str(id(child)) for child in rebuilt.children[1].children]
    assert [obj.style.label for obj in view.picked] == ["upper 2"]
    assert view.picked[0] is rebuilt.children[0].children[2]


@needs_scene_graph
def test_an_object_passed_again_keeps_its_selection_wherever_it_moved(
    scene_objects,
):
    """The same object is followed, not the place it used to be."""
    magnet, sensor = scene_objects
    view = widget.SceneWidget(magnet, sensor)
    view.selected = [str(id(magnet))]
    view.update(sensor, magnet)  # swapped round
    assert view.picked == [magnet]


@pytest.fixture
def nested():
    """Three levels, which is two more than the payload can say."""
    deep = magpy.magnet.Cuboid(
        polarization=(0, 0, 1), dimension=(1, 1, 1), style_label="deep"
    )
    inner = magpy.Collection(deep, style_label="inner")
    ball = magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=1, style_label="ball")
    outer = magpy.Collection(inner, ball, style_label="outer")
    return outer, inner, deep


def _outline(nodes):
    """A tree as nested ``(label, [children])``, for comparing."""
    return [(node["label"], _outline(node["children"])) for node in nodes]


def _walk(nodes):
    """Every node of a tree."""
    for node in nodes:
        yield node
        yield from _walk(node["children"])


@needs_scene_graph
def test_the_legend_keeps_the_nesting_the_payload_cannot(nested):
    """Every trace under a Collection carries the outermost one's legendgroup,
    so the tree has to come from the objects -- and it does."""
    outer, _, _ = nested
    view = widget.SceneWidget(outer, magpy.Sensor(style_label="probe"))
    assert _outline(view.tree) == [
        ("outer", [("inner", [("deep", [])]), ("ball", [])]),
        ("probe", []),
    ]
    assert view.tree[0]["kind"] == "Collection"
    # Every object the view draws is one the tree names.
    drawn = {item["object_id"] for item in view.payload["meshes"]}
    named = {node["id"] for node in _walk(view.tree)}
    assert drawn <= named


@needs_scene_graph
def test_an_object_passed_twice_is_listed_once_where_it_sits(nested):
    """Passing a collection and something inside it names the thing once."""
    outer, _, deep = nested
    view = widget.SceneWidget(deep, outer)  # the inner one first, to be sure
    assert _outline(view.tree) == [("outer", [("inner", [("deep", [])]), ("ball", [])])]


@needs_scene_graph
def test_hiding_is_a_value_like_selecting(scene_objects):
    """Kept by id, resolved by the view, and dropped with its objects."""
    magnet, sensor = scene_objects
    view = widget.SceneWidget(magnet, sensor)
    view.hidden = [str(id(sensor))]

    view.update(magnet, sensor)
    assert view.hidden == [str(id(sensor))]
    view.update(magnet)  # nothing where the sensor was
    assert view.hidden == []


@needs_scene_graph
def test_a_scene_and_its_tree_arrive_together(scene_objects, monkeypatch):
    """Sent apart, the browser draws the new scene against the old tree."""
    view = widget.SceneWidget()
    sent = []

    def record(key=None):
        # A copy: `hold_sync` sends its set of keys and then clears it in
        # place. `None` is ipywidgets for every key, and is kept as that.
        sent.append(None if key is None else set(key))

    monkeypatch.setattr(view, "send_state", record)
    view.update(*scene_objects)
    assert len(sent) == 1
    assert {"payload", "tree"} <= sent[0]


@needs_scene_graph
def test_updating_a_view_is_not_itself_a_view(scene_objects):
    """A cell's value is its last expression, and this is the last line of one.

    Returning the widget would draw a second live view of the same scene under
    the one being updated, with a second WebGL context — which is what the
    demo notebook did until it was counted.
    """
    assert widget.SceneWidget().update(*scene_objects) is None


@needs_scene_graph
def test_frames_are_served_one_at_a_time(morphing, served):
    """The whole run is megabytes; the payload carries one frame of it."""
    view = widget.SceneWidget(*morphing, animation=True)
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
def test_a_capture_keeps_nothing_behind(scene_objects):
    """Read and let go: a module-level scene would keep its objects alive."""
    scene = threejs._capture(scene_objects)
    assert scene.frames
    assert threejs._captured == {}


@needs_scene_graph
def test_one_frame_is_drawn_rather_than_all_of_them(swept):
    """Every frame at once is right for a static scene and a smear for a run."""
    scene = threejs._capture(swept, animation=True)
    everything = threejs.view_payload(scene)
    one = threejs.view_payload(scene, index=0)
    assert len(everything["meshes"]) > len(one["meshes"])
    assert len(one["meshes"]) == len(threejs.frame_payload(scene, 0)["meshes"])


def _positions(item):
    """A payload item's vertices, as rows -- NaN where a line lifts its pen."""
    flat = np.array([np.nan if v is None else v for v in item["position"]])
    return flat.reshape(-1, 3)


def _posed(points, pose):
    """`points` moved by one step of a track: position, then quaternion."""
    x, y, z, qx, qy, qz, qw = pose
    u = np.array([qx, qy, qz])
    # v' = v + 2w(u x v) + 2u x (u x v), for a unit quaternion (u, w)
    turned = np.cross(u, points)
    return points + 2 * qw * turned + 2 * np.cross(u, turned) + [x, y, z]


def _replays(scene, played):
    """Assert that `played` -- poses and carried changes -- draws every frame
    of `scene` as magpylib drew it."""
    items = played["meshes"] + played["scatters"]
    for index in range(len(scene.frames)):
        frame = threejs.frame_payload(scene, index)
        for first, then in zip(items, frame["meshes"] + frame["scatters"], strict=True):
            if "changes" in first:
                shown = _positions(played["changes"][first["changes"]][index])
            elif "track" in first:
                shown = _posed(
                    _positions(first), played["tracks"][first["track"]][index]
                )
            else:
                shown = _positions(first)
            np.testing.assert_allclose(shown, _positions(then), atol=1e-6)


@needs_scene_graph
def test_a_run_that_only_moves_travels_as_its_motion(swept):
    """Each frame is the first one moved: sent as poses, it is the same run."""
    scene = threejs._capture(swept, animation=True)
    played = threejs.played_payload(scene)
    assert played is not None
    assert played["tracks"]
    assert "changes" not in played
    assert {"track"} <= set().union(*played["meshes"], *played["scatters"])
    _replays(scene, played)


@needs_scene_graph
def test_things_that_move_together_share_a_track():
    """Eight magnets turned as one ring are one motion, not eight."""
    ring = magpy.Collection(
        *[
            magpy.magnet.Cuboid(
                polarization=(0, 0, 1), dimension=(1, 1, 1), position=(3, 0, 0)
            ).rotate_from_angax(angle, "z", anchor=0)
            for angle in range(0, 360, 45)
        ]
    )
    ring.rotate_from_angax(np.linspace(0, 360, 40), "z", anchor=0, start=0)
    played = threejs.played_payload(threejs._capture((ring,), animation=True))
    assert len(played["tracks"]) == 1
    assert [item["track"] for item in played["meshes"]] == [0] * 8


@needs_scene_graph
def test_a_run_that_changes_shape_carries_the_change(morphing):
    """A cube that grows is not a cube that moves, however it is fitted: its
    trace is carried as it is at every step, and the run still plays."""
    scene = threejs._capture(morphing, animation=True)
    played = threejs.played_payload(scene)
    assert played["tracks"] == []
    assert len(played["changes"]) == 1
    assert len(played["changes"][0]) == len(scene.frames)
    _replays(scene, played)


@needs_scene_graph
def test_changes_past_the_limit_are_served_instead(morphing, served):
    """Past `_CARRY_LIMIT` the run is served a frame at a time, as before."""
    assert threejs.played_payload(threejs._capture(morphing, animation=True)) is None
    view = widget.SceneWidget(*morphing, animation=True)
    assert view._scene is not None


@needs_scene_graph
def test_only_what_changes_is_carried():
    """Pixels coloured by the field they sit in change as the sensor passes;
    the magnets turning past it only move. Carried as frames, the ring would
    be most of the run: posed, only the probe's pixels are."""
    ring = magpy.Collection(
        *[
            magpy.magnet.Cuboid(
                polarization=(0, 0, 1), dimension=(1, 1, 1), position=(3, 0, 0)
            ).rotate_from_angax(angle, "z", anchor=0)
            for angle in range(0, 360, 45)
        ]
    )
    ring.rotate_from_angax(np.linspace(0, 90, 12), "z", anchor=0, start=0)
    sensor = magpy.Sensor(
        pixel=np.linspace((-1, 0, 0), (1, 0, 0), 5),
        position=np.linspace((-3, 0, 1), (3, 0, 1), 12),
    )
    sensor.style.pixel.field.source = "B"
    scene = threejs._capture((ring, sensor), animation=True)
    played = threejs.played_payload(scene)
    assert played["changes"]
    changing = [
        item for item in played["meshes"] + played["scatters"] if "changes" in item
    ]
    assert {item["object_id"] for item in changing} == {str(id(sensor))}
    assert sum("track" in item for item in played["meshes"]) == 8
    _replays(scene, played)


@needs_scene_graph
def test_a_moving_collection_does_not_stop_the_studio_drawing():
    """magpylib's `Collection.centroid` raises when the members move along a
    path; the studio's Edit view is still drawn, handles at its position."""
    ring = magpy.Collection(
        magpy.magnet.Cuboid(
            polarization=(0, 0, 1), dimension=(1, 1, 1), position=(3, 0, 0)
        ),
        style_label="ring",
    )
    ring.rotate_from_angax(np.linspace(0, 90, 5), "z", anchor=0, start=0)
    payload = threejs.scene_payload([ring], live={"ring": ring})
    assert payload["meshes"]
    assert payload["centroids"]["ring"] == payload["anchors"]["ring"]


@needs_scene_graph
def test_a_colour_table_is_carried_once():
    """Eight magnets coloured by their polarization share one colour table,
    named by index -- not copied into each, in each frame."""
    ring = magpy.Collection(
        *[
            magpy.magnet.Cuboid(
                polarization=(0, 0, 1), dimension=(1, 1, 1), position=(3, 0, 0)
            ).rotate_from_angax(angle, "z", anchor=0)
            for angle in range(0, 360, 45)
        ]
    )
    payload = widget.SceneWidget(ring).payload
    assert len(payload["luts"]) == 1
    assert [mesh["lut"] for mesh in payload["meshes"]] == [0] * 8


@needs_scene_graph
def test_a_run_in_which_nothing_moves_is_motion_of_nothing():
    """A current that ramps changes nothing drawn: no tracks, nothing kept to
    serve -- and the view steps through it with nothing to ask for."""
    coil = magpy.current.Circle(current=np.linspace(1, 2, 5), diameter=2)
    view = widget.SceneWidget(coil, animation=True)
    assert view.frames == 5
    assert view.payload["tracks"] == []
    assert view._scene is None


@needs_scene_graph
def test_a_small_change_far_from_the_origin_is_not_motion():
    """The fit is held to each trace's own size, not to how far out it is: a
    millimetre magnet a kilometre away may move, but not grow."""
    far = (1000, 0, 0)
    grows = magpy.magnet.Cuboid(
        polarization=(0, 0, 1),
        dimension=np.linspace((1e-3,) * 3, (1.01e-3,) * 3, 10),
        position=far,
    )
    moves = magpy.magnet.Cuboid(
        polarization=(0, 0, 1),
        dimension=(1e-3,) * 3,
        position=np.linspace(far, (1000, 0, 0.01), 10),
    )
    _, track_of, changing = threejs.run_motion(
        threejs._capture((grows,), animation=True)
    )
    assert changing == [0]  # carried as it is, not posed
    _, track_of, changing = threejs.run_motion(
        threejs._capture((moves,), animation=True)
    )
    assert changing == []
    assert track_of[0] is not None


@needs_scene_graph
def test_a_frame_says_which_run_it_was_asked_for(morphing, served):
    """The view drops a frame of a run it has been re-pointed away from."""
    view = widget.SceneWidget(*morphing, animation=True)
    sent = []
    view.send = lambda content, buffers=None: sent.append(content)
    view._on_message(view, {"kind": "frame", "index": 2, "runId": 7}, None)
    assert sent[-1]["runId"] == 7


@needs_scene_graph
def test_a_view_plays_a_moving_run_itself(swept):
    """Nothing kept to serve, and a saved page carries poses, not frames."""
    view = widget.SceneWidget(*swept, animation=True)
    assert view.frames > 1
    assert view.payload["tracks"]
    assert view._scene is None
    saved = view._saved()
    assert saved["run"] == []
    assert saved["state"]["payload"]["tracks"] == view.payload["tracks"]


def _unpacked(page, name):
    """What a saved page carries under `name`: gzipped, then base64."""
    found = re.search(rf'id="{name}">([^<]*)<', page)
    assert found, f"the page carries no {name}"
    return gzip.decompress(base64.b64decode(found.group(1))).decode("utf-8")


@needs_scene_graph
def test_a_view_saves_as_one_file_that_needs_nothing_else(scene_objects, tmp_path):
    """The widget and its scene, with nothing to fetch and no kernel to ask."""
    magnet, sensor = scene_objects
    view = widget.SceneWidget(magnet, sensor)
    view.hidden = [str(id(sensor))]
    view.axes = False
    view.theme = "dark"
    path = tmp_path / "scene.html"
    assert view.write_html(path, title="two <objects>") is None  # as Plotly's
    page = path.read_text(encoding="utf-8")

    # The bundle is the one that ships, byte for byte.
    assert _unpacked(page, "magpy-widget") == (widget.STATIC / "widget.js").read_text()
    saved = json.loads(_unpacked(page, "magpy-scene"))
    assert saved["state"]["payload"] == view.payload
    assert saved["state"]["tree"] == view.tree
    assert saved["state"]["hidden"] == [str(id(sensor))]
    assert saved["state"]["axes"] is False  # on by default; put away here
    assert saved["state"]["theme"] == "dark"
    # A page with no python behind it offers no export of its own.
    assert saved["state"]["standalone"] is True
    assert saved["run"] == []
    assert "<title>two &lt;objects&gt;</title>" in page
    assert "$" not in page.split("<script", 1)[0]  # every placeholder filled


@needs_scene_graph
def test_a_view_writes_to_an_open_file_as_well(scene_objects):
    """A path or anything with `write`, as Plotly's `write_html` takes."""
    view = widget.SceneWidget(*scene_objects)
    out = io.StringIO()
    view.write_html(out)
    assert out.getvalue() == view.to_html()


@needs_scene_graph
def test_a_saved_run_plays_without_python(morphing, served):
    """Every frame travels with the file, so the page answers for them."""
    view = widget.SceneWidget(*morphing, animation=True)
    saved = json.loads(_unpacked(view.to_html(), "magpy-scene"))
    assert len(saved["run"]) == view.frames
    assert saved["run"][3] == threejs.frame_payload(view._scene, 3)


@needs_scene_graph
def test_the_export_button_is_answered_with_the_file(scene_objects):
    view = widget.SceneWidget(*scene_objects)
    sent = []
    view.send = lambda content, buffers=None: sent.append(content)
    view._on_message(view, {"kind": "export"}, None)
    assert sent[-1]["kind"] == "export"
    assert sent[-1]["filename"] == widget.EXPORT_NAME
    assert sent[-1]["html"] == view.to_html()


@needs_scene_graph
def test_a_saved_view_opens_where_the_view_was_looking(scene_objects):
    """As the view last said, and as the export button says it is now."""
    view = widget.SceneWidget(*scene_objects)
    saved = lambda: json.loads(_unpacked(view.to_html(), "magpy-scene"))  # noqa: E731
    assert saved()["state"]["camera"] is None  # never drawn: the page frames it

    orbited = {"projection": "perspective", "position": [4, -5, 3], "zoom": 1}
    view._on_message(view, {"kind": "camera", "camera": orbited}, None)
    assert saved()["state"]["camera"] == orbited

    sent = []
    view.send = lambda content, buffers=None: sent.append(content)
    now = {**orbited, "projection": "parallel"}
    view._on_message(view, {"kind": "export", "camera": now}, None)
    exported = json.loads(_unpacked(sent[-1]["html"], "magpy-scene"))
    assert exported["state"]["camera"] == now


def test_a_theme_is_one_of_three():
    """Auto unless chosen, and nothing a view could not wear."""
    view = widget.SceneWidget()
    assert view.theme == "auto"
    view.theme = "light"
    with pytest.raises(traitlets.TraitError):
        view.theme = "sepia"


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


# --- editing: SceneWidget(..., editable=True), over a session in the kernel -


def _studio(**traits):
    """A ring of three and a probe, edited; what the view says back is kept
    in `sent` rather than going to a comm."""
    ring = magpy.Collection(style_label="ring")
    for i in range(3):
        magnet = magpy.magnet.Cuboid(
            polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01), position=(0.03, 0, 0)
        )
        ring.add(magnet.rotate_from_angax(120 * i, "z", anchor=0))
    probe = magpy.Sensor(position=(0, 0, 0.02), style_label="probe")
    with pytest.warns(UserWarning, match="without a variable of their own"):
        studio = widget.SceneWidget(ring, probe, editable=True, **traits)
    studio.sent = []
    studio.send = lambda message, buffers=None: studio.sent.append(message)
    return studio


def _ask(studio, method, **params):
    """What the view sends when it calls the session, and the answer."""
    studio._on_message(
        studio,
        {"kind": "rpc", "id": len(studio.sent), "method": method, "params": params},
        [],
    )
    return studio.sent[-1]


@needs_scene_graph
def test_a_scene_to_edit_is_named_as_the_cell_names_it():
    """`edit` takes the objects under the caller's names, nests them as they
    are nested, and says once what it could not name."""
    studio = _studio()
    assert [(node["id"], node["kind"]) for node in studio.tree] == [
        ("ring", "Collection"),
        ("probe", "Sensor"),
    ]
    assert len(studio.tree[0]["children"]) == 3
    assert studio.editable
    assert isinstance(studio.objects["probe"], magpy.Sensor)
    assert "probe" in studio.to_script()


@needs_scene_graph
def test_a_drag_in_the_view_is_one_edit_and_one_word_to_the_notebook():
    """Poses go to the session as the drag goes, the notebook is told once
    when it ends, and one undo takes the whole of it back."""
    studio = _studio()
    revision = studio.revision
    assert _ask(studio, "begin_interaction")["result"]["ok"]
    for x in (0.01, 0.02, 0.03):
        edits = [{"objectId": "probe", "position": [x, 0, 0.02]}]
        assert _ask(studio, "apply_edits", edits=edits)["result"]["ok"]
        assert studio.revision == revision  # nothing re-runs mid-drag
    _ask(studio, "end_interaction")
    assert studio.revision == revision + 1
    assert studio.payload["anchors"]["probe"] == pytest.approx([0.03, 0, 0.02])
    assert "probe.position = (0.03, 0.0, 0.02)" in studio.to_script()

    assert _ask(studio, "undo")["result"]["ok"]
    assert np.ravel(studio.objects["probe"].position) == pytest.approx([0, 0, 0.02])
    assert studio.payload["anchors"]["probe"] == pytest.approx([0, 0, 0.02])
    studio.redo()
    assert np.ravel(studio.objects["probe"].position) == pytest.approx([0.03, 0, 0.02])


@needs_scene_graph
def test_undo_stops_at_the_scene_as_it_was_given():
    """Loading the objects is where editing starts, not an edit: undoing
    past the first drag -- or before one -- says there is nothing to undo,
    and the scene stays."""
    studio = _studio()
    before = sorted(studio.objects)
    answer = _ask(studio, "undo")["result"]
    assert answer == {"ok": False, "error": "nothing to undo"}
    assert sorted(studio.objects) == before
    assert studio.payload["meshes"]

    _ask(studio, "begin_interaction")
    _ask(
        studio,
        "apply_edits",
        edits=[{"objectId": "probe", "position": [0.01, 0, 0.02]}],
    )
    _ask(studio, "end_interaction")
    assert _ask(studio, "undo")["result"]["ok"]
    assert not _ask(studio, "undo")["result"]["ok"]
    assert sorted(studio.objects) == before


@needs_scene_graph
def test_a_resize_and_an_aim_in_the_view_are_edits_too():
    """R and P hand the session a size and a polarization, as the panel's do."""
    studio = _studio()
    magnet = next(key for key in studio.objects if key != "ring" and key != "probe")
    edits = [
        {
            "objectId": magnet,
            "shape": {"attr": "dimension", "value": [0.02, 0.01, 0.01]},
        },
        {"objectId": magnet, "polarization": [1, 0, 0]},
    ]
    assert _ask(studio, "apply_edits", edits=edits)["result"]["ok"]
    edited = studio.objects[magnet]
    assert edited.dimension == pytest.approx([0.02, 0.01, 0.01])
    assert edited.polarization == pytest.approx([1, 0, 0])


@needs_scene_graph
def test_the_notebook_edits_as_the_view_does():
    """`set` is one edit -- a pose and a parameter together, one step to
    undo -- told to the notebook like a drag's end; and a value already there
    is no edit, so a slider fed back from the view does not echo."""
    studio = _studio()
    magnet = next(key for key in studio.objects if key not in ("ring", "probe"))
    revision, steps = studio.revision, len(studio._session._undo)
    studio.set(magnet, position=(0.05, 0, 0), dimension=(0.02, 0.01, 0.01))
    assert studio.revision == revision + 1
    assert len(studio._session._undo) == steps + 1
    edited = studio.objects[magnet]
    assert np.ravel(edited.position) == pytest.approx([0.05, 0, 0])
    assert edited.dimension == pytest.approx([0.02, 0.01, 0.01])
    assert studio.payload["anchors"][magnet] == pytest.approx([0.05, 0, 0])

    studio.set(magnet, position=(0.05, 0, 0), dimension=(0.02, 0.01, 0.01))
    assert studio.revision == revision + 1  # the echo: nothing recorded
    studio.undo()
    assert np.ravel(studio.objects[magnet].position) != pytest.approx([0.05, 0, 0])

    with pytest.raises(TypeError, match="editable=True"):
        widget.SceneWidget(magpy.Sensor()).set("x", position=(0, 0, 0))


@needs_scene_graph
def test_the_view_may_not_run_files(tmp_path):
    """The view calls what a drag needs, and nothing that executes."""
    script = tmp_path / "touch.py"
    marker = tmp_path / "ran"
    script.write_text(f"open({str(marker)!r}, 'w').close()\n")
    studio = _studio()
    answer = _ask(studio, "load_script", path=str(script))
    assert answer["error"]["type"] == "MethodError"
    assert not marker.exists()


@needs_scene_graph
def test_a_scene_is_edited_from_its_script_or_its_file(tmp_path):
    """A path is a script to run, or a scene the studio saved -- which is
    what `save` writes."""
    script = tmp_path / "scene.py"
    script.write_text(
        "import magpylib as magpy\n"
        "cube = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1))\n"
        "magpy.show(cube)\n"
    )
    studio = widget.SceneWidget(script, editable=True)
    assert list(studio.objects) == ["cube"]
    saved = tmp_path / "scene.magpy.json"
    studio.save(saved)
    again = widget.SceneWidget(saved, editable=True)
    assert list(again.objects) == ["cube"]
    assert json.loads(saved.read_text(encoding="utf-8")) == studio._session.to_dict()


@needs_scene_graph
def test_a_page_saved_from_a_studio_is_read_only():
    """No kernel behind a saved page, so nothing to keep an edit."""
    studio = _studio()
    saved = json.loads(_unpacked(studio.to_html(), "magpy-scene"))
    assert saved["state"]["standalone"] is True
    assert not saved["state"].get("editable")


@needs_scene_graph
def test_a_studio_is_not_re_pointed():
    studio = _studio()
    with pytest.raises(TypeError, match="edit"):
        studio.update(magpy.Sensor())


@needs_scene_graph
def test_a_view_is_editable_from_when_it_is_made(scene_objects):
    """Handles on a view of the cell's own objects would reach nothing that
    keeps an edit, so a view is made editable or not -- and what only an
    editable view can do says so on any other."""
    view = widget.SceneWidget(*scene_objects)
    with pytest.raises(traitlets.TraitError, match="editable=True"):
        view.editable = True
    assert not view.editable
    with pytest.raises(TypeError, match="editable=True"):
        view.to_script()
    magnet, sensor = scene_objects
    assert view.objects == {str(id(magnet)): magnet, str(id(sensor)): sensor}


@needs_scene_graph
def test_a_path_is_opened_to_edit(scene_objects, tmp_path):
    """A path is a scene to edit, not objects to draw -- and an editable view
    takes objects and traits, not magpylib's drawing options."""
    with pytest.raises(TypeError, match="editable=True"):
        widget.SceneWidget(tmp_path / "scene.py")
    with pytest.raises(TypeError, match="animation"):
        widget.SceneWidget(*scene_objects, editable=True, animation=True)


# --- the editable view, as the review of #20 found it ----------------------


@needs_scene_graph
def test_numpy_values_do_not_poison_the_session(tmp_path):
    """A value handed over as an array is stored as a list: the document
    stays JSON, and every edit after it -- and a save -- still works."""
    studio = _studio()
    magnet = next(key for key in studio.objects if key not in ("ring", "probe"))
    studio.set(magnet, dimension=np.array([0.02, 0.01, 0.01]))
    studio.set(magnet, polarization=np.array([1.0, 0, 0]), position=np.zeros(3))
    studio.save(tmp_path / "scene.magpy.json")
    assert studio.objects[magnet].dimension == pytest.approx([0.02, 0.01, 0.01])


@needs_scene_graph
def test_a_refused_set_changes_nothing():
    """A pose and a size set together are one edit: when the size is
    refused, the pose does not go through either, and nothing is told."""
    studio = _studio()
    magnet = next(key for key in studio.objects if key not in ("ring", "probe"))
    before = np.ravel(studio.objects[magnet].position).copy()
    revision, steps = studio.revision, len(studio._session.get_history()["undo"])
    with pytest.raises(ValueError, match=magnet):
        studio.set(magnet, position=(0.05, 0, 0), dimension=(-1, "x", 0))
    assert np.ravel(studio.objects[magnet].position) == pytest.approx(before)
    assert studio.revision == revision
    assert len(studio._session.get_history()["undo"]) == steps


@needs_scene_graph
def test_a_small_value_is_still_an_edit():
    """In SI units a real edit can be tiny: a nanoampere-metre moment, a
    nanometre move. Only the very same value is no edit."""
    dipole = magpy.misc.Dipole(moment=(0, 0, 1e-9))
    studio = widget.SceneWidget(dipole, editable=True)
    studio.set("dipole", moment=(0, 0, 2e-9))
    assert studio.objects["dipole"].moment == pytest.approx([0, 0, 2e-9])
    revision = studio.revision
    studio.set("dipole", moment=(0, 0, 2e-9))
    assert studio.revision == revision


@needs_scene_graph
def test_only_a_change_is_news():
    """Undo with nothing to undo, or a gesture that changed nothing, tells
    the notebook nothing; `undo()` says whether it did anything."""
    studio = _studio()
    revision = studio.revision
    assert studio.undo() is False
    _ask(studio, "undo")
    _ask(studio, "begin_interaction")
    _ask(studio, "end_interaction")
    assert studio.revision == revision


@needs_scene_graph
def test_the_view_is_answered_before_the_notebook_is_told():
    """A callback on `revision` that raises -- or takes long -- does not
    keep the answer from the view, which would give up on it."""
    studio = _studio()

    def broken(change):
        raise RuntimeError("a notebook callback that fails")

    studio.observe(broken, "revision")
    _ask(studio, "begin_interaction")
    _ask(
        studio,
        "apply_edits",
        edits=[{"objectId": "probe", "position": [0.01, 0, 0.02]}],
    )
    asked = len(studio.sent)
    with pytest.raises(RuntimeError):
        _ask(studio, "end_interaction")
    answer = studio.sent[-1]
    assert answer["kind"] == "rpc" and answer["id"] == asked
    assert "error" not in answer


@needs_scene_graph
def test_what_an_edit_was_is_said():
    """`last_edit` says what `revision` counted: a drag and what it left, a
    `set`, an undo and the step it took back."""
    studio = _studio()
    _ask(studio, "begin_interaction")
    _ask(
        studio,
        "apply_edits",
        edits=[{"objectId": "probe", "position": [0.01, 0, 0.02]}],
    )
    _ask(studio, "end_interaction")
    assert studio.last_edit == {
        "by": "drag",
        "objects": ["probe"],
        "changed": {"probe": {"position": [0.01, 0, 0.02]}},
    }
    studio.set("probe", position=(0.02, 0, 0.02))
    assert studio.last_edit["by"] == "set"
    assert studio.last_edit["changed"] == {"probe": {"position": [0.02, 0, 0.02]}}
    studio.undo()
    assert studio.last_edit == {"by": "undo", "step": "set transform probe"}


@needs_scene_graph
def test_objects_are_named_after_the_callers_own_variables():
    """A function's own variables name its objects, not only a module's."""

    def make():
        cube = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1))
        pickup = magpy.Sensor(position=(0, 0, 2))
        return widget.SceneWidget(cube, pickup, editable=True)

    assert sorted(make().objects) == ["cube", "pickup"]


@needs_scene_graph
def test_the_legend_names_an_unlabelled_object_as_the_scene_does():
    """No label of its own: listed as the name it has in the scene, which is
    what the readout and `objects` say, not as its type."""
    rotor = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1))
    pickup = magpy.Sensor(style_label="the pickup")
    studio = widget.SceneWidget(rotor, pickup, editable=True)
    assert [(n["id"], n["label"]) for n in studio.tree] == [
        ("rotor", "rotor"),
        ("pickup", "the pickup"),
    ]


@needs_scene_graph
def test_objects_may_come_as_a_list(scene_objects):
    """As `show` and a read-only view take them -- and none is said plainly."""
    studio = widget.SceneWidget(list(scene_objects), editable=True)
    assert len(studio.objects) == 2
    with pytest.raises(TypeError, match="nothing to edit"):
        widget.SceneWidget(editable=True)


@needs_scene_graph
def test_a_saved_step_that_no_longer_applies_is_said(tmp_path):
    cube = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1))
    doc = widget.SceneWidget(cube, editable=True)._session.to_dict()
    ghost = {"id": "ghost", "target": "nobody", "op": "move", "displacement": [1, 0, 0]}
    doc["events"].append(ghost)
    saved = tmp_path / "scene.magpy.json"
    saved.write_text(json.dumps(doc))
    with pytest.warns(UserWarning, match="no longer applies"):
        widget.SceneWidget(saved, editable=True)
