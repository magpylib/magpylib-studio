"""A magnet meshed into cells, in the view: `marimo edit examples/ucore_demo.py`.

Needs the widget extra, marimo and magpylib-material-response:

    uv pip install -e ".[widget]" marimo magpylib-material-response

The U-core of material-response's docs: three soft-iron cuboids (chi = 999)
wound with a coil of sixteen turns, meshed into about as many cells as asked
for and solved for each cell's polarization. The cells are shown with the
coil and the field lines of a probe in the plane y = 0, the core's plane of
symmetry, and the time each step took is said under the view: a scene of
thousands of objects, which the view, its field lines and a drag have to keep
up with.
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="U-core in the studio")


@app.cell
def _():
    import time

    import magpylib as magpy
    import marimo as mo
    import numpy as np
    from magpylib_material_response.demag import apply_demag
    from magpylib_material_response.meshing import mesh_all
    from magpylib_material_response.polyline import (
        create_polyline_fillet,
        move_grid_along_polyline,
    )

    from magpylib_studio.widget import SceneWidget

    return (
        SceneWidget,
        apply_demag,
        create_polyline_fillet,
        magpy,
        mesh_all,
        mo,
        move_grid_along_polyline,
        np,
        time,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A U-core meshed into cells

    Meshed into as many **cells** as chosen, and solved again when you
    choose another: a few tenths of a second at 768, about twenty at 5,888.
    Click a field line to take the probe, and drag it through the core's
    plane.
    """)
    return


@app.cell
def _(mo):
    # what mesh_all is asked for, by the cells it gives
    target = mo.ui.dropdown(
        options={"270": 250, "768": 1000, "2,520": 3000, "5,888": 6500},
        value="768",
        label="cells",
    )
    target
    return (target,)


@app.cell
def _(create_polyline_fillet, magpy, move_grid_along_polyline, np):
    def ucore():
        """The core, chi = 999 on the collection its cells inherit, and the
        coil round its yoke: 16 windings of 25 A, 400 ampere-turns."""
        a = 0.02
        yoke = magpy.magnet.Cuboid(dimension=(0.10, a, a), style_label="yoke")
        leg_left = magpy.magnet.Cuboid(
            dimension=(a, a, 0.06), position=(-0.04, 0, 0.04), style_label="left leg"
        )
        leg_right = magpy.magnet.Cuboid(
            dimension=(a, a, 0.06), position=(0.04, 0, 0.04), style_label="right leg"
        )
        core = magpy.Collection(yoke, leg_left, leg_right, style_label="U-core")
        core.susceptibility = 999
        h = 0.014
        square = np.array(
            [[0, h, 0], [0, h, h], [0, -h, h], [0, -h, -h], [0, h, -h], [0, h, 0]]
        )
        turn = create_polyline_fillet(square, max_radius=0.006, N=6)
        pitch = 0.0022
        pack = np.array(
            [
                (xt, yl, 0)
                for xt in (np.arange(8) - 3.5) * pitch
                for yl in h + np.arange(2) * pitch
            ]
        )
        windings = move_grid_along_polyline(turn, pack)
        coil = magpy.Collection(
            *(magpy.current.Polyline(current=25, vertices=v) for v in windings),
            style_label="coil",
        )
        return core, coil

    return (ucore,)


@app.cell
def _(apply_demag, magpy, mesh_all, np, target, time, ucore):
    t0 = time.perf_counter()
    core, coil = ucore()
    meshed = mesh_all(magpy.Collection(core, coil), target_elems=target.value)
    t1 = time.perf_counter()
    solved = apply_demag(meshed)
    t2 = time.perf_counter()
    cells = [s for s in solved.sources_all if isinstance(s, magpy.magnet.Cuboid)]
    iron = magpy.Collection(*cells, override_parent=True, style_label="U-core")
    # one body made of its cells: picked, moved and hidden whole
    iron.sealed = True
    windings = magpy.Collection(
        *(s for s in solved.sources_all if isinstance(s, magpy.current.Polyline)),
        override_parent=True,
        style_label="coil",
    )
    # a probe of 15 x 14 pixels in the core's plane, drawn as its field lines
    x, z = np.meshgrid(
        np.linspace(-0.07, 0.07, 15), np.linspace(-0.035, 0.1, 14), indexing="ij"
    )
    probe = magpy.Sensor(
        pixel=np.stack([x, np.zeros_like(x), z], axis=-1),
        style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
    )
    solved_in = (
        f"{len(cells)} cells, meshed in {t1 - t0:.2f} s and solved in {t2 - t1:.1f} s"
    )
    return iron, probe, solved_in, windings


@app.cell
def _(SceneWidget, iron, mo, probe, solved_in, time, windings):
    t3 = time.perf_counter()
    view = SceneWidget(
        iron, windings, probe, field_lines=True, editable=True, height=720
    )
    shown_in = time.perf_counter() - t3
    mo.vstack(
        [
            mo.ui.anywidget(view),
            mo.md(f"{solved_in}; the view and its field lines in {shown_in:.1f} s."),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
