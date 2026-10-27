"""Magpylib Studio in a reactive notebook: `marimo edit examples/marimo_demo.py`.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo

A design is a plain magpylib function marked `@scene`, its parameters the
variables. Built once, it is a document: the 3D view edits it, the field and
the sweep read it, the code tab and the downloads write it. Called, it is plain
magpylib. Two designs here, a Halbach ring to tune and a coil pair to flip, and
then the view's other tricks.
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="Magpylib Studio")


@app.cell
def _():
    import json
    from typing import Annotated

    import magpylib as magpy
    import marimo as mo
    import numpy as np
    import plotly.graph_objects as go

    from magpylib_studio import (
        Angle,
        Bounds,
        Count,
        Length,
        duplicate_along,
        duplicate_around,
        grid,
        scene,
    )
    from magpylib_studio.widget import SceneWidget

    return (
        Angle,
        Annotated,
        Bounds,
        Count,
        Length,
        SceneWidget,
        duplicate_along,
        duplicate_around,
        go,
        grid,
        json,
        magpy,
        mo,
        np,
        scene,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Magpylib Studio

    A design is a plain magpylib function marked `@scene`: its parameters
    are the variables. Built once, it is a document that the view edits,
    the field reads and the file saves. Every control on this page edits
    that one document, so they never disagree.

    ## A Halbach ring, tuned
    """)
    return


@app.cell
def _(
    Angle,
    Annotated,
    Count,
    Length,
    duplicate_around,
    grid,
    magpy,
    scene,
):
    from typing import Literal

    @scene(
        model_unit="mm",
        field_unit="mT",
        variants={
            "compact": {"n": 8, "radius": 0.02, "gap": 0.012},
            "wide": {"n": 16, "radius": 0.035, "gap": 0.014},
        },
    )
    def halbach(
        n: Annotated[int, Count(4, 48, slider=(6, 24))] = 12,
        radius: Annotated[float, Length(0.01, 0.1, slider=(0.018, 0.04))] = 0.025,
        gap: Annotated[float, Length(0.006, 0.05, slider=(0.009, 0.03))] = 0.012,
        twist: Annotated[float, Angle(-180, 180, slider=(-180, 180))] = 0.0,
        tilt: Annotated[float, Angle(-180, 180, slider=(-90, 90))] = 0.0,
        tilt_axis: Literal["x", "y", "z"] = "z",
        density: Annotated[int, Count(2, 25, slider=(3, 15))] = 7,
        layers: Annotated[int, Count(1, 9, slider=(1, 5))] = 1,
    ):
        """Two concentric rings of magnets, the outer `gap` further out, each
        polarization turning twice per revolution: in step their fields add
        up across the bore, and `twist` turns the inner ring against the
        outer. A grid of field arrows across the bore, `layers` of it."""
        rings = magpy.Collection(style_label="Halbach rings")
        ring = {}
        for name, r in (("Inner", radius), ("Outer", radius + gap)):  # literals
            ring[name] = magpy.Collection(style_label=f"{name} ring")
            rings.add(ring[name])
            magnet = magpy.magnet.Cuboid(
                dimension=(0.008, 0.008, 0.008),
                polarization=(1, 0, 0),
                position=(r, 0, 0),
                style_label=f"{name} magnet",
            )
            ring[name].add(magnet)
            duplicate_around(magnet, count=n, axis="z", spin=360 / n)
        ring["Inner"].rotate_from_angax(twist, "z", anchor=0)
        rings.rotate_from_angax(tilt, tilt_axis, anchor=0)

        bore = magpy.Sensor(
            pixel=grid(radius / 2, density, layers=layers),
            style={
                "label": "bore",
                "pixel": {
                    "field": {
                        "source": "B",
                        "symbol": "arrow3d",
                        "colormap": "Viridis",
                    }
                },
            },
        )
        return rings, bore

    return (halbach,)


