"""Tests for the figures a script leaves for its window to draw."""

import base64
import json

import plotly.graph_objects as go
import plotly.io as pio
import pytest

from magpylib_studio import viewer


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
    figure.show(renderer=viewer.RENDERER_NAME)
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
        renderer=viewer.RENDERER_NAME
    )
    (written,) = list(drop.iterdir())
    body = json.loads(written.read_text(encoding="utf-8"))["body"]
    x = body["data"][0]["x"]
    assert x["dtype"] == "f8"
    assert base64.b64decode(x["bdata"]) == np.arange(3.0).tobytes()


def test_asking_for_a_window_that_is_not_there_says_so(monkeypatch):
    monkeypatch.delenv("MAGPYLIB_STUDIO_DROP", raising=False)
    with pytest.raises(RuntimeError, match="not run from one"):
        go.Figure().show(renderer=viewer.RENDERER_NAME)


def test_the_renderer_is_registered_by_importing_the_module():
    assert viewer.RENDERER_NAME in pio.renderers


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
    assert viewer.draw_here() == viewer.RENDERER_NAME
    go.Figure(go.Scatter3d(x=[0], y=[0], z=[0])).show()
    assert len(list(drop.iterdir())) == 1
