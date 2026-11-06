"""The examples, each written once (`magpylib_studio.examples`): the gallery,
the docs and the notebooks read them from there."""

import pytest

from magpylib_studio import SceneFunction
from magpylib_studio.examples import EXAMPLES, GALLERY
from magpylib_studio.session import MagpylibStudioSession


@pytest.mark.parametrize("key", list(EXAMPLES))
def test_an_example_says_what_it_is_and_opens(key):
    """A title and a line for the gallery, a text for its docs page, and a
    scene function named as its module, which opens as a document and,
    called plainly, is magpylib."""
    example = EXAMPLES[key]
    if not example.available:  # as the gallery leaves it out
        pytest.skip(f"{key} needs {', '.join(example.needs)}")
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
