"""The scene as a function, in a reactive notebook: `marimo edit examples/marimo_demo.py`.

Needs the widget extra, marimo, and wigglystuff for the draggable call:

    uv pip install -e ".[widget]" marimo wigglystuff

One function, three callers, in one notebook. `halbach` below is a plain
magpylib function marked `@scene`: its parameters are the variables. Called,
it gives the magpylib objects the 3D view draws. Built, it gives the studio's
document, which the field, the sweep, the code tab and the saved file come
from. And its signature is what the controls are rendered from -- as a call
expression whose numbers drag (wigglystuff's `TangleFunction`), or as
marimo's own sliders, with nothing of studio's in between. Drag a number and
every cell that depends on it re-runs: the view is re-pointed, the numbers
update, the field map redraws.
"""

import marimo

__generated_with = "0.24.0"
app = marimo.App(width="full", app_title="Magpylib Studio")


@app.cell
def _():
    import json

    import magpylib as magpy
    import marimo as mo
    import numpy as np
    import plotly.graph_objects as go

    from magpylib_studio import (
        Angle,
        Count,
        Length,
        derived,
        duplicate_around,
        name,
        sampled,
        scene,
    )
    from magpylib_studio.widget import SceneWidget

    return (
        Angle,
        Count,
        Length,
        SceneWidget,
        derived,
        duplicate_around,
        go,
        json,
        magpy,
        mo,
        name,
        np,
        sampled,
        scene,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A Halbach stack, as one function

    The function below is plain magpylib under `@scene`. Its parameters
    are the design's variables; the controls above the view are rendered
    from its signature; the 3D view draws what the function returns; and
    the document the studio opens is what `.build()` records. Everything
    on this page follows the controls, because marimo re-runs whatever
    depends on them.
    """)
    return


@app.cell
def _(
    Angle,
    Count,
    Length,
    derived,
    duplicate_around,
    magpy,
    name,
    np,
    sampled,
    scene,
):
    from typing import Annotated, Literal

    @scene(model_unit="mm", field_unit="mT")
    def halbach(
        n: Annotated[int, Count(4, 48, slider=(6, 24))] = 12,
        radius: Annotated[float, Length(0.01, 0.1, slider=(0.018, 0.04))] = 0.025,
        gap: Annotated[float, Length(0.006, 0.05, slider=(0.009, 0.03))] = 0.012,
        tilt: Annotated[float, Angle(-180, 180, slider=(-90, 90))] = 0.0,
        tilt_axis: Literal["x", "y", "z"] = "z",
        density: Annotated[int, Count(2, 25, slider=(3, 15))] = 7,
    ):
        """Two rings of magnets whose polarization turns twice per revolution,
        the upper ring half a step round from the lower, and a grid of field
        arrows across the bore."""
        stagger = derived("stagger", 180 / n, unit="angle")
        stack = name(magpy.Collection(style_label="Halbach stack"), "stack")
        rings = {}
        for number, z in ((1, -gap / 2), (2, gap / 2)):  # a loop over literals
            rings[number] = name(
                magpy.Collection(style_label=f"Ring {number}"), f"ring{number}"
            )
            stack.add(rings[number])
            magnet = name(
                magpy.magnet.Cuboid(
                    dimension=(0.008, 0.008, 0.008),
                    polarization=(1, 0, 0),
                    position=(radius, 0, z),
                    style_label=f"Magnet {number}",
                ),
                f"magnet{number}",
            )
            rings[number].add(magnet)
            duplicate_around(magnet, count=n, axis="z", spin=360 / n)
        rings[2].rotate_from_angax(stagger, "z", anchor=0)
        stack.rotate_from_angax(tilt, tilt_axis, anchor=0)

        reach = radius / 2
        bore = name(
            magpy.Sensor(
                pixel=sampled(
                    lambda t: (
                        -reach + 2 * reach * (t % density) / (density - 1),
                        -reach + 2 * reach * (t // density) / (density - 1),
                        0,
                    ),
                    count=density**2,
                    over=(0, density**2 - 1),
                ),
                style={
                    "label": "Field in the bore",
                    "size": 0.004,
                    "pixel": {
                        "field": {
                            "source": "B",
                            "symbol": "arrow3d",
                            "colormap": "Viridis",
                        }
                    },
                },
            ),
            "bore",
        )
        return stack, bore

    _ = np  # the grid above is a formula of the sample, not an array: see `sampled`
    return (halbach,)


@app.cell(hide_code=True)
def _(halbach, mo):
    # The controls, from the signature. wigglystuff renders the call itself:
    # numbers drag, choices click. Without it, marimo's own elements do the
    # same from the same metadata (`halbach.parameters`).
    try:
        from wigglystuff import TangleFunction

        knobs = mo.ui.anywidget(TangleFunction(halbach, halbach.controls()))
        _how = "Drag a number in the call, or click a choice."
    except ImportError:
        _elements = {}
        for _spec in halbach.parameters:
            _name = _spec["name"]
            if "options" in _spec:
                _elements[_name] = mo.ui.dropdown(
                    _spec["options"], value=_spec["value"], label=_name
                )
                continue
            _low, _high = _spec.get("slider") or _spec.get("bounds") or (None, None)
            if _low is None or _high is None:
                _elements[_name] = mo.ui.number(value=_spec["value"], label=_name)
            elif _spec.get("integer"):
                _elements[_name] = mo.ui.slider(
                    _low,
                    _high,
                    step=1,
                    value=_spec["value"],
                    label=_name,
                    show_value=True,
                )
            else:
                _elements[_name] = mo.ui.slider(
                    _low,
                    _high,
                    step=(_high - _low) / 200,
                    value=_spec["value"],
                    label=_name,
                    show_value=True,
                )
        knobs = mo.ui.dictionary(_elements)
        _how = "`pip install wigglystuff` renders these as a call expression whose numbers drag."
    mo.vstack([knobs, mo.md(f"_{_how}_")])
    return (knobs,)


@app.cell
def _(halbach, knobs):
    # The values the controls hold, whichever element renders them.
    values = dict(knobs.value.get("values", knobs.value))
    # Called: magpylib objects, for the view. Built: the document, for the
    # field, the sweep, the code and the file. Both from the same function.
    stack, bore = halbach(**values)
    s = halbach.build(values=values)
    session = s.session
    return bore, s, session, stack, values


@app.cell
def _(SceneWidget, mo):
    # Made once and re-pointed below, so the camera stays where you left it.
    view = mo.ui.anywidget(SceneWidget(height=560))
    view
    return (view,)


@app.cell
def _(bore, stack, view):
    view.widget.update(stack, bore)
    return


@app.cell(hide_code=True)
def _(mo, np, session, values, view):
    _centre = np.linalg.norm(session.get_field(points=[[0, 0, 0]])["values"][0]) * 1e3
    _bore = np.asarray(session.get_field(sensor_id="bore")["values"], dtype=float)
    _magnitude = np.linalg.norm(_bore.reshape(-1, 3), axis=1)
    _spread = np.ptp(_magnitude) / _magnitude.mean() * 100
    _picked = view.value["selected"] and view.widget.picked
    mo.hstack(
        [
            mo.stat(f"{_centre:.1f} mT", label="|B| at the centre", bordered=True),
            mo.stat(
                f"{_spread:.2f} %",
                label="spread across the bore",
                caption=f"(max − min) / mean over {len(_magnitude)} points",
                bordered=True,
            ),
            mo.stat(2 * int(values["n"]), label="magnets", bordered=True),
            mo.stat(
                ", ".join(o.style.label for o in _picked) if _picked else "—",
                label="selected in the view",
                caption="click a magnet, ⌘-click to add",
                bordered=True,
            ),
        ],
        widths="equal",
        gap=1,
    )
    return


@app.cell(hide_code=True)
def _(go, mo, np, s, session):
    _template = "plotly_dark" if mo.app_meta().theme == "dark" else "plotly_white"

    def _figure(spec):
        figure = go.Figure(spec)
        figure.update_layout(template=_template, margin={"t": 40, "r": 20})
        return figure

    _axis = np.linspace(-0.02, 0.02, 81)
    _along = np.asarray(
        session.get_field(points=[[0, 0, z] for z in _axis])["values"], dtype=float
    )
    _profile = go.Figure(
        go.Scatter(x=_axis * 1e3, y=np.linalg.norm(_along, axis=1) * 1e3, mode="lines")
    )
    _profile.update_layout(
        template=_template,
        xaxis_title="z along the axis (mm)",
        yaxis_title="|B| (mT)",
        margin={"t": 40, "r": 20},
    )
    _radii = np.linspace(0.018, 0.04, 12).tolist()

    mo.ui.tabs(
        {
            "Field map": mo.ui.plotly(_figure(session.get_field_map())),
            "Along the axis": mo.ui.plotly(_profile),
            "Sweep the radius": mo.ui.plotly(
                _figure(session.get_sweep_figure("radius", _radii, points=[[0, 0, 0]]))
            ),
            "The scene as code": mo.ui.code_editor(
                session.to_builder_script(), language="python", disabled=True
            ),
            "The document": mo.json(s.to_dict()),
        },
        lazy=True,
    )
    return


@app.cell(hide_code=True)
def _(mo, session):
    _rows = []
    for _entry in session.list_objects():
        if _entry.get("type") != "magnet.Cuboid":
            continue
        _pose = session.get_transform(_entry["id"])
        _x, _y, _z = (round(1e3 * c, 2) for c in _pose["position"])
        _rows.append(
            {
                "id": _entry["id"],
                "label": _entry["label"],
                "x (mm)": _x,
                "y (mm)": _y,
                "z (mm)": _z,
                "made by": _entry.get("derived") or "its own step",
            }
        )
    mo.accordion(
        {
            f"Every magnet in the scene ({len(_rows)})": mo.ui.table(
                _rows, selection=None, page_size=10
            )
        }
    )
    return


@app.cell
def _(mo):
    search = mo.ui.run_button(
        label="Search n × radius for the flattest bore field",
        kind="success",
        tooltip="Rebuilds the document at every pair and reads the field, in milliseconds each",
    )
    search
    return (search,)


@app.cell(hide_code=True)
def _(halbach, mo, np, search, values):
    mo.stop(
        not search.value,
        mo.callout(
            "Press the button: a search over the count and the radius, each try a "
            "rebuild of the document and a read of the field, a few milliseconds each.",
            kind="neutral",
        ),
    )
    _trial = halbach.build(values=values).session
    _grid = [
        (count, r) for count in (8, 12, 16, 20) for r in (0.02, 0.025, 0.03, 0.035)
    ]
    _results = []
    for _count, _r in mo.status.progress_bar(
        _grid, title="Searching", remove_on_exit=True
    ):
        _trial.set_variable("n", _count)
        _trial.set_variable("radius", _r)
        _bore = np.asarray(_trial.get_field(sensor_id="bore")["values"], dtype=float)
        _magnitude = np.linalg.norm(_bore.reshape(-1, 3), axis=1)
        _results.append(
            {
                "n": _count,
                "radius (mm)": _r * 1e3,
                "|B| centre (mT)": round(float(_magnitude.mean()), 2),
                "spread (%)": round(
                    float(np.ptp(_magnitude) / _magnitude.mean() * 100), 3
                ),
            }
        )
    _best = min(_results, key=lambda row: row["spread (%)"])
    mo.vstack(
        [
            mo.callout(
                mo.md(
                    f"Flattest: **n = {_best['n']}, radius = {_best['radius (mm)']:g} mm** "
                    f"at {_best['|B| centre (mT)']} mT, spread {_best['spread (%)']} %. "
                    "Set those in the controls to see it."
                ),
                kind="success",
            ),
            mo.ui.table(_results, selection=None, page_size=16),
        ]
    )
    return


@app.cell(hide_code=True)
def _(mo, np, session):
    def _answer(messages, _config):
        """A number or three in the last message are a point, in mm: the field
        there. Anything else: what this can do."""
        text = messages[-1].content
        found = [
            float(x) for x in np.array(text.replace(",", " ").split()) if _number(x)
        ]
        if len(found) >= 3:
            x, y, z = (c / 1e3 for c in found[:3])
        elif len(found) == 1:
            x, y, z = 0.0, 0.0, found[0] / 1e3
        else:
            return (
                "Give me a point in mm, as `0, 0, 5` or just `5` for a height on the "
                "axis, and I will read the field there from the scene as it is now."
            )
        field = session.get_field(points=[[x, y, z]])
        bx, by, bz = (c * 1e3 for c in field["values"][0])
        norm = (bx**2 + by**2 + bz**2) ** 0.5
        return (
            f"At ({x * 1e3:g}, {y * 1e3:g}, {z * 1e3:g}) mm: |B| = {norm:.2f} mT, "
            f"B = ({bx:.2f}, {by:.2f}, {bz:.2f}) mT."
        )

    def _number(token):
        try:
            float(token)
        except ValueError:
            return False
        return True

    mo.accordion(
        {
            "Ask the scene for the field at a point": mo.ui.chat(
                _answer,
                prompts=["0, 0, 0", "5", "10, 0, 3"],
                max_height=320,
            )
        }
    )
    return


@app.cell(hide_code=True)
def _(json, mo, s, session):
    mo.sidebar(
        [
            mo.md("# Magpylib Studio"),
            mo.md(
                "_One function: the controls, the view, the field and the file all "
                "follow it._"
            ),
            mo.outline(),
            mo.vstack(
                [
                    mo.download(
                        data=lambda: json.dumps(s.to_dict(), indent=2),
                        filename="halbach.magpy.json",
                        mimetype="application/json",
                        label="The scene, to open in the studio",
                    ),
                    mo.download(
                        data=lambda: session.to_builder_script(),
                        filename="halbach_scene.py",
                        mimetype="text/x-python",
                        label="The scene as code, to keep",
                    ),
                ],
                gap=0.5,
            ),
            mo.md(
                "The `.magpy.json` opens in VS Code with **Magpylib Studio: Open "
                "Scene…**, every parameter a slider there too; it never runs code "
                "when opened. The script is the same function, written back from "
                "the document."
            ),
        ],
        footer=mo.md("_magpylib-studio · the 3D view is the studio's own renderer_"),
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## More of the view

    The three below are the same widget on scenes of their own, loaded when
    opened. The view takes the keys once clicked, as the studio's panel
    does: **F** frames the selection and **Home** everything, **1** **3**
    **7** look from the front, the right and the top, **5** switches the
    projection, **H** hides the selection and **shift-H** shows only it,
    **space** plays a run. Its tools sit in the top-right corner: legend,
    axes, framing, projection, theme, a PNG, an export to one HTML file
    that works without this notebook, and full screen.
    """)
    return


