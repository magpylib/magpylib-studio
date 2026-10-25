"""A magnet meshed into cells, in the view: `marimo edit examples/ucore_demo.py`.

Needs the widget extra, marimo and magpylib-material-response:

    uv pip install -e ".[widget]" marimo magpylib-material-response

The U-core of material-response's docs: three soft-iron cuboids (chi = 999)
wound with a coil of sixteen turns, meshed into about as many cells as asked
for and solved for each cell's polarization. The cells are sealed into one
body and shown with the coil and the field lines of a probe in the plane
y = 0, the core's plane of symmetry, `density` by `density` of them, a
variable of the scene. The time each step took is said under the view: a
scene of thousands of objects, which the view, its field lines and a drag
have to keep up with.
"""

import marimo

__generated_with = "0.25.2"
app = marimo.App(width="full", app_title="U-core in the studio")


@app.cell
def _():
    import time
    from typing import Annotated

    import magpylib as magpy
    import marimo as mo
    import numpy as np
    from magpylib_material_response.demag import apply_demag
    from magpylib_material_response.meshing import mesh_all
    from magpylib_material_response.polyline import (
        create_polyline_fillet,
        move_grid_along_polyline,
    )

    from magpylib_studio import Count, grid, scene
    from magpylib_studio.widget import SceneWidget

    return (
        Annotated,
        Count,
        SceneWidget,
        apply_demag,
        create_polyline_fillet,
        grid,
        magpy,
        mesh_all,
        mo,
        move_grid_along_polyline,
        np,
        scene,
        time,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A U-core meshed into cells

    Meshed into as many **cells** as chosen, and solved again when you
    choose another: a few tenths of a second at 768, about twenty at 5,888.
    The cells are one body: a click on any picks it whole. Slide **density**
    in the variables panel for more or fewer field lines, click one to take
    the probe, and drag it through the core's plane.
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
def _(apply_demag, magpy, mesh_all, target, time, ucore):
    t0 = time.perf_counter()
    core, coil = ucore()
    meshed = mesh_all(magpy.Collection(core, coil), target_elems=target.value)
    t1 = time.perf_counter()
    solved = apply_demag(meshed)
    t2 = time.perf_counter()
    cells = [s for s in solved.sources_all if isinstance(s, magpy.magnet.Cuboid)]
    windings = [
        s.vertices for s in solved.sources_all if isinstance(s, magpy.current.Polyline)
    ]
    solved_in = (
        f"{len(cells)} cells, meshed in {t1 - t0:.2f} s and solved in {t2 - t1:.1f} s"
    )
    return cells, solved_in, windings


@app.cell
def _(Annotated, Count, cells, grid, magpy, scene, windings):
    @scene(model_unit="mm", field_unit="mT")
    def ucore_scene(density: Annotated[int, Count(4, 40, slider=(5, 25))] = 15):
        """The solved core, sealed into one body made of its cells; the coil;
        and a probe in the core's plane of symmetry, `density` by `density`
        pixels across 140 mm, drawn as its field lines."""
        coil = magpy.Collection(
            *(magpy.current.Polyline(current=25, vertices=v) for v in windings),
            style_label="coil",
        )
        probe = magpy.Sensor(
            position=(0, 0, 0.0325),
            pixel=grid(0.07, density, plane="xz"),
            style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
        )
        # Made last: every step a scene records builds what is made before it
        # again, and the core is thousands of cells -- 2.4 s to build at
        # 5,888 made last, 7.5 made first.
        iron = magpy.Collection(style_label="U-core")
        iron.sealed = True  # before its cells are added: they are its data
        iron.add(
            *(
                magpy.magnet.Cuboid(
                    dimension=cell.dimension,
                    polarization=cell.polarization,
                    position=cell.position,
                    orientation=cell.orientation,
                )
                for cell in cells
            )
        )
        return iron, coil, probe

    return (ucore_scene,)


@app.cell
def _(SceneWidget, mo, solved_in, time, ucore_scene):
    t3 = time.perf_counter()
    view = SceneWidget(
        ucore_scene.build(),
        editable=True,
        field_lines=True,
        open_panel="variables",
        height=720,
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
