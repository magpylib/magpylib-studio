"""The examples, each written once (`magpylib_studio.examples`): the gallery,
the docs and the notebooks read them from there."""

import pytest

from magpylib_studio import SceneFunction
from magpylib_studio.examples import EXAMPLES, GALLERY
from magpylib_studio.session import MagpylibStudioSession


def test_an_example_needs_a_version_it_can_draw_with(monkeypatch):
    """A package older than an example needs is no use: the gallery leaves
    the example out, as it does when the package is missing."""
    from magpylib_studio import examples

    need = ("json", "magpylib-material-response", "0.12")
    version = {"value": "0.11.0"}
    monkeypatch.setattr(
        examples.importlib.metadata, "version", lambda _: version["value"]
    )
    assert not examples._installed(need)
    version["value"] = "0.12.0.dev3"
    assert examples._installed(need)
    assert not examples._installed(("no_such_module_here", "x", "1"))
    assert examples._installed("json")


@pytest.mark.parametrize("key", list(EXAMPLES))
def test_an_example_says_what_it_is_and_opens(key):
    """A title and a line for the gallery, a text for its docs page, and a
    scene function named as its module, which opens as a document and,
    called plainly, is magpylib."""
    example = EXAMPLES[key]
    if not example.available:  # as the gallery leaves it out
        pytest.skip(f"{key} needs {example.needs}")
    assert isinstance(example.scene, SceneFunction)
    assert example.scene._fn.__name__ == example.module
    assert example.title and example.summary and len(example.text) > 80
    assert example.scene()  # called plainly, plain magpylib
    session = MagpylibStudioSession()
    assert session.load_example(key) == {"ok": True}
    assert session.field_lines is example.field_lines
    assert [e["name"] for e in session.list_examples()["examples"]] == list(GALLERY)


def test_every_notebook_names_what_it_needs():
    """molab, and a WASM export, install what a notebook's script header
    names: without one, molab asks for each package an import misses. Each
    notebook has one naming the studio, and every example's notebook is
    there."""
    import pathlib
    import re

    notebooks = pathlib.Path(__file__).parents[1] / "docs" / "notebooks"
    for path in sorted(notebooks.glob("*.py")):
        head = re.match(r"# /// script\n(.*?)# ///\n", path.read_text("utf-8"), re.S)
        assert head, f"{path.name} has no script header"
        assert '"magpylib-studio[widget]' in head.group(1), path.name
    for example in EXAMPLES.values():
        if example.notebook:
            assert (notebooks / example.notebook).is_file(), example.notebook


def test_magnet_balls_pull_as_magpylib_does():
    """The balls' run steps on `pull`, which must give what magpylib's
    `getFT` gives for spheres -- exact for them -- force and torque."""
    import magpylib as magpy
    import numpy as np

    from magpylib_studio.examples import magnet_balls as mb

    rng = np.random.default_rng(3)
    positions = rng.uniform(-0.01, 0.01, (4, 3))
    poles = rng.normal(size=(4, 3))
    poles /= np.linalg.norm(poles, axis=1, keepdims=True)
    volume = np.pi / 6 * mb.DIAMETER**3
    force, torque, _ = mb.pull(positions, poles * mb.POLARIZATION * volume / mb.MU0)
    balls = [
        magpy.magnet.Sphere(
            diameter=mb.DIAMETER, polarization=mb.POLARIZATION * u, position=x
        )
        for x, u in zip(positions, poles, strict=True)
    ]
    for k, ball in enumerate(balls):
        # getFT differentiates the energy by finite differences: 1e-5 of
        # its own
        f, t = magpy.getFT(balls[:k] + balls[k + 1 :], ball)
        for mine, theirs in ((force[k], np.sum(f, 0)), (torque[k], np.sum(t, 0))):
            np.testing.assert_allclose(mine, theirs, atol=1e-4 * np.linalg.norm(theirs))


def test_magnet_balls_runs_are_kept_for_the_next_session(monkeypatch):
    """The scene's runs are worked out once and kept in the cache, named by
    a stamp of the simulation: a later session reads them back, not
    simulating again, and they are the same runs."""
    import numpy as np

    from magpylib_studio.examples import magnet_balls as mb

    made = mb.runs()
    assert list(mb.cache_dir().glob(f"magnet_balls-{mb.made_by()[:16]}.npz"))
    mb.runs.cache_clear()  # a new session
    monkeypatch.setattr(mb, "let_go", None)  # nothing is worked out again
    try:
        kept = mb.runs()
    finally:
        mb.runs.cache_clear()
    for name, (count, _) in mb.RUNS.items():
        assert kept[name].positions.shape[1] == count
        np.testing.assert_array_equal(kept[name].positions, made[name].positions)
