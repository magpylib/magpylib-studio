"""Overlapping magnets, found as you drag: `marimo edit examples/overlaps_demo.py`.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo

A scene where one magnet overlaps another and everything else only touches: a
Halbach ring, a shaft in its bore, two cubes side by side, a coil on its core.
The view outlines what overlaps in amber, frame by frame while a magnet is
dragged, and the legend marks it. The table under it lists the pairs after each settled edit: the
ones the view outlines, read off the scene it was sent.
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Overlapping magnets")


@app.cell
def _():
    import magpylib as magpy
    import marimo as mo

    from magpylib_studio.widget import SceneWidget

    return SceneWidget, magpy, mo


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Which magnets overlap

    Magpylib adds the magnetizations of two magnets wherever they overlap,
    so a magnet pushed into its neighbour computes a field that looks right
    and is not. The view outlines every magnet that overlaps another in
    amber, and the legend marks its row; the count above the legend steps
    through the pairs. Touching does not count: the Halbach ring, the shaft in its
    bore, the cubes **a** and **b** side by side and the coil on its core all
    touch on purpose. Only **c**, pushed 1 mm into **b**, overlaps.

    Select **c** and drag it out of **b** (**W** moves): the outline goes as
    you drag. Push a cube into a ring segment, or into the shaft, and it comes
    back.
    """)
    return


@app.cell
def _(SceneWidget, magpy, mo):
    mm = 1e-3
    # A Halbach ring of eight segments, each touching its neighbours. A name
    # each, so that the view knows them by name.
    s1, s2, s3, s4, s5, s6, s7, s8 = [
        magpy.magnet.CylinderSegment(
            dimension=(10 * mm, 16 * mm, 8 * mm, 45 * i, 45 * (i + 1)),
            polarization=(0, 0, 1),
            style_label=f"segment {i + 1}",
        )
        for i in range(8)
    ]
    # A shaft that fits its bore exactly.
    shaft = magpy.magnet.Cylinder(
        dimension=(20 * mm, 30 * mm), polarization=(0, 0, 1), style_label="shaft"
    )
    # Two cubes side by side, and a third pushed 1 mm into the second.
    a = magpy.magnet.Cuboid(
        dimension=(10 * mm,) * 3,
        polarization=(1, 0, 0),
        position=(30 * mm, 0, 0),
        style_label="a",
    )
    b = magpy.magnet.Cuboid(
        dimension=(10 * mm,) * 3,
        polarization=(1, 0, 0),
        position=(40 * mm, 0, 0),
        style_label="b",
    )
    c = magpy.magnet.Cuboid(
        dimension=(10 * mm,) * 3,
        polarization=(0, 1, 0),
        position=(40 * mm, 9 * mm, 0),
        style_label="c",
    )
    # A coil wound on its core.
    core = magpy.magnet.Cylinder(
        dimension=(12 * mm, 20 * mm),
        polarization=(0, 0, 1),
        position=(0, 40 * mm, 0),
        style_label="core",
    )
    coil = magpy.current.Circle(
        diameter=12 * mm, current=1, position=(0, 40 * mm, 0), style_label="coil"
    )

    view3d = SceneWidget(
        s1,
        s2,
        s3,
        s4,
        s5,
        s6,
        s7,
        s8,
        shaft,
        a,
        b,
        c,
        core,
        coil,
        editable=True,
        height=520,
    )
    view = mo.ui.anywidget(view3d)
    view
    return view, view3d


@app.cell(hide_code=True)
def _(mo, view, view3d):
    # Reads the view, so it re-runs once per settled edit -- a drag's end,
    # an undo -- never a frame of a drag in progress. The pairs are the ones
    # the view outlines, by id: a pattern's copies included.
    _ = view.value["revision"]
    _pairs = view3d.payload.get("overlaps", [])
    _objects = view3d.objects

    def _name(key):
        return _objects[key].style.label if key in _objects else key

    mo.vstack(
        [
            mo.md(
                f"**{len(_pairs)} overlapping pair{'' if len(_pairs) == 1 else 's'}** "
                f"after {view.value['revision']} edits."
            ),
            mo.ui.table(
                [{"magnet": _name(a), "overlaps": _name(b)} for a, b in _pairs],
                selection=None,
            )
            if _pairs
            else mo.md("Nothing overlaps: every magnet only touches its neighbours."),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
