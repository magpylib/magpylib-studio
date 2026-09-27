"""The studio's magpylib display backends.

Advertised through the `magpylib.backends` entry-point group, so installing
this package is enough for the name to work. Being an entry point is also the
constraint this module is written under: magpylib resolves the group while it
is still importing, so whatever is reachable from here is paid for by every
`import magpylib` on the machine. It stays down to magpylib and numpy — the
plotly half of the viewer lives in `plotly_view.py` and is imported by scripts
that want it.

Two of them, and the constraint is why they share a module:

* ``studio`` draws in the VS Code window the script was run from.
* ``widget`` draws in a notebook cell, as an `anywidget`. Everything that
  needs is in `widget.py`, which this imports from inside `show` -- so
  ipywidgets is loaded by drawing one, not by installing this package.

Both are read only, and honestly declared as such. What they draw is a picture
of a scene whose objects live in someone else's process, or in a cell that has
already run. The studio's own panel is the editable one, and getting there
means handing the studio the script, not the picture.
"""

from __future__ import annotations

import os
import sys

import magpylib as magpy

from magpylib_studio import threejs
from magpylib_studio.viewer import drop_dir, unaddressed, write_view

#: Set on this window's terminals only while "draw scripts here" is on. The
#: address (`MAGPYLIB_STUDIO_DROP`) says *where* a figure can go; this says
#: that a script which named no backend should go there.
CLAIM_VAR = "MAGPYLIB_STUDIO_BACKEND"

#: Selected by name. Registered by magpylib's entry-point discovery, so a
#: script needs no import of its own for this one.
BACKEND_NAME = "studio"

#: The same view, drawn in a notebook cell instead. See `widget.py`.
WIDGET_BACKEND_NAME = "widget"

if threejs.SceneGraphBackend is None:  # pragma: no cover - depends on magpylib
    # 5.2.3 and earlier have no display-backend API to subclass. They also have
    # no entry-point discovery, so nothing ever asks for these names there, and
    # the plotly half of the viewer still works.
    StudioBackend = None
    WidgetBackend = None
else:
    # What the scene graph can draw is `SceneGraphBackend`'s to declare; what
    # differs between the two is where it goes, and so what a host can play.

    class StudioBackend(threejs.SceneGraphBackend):
        """Draws a magpylib scene in the studio window the script ran from."""

        name = BACKEND_NAME
        description = "Magpylib Studio (VS Code) — read-only scene view"
        accepts_options = frozenset()
        #: Not yet: playback needs every step of the path captured and served a
        #: frame at a time, which is the session's job in the studio and has no
        #: equivalent here while the script that owns the objects has exited.
        supports_animation = False

        def show(self, scene):
            payload = threejs.view_payload(scene)
            if write_view("scene", payload, title=scene.title, claimed=CLAIMED) is None:
                raise RuntimeError(unaddressed(f"the {BACKEND_NAME!r} backend"))
            return payload

    class WidgetBackend(threejs.SceneGraphBackend):
        """Draws a magpylib scene in the notebook cell that asked for it."""

        name = WIDGET_BACKEND_NAME
        description = "Magpylib Studio — 3D scene as a notebook widget"
        #: Unlike the panel's, this view can play a run: the widget holds the
        #: captured frames and serves them to the browser one at a time, which
        #: is the job the session does in the studio.
        supports_animation = True
        #: How tall to draw, in pixels. A figure keyword rather than a widget
        #: one so that `magpy.show(..., backend="widget", height=600)` says it
        #: the way every other backend option is said.
        accepts_options = frozenset({"height"})

        def show(self, scene):
            # Imported here, not at module scope: this module is loaded while
            # magpylib is importing, and the widget brings ipywidgets with it.
            from magpylib_studio.widget import (
                SceneWidget,
                display,
            )

            widget = SceneWidget(scene)
            if scene.options.get("height") is not None:
                widget.height = int(scene.options["height"])
            if not scene.return_fig:
                display(widget)
            return widget


def _under_a_test_runner() -> bool:
    """Whether this looks like a test suite rather than someone's script.

    Two tests for one runner, because they catch different moments.
    `PYTEST_CURRENT_TEST` is set per test phase and is *absent* during
    collection -- which is exactly when this module is imported and when the
    claim would be made, so the variable alone let a whole suite run claimed.
    `pytest` in `sys.modules` is what holds at import time.

    A courtesy and not a rule: nox, tox, sphinx-build and a script rendering
    two hundred figures are all still here. A suite is the one that opens
    panels by the dozen.
    """
    return "PYTEST_CURRENT_TEST" in os.environ or "pytest" in sys.modules


def _claim_default() -> bool:
    """Make `studio` the default backend, if this window asked for that.

    Setting a default from the environment is action at a distance, so it is
    hedged on all four sides:

    * the window has to have asked -- the variable is stamped only while the
      setting is on, and unticking it stops this;
    * there has to be somewhere to draw, or the first `show()` would raise
      instead of drawing;
    * the script must not have chosen for itself. Only `"auto"` is replaced,
      so `magpy.defaults.display.backend = "plotly"` in a script wins;
    * and not under a test runner -- see `_under_a_test_runner`.

    Runs while magpylib resolves entry points, which `check_format_input_backend`
    does *before* it reads the default -- so the first `show()` of the process
    already sees this.
    """
    if StudioBackend is None or os.environ.get(CLAIM_VAR) != BACKEND_NAME:
        return False
    if drop_dir() is None:
        return False
    if _under_a_test_runner():
        return False
    if magpy.defaults.display.backend != "auto":
        return False
    magpy.defaults.display.backend = BACKEND_NAME
    return True


#: Whether this process is drawing here because the window asked, rather than
#: because the script did. The panel says so once, and only for these.
CLAIMED = _claim_default()
