---
name: magpylib-studio
description: >-
  Read first whenever a task touches a `.magpy.json` scene (opening it, its
  field, sweeping a variable, changing it) or a script using `magpylib_studio`:
  its words are few but not plain magpylib, and guessing them costs failed
  tries. Also use when building a magnet, coil or sensor arrangement that should
  stay parametric — a Halbach ring, a magnet array, a coil stack, a sensor
  placement — in a project with magpylib-studio installed. Covers writing the
  scene as a plain magpylib function whose parameters are the variables,
  patterns instead of loops, reading the field and sweeping a variable, changing
  a saved scene, and handing the result to the person in the studio. A scene
  written as a flat magpylib script loses its variables: every number is frozen,
  and the studio's sliders have nothing to move.
license: BSD-3-Clause
---

# magpylib-studio

A studio scene is one parametric document, saved as `.magpy.json`: magnets,
currents and sensors, the variables they are written in, and the steps that
placed them. The person works on it in the studio — a VS Code panel or a
notebook widget — with a slider per variable. You write it as a plain magpylib
function marked `@scene`: its parameters are the variables, its body is
magpylib, and `.build()` records what the body does into the document. Every
recorded call goes through the operation the studio's own panel uses, so a call
the scene cannot take fails at its line and says why.

## Quick reference

- Write the scene as a function under `@scene`. Each parameter is a variable: a
  default, and in `Annotated[...]` its kind and bounds — `Length(lo, hi)`,
  `Angle(lo, hi)`, `Count(lo, hi)`, `Bounds(lo, hi, unit=...)`, each taking
  `slider=(lo, hi)` for the range worth dragging. A choice is
  `Literal["x", "y", "z"]`. A variable defined by a formula is
  `derived("name", formula)` in the body.
- The body is plain magpylib: `magpy.magnet.Cuboid(...)`, `magpy.Collection`,
  `.add`, `.move`, `.rotate_from_angax`, `.copy`. Values are SI: metres, tesla,
  amperes, degrees.
- Studio's own words, imported from `magpylib_studio`: `duplicate_around`,
  `duplicate_along`, `mirror` (patterns), `place` (a pose stated outright),
  `sampled` (a run of points as a formula), `hide`, `show`, `remove`,
  `TriangularMesh` (a mesh by its source), `name` (an id the label does not
  give).
- Called plainly, `ring(n=12)` returns magpylib objects at those values: a real
  field from `getB`, no studio involved. `ring.build()` is the document;
  `ring.build().save("ring.magpy.json")` writes it.
