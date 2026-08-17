"""Tests for the figures a script leaves for its window to draw."""

import base64
import json
import subprocess
import sys
import tempfile

import magpylib as magpy
import plotly.graph_objects as go
import plotly.io as pio
import pytest

from magpylib_studio import backend, plotly_view, threejs, viewer


@pytest.fixture
def drop(tmp_path, monkeypatch):
    """A stamped window, and a process that has not drawn yet."""
    monkeypatch.setenv("MAGPYLIB_STUDIO_DROP", str(tmp_path))
    monkeypatch.setattr(viewer, "_calls", {})
    return tmp_path / viewer.VIEWS_SUBDIR


def test_unstamped_process_writes_nothing(monkeypatch):
    """No window to draw in is not an error until someone asks for one."""
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    assert viewer.drop_dir() is None
    assert viewer.write_view("plotly", {}) is None


def test_view_is_written_whole(drop):
    path = viewer.write_view("plotly", {"data": [], "layout": {}}, title="A scene")
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == viewer.PAYLOAD_VERSION
    assert payload["kind"] == "plotly"
    assert payload["title"] == "A scene"
    assert payload["index"] == 0
    # Nothing half-written is left behind for the watcher to trip over.
    assert [p.name for p in drop.iterdir()] == [path.name]


def test_each_call_gets_its_own_panel(drop):
    first = viewer.write_view("plotly", {})
    second = viewer.write_view("plotly", {})
    assert first != second
    assert json.loads(second.read_text(encoding="utf-8"))["index"] == 1


def test_a_rerun_addresses_the_panels_the_last_one_opened(drop, monkeypatch):
    """The point of counting from zero: two runs, two files, not four."""
    before = [viewer.write_view("plotly", {}), viewer.write_view("plotly", {})]
    monkeypatch.setattr(viewer, "_calls", {})  # the next run of the same script
    after = [viewer.write_view("plotly", {}), viewer.write_view("plotly", {})]
    assert before == after
    assert len(list(drop.iterdir())) == 2


def test_the_renderer_writes_what_plotly_hands_it(drop):
    """Through plotly's own dispatch, not by calling render() directly."""
    figure = go.Figure(go.Scatter3d(x=[0, 1], y=[0, 1], z=[0, 1]))
    figure.show(renderer=plotly_view.RENDERER_NAME)
    (written,) = list(drop.iterdir())
    payload = json.loads(written.read_text(encoding="utf-8"))
    assert payload["body"]["data"][0]["type"] == "scatter3d"


def test_numpy_survives_the_trip(drop):
    """Magpylib's traces are numpy arrays, which plain `json.dumps` refuses.

    Plotly's own encoder writes them as its binary form -- `{"dtype": "f8",
    "bdata": "<base64>"}` -- rather than as lists, and plotly.js has read that
    natively since 2.32 (the extension bundles 3.x). It is why the payload can
    be plain JSON at all, and it is smaller than the lists would have been.
    """
    np = pytest.importorskip("numpy")
    go.Figure(go.Scatter3d(x=np.arange(3.0), y=np.arange(3.0), z=np.arange(3.0))).show(
        renderer=plotly_view.RENDERER_NAME
    )
    (written,) = list(drop.iterdir())
    body = json.loads(written.read_text(encoding="utf-8"))["body"]
    x = body["data"][0]["x"]
    assert x["dtype"] == "f8"
    assert base64.b64decode(x["bdata"]) == np.arange(3.0).tobytes()


def test_asking_for_a_window_that_is_not_there_says_so(monkeypatch):
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    with pytest.raises(RuntimeError, match="not run from one"):
        go.Figure().show(renderer=plotly_view.RENDERER_NAME)


def test_the_renderer_is_registered_by_importing_the_module():
    assert plotly_view.RENDERER_NAME in pio.renderers


@pytest.fixture
def plotly_default():
    """Plotly's default renderer is global; put it back."""
    before = pio.renderers.default
    yield
    pio.renderers.default = before


def test_draw_here_is_enough_on_its_own(drop, plotly_default):
    """The route that works on every magpylib this package supports.

    `show(plotly_renderer=...)` reaches the figure on 5.2.4.dev and is dropped
    without a word on 5.2.3, so the example asks plotly directly instead. Here
    that is a figure shown with no renderer named at all.
    """
    assert plotly_view.draw_here() == plotly_view.RENDERER_NAME
    go.Figure(go.Scatter3d(x=[0], y=[0], z=[0])).show()
    assert len(list(drop.iterdir())) == 1


