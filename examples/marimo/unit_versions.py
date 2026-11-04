"""Two versions of a unit that differ in structure:
`marimo edit examples/marimo/unit_versions.py`.

`choose(version)` picks what the scene is made of; one document holds both
versions, and the variants mix the choice with the other variables.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="Unit versions")


@app.cell
def _():
    from typing import Annotated

    import magpylib as magpy
    import marimo as mo

    from magpylib_studio import (
        Bounds,
        Length,
        choose,
        duplicate_along,
        grid,
        scene,
    )
    from magpylib_studio.widget import SceneWidget

    return (
        Annotated,
        Bounds,
        choose,
        duplicate_along,
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
    # Versions that differ in structure

    A choice can pick what a scene is made of, not only a value:
    `versions = choose(version)`, then `versions.add("v2", ...)`. One
    document holds both versions, a narrow core with two inlay pieces and
    a wide one with three and a notch, and the one **version** names is in
    the scene: drawn, listed, in the field. A piece moved in one version is
    still where you left it when you come back to it.

    The other variables mix in as before. **spacing** spreads v1's two
    pieces, and only v1 reads it: with v2 shown its slider is dimmed.
    **current** is the coil's, both versions'. A variant sets what it
    names: **v2 reversed** sets the version and the current at once, and
    **v1** then sets only the version, so the current stays reversed.
    """)
    return


@app.cell
def _(Annotated, Bounds, Length, choose, duplicate_along, grid, magpy, scene):
    import typing

    @scene(
        model_unit="mm",
        field_unit="mT",
        variants={
            "v1": {"version": "v1"},
            "v1 wide": {"version": "v1", "spacing": 0.018},
            "v2": {"version": "v2"},
            "v2 reversed": {"version": "v2", "current": -2000.0},
        },
    )
    def mtu(
        version: typing.Literal["v1", "v2"] = "v1",
        spacing: Annotated[float, Length(0.008, 0.024)] = 0.012,
        current: Annotated[float, Bounds(-3000, 3000, unit="current")] = 2000.0,
    ):
        """Two versions of a test unit: a narrow core with two inlay pieces
        `spacing` apart, and a wide one with three and a notched piece under
        it. The coil, carrying `current` amperes, and the probe are both
        versions'."""
        versions = choose(version, style_label="versions")
        core1 = magpy.magnet.Cuboid(
            dimension=(0.03, 0.01, 0.01), polarization=(0, 0, 1), style_label="core"
        )
        piece1 = magpy.magnet.Cuboid(
            dimension=(0.006, 0.008, 0.004),
            polarization=(0.8, 0, 0),
            position=(-spacing / 2, 0, 0.008),
            style_label="inlay",
        )
        inlay1 = magpy.Collection(piece1, style_label="inlay")
        versions.add("v1", core1, inlay1)
        duplicate_along(piece1, count=2, step=(spacing, 0, 0))
        core2 = magpy.magnet.Cuboid(
            dimension=(0.044, 0.012, 0.01), polarization=(0, 0, 1), style_label="core"
        )
        piece2 = magpy.magnet.Cuboid(
            dimension=(0.006, 0.008, 0.004),
            polarization=(0.8, 0, 0),
            position=(-0.014, 0, 0.008),
            style_label="inlay",
        )
        notch = magpy.magnet.Cuboid(
            dimension=(0.008, 0.012, 0.003),
            polarization=(0, 0, -0.6),
            position=(0, 0, -0.0065),
            style_label="notch",
        )
        inlay2 = magpy.Collection(piece2, style_label="inlay")
        versions.add("v2", core2, inlay2, notch)
        duplicate_along(piece2, count=3, step=(0.014, 0, 0))
        coil = magpy.current.Circle(
            current=current, diameter=0.05, position=(0, 0, -0.016), style_label="coil"
        )
        probe = magpy.Sensor(
            pixel=grid(0.04, 11, plane="xz"),
            style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
        )
        return versions, coil, probe

    return (mtu,)


@app.cell
def _(SceneWidget, mo, mtu):
    mtu_view3d = SceneWidget(
        mtu.build(), editable=True, height=480, field_lines=True, open_panel="variables"
    )
    mo.ui.anywidget(mtu_view3d)
    return


if __name__ == "__main__":
    app.run()
