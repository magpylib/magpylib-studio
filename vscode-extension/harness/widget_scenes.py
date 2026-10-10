"""The scenes `check-widget-browser.mjs` draws.

    python harness/widget_scenes.py OUT

Writes into OUT:

* ``state.json`` -- a nested scene as a widget's model holds it, for the
  pages that play the notebook themselves;
* ``still.html`` -- that scene saved, looking from `CAMERA`;
* ``run.html`` -- a sensor on a path past a turning magnet: a run that only
  moves, which the page plays from poses, over and over;
* ``morph.html`` -- a magnet that grows along its path: a run no motion can
  play, which carries its changes and plays them;
* ``mix.html`` -- magnets turning past a probe coloured by the field: posed
  magnets, and only the probe carried as it changes;
* ``ramp.html`` -- a coil whose current ramps: a run in which nothing drawn
  moves, which plays all the same;
* ``served.html`` -- the growing magnet again, with nothing carried: served a
  frame at a time, as a run past the carry limit is;
* ``run.json``, ``served.json`` -- a run that moves and a served one as a
  model holds them, for pages that play the notebook themselves;
* ``panel.json`` -- what the ``studio`` backend leaves for the panel: a stack
  of turning rings and a probe, as the widget's state, with its legend;
* ``readings.json`` -- the studio's quiver example as its panel draws it, then
  again with the sensor moved: a sensor whose arrows are its own reading, for
  the panel's renderer to redraw while it is dragged;
* ``edit.json`` -- an editable view's model, a ring and a probe to edit, and
  the scene its session answers `get_scene` with;
* ``studio.json`` -- what the studio panel's engine answers for that scene:
  ``get_scene`` and ``object_tree``;
* ``collection.json`` -- an editable view of two magnets held as one
  collection, and the scene its session answers `get_scene` with;
* ``variables.json`` -- an editable view of a scene written in code, with a
  variable of each kind, the scene its session draws, and what it answers
  `get_variables` with: for the view's own variables panel;
* ``array.json`` -- the array example as the studio panel's engine answers
  it: a tile patterned into a row, the row into a layer, the layer again, the
  copies drawn on the nodes of what was patterned;
* ``pathed.json`` -- a magnet on a path, as the studio panel's engine
  answers it: what a drag of its handles must leave the path where the edit
  leaves it;
* ``small.html`` -- a ring of centimetre magnets, edited (so drawn in metres,
  as a session draws), saved never drawn: the page frames it itself, as a
  notebook's first look does;
* ``expected.json`` -- what the check compares against: the camera, the
  legend's rows in tree order, and the small ring's span.
"""

import json
import pathlib
import sys
import warnings

import magpylib as magpy
import numpy as np

from magpylib_studio import threejs
from magpylib_studio.session import MagpylibStudioSession
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


def small_ring():
    """Six 1 cm magnets on a 2.3 cm ring: an assembly's real size, in metres,
    which is a long way below the unit cube a three.js helper starts as."""
    return magpy.Collection(
        *[
            magpy.magnet.Cuboid(
                polarization=(1, 0, 0),
                dimension=(0.01, 0.01, 0.01),
                position=(0.023, 0, 0),
            ).rotate_from_angax(60 * i, "z", anchor=0)
            for i in range(6)
        ],
        style_label="small",
    )


def scene_to_edit():
    """A magnet and a probe, editable -- named, as the view names them, after
    the variables that hold them here."""
    magnet = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01))
    # y off the readout's four decimals: a value typed beside it shows
    # whether y is sent as it is, or as the box rounds it
    probe = magpy.Sensor(position=(0, 0.00012345, 0.02))
    return SceneWidget(magnet, probe, editable=True)


def scene_with_a_collection():
    """Two magnets held as one collection, editable, named after the
    variables that hold them here."""
    left = magpy.magnet.Cuboid(
        polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01), position=(-0.01, 0, 0)
    )
    right = magpy.magnet.Cuboid(
        polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01), position=(0.01, 0, 0)
    )
    pair = magpy.Collection(left, right)
    return SceneWidget(pair, editable=True)


