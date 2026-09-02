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

        Drag the sliders: the ring is rebuilt in python and the view is
        re-pointed at it, keeping your camera — zoom in and drag one, the zoom
        stays. **Tilt** turns every polarization together, from an axial ring
        at 0° through a radial one at 90°. Click a magnet: the selection is a
        value the cells below react to. Drag to orbit, scroll to zoom, **Fit**
        to reframe.
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
    ring = magpy.Collection(style_label="ring")
    # `mo.ui.slider` values are int | float whatever its bounds are, and a
    # count has to be a whole number for `range` -- and for the angle below,
    # so that the last magnet lands beside the first rather than on it.
    _count = int(n.value)
    for _i in range(_count):
        _magnet = magpy.magnet.Cuboid(
            dimension=(1, 1, 1),
            polarization=(0, 0, 1),
            position=(radius.value, 0, 0),
            style_label=f"magnet {_i + 1}",
        )
        # Turned in place first, by the same angle for every magnet -- the
        # tilt is what the ring *is*, not a pattern across it: 0° is an axial
        # ring, 90° a radial one, 180° axial the other way. (Multiplying the
        # angle by `_i` would make it a Halbach-ish pattern, and would leave
        # this magnet, at index zero, the one the slider never moves.)
        _magnet.rotate_from_angax(tilt.value, "y", anchor=_magnet.position)
        _magnet.rotate_from_angax(360 * _i / _count, "z", anchor=(0, 0, 0))
        ring.add(_magnet)

    probe = magpy.Sensor(style_label="centre probe")
    return probe, ring


@app.cell
def _(SceneWidget, mo):
    scene = mo.ui.anywidget(SceneWidget(height=460))
    scene
    return (scene,)


@app.cell
def _(probe, ring, scene):
    # Re-pointed, not remade. A slider re-runs every cell that reads it, so a
    # `view(...)` call in one of them would build a new widget per drag: a new
    # element, a bar rebuilt from nothing, and the camera back at its opening
    # framing -- losing whatever you had just zoomed in on. This cell reads the
    # sliders; the one above, which owns the view, does not.
    scene.widget.update(ring, probe)
    return


@app.cell
def _(magpy, mo, np, probe, ring, scene):
    # `scene.value` is what makes this cell re-run on a click; the widget it
    # wraps is what turns the ids in it back into magpylib objects.
    _clicked = scene.value["selected"] and scene.widget.picked
    _field = np.round(magpy.getB(ring, probe) * 1000, 3)

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
