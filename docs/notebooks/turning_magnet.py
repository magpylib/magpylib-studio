# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "magpylib-studio[widget]>=0.15.0",
#     "marimo",
#     "plotly",
# ]
# ///
"""A turning magnet and its field over the run:
`marimo edit docs/notebooks/turning_magnet.py`.

A magnet turns once under a grid of field arrows. The plot beside the view
draws the field above its centre at every step of the run, and its dotted
line follows the view: pause it or scrub it, and the line is there; click a
curve, and the view goes to that step.

Needs the widget extra and marimo:

    pip install "magpylib-studio[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="A turning magnet")


@app.cell
def _():
    import inspect

    import marimo as mo
    import numpy as np
    import plotly.graph_objects as go

    from magpylib_studio.widget import SceneWidget

    return SceneWidget, go, inspect, mo, np


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A turning magnet, and its field over the run

    The magnet turns once about y, in fifty-one steps, under a grid of
    arrows that read its field. Press play at the foot of the view, or drag
    its slider: the plot beside it draws the field above the magnet's
    centre at every step, and its dotted line is the step the view stopped
    on. Click a curve, and the view goes to that step.

    The view says its step as `view.step`, the row of a field read along
    the path, when the run pauses, ends or is scrubbed; not at each frame
    it plays. Set from a cell, the run goes there.
    """)
    return


@app.cell
def _(inspect, mo):
    # The scene, from the package that the gallery and the docs read too:
    # its source a click away, so the page still says how it is written.
    from magpylib_studio.examples.turning_magnet import turning_magnet as turning

    mo.accordion(
        {"How it is written": mo.md(f"```python\n{inspect.getsource(turning)}```")}
    )
    return (turning,)


@app.cell
def _(SceneWidget, mo, np, turning):
    turning_built = turning.build()
    turning_session = turning_built.session
    # for looking only: no pencil, so the field plotted is the scene's
    turning_view3d = SceneWidget(turning_built, height=420, editable="never")
    turning_view3d.step = 0  # opened at the start of the run
    # the step the view stopped on, for the plot to mark
    turning_step, set_turning_step = mo.state(turning_view3d.step)
    turning_view3d.observe(lambda change: set_turning_step(change.new), names="step")
    # the field above the magnet's centre, where the arrows' grid is: one
    # row a step of the path
    _lift = turning_session.get_variables()["variables"][0]["value"]
    turning_b = np.asarray(
        turning_session.get_field(points=[[0, 0, _lift]])["values"], dtype=float
    )
    # held by name, so that marimo hands it what the page does to it; shown
    # beside the plot below, made here, once, so the camera stays put
    turning_view = mo.ui.anywidget(turning_view3d)
    turning_shown = mo.as_html(turning_view)
    return turning_b, turning_shown, turning_step, turning_view, turning_view3d


@app.cell(hide_code=True)
def _(go, mo, turning_b, turning_shown, turning_step):
    _template = "plotly_dark" if mo.app_meta().theme == "dark" else "plotly_white"
    _at = turning_step()
    _figure = go.Figure()
    for _axis, _name in ((0, "Bx"), (2, "Bz")):
        _figure.add_scatter(y=turning_b[:, _axis] * 1e3, name=_name, mode="lines")
    _figure.add_vline(x=_at, line_dash="dot")
    _figure.update_layout(
        template=_template,
        height=380,
        margin={"l": 50, "r": 10, "t": 40, "b": 40},
        hovermode="x",
        xaxis_title="step of the run",
        yaxis_title="field above the centre (mT)",
        title=f"step {_at}: Bx {turning_b[_at, 0] * 1e3:.1f} mT, "
        f"Bz {turning_b[_at, 2] * 1e3:.1f} mT",
    )
    # a click on a curve is read in the next cell
    turning_plot = mo.ui.plotly(_figure, config={"displayModeBar": False})
    mo.hstack([turning_shown, turning_plot], widths=[3, 2], align="center")
    return (turning_plot,)


@app.cell
def _(turning_plot, turning_view3d):
    # a curve clicked: the view goes to that step
    if turning_plot.value:
        turning_view3d.step = round(turning_plot.value[0]["x"])
    return


if __name__ == "__main__":
    app.run()
