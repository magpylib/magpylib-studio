"""Tests for the figures a script leaves for its window to draw."""

import base64
import hashlib
import json
import os
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


# --- "draw scripts here", the one thing that chooses a backend for you -----


@pytest.fixture
def default_backend():
    """`magpy.defaults` is process-wide; put the backend back."""
    before = magpy.defaults.display.backend
    yield
    magpy.defaults.display.backend = before


@pytest.fixture
def asked(monkeypatch, tmp_path, default_backend):
    """A window with the setting on.

    `PYTEST_CURRENT_TEST` is deliberately not cleared here: pytest sets it
    again for every phase, so a fixture that deletes it has been undone by the
    time the body runs. The tests that need to look like an ordinary script
    clear it themselves.
    """
    monkeypatch.setenv("MAGPYLIB_STUDIO_DROP", str(tmp_path))
    monkeypatch.setenv(backend.CLAIM_VAR, backend.BACKEND_NAME)
    magpy.defaults.display.backend = "auto"


@needs_scene_graph
def test_the_window_can_be_asked_to_choose(asked, monkeypatch):
    monkeypatch.setattr(backend, "_under_a_test_runner", lambda: False)
    assert backend._claim_default() is True
    assert magpy.defaults.display.backend == backend.BACKEND_NAME


@needs_scene_graph
def test_nothing_is_claimed_unasked(asked, monkeypatch):
    """The address alone never chooses; that is the whole design."""
    monkeypatch.setattr(backend, "_under_a_test_runner", lambda: False)
    monkeypatch.delenv(backend.CLAIM_VAR)
    assert backend._claim_default() is False
    assert magpy.defaults.display.backend == "auto"


@needs_scene_graph
def test_a_script_that_chose_for_itself_wins(asked, monkeypatch):
    monkeypatch.setattr(backend, "_under_a_test_runner", lambda: False)
    magpy.defaults.display.backend = "plotly"
    assert backend._claim_default() is False
    assert magpy.defaults.display.backend == "plotly"


@needs_scene_graph
def test_a_test_run_is_left_alone(asked, monkeypatch):
    """A courtesy, not a rule -- but a suite is what opens panels by the
    dozen, and it is the case the setting's description warns about.

    pytest has already set the variable for this very call; the test says so
    rather than relying on it.
    """
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "tests/test_x.py::test_y (call)")
    assert backend._claim_default() is False
    assert magpy.defaults.display.backend == "auto"


@needs_scene_graph
def test_a_suite_is_left_alone_at_collection_time(asked):
    """The moment the environment variable does not cover.

    Modules are imported during collection, when `PYTEST_CURRENT_TEST` is not
    set -- and importing this module is what claims. Checked here without
    patching anything, since this very session is the case.
    """
    assert "PYTEST_CURRENT_TEST" in os.environ or "pytest" in sys.modules
    assert backend._claim_default() is False


@needs_scene_graph
def test_a_plain_script_claims_at_import(tmp_path, monkeypatch):
    """End to end, in an interpreter that is not a test run.

    Importing the backend is what sets the default, and nothing in-process can
    show that: pytest is in `sys.modules` here by definition.
    """
    env = {
        **os.environ,
        "MAGPYLIB_STUDIO_DROP": str(tmp_path),
        backend.CLAIM_VAR: backend.BACKEND_NAME,
    }
    env.pop("PYTEST_CURRENT_TEST", None)
    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "import magpylib_studio.backend, magpylib as magpy;"
            "print(magpy.defaults.display.backend)",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
        env=env,
        cwd=tempfile.gettempdir(),
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == backend.BACKEND_NAME, out.stderr


@needs_scene_graph
def test_nothing_is_claimed_without_somewhere_to_draw(asked, monkeypatch):
    """Claiming with no address makes the first show() raise instead."""
    monkeypatch.setattr(backend, "_under_a_test_runner", lambda: False)
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP")
    assert backend._claim_default() is False
    assert magpy.defaults.display.backend == "auto"


def test_a_payload_says_what_drew_it(drop):
    """The interpreter, for whatever re-runs the script later.

    A panel that has gone stale can offer to run it again, and "python" on a
    PATH is not the same answer as the interpreter this package was importable
    in -- which is the whole reason a stamped terminal is not sufficient.
    """
    path = viewer.write_view("plotly", {})
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["python"] == sys.executable
    assert payload["claimed"] is False


def test_a_payload_says_where_it_ran(drop):
    """Enough to run the script again exactly as it was run."""
    path = viewer.write_view("plotly", {})
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["cwd"] == os.getcwd()


def test_a_payload_says_what_the_file_held(drop, tmp_path, monkeypatch):
    """So that saving a file is not mistaken for changing it."""
    script = tmp_path / "run.py"
    script.write_bytes(b"import magpylib\n")
    monkeypatch.setattr(viewer, "_script_path", lambda: str(script))
    payload = json.loads(
        viewer.write_view("plotly", {}).read_text(encoding="utf-8")
    )
    assert payload["digest"] == hashlib.sha256(script.read_bytes()).hexdigest()


def test_a_payload_with_no_file_has_no_digest(drop, monkeypatch):
    """A REPL has nothing to hash, and nothing to go stale against."""
    monkeypatch.setattr(viewer, "_script_path", lambda: "<stdin>")
    payload = json.loads(
        viewer.write_view("plotly", {}).read_text(encoding="utf-8")
    )
    assert payload["digest"] is None
