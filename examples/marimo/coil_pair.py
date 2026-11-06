# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "magpylib-studio[widget]>=0.15.0",
#     "marimo",
#     "plotly",
# ]
# ///
"""A coil pair to flip: `marimo edit examples/marimo/coil_pair.py`.

Two coils on one axis, their currents variables: the Helmholtz variant runs
them together, anti-Helmholtz against each other, and the numbers beside the
view follow every edit. The plot draws a curve for each variant selected at the
foot of the view, Ctrl-click or Cmd-click for more, and the scene's while none
is.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="A coil pair")


@app.cell
def _():
    import inspect
    import json

    import marimo as mo
    import numpy as np
    import plotly.graph_objects as go

    from magpylib_studio.widget import SceneWidget

    return (
        go,
        inspect,
        json,
        mo,
        np,
        SceneWidget,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A coil pair, flowing

    Current flows along every wire in the view, the way it runs. Two
    coils on one axis, each current a variable: the **Helmholtz** variant
    runs them together, for a flat field between, and **anti-Helmholtz**
    turns the upper one round, for a field that passes through zero.
    Ctrl-click or Cmd-click the other variant's chip, at the foot of the
    view, and the plot draws both, one curve each; drag the chip up
    into the view, and it has a pane of its own beside the scene.
    """)
    return


@app.cell
def _(inspect, mo):
    # The scene, from the package that the gallery and the docs read too:
    # its source a click away, so the page still says how it is written.
    from magpylib_studio.examples.coil_pair import coil_pair as coils

    mo.accordion(
        {"How it is written": mo.md(f"```python\n{inspect.getsource(coils)}```")}
    )
    return (coils,)


@app.cell
def _(SceneWidget, coils, json, mo):
    pair = coils.build()
    pair_session = pair.session
    # Opened with its variables; the two variants a click each at its foot.
    pair_view3d = SceneWidget(
        pair, editable=True, height=480, field_lines=True, open_panel="variables"
    )
    pair_view = mo.ui.anywidget(pair_view3d)
    pair_edited, set_pair_edited = mo.state(0)
    pair_view3d.observe(lambda change: set_pair_edited(change.new), names="revision")
    # the variants selected at the foot of the view: a curve each, below
    pair_chosen, set_pair_chosen = mo.state([])
    pair_view3d.observe(
        lambda change: set_pair_chosen(change.new), names="selected_variants"
    )
    # Shown beside the numbers below, made here, once, so the camera stays
    # put; its files written when clicked, so they hold the scene as it is
    # then.
    pair_shown = mo.as_html(
        mo.vstack(
            [
                pair_view,
                mo.hstack(
                    [
                        mo.download(
                            data=lambda: json.dumps(pair.to_dict(), indent=2),
                            filename="coils.magpy.json",
                            mimetype="application/json",
                            label="coils.magpy.json",
                        ),
                        mo.download(
                            data=pair_session.to_builder_script,
                            filename="coils_scene.py",
                            mimetype="text/x-python",
                            label="coils_scene.py",
                        ),
                    ],
                    justify="start",
                ),
            ]
        )
    )
    return pair_chosen, pair_edited, pair_session, pair_shown, pair_view3d


@app.cell(hide_code=True)
def _(go, mo, np, pair_chosen, pair_edited, pair_session, pair_shown, pair_view3d):
    _ = pair_edited()
    _template = "plotly_dark" if mo.app_meta().theme == "dark" else "plotly_white"
    _radius = pair_view3d.variables["radius"]
    _z = np.linspace(-1.5, 1.5, 121) * _radius

    def _bz_of(session):
        _along = session.get_field(points=[[0, 0, z] for z in _z])["values"]
        return np.asarray(_along, dtype=float)[:, 2]

    _bz = _bz_of(pair_session)
    _middle = len(_z) // 2
    _gradient = np.gradient(_bz, _z)[_middle]
    _probe = np.asarray(
        pair_session.get_field(sensor_id="probe")["values"], dtype=float
    )
    _magnitude = np.linalg.norm(_probe.reshape(-1, 3), axis=1)
    # a curve for each variant selected, from the copy of the scene at it --
    # the scene's own where it is at that one -- and the scene's alone while
    # none is
    _at = pair_session.get_variables()["variant"]
    _curves = {}
    for _name in pair_chosen():
        if _name == _at:
            _curves[_name] = _bz
            continue
        try:
            _curves[_name] = _bz_of(pair_session.variant_session(_name))
        except ValueError:
            continue  # one the scene cannot use as it stands: its chip says why
    _figure = go.Figure(
        [
            go.Scatter(x=_z * 1e3, y=_along * 1e3, name=_name)
            for _name, _along in (_curves or {_at or "edited": _bz}).items()
        ]
    )
    _figure.update_layout(
        template=_template,
        autosize=True,
        margin={"t": 40, "r": 20},
        height=300,
        xaxis_title="z along the axis (mm)",
        yaxis_title="Bz (mT)",
    )
    _numbers = mo.vstack(
        [
            mo.hstack(
                [
                    mo.stat(
                        f"{round(_bz[_middle] * 1e3, 2) + 0:.2f} mT",
                        label="Bz at the centre",
                        caption="zero when they oppose",
                        bordered=True,
                    ),
                    mo.stat(
                        f"{round(_gradient, 3) + 0:.3f} T/m",
                        label="dBz/dz at the centre",
                        caption="zero when they agree",
                        bordered=True,
                    ),
                    mo.stat(
                        f"{np.ptp(_magnitude) / max(_magnitude.mean(), 1e-12) * 100:.1f} %",
                        label="spread over the probe",
                        caption="flattest near spacing = radius",
                        bordered=True,
                    ),
                ],
                widths="equal",
                gap=1,
                wrap=True,
            ),
            mo.ui.plotly(_figure, config={"responsive": True}),
        ]
    )
    # Side by side in a grid whose columns may shrink below what they hold,
    # as a stack's do not: in a narrow window the numbers scroll, rather than
    # run off the page.
    mo.Html(
        '<div style="display: grid; gap: 1rem; align-items: start; '
        'grid-template-columns: minmax(0, 5fr) minmax(0, 4fr)">'
        f"{pair_shown.text}"
        f'<div style="overflow-x: auto">{mo.as_html(_numbers).text}</div></div>'
    )
    return


if __name__ == "__main__":
    app.run()
