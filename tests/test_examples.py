"""The examples, each written once (`magpylib_studio.examples`): the gallery,
the docs and the notebooks read them from there."""

import pytest

from magpylib_studio import SceneFunction
from magpylib_studio.examples import EXAMPLES, GALLERY
from magpylib_studio.session import MagpylibStudioSession


@pytest.mark.parametrize("key", list(EXAMPLES))
def test_an_example_says_what_it_is_and_opens(key):
    """A title and a line for the gallery, a text for its docs page, and a
    scene function named as its module, which opens as a document."""
    example = EXAMPLES[key]
    assert isinstance(example.scene, SceneFunction)
    assert example.scene._fn.__name__ == example.module
    assert example.title and example.summary and len(example.text) > 80
    session = MagpylibStudioSession()
    assert session.load_example(key) == {"ok": True}
    assert session.field_lines is example.field_lines
    assert [e["name"] for e in session.list_examples()["examples"]] == list(GALLERY)
