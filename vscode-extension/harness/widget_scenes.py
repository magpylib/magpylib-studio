"""The scenes `check-widget-browser.mjs` draws.

    python harness/widget_scenes.py OUT

Writes into OUT:

* ``state.json`` -- a nested scene as a widget's model holds it, for the
  pages that play the notebook themselves;
* ``still.html`` -- that scene saved, looking from `CAMERA`;
* ``run.html`` -- a sensor on a path, saved with its run, to play with no
  python behind it;
* ``expected.json`` -- what the check compares against: the camera, and the
  legend's rows in tree order.
"""

import json
import pathlib
import sys

import magpylib as magpy
import numpy as np

from magpylib_studio.widget import SceneWidget

#: A parallel view from the front and a little above -- nothing the page
#: would arrive at by framing the scene itself.
CAMERA = {
    "projection": "parallel",
    "position": [0.0, -12.0, 4.0],
    "target": [0.0, 0.0, 0.5],
    "up": [0.0, 0.0, 1.0],
    "zoom": 1.5,
    "height": 10.0,
    "near": -80.0,
    "far": 400.0,
}


def ring(label, z):
    """Four magnets round the z axis, as a collection."""
    return magpy.Collection(
        *[
            magpy.magnet.Cuboid(
                polarization=(0, 0, 1),
                dimension=(1, 1, 1),
                position=(3, 0, z),
                style_label=f"{label} {i}",
            ).rotate_from_angax(90 * i, "z", anchor=0)
            for i in range(4)
        ],
        style_label=label,
    )


def main(out):
    out.mkdir(parents=True, exist_ok=True)
    stack = magpy.Collection(ring("upper", 1), ring("lower", -1), style_label="stack")
    probe = magpy.Sensor(position=(0, 0, 0), style_label="probe")

    still = SceneWidget(stack, probe)
    (out / "state.json").write_text(json.dumps(still._saved()["state"]))
    still._camera = CAMERA
    still.write_html(out / "still.html")

    rotor = magpy.magnet.Cylinder(
        polarization=(1, 0, 0), dimension=(4, 1), style_label="rotor"
    )
    sweep = magpy.Sensor(
        position=np.linspace((-6, 0, 1.5), (6, 0, 1.5), 30), style_label="sweep"
    )
    SceneWidget(rotor, sweep, animation=True).write_html(out / "run.html")

    rows = [obj.style.label for obj in [stack, *stack.children_all, probe]]
    expected = {"camera": CAMERA, "rows": rows}
    (out / "expected.json").write_text(json.dumps(expected))


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
