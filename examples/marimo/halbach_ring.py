"""A Halbach ring to tune: `marimo edit examples/marimo/halbach_ring.py`.

The view edits the document; the field map, the axis, a sweep, the magnets
and the code tab read it; a search tries sixteen rings for the flattest bore;
the sidebar saves the scene as a document and as a script.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="A Halbach ring")


@app.cell
def _():
    import inspect
    import json

    import magpylib as magpy
    import marimo as mo
    import numpy as np
    import plotly.graph_objects as go

    from magpylib_studio.widget import SceneWidget

    return (
        go,
        inspect,
        json,
        magpy,
        mo,
        np,
        SceneWidget,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A Halbach ring, tuned

    A design is a plain magpylib function marked `@scene`: its parameters
    are the variables. Here one magnet and a pattern round the axis make
    the ring, and a probe across the bore draws the field's lines. Built once, it is a document that the view edits,
    the field reads and the file saves. Every control on this page edits
    that one document, so they never disagree.
    """)
    return


@app.cell
def _(inspect, mo):
    # The scene, from the package that the gallery and the docs read too:
    # its source shown, so the page still says how it is written.
    from magpylib_studio.examples.halbach_ring import halbach_ring as halbach

    mo.md(f"```python\n{inspect.getsource(halbach)}```")
    return (halbach,)


@app.cell
def _(halbach):
    # Built once: the document every control below edits.
    s = halbach.build()
    session = s.session
    return s, session


@app.cell(hide_code=True)
def _(json, mo, s, session):
    # Shown before the view: a sidebar that comes after it has marimo lay the
    # page out again, and the view mounted a second time. Its files are
    # written when clicked, so they hold the scene as it is then.
    _downloads = [
        mo.download(
            data=lambda: json.dumps(s.to_dict(), indent=2),
            filename="halbach.magpy.json",
            mimetype="application/json",
            label="halbach.magpy.json",
        ),
        mo.download(
            data=session.to_builder_script,
            filename="halbach_scene.py",
            mimetype="text/x-python",
            label="halbach_scene.py",
        ),
    ]

    mo.sidebar(
        [
            mo.md("# Magpylib Studio"),
            mo.outline(),
            mo.md("**The scene, as edited**"),
            mo.vstack(_downloads, gap=0.5),
            mo.md(
                "_A `.magpy.json` opens in VS Code with **Magpylib Studio: Open "
                "Scene…**, never running code; the `.py` is the same function, "
                "written back from the document._"
            ),
        ],
        footer=mo.md("_magpylib-studio_"),
    )
    return


@app.cell
def _(SceneWidget, mo, s):
    # The document's own view, editable from the start, the bore's field
    # lines drawn through its pixels. Shown beside the tabs below, made here,
    # once, so the camera stays put.
    view3d = SceneWidget(s, editable=True, height=560, field_lines=True)
    view = mo.ui.anywidget(view3d)
    # A cell that names `view` re-runs on its every change, a click
    # included. What should follow edits alone reads this count instead,
    # and is handed the view as a picture of it, which it does not watch.
    edited, set_edited = mo.state(0)
    view3d.observe(lambda change: set_edited(change.new), names="revision")
    shown = mo.as_html(view)
    tab, set_tab = mo.state("Field map")
    return edited, set_tab, shown, tab, view, view3d


