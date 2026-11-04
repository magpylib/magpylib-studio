"""A U-core solved by face charge while you drag:
`marimo edit examples/marimo/ucore_solved.py`.

Needs the widget extra, marimo and magpylib-material-response 0.9.2, and
says so without it:

    uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.9.2"
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="A U-core, solved")


@app.cell
def _():
    from typing import Annotated

    import magpylib as magpy
    import marimo as mo
    import numpy as np

    from magpylib_studio import (
        Bounds,
        Count,
        grid,
        scene,
    )
    from magpylib_studio.widget import SceneWidget

    return (
        Annotated,
        Bounds,
        Count,
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
    # A U-core, solved while you drag

    Three soft-iron cuboids (χ = 999) wound with a coil of 400
    ampere-turns, a magnet in the gap and two uniform fields on it, solved
    by face charge: sheets of charge on the core's surfaces, no volume
    mesh. Each sheet keeps the part it was solved from, so the view solves
    the core again at every step of a drag, with nothing written here to ask
    for it. Drag the **magnet**, or slide **current** or **vertical**: the
    solve keeps its factorization, so a new load costs milliseconds. Drag
    a **leg** off the yoke and each step factors the matrix again. One undo
    takes back the move and its solve together. The arrow in the corner is
    the sum of the two fields; pick one in the legend for its own.
    """)
    return


@app.cell
def _(mo):
    # magpylib-material-response is not one of studio's dependencies: without
    # it, or before 0.9.2, this part of the page says so and the rest runs.
    try:
        from magpylib_material_response import UniformField, solve_face_charge
        from magpylib_material_response.face_charge import ChargeSheet
        from magpylib_material_response.polyline import (
            create_polyline_fillet,
            move_grid_along_polyline,
        )
    except ImportError:
        ChargeSheet = None
    mo.stop(
        ChargeSheet is None or not hasattr(ChargeSheet, "part"),
        mo.md(
            "_Needs magpylib-material-response 0.9.2: "
            '`uv pip install "magpylib-material-response>=0.9.2"`._'
        ),
    )
    return (
        ChargeSheet,
        UniformField,
        create_polyline_fillet,
        move_grid_along_polyline,
        solve_face_charge,
    )


@app.cell
def _(mo):
    ucore_level = mo.ui.dropdown(
        options={"2": 2, "3": 3, "4": 4}, value="2", label="panels: level"
    )
    ucore_level
    return (ucore_level,)


@app.cell
def _(create_polyline_fillet, magpy, move_grid_along_polyline, np):
    _a = 0.02
    #: The core's parts, each its label and its dimension, in the order solved.
    _parts = {
        "yoke": (0.10, _a, _a),
        "left leg": (_a, _a, 0.06),
        "right leg": (_a, _a, 0.06),
    }

    def ucore_solvable(placed, *drives):
        """The model to solve: a soft cuboid for each of `_parts`, at the pose
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
                    _parts.items(), placed, strict=True
                )
            ),
            style_label="U-core",
        )
        core.susceptibility = 999
        return magpy.Collection(core, *drives)

    # Where the parts start: the yoke, and a leg standing on each end of it.
    ucore_poses = [((0, 0, 0), None), ((-0.04, 0, 0.04), None), ((0.04, 0, 0.04), None)]

    _h = 0.014
    _square = np.array(
        [[0, _h, 0], [0, _h, _h], [0, -_h, _h], [0, -_h, -_h], [0, _h, -_h], [0, _h, 0]]
    )
    # Four turns where material-response's docs wind sixteen, at the same 400
    # ampere-turns: a solve computes the coil's field on every panel again, and
    # 400 segments made it 167 ms a step where the magnet alone is 15.
    _turn = create_polyline_fillet(_square, max_radius=0.006, N=2)
    _pack = np.array([(xt, _h + 0.0011, 0) for xt in (np.arange(4) - 1.5) * 0.0044])
    ucore_windings = move_grid_along_polyline(_turn, _pack)
    return ucore_poses, ucore_solvable, ucore_windings


@app.cell
def _(
    Annotated,
    Bounds,
    ChargeSheet,
    Count,
    UniformField,
    grid,
    magpy,
    scene,
    solve_face_charge,
    ucore_level,
    ucore_poses,
    ucore_solvable,
    ucore_windings,
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
        *(magpy.current.Polyline(current=100, vertices=v) for v in ucore_windings)
    )
    # Kept by `reuse=True`, for the first step of a drag to reuse: 8 n² bytes,
    # on the result, so only the last result is held.
    ucore_solved = solve_face_charge(
        ucore_solvable(ucore_poses, _magnet(), _coil, *_fields(0.01)),
        level=ucore_level.value,
        reuse=True,
    )
    _sheets = [s for s in ucore_solved.sources_all if isinstance(s, ChargeSheet)]
    _parts = [s.part for s in _sheets]  # read here: each read makes a magnet

    @scene(model_unit="mm", field_unit="mT", solve_level=ucore_level.value)
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
            *(
                magpy.current.Polyline(current=current, vertices=v)
                for v in ucore_windings
            ),
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
                for s, part in zip(_sheets, _parts, strict=True)
            ),
            style_label="U-core",
        )
        return iron, coil, magnet, upward, turned, probe

    return ucore_scene, ucore_solved


@app.cell
def _(SceneWidget, mo, ucore_scene):
    ucore_view3d = SceneWidget(
        ucore_scene.build(),
        editable=True,
        field_lines=True,
        open_panel="variables",
        height=620,
    )
    ucore_last = {"solves": []}
    ucore_edited, _set_edited = mo.state(0)

    def _told(change):
        """An edit let go: what it solved, for the line under the view."""
        ucore_last["solves"] = ucore_view3d.last_edit.get(
            "solves", ucore_last["solves"]
        )
        _set_edited(change.new)

    ucore_view3d.observe(_told, names="revision")
    ucore_view = mo.as_html(mo.ui.anywidget(ucore_view3d))
    return ucore_edited, ucore_last, ucore_view


@app.cell
def _(mo, ucore_edited, ucore_last, ucore_solved, ucore_view):
    ucore_edited()  # the numbers follow each edit, when it is let go
    _solves = ucore_last["solves"]
    _info = _solves[-1] if _solves else ucore_solved.face_charge_info
    _said = (
        f"Solved by `{ucore_solved.solved_by}` at level {_info['level']}, "
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
    mo.vstack([ucore_view, mo.md(_said)])
    return


if __name__ == "__main__":
    app.run()