- Inside `.build()` a parameter is a handle, not a number. Arithmetic on it
  writes an expression; `if`, `range`, `float`, `math.*` or `print` on it raise
  `TypeError`, saying what to write instead. See
  [Variables are handles](#variables-are-handles).
- Repeat with a pattern — `duplicate_around`, `duplicate_along`, `mirror` —
  never with a loop over a variable. The object must sit in a collection.
- Read the field with `s = ring.build()` and `s.session.get_field(...)`; try
  other values with `s.session.sweep(...)`. Both return plain data, in SI.
- Search a design in one script, in a loop over `set_variable` and `get_field`,
  not one run per guess. See [Search a design](#search-a-design).
- To change a saved scene, write it out as a scene function, edit that, and run
  it. See [Change a saved scene](#change-a-saved-scene).
- Every signature: [references/api.md](references/api.md).

## Write a scene

```python
from typing import Annotated

import magpylib as magpy
from magpylib_studio import Count, Length, duplicate_around, scene


@scene
def halbach(
    n: Annotated[int, Count(4, 48)] = 12,
    radius: Annotated[float, Length(0.01, 0.1)] = 0.025,
):
    ring = magpy.Collection(style_label="Halbach ring")
    magnet = magpy.magnet.Cuboid(
        dimension=(0.008, 0.008, 0.008),  # m
        polarization=(1, 0, 0),  # T, in the magnet's own frame
        position=(radius, 0, 0),  # kept as the variable, not as 0.025
        style_label="Magnet",
    )
    ring.add(magnet)
    # n copies round z, each turned by a further 360/n: the polarization turns
    # twice per revolution, which makes a Halbach dipole
    duplicate_around(magnet, count=n, axis="z", spin=360 / n)
    centre = magpy.Sensor(position=(0, 0, 0), style_label="Centre")
    return ring, centre


s = halbach.build()  # the document: n and radius are its variables
s.save("halbach.magpy.json")
```

- **Parameters** need a default each; the default is the variable's value when
  the scene is first built. `int` makes a count, `float` a quantity; `Count`,
  `Length` (m), `Angle` (degrees) say the bounds and what it measures;
  `Bounds(lo, hi, unit="field")` for a field (T), `"current"` (A) or
  `"dimensionless"`. A `Literal` of names is a choice, such as an axis.
- **Shown units:** `@scene(model_unit="mm", field_unit="mT")` shows the scene in
  mm and mT. What you write stays SI.
- **Objects** are magpylib's, with magpylib's keywords. `style_label=` names an
  object for the person; the document's id comes from it.
- **Groups:** `magpy.Collection(*children)` and `group.add(...)`. Add an object
  to its group before anything else happens to it: added after a move or a turn,
  it is moved into the group with its position frozen as numbers, and a
  `UserWarning` says so.
- **Steps:** `move`, `rotate_from_angax(angle, axis, anchor=...)`,
  `rotate_from_rotvec`, `rotate` (with a scipy `Rotation`), `obj.position =`,
  `copy()`, as in magpylib, applied in the order written. A step on a collection
  carries what is in it. `place(obj, position=..., orientation=...)` states a
  pose outright, as a drag in the studio does. `obj.parent = group` moves an
  object into a group keeping its pose, as the studio's tree does;
  `group.add(obj)` on a fresh object creates it inside.
- **Patterns:** `duplicate_around(obj, count, axis="z", anchor=0, spin=0)`,
  `duplicate_along(obj, count, step)` (twice — on the object, then on its
  collection — for a grid) and `mirror(obj, plane="xy")`. Each is one step that
  stays a pattern: change `n` and the ring rebuilds. The copies are generated;
  to change them, change the source object, its pattern step, or a variable.
  `spin` is the extra turn of each copy about its own axis, on top of the turn
  that going round the ring already gives it: a Halbach ring takes
  `spin=360 / n`, not twice that.
- **Called plainly** — `halbach(n=16)` — the function is plain magpylib:
  patterns make real copies, `derived` returns the number, and nothing is
  recorded. Use that to compute with the objects directly.
- **Starting points:** `MagpylibStudioSession().list_examples()` names the
  built-in scenes; `load_example(name)` and `to_builder_script()` show how each
  is written.

## Variables are handles

| Instead of                           | Write                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `for i in range(n): ... copy() ...`  | `duplicate_around(obj, count=n, ...)` or `duplicate_along(obj, count=n, step=...)`         |
| `if gap > 0.01:`                     | decide in Python on fixed values: a scene holds no conditions                              |
| `math.sin(tilt)`, `float(radius)`    | `np.sin(tilt)`; pass `radius` itself where a value goes                                    |
| `np.linspace(0, radius, k)`          | `sampled(lambda t: ..., count=..., over=...)`, a run of points as a formula                |
| `print(radius)`                      | `repr(radius)` for its expression, `s.session.get_variables()` for values                  |
| `b = magnet.position + (0.02, 0, 0)` | `position=(radius + 0.02, 0, 0)`: a property read is today's number, and a warning says so |

A loop over fixed values is ordinary Python (`for z in (0.0, 0.01):` to make two
rings), and a plain name can hold an expression: after `reach = radius / 2`,
`position=(reach, 0, 0)` still follows `radius`. A formula the person should see
as a variable of its own is `stagger = derived("stagger", 360 / (2 * n))`. The
functions an expression may call are listed in
[references/api.md](references/api.md).

## Read the field

```python
import numpy as np

field = s.session.get_field(points=[(0, 0, 0), (0.005, 0, 0)])  # m
B = np.array(field["values"])  # T, one row per point
print(field["unit"], np.linalg.norm(B, axis=1))
```

- `get_field(points=...)` sums the field of every source in the scene at those
  points, hidden ones included; `get_field(sensor_id="Centre")` reads a sensor
  along its path. `field="H"` gives H in A/m; `"J"` and `"M"` give the material,
  zero outside it. Values are SI whatever units the scene is shown in.
- Read `field.get("skipped")` and `field.get("warnings")` and pass them on: a
  source that could not be included, or a mesh whose surface does not close,
  whose field is computed and wrong.
- Uniformity, a peak or a gradient: compute it from the values with numpy.

```python
grid = np.mgrid[-0.005:0.005:5j, -0.005:0.005:5j, 0:0:1j].T.reshape(-1, 3)
magnitude = np.linalg.norm(s.session.get_field(points=grid)["values"], axis=1)
print(f"{magnitude.mean():.4f} T, spread {np.ptp(magnitude) / magnitude.mean():.1%}")
```

## Try other values

```python
result = s.session.sweep(
    "radius", np.linspace(0.02, 0.04, 5).tolist(), points=[(0, 0, 0)]
)
assert result["ok"], result["error"]
for step in result["steps"]:
    print(step["value"], step["magnitude"])

print(s.session.set_variable("n", 16))  # {'ok': True}
print(
    s.session.set_variable("n", 6.5)
)  # {'ok': False, 'error': 'n = 6.5 counts things, ...'}
```

- `sweep(variable, values, points=... or sensor_id=..., field="B")` rebuilds the
  scene once per value and reads the field each time, in milliseconds, and
  leaves the scene on the value it started with. `values` must be a list:
  `.tolist()` a numpy array.
- `set_variable(name, value)` changes a value for good.
- Session calls report a refusal rather than raise it: check `["ok"]` and read
  `["error"]`.

## Search a design

Search in one script, not one run per guess: a try costs milliseconds in a loop,
and a turn when each guess is a run of its own.

```python
best = None
for count in (8, 12, 16):
    for r in (0.025, 0.03, 0.035):
        s.session.set_variable("n", count)
        s.session.set_variable("radius", r)
        b = np.linalg.norm(s.session.get_field(points=[(0, 0, 0)])["values"][0])
        if best is None or b > best[0]:
            best = (b, count, r)
s.session.set_variable("n", best[1])  # leave the scene on the one you keep
s.session.set_variable("radius", best[2])
print(f"{best[0] * 1e3:.1f} mT with n = {best[1]}, radius = {best[2]} m")
```

What is not a variable — which shape, how many parts — is a plain argument of a
function that makes the scene function, decided before the scene is built:

```python
def magnet_of(shape):
    @scene
    def design(height: Annotated[float, Length(0.002, 0.05)] = 0.01):
        if shape == "cube":  # `shape` is a plain value: branching on it is fine
            magpy.magnet.Cuboid(
                dimension=(0.01, 0.01, height), polarization=(0, 0, 1.2)
            )
        else:  # a cylinder of the same footprint
            diameter = 2 * (0.01**2 / np.pi) ** 0.5
            magpy.magnet.Cylinder(
                dimension=(diameter, height), polarization=(0, 0, 1.2)
            )

    return design


for shape in ("cube", "cylinder"):
    field = magnet_of(shape).build().session.get_field(points=[(0, 0, 0.01)])
    print(shape, np.linalg.norm(field["values"][0]))
```

Check what the search cannot see the same way, in the loop: two magnets in the
same place, a limit the task sets. Then save the one you keep.

## Change a saved scene

A `.magpy.json` is the log of the steps that built the scene; do not edit it by
hand. Write it out as a scene function, edit that, and run it:

```python
import pathlib

from magpylib_studio.session import MagpylibStudioSession

session = MagpylibStudioSession()
assert session.load_scene("halbach.magpy.json")["ok"]
pathlib.Path("halbach_scene.py").write_text(session.to_builder_script())
```

The script defines a function `design` under `@scene` that builds the same
scene, variables and patterns included. Add
`design.build().save("halbach.magpy.json")` at its end, make the change, and run
it. Write it out afresh each time: the person may have changed the scene in the
studio since.

When the script is what is kept — in git, with the `.magpy.json` rebuilt from it
— edit the script itself, and build with
`design.build(values="halbach.magpy.json")` so that the slider positions the
person saved survive the next run.

## Hand it to the person

- **VS Code:** right-click a scene script and choose **Open in Magpylib Studio**
  — the studio runs it and opens the scene it built, with a slider per variable.
  A `.magpy.json` opens with **Magpylib Studio: Open Scene…**.
- **Notebook:** `SceneWidget(s, editable=True)`, from `magpylib_studio.widget`
  (`pip install "magpylib-studio[widget]"`), is the 3D view with handles; the
  sliders toggle at the foot of its edit column opens a slider per variable, the
  object toggle beside it the selection's parameters, pose and style, and
  `.variables` holds their values.
- Give numbers with where they were read and in what unit, and say how you
  computed them. Whether a field is good enough is the person's call.

## When a call fails

- **`TypeError` on a line that uses a variable:** the line asked for its value.
  The message says what to write instead; see
  [Variables are handles](#variables-are-handles).
- **`TypeError` at the `@scene` line:** a parameter without a default, a `bool`
  parameter, or a name without its `Literal` of choices.
- **`BuildError`:** the scene refused the call, in the studio's own words, and
  is as it was. The common ones:
  - `'Magnet' is not inside a Collection, so its copies have no group to join` —
    add the object to a collection before patterning it.
  - `n = 100 is above its maximum 48` — a value outside its variable's bounds; a
    fraction for a `Count` is refused the same way.
  - `object id 'ring' already exists`, `there is already a variable 'n'` — names
    are unique in a scene.
  - `Tetrahedron cannot be mirrored` — only shapes with a mirror symmetry of
    their own can be: cuboids, cylinders and their segments, spheres, dipoles
    and sensors.
  - `... was made before this scene started recording` — an object made at
    module level and used inside the function: make it inside.
- Fix the line and run the script again: `.build()` starts from nothing on every
  run.

## Conventions to check

- SI throughout: a 5 mm cube is `dimension=(0.005, 0.005, 0.005)`, NdFeB about
  `polarization=(0, 0, 1.2)`. Millimetres and millitesla from old magpylib code
  are wrong by factors of 1000 or more, and nothing raises.
- `magnet.Cylinder(dimension=(d, h))` and `current.Circle(diameter=d)` take a
  diameter, not a radius.
- `polarization` is in the magnet's own frame: rotate the magnet and it turns
  with it. `magnetization` is in A/m; prefer `polarization`, in T.

A scene script is Python and runs with the person's rights, like any script. A
`.magpy.json` never runs code when it is opened, so it is the form in which to
share a scene.