@app.cell(hide_code=True)
def _(edited, go, mo, np, session, set_tab, shown, tab):
    _ = edited()
    _template = "plotly_dark" if mo.app_meta().theme == "dark" else "plotly_white"

    def _plot(figure, **layout):
        figure.update_layout(
            template=_template, autosize=True, margin={"t": 40, "r": 20}, **layout
        )
        return mo.ui.plotly(figure, config={"responsive": True})

    def _axis():
        z = np.linspace(-0.02, 0.02, 81)
        field = session.get_field(points=[[0, 0, v] for v in z])["values"]
        return _plot(
            go.Figure(go.Scatter(x=z * 1e3, y=np.linalg.norm(field, axis=1) * 1e3)),
            xaxis_title="z (mm)",
            yaxis_title="|B| (mT)",
        )

    def _magnets():
        rows = []
        for entry in session.list_objects():
            if entry.get("type") != "magnet.Cuboid":
                continue
            x, y, z = (
                round(1e3 * c, 2)
                for c in session.get_transform(entry["id"])["position"]
            )
            rows.append(
                {
                    "label": entry["label"],
                    "x (mm)": x,
                    "y (mm)": y,
                    "z (mm)": z,
                    "made by": entry.get("derived") or "its own step",
                }
            )
        return mo.ui.table(rows, selection=None, page_size=12)

    # Each tab is worked out when it is opened: a sweep nobody looks at
    # would rebuild the scene a dozen times after every edit. The one open
    # stays open across them -- held by a name of its own, as an element
    # only inside the layout below would be let go, and with it the call
    # that keeps the tab.
    tabs = mo.ui.tabs(
        {
            # on a log scale: the plane runs through the magnets
            "Field map": mo.lazy(
                lambda: _plot(go.Figure(session.get_field_map(log=True)))
            ),
            "Axis": mo.lazy(_axis),
            "Sweep": mo.lazy(
                lambda: _plot(
                    go.Figure(
                        session.get_sweep_figure(
                            "radius",
                            np.linspace(0.018, 0.04, 12).tolist(),
                            points=[[0, 0, 0]],
                        )
                    )
                )
            ),
            "Magnets": mo.lazy(_magnets),
            "Code": mo.lazy(
                lambda: mo.ui.code_editor(
                    session.to_builder_script(), language="python", disabled=True
                )
            ),
        },
        value=tab(),
        on_change=set_tab,
        lazy=True,
    )
    # Side by side in a grid whose columns may shrink below what they hold,
    # as a stack's do not: in a narrow window the tabs scroll, rather than
    # run off the page.
    mo.Html(
        '<div style="display: grid; gap: 1rem; align-items: start; '
        'grid-template-columns: minmax(0, 5fr) minmax(0, 4fr)">'
        f'{shown.text}<div style="overflow-x: auto">{tabs.text}</div></div>'
    )
    return (tabs,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    **W** moves, **E** turns, **R** resizes, **P** aims a polarization;
    ⌘Z / ctrl-Z undoes a whole drag, and a magnet pushed into another is
    outlined in amber. The sliders at the foot of the edit column open the
    variables; the `compact` and `wide` variants are a click each along the
    foot of the view.
    """)
    return


@app.cell
def _(edited, halbach, view3d):
    # The variables as the document holds them, once per settled edit.
    _ = edited()
    values = {p["name"]: view3d.variables[p["name"]] for p in halbach.parameters}
    return (values,)


@app.cell(hide_code=True)
def _(halbach, magpy, mo, np, session, values, view):
    # From the document, drags included, and from the function called
    # plainly at the same values: the two agree until a magnet is dragged.
    _ = view.value["revision"]
    _centre = np.linalg.norm(session.get_field(points=[[0, 0, 0]])["values"][0]) * 1e3
    _ring, _ = halbach(**values)
    _plain = np.linalg.norm(magpy.getB(_ring, (0, 0, 0))) * 1e3
    _bore = np.asarray(session.get_field(sensor_id="bore")["values"], dtype=float)
    _magnitude = np.linalg.norm(_bore.reshape(-1, 3), axis=1)
    _picked = view.value["selected"] and view.widget.picked
    mo.hstack(
        [
            mo.stat(
                f"{_centre:.1f} mT",
                label="|B| at the centre",
                caption="drags included",
                bordered=True,
            ),
            mo.stat(
                f"{_plain:.1f} mT",
                label="the function, called plainly",
                caption="no drags",
                bordered=True,
            ),
            mo.stat(
                f"{np.ptp(_magnitude) / _magnitude.mean() * 100:.1f} %",
                label="spread across the bore",
                caption=f"over {len(_magnitude)} points",
                bordered=True,
            ),
            mo.stat(
                int(values["n"]),
                label="magnets",
                caption="one magnet, a pattern",
                bordered=True,
            ),
            mo.stat(
                ", ".join(o.style.label for o in _picked) if _picked else "—",
                label="selected",
                caption="click a magnet",
                bordered=True,
            ),
        ],
        widths="equal",
        gap=1,
    )
    return


@app.cell
def _(mo):
    search = mo.ui.run_button(
        label="Find the flattest bore: n × radius",
        kind="success",
        tooltip="Sixteen rebuilds of the document, a field read each",
    )
    search
    return (search,)


@app.cell(hide_code=True)
def _(halbach, mo, np, search, values):
    mo.stop(not search.value)
    # A trial document at the current values, apart from the one on view.
    _trial = halbach.build(values=values).session
    _results = []
    for _count, _r in mo.status.progress_bar(
        [(c, r) for c in (8, 12, 16, 20) for r in (0.02, 0.025, 0.03, 0.035)],
        title="Searching",
        remove_on_exit=True,
    ):
        _trial.set_variable("n", _count)
        _trial.set_variable("radius", _r)
        _bore = np.asarray(_trial.get_field(sensor_id="bore")["values"], dtype=float)
        _magnitude = np.linalg.norm(_bore.reshape(-1, 3), axis=1)
        _results.append(
            {
                "n": _count,
                "radius (mm)": _r * 1e3,
                "|B| (mT)": round(float(_magnitude.mean()) * 1e3, 1),
                "spread (%)": round(
                    float(np.ptp(_magnitude) / _magnitude.mean() * 100), 2
                ),
            }
        )
    _best = min(_results, key=lambda row: row["spread (%)"])
    mo.vstack(
        [
            mo.callout(
                mo.md(
                    f"Flattest at **n = {_best['n']}, radius = "
                    f"{_best['radius (mm)']:g} mm**: spread {_best['spread (%)']} %."
                ),
                kind="success",
            ),
            mo.ui.table(_results, selection=None, page_size=16),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
