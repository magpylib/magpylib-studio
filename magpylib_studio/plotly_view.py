"""A script's plotly figures, drawn in the window it was run from.

The half of the viewer that needs plotly, kept apart from `viewer.py` because
that one is imported while magpylib is: `backend.py` is an entry point, and an
entry point is resolved before the defaults tree can validate its own default
backend. Making every `import magpylib` on a machine with this package
installed also import plotly would be a poor way to repay being installed.

A script that wants this imports it itself.
"""

from __future__ import annotations

import plotly.io as pio
from plotly.io._base_renderers import ExternalRenderer
from plotly.utils import PlotlyJSONEncoder

from magpylib_studio.viewer import write_view

#: Registered on import, and selected either by name or by `draw_here()`.
RENDERER_NAME = "magpylib-studio"


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
        if write_view("plotly", fig, encoder=PlotlyJSONEncoder) is None:
            msg = (
                f"the {RENDERER_NAME!r} renderer draws in a Magpylib Studio "
                "window, and this script was not run from one "
                "(MAGPYLIB_STUDIO_DROP is unset). Run it from a terminal in a "
                "window where the extension is active, or pick another "
                "renderer."
            )
            raise RuntimeError(msg)


pio.renderers[RENDERER_NAME] = StudioRenderer()
