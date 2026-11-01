"""A U-core solved again under your hand: `marimo edit examples/ucore_solve_demo.py`.

Needs the widget extra, marimo and magpylib-material-response 0.8:

    uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.8"

The U-core of material-response's docs, three soft-iron cuboids (chi = 999)
wound with a coil of 400 ampere-turns, with a magnet in its gap, solved by face
charge: sheets of charge on the core's surfaces and no volume mesh. Every step
of a drag solves the core again (`SceneWidget.follow_edits`). What the solve
keeps does the rest: `apply_face_charge(model, reuse=solved)` takes only a new
load and a back-substitution while the core stays as it was, so moving the
magnet or changing the coil's current costs milliseconds. Pull a leg off the
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
    from magpylib_material_response.face_charge import (
        ChargeSheet,
        apply_face_charge,
    )
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
        apply_face_charge,
        create_polyline_fillet,
        grid,
        magpy,
        mo,
        move_grid_along_polyline,
        np,
        scene,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A U-core solved while you drag

    Drag the **magnet**, or slide **current** in the variables panel: the core
    is solved again at every step, and its colours and the field lines follow.
    Drag a **leg** off the yoke and each step costs a whole solve. One undo
    takes back the move and its solve together.
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
    apply_face_charge,
    grid,
    level,
    magpy,
    poses,
    scene,
    solvable,
    windings,
):
    def _magnet():
        return magpy.magnet.Cuboid(
            dimension=(0.02, 0.01, 0.01),
            polarization=(1.2, 0, 0),
            position=(0, 0, 0.055),
            style_label="magnet",
        )

    _coil = magpy.Collection(
        *(magpy.current.Polyline(current=100, vertices=v) for v in windings)
    )
    # Kept by `reuse=True`, for the first step of a drag to reuse: 8 n² bytes,
    # on the result, so only the last result is held.
    solved = apply_face_charge(
        solvable(poses, _magnet(), _coil), level=level.value, reuse=True
    )
    sheets = [s for s in solved.sources_all if isinstance(s, ChargeSheet)]

    @scene(model_unit="mm", field_unit="mT")
    def ucore_scene(
        current: Annotated[float, Bounds(-200, 200, unit="current")] = 100,
        density: Annotated[int, Count(4, 40, slider=(5, 25))] = 15,
    ):
        """The solved core, the coil at `current` amperes, the magnet in the
        gap, and a probe in the core's plane of symmetry, `density` by
        `density` pixels across 140 mm, drawn as its field lines."""
        magnet = _magnet()
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
                    position=s.position,
                    style={
                        "label": s.style.label,
                        "charge": {"level": s.style.charge.level},
                    },
                )
                for s in sheets
            ),
            style_label="U-core",
        )
        return iron, coil, magnet, probe

    return solved, ucore_scene


@app.cell
def _(SceneWidget, mo, solved, ucore_scene):
    view3d = SceneWidget(
        ucore_scene.build(),
        editable=True,
        field_lines=True,
        open_panel="variables",
        height=720,
    )
    last = {"solved": solved, "seconds": [], "edit": []}
    edited, set_edited = mo.state(0)

    def told(change):
        """An edit let go: what it solved, for the line under the view. An
        undo comes back to a scene solved already, but not the last one solved."""
        if last["seconds"]:
            last["edit"], last["seconds"] = last["seconds"], []
        if view3d.last_edit.get("by") in ("undo", "redo", "reset"):
            last.pop("state", None)
        set_edited(change.new)

    view3d.observe(told, names="revision")
    view = mo.as_html(mo.ui.anywidget(view3d))
    return edited, last, view, view3d


@app.cell
def _(
    ChargeSheet,
    apply_face_charge,
    last,
    level,
    magpy,
    np,
    solvable,
    view3d,
):
    def state_of(objects):
        """What a solve follows from, to tell an edit that changes it from one
        that does not, a probe dragged or its density."""
        return [
            (
                obj.position.tobytes(),
                obj.orientation.as_quat().tobytes(),
                *(
                    np.asarray(getattr(obj, name)).tobytes()
                    for name in ("polarization", "dimension", "current", "vertices")
                    if hasattr(obj, name)
                ),
            )
            for obj in objects.values()
            if not isinstance(obj, magpy.Sensor | magpy.Collection)
        ]

    def follow(objects):
        """The core solved again where the view's objects now stand."""
        state = state_of(objects)
        if state == last.get("state"):
            return None
        last["state"] = state
        ids = [k for k, obj in objects.items() if isinstance(obj, ChargeSheet)]
        drives = [
            obj.copy()
            for obj in objects.values()
            if isinstance(obj, magpy.magnet.Cuboid | magpy.current.Polyline)
        ]
        placed = [(objects[k].position, objects[k].orientation) for k in ids]
        out = apply_face_charge(
            solvable(placed, *drives), level=level.value, reuse=last["solved"]
        )
        last["solved"] = out
        last["seconds"].append(out.face_charge_info["seconds"])
        sheets = [s for s in out.sources_all if isinstance(s, ChargeSheet)]
        return {
            k: {
                "vertices": s.vertices,
                "faces": s.faces,
                "panels": s.panels,
                "charge_densities": s.charge_densities,
                "mean_polarization": s.mean_polarization,
            }
            for k, s in zip(ids, sheets, strict=True)
        }

    view3d.follow_edits(follow)
    return


@app.cell
def _(edited, last, mo, view):
    edited()  # the numbers follow each edit, when it is let go
    _info = last["solved"].face_charge_info
    _said = (
        f"Solved by `{last['solved'].solved_by}` at level {_info['level']}, "
        f"{_info['unknowns']:,} unknowns, "
        f"in {_info['seconds'] * 1000:.0f} ms"
        f"{', on the factorization it kept' if _info['reused'] else ''}."
    )
    if last["edit"]:
        _said += (
            f" The last edit solved {len(last['edit'])} times, "
            f"at {sum(last['edit']) / len(last['edit']) * 1000:.0f} ms each."
        )
    mo.vstack([view, mo.md(_said)])
    return


if __name__ == "__main__":
    app.run()