@app.cell(hide_code=True)
def _(SceneWidget, magpy, mo, np):
    def _played_in_the_browser():
        rotor = magpy.magnet.Cylinder(
            polarization=(1, 0, 0), dimension=(4, 1), style_label="rotor"
        )
        sweep = magpy.Sensor(
            position=np.linspace((-6, 0, 1.5), (6, 0, 1.5), 60), style_label="sweep"
        )
        sweep.style.arrows.x.show = True
        sweep.style.arrows.y.show = True
        return mo.vstack(
            [
                mo.md(
                    "`animation=True` captures every step of the run. Every step here "
                    "is the first one moved, so the view is handed the motion and "
                    "**▶** plays it in the browser with nothing to ask python, which "
                    "is also why it still plays in a saved page."
                ),
                SceneWidget(rotor, sweep, animation=True, height=380),
            ]
        )

    def _properties_along_a_path():
        steps = 40
        turn = np.linspace(0, 2 * np.pi, steps)
        spinner = magpy.magnet.Cylinder(
            polarization=np.column_stack([np.cos(turn), np.sin(turn), np.zeros(steps)]),
            dimension=(2, 1),
            style_label="spinner",
        )
        coil = magpy.current.Circle(
            diameter=np.linspace(2, 5, steps),
            current=np.linspace(1, 100, steps),
            position=(0, 0, 1.5),
            style_label="coil",
        )
        probe = magpy.Sensor(
            pixel=np.linspace((-3, 0, 0), (3, 0, 0), 13),
            position=(0, 0, -1.5),
            style_label="probe",
        )
        probe.style.pixel.field.source = "B"
        return mo.vstack(
            [
                mo.md(
                    "On magpylib main more than the pose can vary along a path: a "
                    "polarization turning a full circle, a coil growing while its "
                    "current ramps, pixels coloured by the field they sit in. No "
                    "motion can play that, so the widget serves the frames one at a "
                    "time, each as magpylib computed it."
                ),
                SceneWidget(spinner, coil, probe, animation=True, height=380),
            ]
        )

    def _editing():
        rotor = magpy.magnet.Cuboid(
            dimension=(1, 1, 1), polarization=(0, 0, 1), style_label="rotor"
        )
        pickup = magpy.Sensor(position=(0, 0, 2), style_label="pickup")
        return mo.vstack(
            [
                mo.md(
                    "`editable=True` puts out the studio's handles over a studio "
                    "session in this kernel: **W** moves, **E** turns, **R** resizes, "
                    "**P** aims, and ⌘Z / ctrl-Z undoes a whole drag. The widget's "
                    "`objects` are the scene as edited, `to_script()` what was done."
                ),
                SceneWidget(rotor, pickup, editable=True, height=380),
            ]
        )

    mo.accordion(
        {
            "Paths, played in the browser": mo.lazy(_played_in_the_browser),
            "Properties along a path": mo.lazy(_properties_along_a_path),
            "Editing a scene with the handles": mo.lazy(_editing),
        },
        lazy=True,
    )
    return


if __name__ == "__main__":
    app.run()
