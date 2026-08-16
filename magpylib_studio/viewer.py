"""Where a script's `show()` lands when it was run from a studio window.

The engine is a child of the extension: it is handed a scene and asked for a
figure. A script is not. The user starts it, it owns its own objects, and
nothing in VS Code knows it exists — so the connection has to run the other
way, and the only thing pointing back at a particular window is the address
that window stamps on its terminals. `MAGPYLIB_STUDIO_DROP` names a directory
it watches; a script run from there leaves a figure in it and the window draws
it.

One file per `show()` call, named from the script and the call's position in
it. A rerun counts from zero again, so it overwrites the files its last run
wrote and the panels already open update in place — keeping their cameras —
instead of a second set appearing beside them.

Nothing here runs unless the renderer was asked for by name. The stamp is an
address, not an instruction: `pytest` in the same terminal carries it too, and
a default set from an environment variable would have applied to every figure
the interpreter drew. See CONTINUE.md, design decision 8.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

import plotly.io as pio
from plotly.io._base_renderers import ExternalRenderer
from plotly.utils import PlotlyJSONEncoder

#: Selected by name — `show(backend="plotly", plotly_renderer=RENDERER_NAME)`.
#: Never made plotly's default from in here; that is the user's to set, for
#: the reason in the module docstring.
RENDERER_NAME = "magpylib-studio"

#: Bumped when the payload's shape changes. A panel that does not know a
#: version says so rather than drawing part of it.
PAYLOAD_VERSION = 1

#: The stamp names the window's storage directory, which holds other things.
#: The views get a subdirectory of their own so only they are watched.
VIEWS_SUBDIR = "views"


def drop_dir() -> Path | None:
    """The directory this window draws from, or None if not run from one."""
    stamp = os.environ.get("MAGPYLIB_STUDIO_DROP")
    return Path(stamp) / VIEWS_SUBDIR if stamp else None


def _script_path() -> str:
    """What identifies the run — the file, where there is one.

    A REPL, `python -c` and a frozen entry point have no `__file__`. Those
    share one identity rather than having none, which keeps a REPL to a single
    panel it redraws instead of a new one per call.
    """
    main = sys.modules.get("__main__")
    path = getattr(main, "__file__", None)
    return str(Path(path).resolve()) if path else f"<{sys.executable}>"


#: How many times each script has drawn, this process. Reruns start again,
#: which is the whole addressing mechanism.
_calls: dict[str, int] = {}


def _next_call(script: str) -> int:
    index = _calls.get(script, 0)
    _calls[script] = index + 1
    return index


def write_view(kind: str, body: object, *, title: str | None = None) -> Path | None:
    """Leave one figure where the window will find it.

    Returns the file written, or None when the script was not run from a
    studio window and there is nowhere to put it.
    """
    views = drop_dir()
    if views is None:
        return None
    script = _script_path()
    index = _next_call(script)
    key = hashlib.sha256(f"{script}#{index}".encode()).hexdigest()[:16]
    views.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": PAYLOAD_VERSION,
        "kind": kind,
        "script": script,
        "index": index,
        "title": title,
        "written": time.time(),
        "body": body,
    }
    target = views / f"{key}.json"
    # Written beside the target and moved onto it. The watcher wakes on a file
    # that is already whole; without this it can read one that is still being
    # written, and "unexpected end of JSON" is a confusing way for a panel to
    # say "too early". os.replace is atomic within a directory on both POSIX
    # and Windows.
    staging = views / f"{key}.{os.getpid()}.part"
    staging.write_text(
        json.dumps(payload, cls=PlotlyJSONEncoder), encoding="utf-8"
    )
    os.replace(staging, target)
    return target


def draw_here() -> str:
    """Send this script's plotly figures to the window it was run from.

    Sets plotly's own default renderer and returns its name. A script's author
    is entitled to do that for their script — it is the environment doing it
    behind their back that design decision 8 rules out.

    It is also the only route that works on every magpylib this package
    supports. `show(backend="plotly", plotly_renderer=...)` reaches the figure
    on 5.2.4.dev, and 5.2.3 drops the argument without a word — no warning, no
    error, and a browser tab opens instead. Measured, both ways.
    """
    pio.renderers.default = RENDERER_NAME
    return RENDERER_NAME


class StudioRenderer(ExternalRenderer):
    """Draws a plotly figure in the studio window the script was run from."""

    def render(self, fig: dict) -> None:
        if write_view("plotly", fig) is None:
            msg = (
                f"the {RENDERER_NAME!r} renderer draws in a Magpylib Studio "
                "window, and this script was not run from one "
                "(MAGPYLIB_STUDIO_DROP is unset). Run it from a terminal in a "
                "window where the extension is active, or pick another "
                "renderer."
            )
            raise RuntimeError(msg)


pio.renderers[RENDERER_NAME] = StudioRenderer()
