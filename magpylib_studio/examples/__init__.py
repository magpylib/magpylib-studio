"""The studio's examples, each written once, as a scene function.

The VS Code gallery, the docs and the marimo notebooks all read them from
here: each module holds one `@scene` function, named as the module, and its
`TITLE`. The function's docstring is the one description of it: its first
sentence is the gallery's line, the whole of it the docs page's text. A scene
function is how a scene is meant to be written, so an example is also a
lesson in writing one::

    from magpylib_studio.examples import EXAMPLES

    ring = EXAMPLES["rings"]
    ring.scene.build().save("ring.magpy.json")
"""

from __future__ import annotations

import ast
import dataclasses
import functools
import importlib
import importlib.util
import pathlib
import re


@dataclasses.dataclass(frozen=True)
class Example:
    """One example: its key, the module that holds it, and how it opens."""

    #: The name `load_example` takes, and the gallery's.
    key: str
    #: The module under `magpylib_studio.examples`, which is also the name of
    #: its scene function.
    module: str
    #: Opened with its field lines on.
    field_lines: bool = False
    #: Offered by the gallery. The others stay loadable by name: tests, the
    #: harness and the evals are written against them.
    gallery: bool = True
    #: The packages it needs beyond the studio's own: a part solved by
    #: magpylib-material-response, which is not one of them.
    needs: tuple = ()
    #: Its marimo notebook in `examples/marimo/`, where it has one: the scene
    #: imported, and what a notebook adds round it.
    notebook: str | None = None

    @property
    def available(self):
        """Whether what it `needs` is installed: the gallery offers it only
        then, and its module solves at import."""
        return all(importlib.util.find_spec(name) for name in self.needs)

    @property
    def scene(self):
        """The `@scene` function. Importing its module builds what it needs
        first -- for a solved example, the solve."""
        module = importlib.import_module(f"{__name__}.{self.module}")
        return getattr(module, self.module)

    @property
    def title(self):
        """Its name, as the gallery and its docs page head it."""
        return _said(self.module)["TITLE"]

    @property
    def summary(self):
        """The line the gallery shows under the title: the first sentence of
        its `text`."""
        head = " ".join(self.text.split("\n\n")[0].split())
        match = re.match(r"(.+?[.!?])(\s|$)", head)
        return match.group(1) if match else head

    @property
    def text(self):
        """What it is, once: its scene function's docstring, which its docs
        page shows."""
        return _said(self.module)["text"]

    def document(self):
        """The scene as a document, as `load_scene` takes it."""
        session = self.scene.build().session
        if self.field_lines:
            session.set_field_lines(True)
        return session.to_dict()


@functools.cache
def _said(module):
    """A module's title and its scene function's docstring, read from its
    source rather than by importing it: listing the gallery imports no
    example, so it solves nothing and needs nothing an example does."""
    tree = ast.parse(
        (pathlib.Path(__file__).parent / f"{module}.py").read_text("utf-8")
    )
    said = {}
    for node in tree.body:
        target = node.targets[0] if isinstance(node, ast.Assign) else None
        if isinstance(target, ast.Name) and target.id == "TITLE":
            said["TITLE"] = ast.literal_eval(node.value)
        if isinstance(node, ast.FunctionDef) and node.name == module:
            said["text"] = ast.get_docstring(node)
    return said


_SOLVED = ("magpylib_material_response",)

#: In the gallery's order: each leans on a different feature.
EXAMPLES = {
    e.key: e
    for e in (
        Example("rings", "halbach_ring", field_lines=True, notebook="halbach_ring.py"),
        Example("helmholtz", "coil_pair", field_lines=True, notebook="coil_pair.py"),
        Example("spiral", "helical_winding"),
        Example("pair", "facing_magnets"),
        Example("tolerance", "probe_placement"),
        Example("quiver", "turning_magnet"),
        Example("array", "magnet_array"),
        Example("solid", "superellipsoid"),
        Example("halbach", "halbach_stack"),
        Example(
            "versions", "unit_versions", field_lines=True, notebook="unit_versions.py"
        ),
        Example("kinds", "every_kind", notebook="every_kind.py"),
        Example(
            "ucore",
            "ucore_electromagnet",
            field_lines=True,
            needs=_SOLVED,
            notebook="ucore_solved.py",
        ),
        Example(
            "slide",
            "solved_plate_run",
            field_lines=True,
            needs=_SOLVED,
            notebook="run_with_variants.py",
        ),
        Example("coil", "solenoid", gallery=False),
    )
}

#: The ones the gallery offers: those it shows, whose needs are installed.
GALLERY = {key: e for key, e in EXAMPLES.items() if e.gallery and e.available}