def scene_with_variables():
    """A scene written in code with a variable of each kind: a count with a
    slider range, a length with hard limits, a choice, a number with no range,
    and one that follows the others."""
    from typing import Annotated, Literal

    from magpylib_studio import Bounds, Count, derived, duplicate_around, name, scene

    @scene
    def design(
        n: Annotated[int, Count(2, 60, slider=(4, 20))] = 10,
        r: Annotated[float, Bounds(0.005, 0.08)] = 0.02,
        axis: Literal["x", "y", "z"] = "z",
        free: float = 3.0,
    ):
        derived("half", r / 2)
        magnet = name(
            magpy.magnet.Cuboid(
                dimension=(0.01, 0.01, 0.01), polarization=(0, 0, 1), position=(r, 0, 0)
            ),
            "m",
        )
        name(magpy.Collection(magnet), "ring")
        duplicate_around(magnet, count=n, axis=axis)

    return SceneWidget(design.build(), editable=True)


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
    rotor.rotate_from_angax(np.linspace(0, 180, 30), "z", start=0)
    sweep = magpy.Sensor(
        position=np.linspace((-6, 0, 1.5), (6, 0, 1.5), 30), style_label="sweep"
    )
    run = SceneWidget(rotor, sweep, animation=True, repeat=True)
    if not run.payload.get("tracks"):
        raise SystemExit("run.html: the sweep should play as motion")
    run.write_html(out / "run.html")
    (out / "run.json").write_text(json.dumps(run._saved()))

    grow = magpy.magnet.Cuboid(
        polarization=(0, 0, 1),
        dimension=np.linspace((1, 1, 1), (2, 2, 2), 30),
        style_label="grow",
    )
    morph = SceneWidget(grow, animation=True)
    if not morph.payload.get("changes"):
        raise SystemExit("morph.html: a growing magnet carries its changes")
    morph.write_html(out / "morph.html")

    # the same run with nothing carried, as one past the limit is served
    limit, threejs._CARRY_LIMIT = threejs._CARRY_LIMIT, 0
    try:
        served = SceneWidget(grow, animation=True)
    finally:
        threejs._CARRY_LIMIT = limit
    if served._scene is None:
        raise SystemExit("served.html: nothing carried, so frames are served")
    served.write_html(out / "served.html")
    (out / "served.json").write_text(json.dumps(served._saved()))

    turning = magpy.Collection(
        *[
            magpy.magnet.Cuboid(
                polarization=(0, 0, 1), dimension=(1, 1, 1), position=(3, 0, 0)
            ).rotate_from_angax(angle, "z", anchor=0)
            for angle in range(0, 360, 30)
        ],
        style_label="ring",
    )
    turning.rotate_from_angax(np.linspace(0, 180, 30), "z", anchor=0, start=0)
    passing = magpy.Sensor(
        pixel=np.linspace((-1, 0, 0), (1, 0, 0), 5),
        position=np.linspace((-3, 0, 1), (3, 0, 1), 30),
        style_label="probe",
    )
    passing.style.pixel.field.source = "B"
    mix = SceneWidget(turning, passing, animation=True)
    if not (mix.payload.get("tracks") and mix.payload.get("changes")):
        raise SystemExit("mix.html: posed magnets and a carried probe")
    mix.write_html(out / "mix.html")

    coil = magpy.current.Circle(
        current=np.linspace(1, 100, 30), diameter=3, style_label="coil"
    )
    ramp = SceneWidget(coil, animation=True)
    if ramp.payload.get("tracks") != []:
        raise SystemExit("ramp.html: nothing drawn moves, so no tracks")
    ramp.write_html(out / "ramp.html")

    # what the `studio` backend writes for the panel, the stack turning
    spinning = magpy.Collection(
        ring("upper", 1), ring("lower", -1), style_label="stack"
    )
    spinning.rotate_from_angax(np.linspace(0, 90, 20), "z", anchor=0, start=0)
    panel = threejs.widget_state(
        threejs._capture((spinning, probe), animation=True, on_behalf_of="studio")
    )
    if not panel["state"]["tree"] or not panel["state"]["payload"].get("tracks"):
        raise SystemExit("panel.json: the legend and the motion should be there")
    (out / "panel.json").write_text(json.dumps(panel))

    # the quiver's sensor where it starts, and part-way through a drag
    session = MagpylibStudioSession()
    session.load_example("quiver")
    before = session.get_scene()
    session.set_transform("field", position=[0.004, 0.003, 0.012])
    after = session.get_scene()
    if before["readings"] != ["field"]:
        raise SystemExit("readings.json: the quiver's sensor should be a reading")
    (out / "readings.json").write_text(json.dumps([before, after]))

    # a scene to edit: the model a studio holds, and its session's answer
    studio = scene_to_edit()
    if not studio.editable or "probe" not in studio.payload["anchors"]:
        raise SystemExit("edit.json: the studio should hold a probe to edit")
    (out / "edit.json").write_text(
        json.dumps({"state": studio.get_state(), "scene": studio.payload})
    )
    # what the studio panel's engine answers: the scene, and its tree
    (out / "studio.json").write_text(
        json.dumps({"scene": studio.payload, "tree": studio.tree})
    )

    array = MagpylibStudioSession()
    array.load_example("array")
    (out / "array.json").write_text(
        json.dumps({"scene": array.get_scene(), "tree": array.object_tree()})
    )

    pathed = MagpylibStudioSession()
    pathed.add_object(
        "mover",
        "magnet.Cuboid",
        {"polarization": [0, 0, 1], "dimension": [0.01, 0.01, 0.01]},
    )
    pathed.move("mover", [[0.01 * i, 0, 0] for i in range(1, 6)], start=0)
    (out / "pathed.json").write_text(
        json.dumps({"scene": pathed.get_scene(), "tree": pathed.object_tree()})
    )

    parametric = scene_with_variables()
    listed = parametric._session.get_variables()
    if [v["name"] for v in listed["variables"]] != ["n", "r", "axis", "free", "half"]:
        raise SystemExit("variables.json: a variable of each kind, in order")
    (out / "variables.json").write_text(
        json.dumps(
            {
                "state": parametric.get_state(),
                "scene": parametric.payload,
                "variables": listed,
            }
        )
    )

    held = scene_with_a_collection()
    if held.payload["collections"] != {"pair": ["left", "right"]}:
        raise SystemExit("collection.json: the pair should hold left and right")
    (out / "collection.json").write_text(
        json.dumps({"state": held.get_state(), "scene": held.payload})
    )

    # Edited, so its session draws it in metres -- magpylib's own display would
    # pick millimetres, where 56 of them are nothing like small. Never drawn,
    # so no camera: the page frames it, with its axes on.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # the ring's magnets have no names
        small = SceneWidget(small_ring(), editable=True)
    if small._camera is not None or not small.axes:
        raise SystemExit("small.html: a view never drawn, with its axes on")
    small.write_html(out / "small.html")
    span = max(high - low for low, high in small.payload["ranges"])

    rows = [obj.style.label for obj in [stack, *stack.children_all, probe]]
    expected = {"camera": CAMERA, "rows": rows, "small_span": span}
    (out / "expected.json").write_text(json.dumps(expected))


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
