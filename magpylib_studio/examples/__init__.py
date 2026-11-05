"""The studio's examples, each written once, as a scene function.

The VS Code gallery, the docs and the marimo notebooks all read them from
here: each module holds one `@scene` function, its `TITLE`, the `SUMMARY` the
gallery shows under it, and, as its docstring, what the docs page says about
it. A scene function is how a scene is meant to be written, so an example is
also a lesson in writing one.

    from magpylib_studio.examples import EXAMPLES

    ring = EXAMPLES["rings"]
    ring.scene.build().save("ring.magpy.json")
"""

from __future__ import annotations

import dataclasses
import importlib
import inspect


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

    @property
    def _module(self):
        return importlib.import_module(f"{__name__}.{self.module}")

    @property
    def scene(self):
        """The `@scene` function."""
        return getattr(self._module, self.module)

    @property
    def title(self):
        return self._module.TITLE

    @property
    def summary(self):
        """The line the gallery shows under the title."""
        return self._module.SUMMARY

    @property
    def text(self):
        """What the docs page says about it: the module's docstring."""
        return inspect.getdoc(self._module)

    def document(self):
        """The scene as a document, as `load_scene` takes it."""
        session = self.scene.build().session
        if self.field_lines:
            session.set_field_lines(True)
        return session.to_dict()


#: In the gallery's order: each leans on a different feature.
EXAMPLES = {
    e.key: e
    for e in (
        Example("rings", "halbach_ring", field_lines=True),
        Example("helmholtz", "coil_pair", field_lines=True),
        Example("spiral", "helical_winding"),
        Example("pair", "facing_magnets"),
        Example("tolerance", "probe_placement"),
        Example("quiver", "turning_magnet"),
        Example("array", "magnet_array"),
        Example("solid", "superellipsoid"),
        Example("halbach", "halbach_stack", gallery=False),
        Example("coil", "solenoid", gallery=False),
    )
}

#: The ones the gallery offers.
GALLERY = {key: e for key, e in EXAMPLES.items() if e.gallery}
