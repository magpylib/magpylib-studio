"""The studio as a magpylib display backend: `magpy.show(backend="studio")`.

Advertised through the `magpylib.backends` entry-point group, so installing
this package is enough for the name to work. Being an entry point is also the
constraint this module is written under: magpylib resolves the group while it
is still importing, so whatever is reachable from here is paid for by every
`import magpylib` on the machine. It stays down to magpylib and numpy — the
plotly half of the viewer lives in `plotly_view.py` and is imported by scripts
that want it.

Read only, and honestly declared as such. What it draws is a picture of a
scene whose objects live in someone else's process — one that has usually
exited by the time the panel appears. The studio's own panel is the editable
one, and getting there means handing the studio the script, not the picture.
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

if threejs.DisplayBackend is None:  # pragma: no cover - depends on magpylib
    # 5.2.3 and earlier have no display-backend API to subclass. They also have
    # no entry-point discovery, so nothing ever asks for this name there, and
    # the plotly half of the viewer still works.
    StudioBackend = None
else:

    class StudioBackend(threejs.DisplayBackend):
        """Draws a magpylib scene in the studio window the script ran from."""

        name = BACKEND_NAME
        description = "Magpylib Studio (VS Code) — read-only scene view"

        #: three.js interpolates vertex colours, so the gradient arrives whole
        #: rather than sliced into one mesh per colour band.
        supports_colorgradient = True
        #: One mesh per object, so each object's traces hang on one node and
        #: highlight together.
        merge_traces = False
        handles_traces = frozenset({"mesh3d", "scatter3d"})
        #: Pinned, not inherited. Inheriting takes whatever the installed
        #: magpylib emits, so the two can never disagree and the mismatch
        #: warning this exists for could never fire. This is the version the
        #: payload was written against; raise it when it has been checked.
        api_version = 1
        accepts_options = frozenset()
        #: Not yet: playback needs every step of the path captured and served a
        #: frame at a time, which is the session's job in the studio and has no
        #: equivalent here while the script that owns the objects has exited.
        supports_animation = False
        supports_subplots = False

        def show(self, scene):
            payload = threejs.view_payload(scene)
            if write_view("scene", payload, title=scene.title, claimed=CLAIMED) is None:
                raise RuntimeError(unaddressed(f"the {BACKEND_NAME!r} backend"))
            return payload


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