@app.cell
def _(halbach):
    # Built once: the document every control below edits.
    s = halbach.build()
    session = s.session
    return s, session


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
    variables, with the `compact` and `wide` variants a click each above
    them.
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
    _rings, _ = halbach(**values)
    _plain = np.linalg.norm(magpy.getB(_rings, (0, 0, 0))) * 1e3
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
                2 * int(values["n"]),
                label="magnets",
                caption="two rings",
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


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## A coil pair, flowing

    Current flows along every wire in the view, the way it runs. Two
    coils on one axis, each current a variable: the **Helmholtz** variant
    runs them together, for a flat field between, and **anti-Helmholtz**
    turns the upper one round, for a field that passes through zero.
    """)
    return


@app.cell
def _(Annotated, Bounds, Count, Length, duplicate_along, grid, magpy, scene):
    _amperes = Bounds(-100, 100, slider=(-50, 50), unit="current")

    @scene(
        model_unit="mm",
        field_unit="mT",
        variants={
            "Helmholtz": {"lower": 20.0, "upper": 20.0, "spacing": 0.04},
            "anti-Helmholtz": {"lower": 20.0, "upper": -20.0, "spacing": 0.04},
        },
    )
    def coils(
        radius: Annotated[float, Length(0.01, 0.1, slider=(0.02, 0.06))] = 0.04,
        spacing: Annotated[float, Length(0.005, 0.15, slider=(0.01, 0.1))] = 0.04,
        lower: Annotated[float, _amperes] = 20.0,
        upper: Annotated[float, _amperes] = 20.0,
        turns: Annotated[int, Count(1, 20, slider=(1, 12))] = 6,
    ):
        """Two coils of `turns` loops, `spacing` apart centre to centre, and
        a probe across the gap between them, in the plane of the axis."""
        pitch = 0.002
        pair = magpy.Collection(style_label="coil pair")
        for name, current, centre in (
            ("lower", lower, -spacing / 2),
            ("upper", upper, spacing / 2),
        ):  # literals
            coil = magpy.Collection(style_label=f"{name} coil")
            pair.add(coil)
            loop = magpy.current.Circle(
                current=current,
                diameter=2 * radius,
                position=(0, 0, centre - (turns - 1) * pitch / 2),
                style_label=f"{name} loop",
            )
            coil.add(loop)
            duplicate_along(loop, count=turns, step=(0, 0, pitch))
        probe = magpy.Sensor(
            pixel=grid(0.6 * radius, 9, plane="xz"),
            style={
                "label": "probe",
                "pixel": {"field": {"source": "B", "symbol": "arrow3d"}},
            },
        )
        return pair, probe

    return (coils,)


@app.cell
def _(SceneWidget, coils, mo):
    pair = coils.build()
    pair_session = pair.session
    # Opened with its variables, the two variants a click each above them.
    pair_view3d = SceneWidget(
        pair, editable=True, height=480, field_lines=True, open_panel="variables"
    )
    pair_view = mo.ui.anywidget(pair_view3d)
    pair_edited, set_pair_edited = mo.state(0)
    pair_view3d.observe(lambda change: set_pair_edited(change.new), names="revision")
    pair_view
    return pair, pair_edited, pair_session, pair_view3d


@app.cell(hide_code=True)
def _(go, mo, np, pair_edited, pair_session, pair_view3d):
    _ = pair_edited()
    _template = "plotly_dark" if mo.app_meta().theme == "dark" else "plotly_white"
    _radius = pair_view3d.variables["radius"]
    _z = np.linspace(-1.5, 1.5, 121) * _radius
    _bz = np.asarray(
        pair_session.get_field(points=[[0, 0, z] for z in _z])["values"], dtype=float
    )[:, 2]
    _middle = len(_z) // 2
    _gradient = np.gradient(_bz, _z)[_middle]
    _probe = np.asarray(
        pair_session.get_field(sensor_id="probe")["values"], dtype=float
    )
    _magnitude = np.linalg.norm(_probe.reshape(-1, 3), axis=1)
    _figure = go.Figure(go.Scatter(x=_z * 1e3, y=_bz * 1e3))
    _figure.update_layout(
        template=_template,
        margin={"t": 40, "r": 20},
        height=300,
        xaxis_title="z along the axis (mm)",
        yaxis_title="Bz (mT)",
    )
    mo.vstack(
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
            ),
            mo.ui.plotly(_figure),
        ]
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## More of the view

    Click a view to give it the keys: **F** frames the selection, **Home**
    everything, **1** **3** **7** look from the front, the right and the
    top, **H** hides, **space** plays a run. The tools in its top-right
    corner export a PNG, or one HTML file that works without this notebook.
    """)
    return


