"""The 3D view in a reactive notebook: `marimo edit examples/marimo_demo.py`.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo

The point of the file is the loop it closes. The sliders rebuild the magpylib
objects, the view redraws them, a click in the view is a value the next cell
reads, and nothing in between is a protocol -- the notebook re-runs the cells
that depend on what changed, which is the parameter binding the studio's GUI
is heading for.
"""

import marimo

__generated_with = "0.25.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import magpylib as magpy
    import marimo as mo
    import numpy as np

    from magpylib_studio.widget import SceneWidget

    return SceneWidget, magpy, mo, np


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A magpylib scene in marimo

    The 3D view is the one the VS Code studio draws — the same three.js
    renderer, handed the same payload — wrapped as an `anywidget`.

    Drag the sliders: the rings are rebuilt in python and the view is
    re-pointed at them, keeping your camera — zoom in and drag one, the
    zoom stays. **Tilt** turns every polarization together, from axial at
    0° to radial at 90°. Click a magnet: the selection is a value the cells
    below react to.

    The list over the view is the scene as it is nested — the stack, its
    rings, their magnets. Fold a ring with its caret, hide it with the eye
    that shows when the pointer is on its row, or click the row to select
    everything under it (⌘/ctrl-click adds, shift-click takes a range);
    double-click to frame it.

    Click the view and it takes the keys, as the studio's panel does:
    **F** frames the selection and **Home** everything, **1** **3** **7**
    look from the front, the right and the top, **5** switches the
    projection, **H** hides the selection and **shift-H** shows only it,
    **Esc** lets go, and **space** plays a run.

    Put the pointer on the view and its tools show in the top-right
    corner: the legend, the axes, framing, the projection, the theme
    (auto, light, dark), a PNG picture, **export** — the view as a single
    HTML file that works without this notebook, opens where you left the
    camera, and in which the runs below still play — and full screen.
    """)
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
    # `SceneWidget(...)` in one of them would be a new widget per drag: a new
    # element, controls rebuilt from nothing, and the camera back at its opening
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
    mo.md("""
    ## Paths, played in the browser

    `animation=True` captures every step of the run. Here every step is the
    first one moved — a sensor sweeping past a magnet — so the view is handed
    the motion rather than the frames: **▶** plays and the slider scrubs in
    the browser with nothing to ask python, which is also why the run still
    plays in a saved page, or in a notebook read without its kernel. A run
    that changes shape as it goes is served a frame at a time instead, like
    the next one.
    """)
    return


@app.cell
def _(SceneWidget, magpy, np):
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

    SceneWidget(_rotor, _sweep, animation=True, height=380)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Properties along a path

    On magpylib main, more than position and orientation can vary along a
    path — `polarization`, `dimension`, `diameter`, `current` and others;
    `obj.path_properties` lists them for an object. Here a magnet's
    polarization turns a full circle, a coil grows while its current ramps
    up, and the probe's pixels show the field they sit in. None of that is
    a magnet moving, so no motion can play it: the widget keeps the frames
    and serves them one at a time, each as magpylib computed it.
    """)
    return


@app.cell
def _(SceneWidget, magpy, np):
    _steps = 40
    _turn = np.linspace(0, 2 * np.pi, _steps)
    _spinner = magpy.magnet.Cylinder(
        polarization=np.column_stack([np.cos(_turn), np.sin(_turn), np.zeros(_steps)]),
        dimension=(2, 1),
        style_label="spinner",
    )
    _coil = magpy.current.Circle(
        diameter=np.linspace(2, 5, _steps),
        current=np.linspace(1, 100, _steps),
        position=(0, 0, 1.5),
        style_label="coil",
    )
    _probe = magpy.Sensor(
        pixel=np.linspace((-3, 0, 0), (3, 0, 0), 13),
        position=(0, 0, -1.5),
        style_label="probe",
    )
    _probe.style.pixel.field.source = "B"  # each pixel an arrow of the field

    SceneWidget(_spinner, _coil, _probe, animation=True, height=380)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## The magpylib way

    `magpy.show(..., backend="widget")` draws the same view through
    magpylib's own call, legend included: magpylib hands its display
    backends the objects it draws (`Panel.objects`), so the nesting comes
    with them, and with `return_fig=True` the widget's `picked` works too.
    `magpy.defaults.display.backend = "widget"` makes every `show()` in
    the notebook draw one.

    Where a view is rebuilt by sliders, make it once with `SceneWidget`
    and `update()` it, as above: a `show()` in a cell that re-runs draws a
    new view on every drag. So this one draws a ring of its own.
    """)
    return


@app.cell
def _(magpy, np):
    _angles = np.linspace(0, 2 * np.pi, 8, endpoint=False)
    _ring = magpy.Collection(
        *[
            magpy.magnet.Cuboid(
                dimension=(1, 1, 1),
                polarization=(0, 0, 1),
                position=(3 * np.cos(_a), 3 * np.sin(_a), 0),
                style_label=f"magnet {_i + 1}",
            )
            for _i, _a in enumerate(_angles)
        ],
        style_label="ring",
    )
    magpy.show(
        magpy.Collection(_ring, style_label="assembly"),
        magpy.Sensor(style_label="probe"),
        backend="widget",
        height=380,
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## Editing the scene

    `editable=True` puts out the studio's handles, over a
    studio session in this kernel. Select an object and drag: **W** moves,
    **E** turns, **R** resizes, **P** aims, **L** swaps the world's axes for
    the object's own, and ⌘Z / ctrl-Z undoes a whole drag -- or use the
    column down the right. The cell below re-runs when a drag ends, not on
    every frame.
    """)
    return


@app.cell
def _(SceneWidget, magpy, mo):
    _rotor = magpy.magnet.Cuboid(
        dimension=(1, 1, 1), polarization=(0, 0, 1), style_label="rotor"
    )
    _pickup = magpy.Sensor(position=(0, 0, 2), style_label="pickup")
    studio = mo.ui.anywidget(SceneWidget(_rotor, _pickup, editable=True, height=380))
    studio
    return (studio,)


@app.cell
def _(studio):
    _edited = studio.widget.objects
    # the field where the pickup is now; `studio.widget.to_script()` is the scene
    _edited["pickup"].getB(_edited["rotor"])
    return


if __name__ == "__main__":
    app.run()
