"""A run beside variants, solved and drawn with field lines, every combination
exportable: `marimo edit examples/marimo/run_with_variants.py`.

Needs the widget extra, marimo and magpylib-material-response 0.9.2, and says
so without it:

    uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.9.2"
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="A run beside variants")


@app.cell
def _():
    import json
    from typing import Annotated

    import magpylib as magpy
    import marimo as mo
    import numpy as np

    from magpylib_studio import (
        Bounds,
        Length,
        grid,
        scene,
    )
    from magpylib_studio.widget import SceneWidget

    return (
        Annotated,
        Bounds,
        json,
        Length,
        grid,
        magpy,
        mo,
        np,
        scene,
        SceneWidget,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A run beside variants, solved, with field lines

    A magnet slides across a soft-iron plate in thirteen steps: the scene's
    path is the run, played by the transport at the foot of the view. The
    plate is solved by face charge, sheets of charge on its surfaces, and
    keeps the part it was solved from, so the view solves it again when the
    magnet's height or strength changes. The **low**, **high** and
    **reversed** variants are a click each, beside the transport.

    Every step of every variant has its own solve and its own field lines:
    material-response solves one configuration, so the view hands it each
    step. The view's download button, in its top-right corner, writes a page
    that carries them all and plays any variant's run with no notebook
    behind it: fifty-one frames, each solved and drawn, a few seconds, which
    the foot of the view counts and its Cancel stops. Dragging, or a variable the
    variants do not name, needs the notebook: a new solve, a new field.
    """)
    return


@app.cell
def _(mo):
    # magpylib-material-response is not one of studio's dependencies: without
    # it, or before 0.9.2, this page says so.
    try:
        from magpylib_material_response import solve_face_charge
        from magpylib_material_response.face_charge import ChargeSheet
    except ImportError:
        ChargeSheet = None
    mo.stop(
        ChargeSheet is None or not hasattr(ChargeSheet, "part"),
        mo.md(
            "_Needs magpylib-material-response 0.9.2: "
            '`uv pip install "magpylib-material-response>=0.9.2"`._'
        ),
    )
    return ChargeSheet, solve_face_charge


@app.cell
def _(ChargeSheet, magpy, solve_face_charge):
    # Solved once here, outside the scene function -- a solve inside one is
    # refused -- each sheet keeping the part it was solved from, for the view
    # to solve again from.
    _start = magpy.magnet.Cuboid(
        polarization=(0, 0, 1.2), dimension=(0.01, 0.01, 0.005), position=(0, 0, 0.0085)
    )
    _iron = magpy.magnet.Cuboid(polarization=(0, 0, 0), dimension=(0.06, 0.03, 0.004))
    _iron.susceptibility = 1000
    _solved = solve_face_charge(magpy.Collection(_start, _iron), level=1)
    plate_sheets = [s for s in _solved.sources_all if isinstance(s, ChargeSheet)]
    plate_parts = [s.part for s in plate_sheets]  # read here: each read makes a magnet
    return plate_parts, plate_sheets


@app.cell
def _(
    Annotated,
    Bounds,
    ChargeSheet,
    Length,
    grid,
    magpy,
    np,
    plate_parts,
    plate_sheets,
    scene,
):
    @scene(
        model_unit="mm",
        field_unit="mT",
        solve_level=1,
        variants={
            "low": {"height": 0.006, "strength": 1.2},
            "high": {"height": 0.016, "strength": 1.2},
            "reversed": {"height": 0.006, "strength": -1.2},
        },
    )
    def slide(
        height: Annotated[float, Length(0.005, 0.03)] = 0.006,
        strength: Annotated[float, Bounds(-1.5, 1.5, unit="field")] = 1.2,
    ):
        """A magnet `height` above a solved plate, polarized `strength` tesla
        up, sliding across it in thirteen steps, and a probe in the plane of
        the slide, drawn as its field lines."""
        magnet = magpy.magnet.Cuboid(
            polarization=(0, 0, strength),
            dimension=(0.01, 0.01, 0.005),
            position=(-0.024, 0, height),
            style_label="magnet",
        )
        magnet.move(np.linspace((0, 0, 0), (0.048, 0, 0), 13), start=0)
        plate = magpy.Collection(
            *(
                ChargeSheet(
                    vertices=s.vertices,
                    faces=s.faces,
                    charge_densities=s.charge_densities,
                    panels=s.panels,
                    mean_polarization=s.mean_polarization,
                    part=part,
                    position=s.position,
                    style={
                        "label": s.style.label,
                        "charge": {"level": s.style.charge.level},
                    },
                )
                for s, part in zip(plate_sheets, plate_parts, strict=True)
            ),
            style_label="plate",
        )
        probe = magpy.Sensor(
            position=(0, 0, 0.004),
            pixel=grid(0.04, 13, plane="xz"),
            style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
        )
        return plate, magnet, probe

    return (slide,)


@app.cell
def _(SceneWidget, json, mo, slide):
    built = slide.build()
    view3d = SceneWidget(
        built, editable=True, height=560, field_lines=True, open_panel="variables"
    )
    # Written when clicked, so it holds the scene as it is then. The page is
    # the view's own download button: written a piece at a time, so it can be
    # stopped, where a `mo.download` keeps the kernel busy until it is done.
    mo.vstack(
        [
            mo.ui.anywidget(view3d),
            mo.download(
                data=lambda: json.dumps(built.to_dict(), indent=2),
                filename="slide.magpy.json",
                mimetype="application/json",
                label="slide.magpy.json",
            ),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
