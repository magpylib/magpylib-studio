"""The 3D view in a reactive notebook: `marimo edit sandbox/marimo_demo.py`.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo

The point of the file is the loop it closes. The sliders rebuild the magpylib
objects, the view redraws them, a click in the view is a value the next cell
reads, and nothing in between is a protocol -- the notebook re-runs the cells
that depend on what changed, which is the parameter binding the studio's GUI
is heading for.
"""

import marimo

__generated_with = "0.24.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import magpylib as magpy
    import marimo as mo
    import numpy as np

    from magpylib_studio.widget import SceneWidget, view

    return SceneWidget, magpy, mo, np, view


@app.cell(hide_code=True)
def _(mo):
    mo.md(
        """
        # A magpylib scene in marimo

        The 3D view is the one the VS Code studio draws — the same three.js
        renderer, handed the same payload — wrapped as an `anywidget`.

        Drag the sliders: the rings are rebuilt in python and the view is
        re-pointed at them, keeping your camera — zoom in and drag one, the
        zoom stays. **Tilt** turns every polarization together, from axial at
        0° to radial at 90°. Click a magnet: the selection is a value the cells
        below react to.

        The list over the view is the scene as it is nested — the stack, its
        rings, their magnets. Fold a ring with its caret, hide it with its eye,
        or click a name to select everything under it (⌘/ctrl-click adds,
        shift-click takes a range); double-click to frame it. **Legend** puts
        it away.

        Click the view and it takes the keys, as the studio's panel does:
        **F** frames the selection and **Home** everything, **1** **3** **7**
        look from the front, the right and the top, **5** switches the
        projection, **H** hides the selection and **shift-H** shows only it,
        **Esc** lets go, and **space** plays a run.
        """
    )
    return


@app.cell
def _(mo):
    n = mo.ui.slider(2, 16, value=6, label="magnets")
    radius = mo.ui.slider(2.0, 8.0, step=0.5, value=4.0, label="ring radius")
    tilt = mo.ui.slider(0, 180, step=15, value=45, label="polarization tilt °")
    mo.hstack([n, radius, tilt], justify="start", gap=2)
    return n, radius, tilt


@app.cell
def _(magpy, n, radius, tilt):
    def _ring(name, z, turn):
        ring = magpy.Collection(style_label=f"{name} ring")
        # `mo.ui.slider` values are int | float whatever its bounds are, and a
        # count has to be a whole number for `range` -- and for the angle
        # below, so that the last magnet lands beside the first, not on it.
        count = int(n.value)
        for i in range(count):
            magnet = magpy.magnet.Cuboid(
                dimension=(1, 1, 1),
                polarization=(0, 0, 1),
                position=(radius.value, 0, z),
                style_label=f"{name} {i + 1}",
            )
            # Turned in place first, by the same angle for every magnet: the
            # tilt is what the ring *is*, not a pattern across it -- 0° is an
            # axial ring, 90° a radial one. (Multiplying it by `i` would make
            # a Halbach-ish pattern, and leave the magnet at index zero the
            # one the slider never moves.)
            magnet.rotate_from_angax(turn, "y", anchor=magnet.position)
            magnet.rotate_from_angax(360 * i / count, "z", anchor=(0, 0, 0))
            ring.add(magnet)
        return ring

    # Two rings turned opposite ways, so the legend has something to fold:
    # the stack, each ring in it, each magnet in those.
    stack = magpy.Collection(
        _ring("upper", 1.0, tilt.value),
        _ring("lower", -1.0, -tilt.value),
        style_label="stack",
    )
    probe = magpy.Sensor(style_label="centre probe")
    return probe, stack


@app.cell
def _(SceneWidget, mo):
    scene = mo.ui.anywidget(SceneWidget(height=460))
    scene
    return (scene,)


@app.cell
def _(probe, scene, stack):
    # Re-pointed, not remade. A slider re-runs every cell that reads it, so a
    # `view(...)` call in one of them would build a new widget per drag: a new
    # element, a bar rebuilt from nothing, and the camera back at its opening
    # framing -- losing whatever you had just zoomed in on. This cell reads the
    # sliders; the one above, which owns the view, does not.
    scene.widget.update(stack, probe)
    return


@app.cell
def _(magpy, mo, np, probe, scene, stack):
    # `scene.value` is what makes this cell re-run on a click; the widget it
    # wraps is what turns the ids in it back into magpylib objects.
    _clicked = scene.value["selected"] and scene.widget.picked
    _field = np.round(magpy.getB(stack, probe) * 1000, 3)

    mo.md(
        f"""
        **B at the probe:** {_field} mT

        **Selected:** {", ".join(o.style.label for o in _clicked) if _clicked else "_click an object in the view_"}
        """
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(
        """
        ## Paths, played in the browser

        `animation=True` captures every step of the run. The widget keeps the
        frames and serves them to the view one at a time, so **▶** plays and
        the slider scrubs — including what a pose cannot express: the probe's
        field arrows are recomputed per frame, so they turn as it passes.
        """
    )
    return


@app.cell
def _(magpy, np, view):
    _rotor = magpy.magnet.Cylinder(
        polarization=(1, 0, 0),
        dimension=(4, 1),
        style_label="rotor",
    )
    _sweep = magpy.Sensor(
        position=np.linspace((-6, 0, 1.5), (6, 0, 1.5), 60),
        style_label="sweep",
    )
    _sweep.style.arrows.x.show = True
    _sweep.style.arrows.y.show = True

    view(_rotor, _sweep, animation=True, height=380)
    return


if __name__ == "__main__":
    app.run()