@app.cell(hide_code=True)
def _(SceneWidget, magpy, mo, np):
    mm = 1e-3

    def _every_kind():
        # The centrepiece: a Möbius band, as the docs build one -- vertices
        # from its middle line out to its edge, twice round, which covers
        # both halves of it -- its current running over both its faces.
        # Turned to the view's first look, which comes from 51 degrees below
        # x, so that its twist shows.
        round_twice = np.linspace(0, 4 * np.pi, 160)

        def band(w):
            reach = 1 + w * np.cos(round_twice / 2)
            return np.column_stack(
                [
                    reach * np.cos(round_twice),
                    reach * np.sin(round_twice),
                    w * np.sin(round_twice / 2),
                ]
            )

        strip = np.empty((320, 3))
        strip[0::2], strip[1::2] = band(0), band(0.36)
        moebius = magpy.current.TriangleStrip(
            current=20, vertices=strip * 16 * mm, style_label="Möbius band"
        )
        moebius.rotate_from_angax(-51, "z", anchor=0)

        # a square sheet, as the docs build one: its current circulating, the
        # stronger the further out
        side = np.linspace(-5, 5, 11) * mm
        sheet = np.array([(x, y, 0) for x in side for y in side])
        sheet_faces = [
            face
            for i in range(10)
            for j in range(10)
            for face in (
                (j + 11 * i, j + 11 * i + 11, j + 11 * i + 12),
                (j + 11 * i, j + 11 * i + 12, j + 11 * i + 1),
            )
        ]
        centres = sheet[np.array(sheet_faces)].mean(axis=1)
        sheet_current = np.column_stack(
            [centres[:, 1], -centres[:, 0], np.zeros(len(centres))]
        ) / (5 * mm)

        # one of every other kind, each made with its magnetization along `p`
        kinds = {
            "mesh": lambda p: magpy.magnet.TriangularMesh.from_ConvexHull(
                polarization=p, points=np.vstack([np.eye(3), -np.eye(3)]) * 7.5 * mm
            ),
            "sphere": lambda p: magpy.magnet.Sphere(polarization=p, diameter=11 * mm),
            "cuboid": lambda p: magpy.magnet.Cuboid(
                polarization=p, dimension=(11 * mm,) * 3
            ),
            "cylinder": lambda p: magpy.magnet.Cylinder(
                polarization=p, dimension=(11 * mm, 13 * mm)
            ),
            "segment": lambda p: magpy.magnet.CylinderSegment(
                polarization=p, dimension=(5 * mm, 11 * mm, 10 * mm, -42, 42)
            ),
            "tetrahedron": lambda p: magpy.magnet.Tetrahedron(
                polarization=p,
                vertices=(
                    np.array([(0, 0, 0), (10, 0, 0), (0, 10, 0), (0, 0, 10)]) - 2.5
                )
                * 1.3
                * mm,
            ),
            "triangle": lambda p: magpy.misc.Triangle(
                polarization=(0, 0, 1),
                vertices=np.array([(-5, -4, 0), (5, -4, 0), (0, 5, 0)]) * 1.3 * mm,
            ),
            "loop": lambda p: magpy.current.Circle(current=10, diameter=13 * mm),
            "sheet": lambda p: magpy.current.TriangleSheet(
                current_densities=sheet_current, vertices=sheet, faces=sheet_faces
            ),
            "wire": lambda p: magpy.current.Polyline(
                current=10,
                vertices=np.array([(-6, -4, 0), (-2, 4, 0), (2, -4, 0), (6, 4, 0)])
                * 1.3
                * mm,
            ),
            "dipole": lambda p: magpy.misc.Dipole(
                moment=0.4 * np.array(p), style_size=12 * mm, style_sizemode="absolute"
            ),
        }
        # Round the band, in this order from 47 degrees: the magnets behind it,
        # as the view first looks, polarized round the ring; the flat ones in
        # front, stood up to face it.
        ring = []
        for k, name in enumerate(kinds):
            angle = np.deg2rad(47 + k * 360 / len(kinds))
            outward = np.array([np.cos(angle), np.sin(angle), 0])
            around = np.array([-np.sin(angle), np.cos(angle), 0])
            made = kinds[name](around)
            made.style.label = name
            reach = 37 * mm
            if name == "segment":
                # its arc bulging outward, and its own y round the ring
                made.rotate_from_angax(np.rad2deg(angle), "z", anchor=0)
                made.polarization = (0, 1, 0)
                reach -= 8 * mm
            elif name in ("triangle", "loop", "sheet", "wire"):
                # facing that first look: 51 degrees below x, 29 above the floor
                made.rotate_from_angax(61, "x", anchor=0)
                made.rotate_from_angax(39, "z", anchor=0)
            made.move(reach * outward)
            ring.append(made)
        objects = [moebius, *ring]
        return mo.vstack(
            [
                mo.md(
                    "Every kind of object, round a Möbius band whose current runs "
                    "over both its faces. Each takes the handles: **R** on a "
                    "magnet's faces resizes it, ⌥ moving the opposite one too; a "
                    "sphere and a loop resize by the rim; a shape made of points "
                    "has a dot on each, ⌘/ctrl-click to take several. Hold ⇧ to "
                    "land on another object's corner; Esc takes a drag back. These "
                    "are copies of the cell's objects, which stay as made."
                ),
                SceneWidget(*objects, editable=True, height=540),
            ]
        )

    _every_kind()
    return


@app.cell(hide_code=True)
def _(edited, json, mo, pair, pair_edited, pair_session, s, session):
    # Re-run after each edit, so the files hold the scenes as they are now.
    _ = edited(), pair_edited()

    def _downloads(document, code, name):
        return [
            mo.download(
                data=json.dumps(document.to_dict(), indent=2),
                filename=f"{name}.magpy.json",
                mimetype="application/json",
                label=f"{name}.magpy.json",
            ),
            mo.download(
                data=code.to_builder_script(),
                filename=f"{name}_scene.py",
                mimetype="text/x-python",
                label=f"{name}_scene.py",
            ),
        ]

    mo.sidebar(
        [
            mo.md("# Magpylib Studio"),
            mo.outline(),
            mo.md("**The scenes, as edited**"),
            mo.vstack(
                [
                    *_downloads(s, session, "halbach"),
                    *_downloads(pair, pair_session, "coils"),
                ],
                gap=0.5,
            ),
            mo.md(
                "_A `.magpy.json` opens in VS Code with **Magpylib Studio: Open "
                "Scene…**, never running code; the `.py` is the same function, "
                "written back from the document._"
            ),
        ],
        footer=mo.md("_magpylib-studio_"),
    )
    return


if __name__ == "__main__":
    app.run()