# --- the scene graph, drawn from a script ---------------------------------


needs_scene_graph = pytest.mark.skipif(
    not threejs.available(),
    reason="the scene graph needs magpylib's display-backend API and unit pinning",
)


@needs_scene_graph
def test_the_backend_is_found_by_installing_the_package():
    """No import in the user's script: magpylib resolves the entry point.

    Asked of a fresh interpreter, because in-process it proves nothing — this
    module imports `backend`, and defining the class registers it, so the name
    would be there with no entry point installed at all.

    Worth a test because the ways it can go missing are quiet ones. The module
    is loaded during discovery, and anything that leaves it without a class —
    a magpylib too old for `DisplayBackend`, a package installed but not its
    entry point — ends with the name simply not existing.
    """
    code = (
        "import magpylib\n"
        "from magpylib._src.defaults.defaults_utility import "
        "get_registered_backends\n"
        f"print({backend.BACKEND_NAME!r} in get_registered_backends())\n"
    )
    out = subprocess.run(  # noqa: S603
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
        # not the repo: importable-from-cwd would not register it either, but
        # the question is what an installed package gives a stranger
        cwd=tempfile.gettempdir(),
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "True", out.stderr


@needs_scene_graph
def test_a_scene_is_drawn_through_show(drop):
    magnet = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1))
    sensor = magpy.Sensor(position=(0, 0, 2), pixel=[(0, 0, 0), (0.5, 0, 0)])
    magpy.show(magnet, sensor, backend=backend.BACKEND_NAME)
    (written,) = list(drop.iterdir())
    payload = json.loads(written.read_text(encoding="utf-8"))
    assert payload["kind"] == "scene"
    body = payload["body"]
    assert body["meshes"], "the objects should arrive as meshes"
    assert body["ranges"], "the view frames its camera from these"


@needs_scene_graph
def test_each_object_keeps_its_own_identity(drop):
    """Two objects, two ids — so a pick or a highlight acts on one of them.

    The ids are magpylib's `id(obj)`, valid only for as long as the payload
    is. That is enough here and no more than that is claimed.
    """
    magpy.show(
        magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1)),
        magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=1, position=(3, 0, 0)),
        backend=backend.BACKEND_NAME,
    )
    (written,) = list(drop.iterdir())
    body = json.loads(written.read_text(encoding="utf-8"))["body"]
    ids = {item["object_id"] for item in body["meshes"] + body["scatters"]}
    assert len(ids) == 2
    assert all(isinstance(name, str) for name in ids)


@needs_scene_graph
def test_the_scene_payload_is_plain_json(drop):
    """No plotly encoder in this path: threejs.py has already made it lists.

    Worth pinning, because the failure is a TypeError deep inside a show()
    rather than anything a user could act on.
    """
    magpy.show(
        magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1)),
        backend=backend.BACKEND_NAME,
    )
    (written,) = list(drop.iterdir())
    json.loads(written.read_text(encoding="utf-8"))


@needs_scene_graph
def test_a_scene_asked_for_outside_a_window_says_so(monkeypatch):
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    with pytest.raises(RuntimeError, match="not run from one"):
        magpy.show(
            magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1)),
            backend=backend.BACKEND_NAME,
        )


def test_a_notebook_is_told_something_it_can_act_on(monkeypatch):
    """"Run it from a terminal" is no advice to a kernel started by the editor.

    A notebook never carries the address, and magpylib already draws inline
    there, so the message names the thing to do instead.
    """
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    monkeypatch.setattr(viewer, "_in_notebook", lambda: True)
    with pytest.raises(RuntimeError, match="notebook kernel has none"):
        go.Figure().show(renderer=plotly_view.RENDERER_NAME)


def test_a_script_is_still_told_about_the_terminal(monkeypatch):
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    monkeypatch.setattr(viewer, "_in_notebook", lambda: False)
    with pytest.raises(RuntimeError, match="Run it from a terminal"):
        go.Figure().show(renderer=plotly_view.RENDERER_NAME)
