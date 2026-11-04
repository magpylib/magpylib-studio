"""A test unit's operating steps, shared as a page:
`marimo edit examples/marimo/operating_steps.py`.

Eight variants, each a step; the page downloaded under the view carries all
eight, each drawn ahead with its field lines, and clicks through them with no
notebook behind it.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="Operating steps")


@app.cell
def _():
    from typing import Annotated

    import magpylib as magpy
    import marimo as mo

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
        grid,
        Length,
        magpy,
        mo,
        scene,
        SceneWidget,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Operating steps, on a page anyone can open

    A test unit's eight operating steps as **variants**: each slides the
    inlay along the core and turns the coil's current round. Click one
    along the foot of the view, or download the page under it: it carries
    all eight, each drawn ahead with its field lines, and a click on the
    page draws that step with no notebook behind it.
    """)
    return


@app.cell
def _(Annotated, Bounds, Length, grid, magpy, scene):
    @scene(
        model_unit="mm",
        field_unit="mT",
        variants={
            f"step {i}": {
                "shift": round(0.004 * i - 0.014, 4),
                "current": 2000.0 * (-1) ** i,
            }
            for i in range(8)
        },
    )
    def unit(
        shift: Annotated[float, Length(-0.02, 0.02)] = -0.014,
        current: Annotated[float, Bounds(-3000, 3000, unit="current")] = 2000.0,
    ):
        """A core of three legs, an inlay on it `shift` along, a coil under
        it carrying `current` amperes, and a probe in the plane of the legs."""
        core = magpy.Collection(style_label="core")
        for k, x in enumerate((-0.02, 0.0, 0.02)):  # literals
            core.add(
                magpy.magnet.Cuboid(
                    dimension=(0.01, 0.01, 0.03),
                    polarization=(0, 0, 0),
                    position=(x, 0, 0),
                    style_label=f"leg {k}",
                )
            )
        inlay = magpy.magnet.Cuboid(
            dimension=(0.01, 0.01, 0.005),
            polarization=(0, 0, 1),
            position=(0, 0, 0.02),
            style_label="inlay",
        )
        inlay.move((shift, 0, 0))
        coil = magpy.current.Circle(
            current=current,
            diameter=0.04,
            position=(0, 0, -0.02),
            style_label="coil",
        )
        probe = magpy.Sensor(
            pixel=grid(0.04, 9, plane="xz"),
            style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
        )
        return core, inlay, coil, probe

    return (unit,)


@app.cell
def _(SceneWidget, mo, unit):
    # The page is written when the button is clicked, so it holds the steps
    # as the scene is then: each drawn ahead, which takes a moment.
    steps_view3d = SceneWidget(
        unit.build(),
        editable=True,
        height=480,
        field_lines=True,
        open_panel="variables",
    )
    mo.vstack(
        [
            mo.ui.anywidget(steps_view3d),
            mo.download(
                data=lambda: steps_view3d.to_html("operating steps"),
                filename="steps.html",
                mimetype="text/html",
                label="steps.html: the eight steps, a click each, no notebook",
            ),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
