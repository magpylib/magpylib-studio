"""A U-core solved again under your hand: `marimo edit examples/ucore_solve_demo.py`.

Needs the widget extra, marimo and magpylib-material-response 0.9.2:

    uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.9.2"

The U-core of material-response's docs, three soft-iron cuboids (chi = 999)
wound with a coil of 400 ampere-turns, with a magnet in its gap and two uniform
fields on it, solved by face charge: sheets of charge on the core's surfaces and no volume mesh. Each sheet
keeps the part it was solved from, so the view solves the core again at every
step of a drag, with nothing written here to ask for it. What the solve keeps
does the rest: `solve_face_charge(model, reuse=solved)` takes only a new
load and a back-substitution while the core stays as it was, so moving the
magnet, changing the coil's current or a field costs milliseconds. Pull a leg off the
yoke and the matrix changes, so each step factors it again. The result stays
right just past contact, which is where 0.8 fixed face charge. What each solve
did is said under the view, from `solved_by` and `face_charge_info`.
"""

import marimo

__generated_with = "0.25.2"
app = marimo.App(width="full", app_title="U-core, solved while you drag")


@app.cell
def _():
    from typing import Annotated

    import magpylib as magpy
    import marimo as mo
    import numpy as np
    from magpylib_material_response import UniformField, solve_face_charge
    from magpylib_material_response.face_charge import ChargeSheet
    from magpylib_material_response.polyline import (
        create_polyline_fillet,
        move_grid_along_polyline,
    )

    from magpylib_studio import Bounds, Count, grid, scene
    from magpylib_studio.widget import SceneWidget

    return (
        Annotated,
        Bounds,
        ChargeSheet,
        Count,
        SceneWidget,
        UniformField,
        create_polyline_fillet,
        grid,
        magpy,
        mo,
        move_grid_along_polyline,
        np,
        scene,
        solve_face_charge,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A U-core solved while you drag

    Drag the **magnet**, or slide **current** or **vertical** in the variables
    panel: the core is solved again at every step, and its colours and the field
    lines follow. Drag a **leg** off the yoke and each step costs a whole solve.
    One undo takes back the move and its solve together.

    The arrow in the corner is the sum of the two uniform fields. Pick one in the
    legend for its own arrow and its **B** in the object panel; pick both for
    their sum.
    """)
    return


@app.cell
def _(mo):
    level = mo.ui.dropdown(
        options={"2": 2, "3": 3, "4": 4},
        value="2",
        label="panels: level",
    )
    level
    return (level,)


@app.cell
def _(create_polyline_fillet, magpy, move_grid_along_polyline, np):
    a = 0.02
    #: The core's parts, each its label and its dimension, in the order solved.
    parts = {
        "yoke": (0.10, a, a),
        "left leg": (a, a, 0.06),
        "right leg": (a, a, 0.06),
    }

    def solvable(placed, *drives):
        """The model to solve: a soft cuboid for each of `parts`, at the pose
        in `placed`, and the sources that `drives` hold."""
        core = magpy.Collection(
            *(
                magpy.magnet.Cuboid(
                    dimension=dimension,
                    position=position,
                    orientation=orientation,
                    style_label=label,
                )
                for (label, dimension), (position, orientation) in zip(
                    parts.items(), placed, strict=True
                )
            ),
            style_label="U-core",
        )
        core.susceptibility = 999
        return magpy.Collection(core, *drives)

    # Where the parts start: the yoke, and a leg standing on each end of it.
    poses = [((0, 0, 0), None), ((-0.04, 0, 0.04), None), ((0.04, 0, 0.04), None)]

    h = 0.014
    square = np.array(
        [[0, h, 0], [0, h, h], [0, -h, h], [0, -h, -h], [0, h, -h], [0, h, 0]]
    )
    # Four turns where the docs wind sixteen, at the same 400 ampere-turns: a
    # solve computes the coil's field on every panel again, and 400 segments
    # made it 167 ms a step where the magnet alone is 15.
    turn = create_polyline_fillet(square, max_radius=0.006, N=2)
    pack = np.array([(xt, h + 0.0011, 0) for xt in (np.arange(4) - 1.5) * 0.0044])
    windings = move_grid_along_polyline(turn, pack)
    return poses, solvable, windings


@app.cell
def _(
    Annotated,
    Bounds,
    ChargeSheet,
    Count,
    UniformField,
    grid,
    level,
    magpy,
    poses,
    scene,
    solvable,
    solve_face_charge,
    windings,
):
    def _magnet():
        return magpy.magnet.Cuboid(
            dimension=(0.02, 0.01, 0.01),
            polarization=(1.2, 0, 0),
            position=(0, 0, 0.055),
            style_label="magnet",
        )

    def _fields(vertical):
        """A field along z, in tesla, and a weaker one turned about z. A field
        is the same everywhere, so it has no place: only its turn counts."""
        upward = UniformField(B=(0, 0, vertical), style_label="vertical")
        turned = UniformField(B=(0.008, 0, 0), style_label="turned")
        turned.rotate_from_angax(30, "z")
        return upward, turned

    _coil = magpy.Collection(
        *(magpy.current.Polyline(current=100, vertices=v) for v in windings)
    )
    # Kept by `reuse=True`, for the first step of a drag to reuse: 8 n² bytes,
    # on the result, so only the last result is held.
    solved = solve_face_charge(
        solvable(poses, _magnet(), _coil, *_fields(0.01)),
        level=level.value,
        reuse=True,
    )
    sheets = [s for s in solved.sources_all if isinstance(s, ChargeSheet)]
    _parts = [s.part for s in sheets]  # read here: each read makes a magnet

    @scene(model_unit="mm", field_unit="mT", solve_level=level.value)
    def ucore_scene(
        current: Annotated[float, Bounds(-200, 200, unit="current")] = 100,
        vertical: Annotated[float, Bounds(-0.1, 0.1, unit="field")] = 0.01,
        density: Annotated[int, Count(4, 40, slider=(5, 25))] = 15,
    ):
        """The solved core, the coil at `current` amperes, the magnet in the
        gap, the two fields, and a probe in the core's plane of symmetry,
        `density` by `density` pixels across 140 mm, drawn as its field
        lines."""
        magnet = _magnet()
        upward, turned = _fields(vertical)
        coil = magpy.Collection(
            *(magpy.current.Polyline(current=current, vertices=v) for v in windings),
            style_label="coil",
        )
        probe = magpy.Sensor(
            position=(0, 0, 0.0325),
            pixel=grid(0.07, density, plane="xz"),
            style={"label": "probe", "pixel": {"size": 0, "field": {"source": "B"}}},
        )
        iron = magpy.Collection(
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
                for s, part in zip(sheets, _parts, strict=True)
            ),
            style_label="U-core",
        )
        return iron, coil, magnet, upward, turned, probe

    return solved, ucore_scene


@app.cell
def _(SceneWidget, mo, ucore_scene):
    view3d = SceneWidget(
        ucore_scene.build(),
        editable=True,
        field_lines=True,
        open_panel="variables",
        height=720,
    )
    last = {"solves": []}
    edited, set_edited = mo.state(0)

    def told(change):
        """An edit let go: what it solved, for the line under the view."""
        last["solves"] = view3d.last_edit.get("solves", last["solves"])
        set_edited(change.new)

    view3d.observe(told, names="revision")
    view = mo.as_html(mo.ui.anywidget(view3d))
    return edited, last, view


@app.cell
def _(edited, last, mo, solved, view):
    edited()  # the numbers follow each edit, when it is let go
    _solves = last["solves"]
    _info = _solves[-1] if _solves else solved.face_charge_info
    _said = (
        f"Solved by `{solved.solved_by}` at level {_info['level']}, "
        f"{_info['unknowns']:,} unknowns, "
        f"in {_info['seconds'] * 1000:.0f} ms"
        f"{', on the factorization it kept' if _info['reused'] else ''}."
    )
    if _solves:
        _mean = sum(each["seconds"] for each in _solves) / len(_solves)
        _said += (
            f" The last edit solved {len(_solves)} times, "
            f"at {_mean * 1000:.0f} ms each."
        )
    mo.vstack([view, mo.md(_said)])
    return


if __name__ == "__main__":
    app.run()
