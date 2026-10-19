# A scene function, its words, and the session, as the skill uses them

Generated from the code by `tools/write-skill-reference.py`: edit the
docstrings, not this file. What follows is what this version of
magpylib-studio has.

## The mark

### `scene(fn=None, *, model_unit=None, field_unit=None, variants=None)`

Mark a function as a scene: its parameters are the variables, its body
is plain magpylib, and `build()` records it. `@scene`, or
`@scene(model_unit="mm", field_unit="mT")` for the units the studio
shows the scene in (the numbers stay SI).

`variants` names sets of parameter values, a variant each:
`@scene(variants={"compact": {"n": 8}, "wide": {"n": 16, "radius": 0.035}})`.
The studio's variables panel lists them and sets the parameters to one
in a step; in code, `ring.variants["wide"]` is that mapping, so
`ring(**ring.variants["wide"])` is the scene at those values in plain
magpylib. A variant may leave parameters out, and those keep the values
they have when it is used. It holds values only: a `derived` variable is
a formula of the parameters, and follows them.

What `@scene` makes:

### `fn.build(values=None)`

Call the function with its parameters as handles, recording what
it does, and return the `Scene` it built: the document, to `save`, to
read the field of through `s.session`, or to show (`SceneWidget(s)`)
where several cells share it. A view alone takes the function,
`SceneWidget(ring)`, and builds its own.

`values` is where the parameters' values come from when there are
some: a saved scene (its path) or a mapping of names to values. A
default in the signature is the value when nothing says otherwise;
a slider dragged in the panel and saved wins, so the next run keeps
it. A `derived` variable is a definition, and the function's wins.

The variants named in the mark are the scene's; a saved scene's come
with its values, as its sliders do, and win over one of the same
name -- so a variant saved in the panel survives the next run. One
the scene can no longer take whole -- a parameter it names gone or a
formula now, a value past new limits -- is left out with a warning,
and the mark's of that name, if any, stays.

### `fn.save(path, values=None)`

`build(values).save(path)`: the document, as the studio saves one.

## A parameter's kind and bounds

Inside `Annotated[float, ...]` or `Annotated[int, ...]`; a choice of
names is `Literal[...]`. A parameter without an annotation is a plain
number with no bounds.

### `Length(low=None, high=None, *, slider=None)`

A length in metres: `Annotated[float, Length(0.005, 0.08)]`.

### `Angle(low=None, high=None, *, slider=None)`

An angle in degrees, as magpylib turns.

### `Count(low=None, high=None, *, slider=None)`

A whole number of things: `Annotated[int, Count(2, 60)]`.

### `Bounds(low: 'float | None' = None, high: 'float | None' = None, slider: 'tuple | None' = None, unit: 'str | None' = None, integer: 'bool' = False) -> None`

A parameter's limits, as `annotated_types` constraints with studio's
metadata beside them: `Annotated[float, Bounds(0, 1, slider=(0.2, 0.8),
unit="length")]`. Expands to `Ge`, `Le` and a `MultipleOf` for any reader
that follows the protocol, so pydantic and the like read the bounds; the
`Unit` and `Slider` ride along for the studio. `Length`, `Angle` and
`Count` are this with the kind filled in.

## Studio's words

Imported from `magpylib_studio`. Each is one step in the document when
the scene is built, and plain magpylib when the function is called.

### `derived(name, formula, *, unit=None)`

A variable defined by a formula of the others, shown in the panel as
one: `stagger = derived("stagger", 360 / (2 * n), unit="angle")`. Called
plainly, it is the formula's value.

### `duplicate_around(obj, count, axis='z', anchor=0, spin=0)`

`count` of `obj` about `axis` through `anchor`, each copy turned by
`spin` degrees more than the last: one step, which stays a pattern.
`obj` must sit in a collection, which the copies join.

Going round the ring already turns each copy with it. `spin` is the extra
turn about the copy's own axis, on top of that: a Halbach ring, whose
magnets turn twice as fast as they go round, takes `spin=360 / count`.

### `duplicate_along(obj, count, step)`

`count` of `obj` in a row, each `step` on from the last. Twice -- on
the object, then on its collection -- for a grid.

### `mirror(obj, plane='xy', normal=None, anchor=0)`

A reflected copy of `obj` across `plane` (or the plane with `normal`),
polarization and all. Only shapes with a mirror symmetry of their own:
cuboids, cylinders and their segments, spheres, dipoles and sensors.

### `place(obj, position=None, orientation=None)`

Put `obj` at `position` and turn it to `orientation`, in world
coordinates: the studio's own step for a pose stated outright, which is
what a drag records. `orientation` is a rotation vector in degrees.

### `sampled(of, *, count=None, over=None)`

A run of points as a formula: `of(t)` for `t` running across `over`
(0 to 1 unless said) in `count` steps. Where a value is a run of points
-- a sensor's pixels, a path -- this keeps it a formula of the
variables, count included, which `np.linspace` over a variable cannot.
Called plainly, it is the points.

### `grid(half, count, *, plane='xy', at=0, layers=1)`

A square of `count` by `count` points across ±`half` in `plane` (xy,
xz or yz), `at` the third coordinate: a sensor's pixels as a formula of
the variables, `pixel=grid(reach, density)`, so the grid follows a slider
as `sampled` does; `count` is two or more. `layers` stacks that many
squares along the third axis, as far apart as the points of one and
centred on `at`, for a block of pixels. Called plainly, it is the
points.

### `hide(obj)`

Hide `obj` in the 3D view. It still counts in the field.

### `unhide(obj)`

Show `obj` again in the 3D view, after `hide`. Not `show`: that is
magpylib's word for drawing a scene.

### `remove(obj)`

Take `obj` out of the scene, as a step: what happened while it was
there still happened.

### `TriangularMesh(mesh_source, **kwargs)`

magpylib's `TriangularMesh`, recorded as where its mesh came from
rather than as its vertices: `mesh_source={"from": "file", "path":
"rotor.stl", "scale": 0.001}`, `{"from": "hull", "points": [...]}` or
`{"from": "superquadric", "size": ..., "roundness": ...}`. The other
keywords are magpylib's (`polarization`, `position`, `style_label`).

### `name(obj, object_id)`

Give an object the id `object_id` in the document, where neither the
variable it is assigned to nor its label gives it. Rarely needed: an
object is named by the variable that holds it, and the script tab writes
it only where it cannot write that variable.

### `TriangularMesh.from_file(path, *, scale=None, sha256=None, **kwargs)`

`TriangularMesh.from_file("rotor.stl", scale=0.001, polarization=...)`:
the mesh a file holds, `scale` in metres per file unit -- 0.001 for a file
drawn in millimetres, which is most of them. `sha256` is what the file
held when a scene was saved, which the script tab carries so a changed
file is still noticed; nobody writes it by hand.

### `TriangularMesh.from_hull(points, **kwargs)`

`TriangularMesh.from_hull(points, polarization=...)`: the convex hull
of `points`, as magpylib's `from_ConvexHull` makes it, kept as the points
so a variable among them still decides it.

### `TriangularMesh.from_superquadric(size, roundness=(1, 1), *, around=None, across=None, **kwargs)`

`TriangularMesh.from_superquadric((w, d, h), (profile, plan))`: a
rounded solid, `roundness` 0.05/0.05 a block, 0.05/1 a cylinder, 1/1 a
sphere, 2/2 a diamond; `around` and `across` how many samples.

## What an expression may call

`abs`, `acos`, `asin`, `atan`, `atan2`, `cos`, `degrees`, `exp`, `hypot`, `log`, `max`, `min`, `radians`, `round`, `sin`, `sqrt`, `tan`, and the constants `e`, `pi`, `tau`: the expression
allow-list's own names, and all a scene can hold. Over a variable,
numpy's `np.sin`, `np.cos`, `np.tan`, `np.arcsin`, `np.arccos`, `np.arctan`, `np.arctan2`, `np.sqrt`, `np.exp`, `np.log`, `np.hypot`, `np.radians`, `np.deg2rad`, `np.degrees`, `np.rad2deg`, `np.absolute`, `np.minimum`, `np.maximum` write these expressions, as does arithmetic, and
the builtins `abs` and `round`; any other numpy function refuses. The
constants as handles are `from magpylib_studio import pi, tau, e`.

## The session

`fn.build().session` is the scene's `MagpylibStudioSession`;
`MagpylibStudioSession()` is an empty one, to open a saved scene into.
Most of its calls report a refusal rather than raise it:
`{"ok": False, "error": "..."}`.

### `session.get_field(sensor_id=None, points=None, field='B')`

Total field of all sources, summed, at the given observers.

Observers: explicit `points` [[x,y,z], ...] (m), else the sensor with
`sensor_id`, else the first sensor in the scene (its whole path).
Returns {"field", "unit", "points", "values", "magnitude"} in SI.

### `session.sweep(variable, values, sensor_id=None, points=None, field='B')`

Rebuild the scene once per value of a variable and read the field.

This is what variables are *for*: a parameter study. It costs a full
re-fold of the document per step, which is milliseconds — the scene is
rebuilt from the log on every ordinary edit anyway. Nothing is
recorded in the history: the document ends on the value it started on.

### `session.set_variable(name, value, unit=None)`

Define or redefine a variable. `value` is a number, or an
expression over the other variables ("=gap*2"). Everything that
references it is rebuilt; a definition that cannot resolve (a typo, a
cycle, a value some object rejects) is reported and rolled back.

`unit` says what it measures in the same step (see
`set_variable_unit`), so a variable is created a length rather than
created and then made one; None leaves what it says as it was.

### `session.set_variables(values)`

Set several variables at once, each as `set_variable` sets one:
one rebuild and one step to undo, however many there are, and refused
whole when any value is. So a combination that holds only together --
two lengths a wall is the difference of -- is taken as the
combination it is, never checked half-set.

### `session.get_variables()`

The document's variables, as written, as resolved, and as heeded.

`inert` marks one nothing in the scene follows any more, and
`shadowed` says where it is being overruled, by which steps or by
which value written over it — enough for a view to explain a slider
that moves nothing, and to offer the way back. See `restore_variable`.

A scene with variants lists them too, `variants`, each a variable's
value by its name, and says which one the variables are in now,
`variant`: of those whose values all hold, the one naming the most,
or None once a slider has moved off them -- and `unusable`, each variant that cannot be
used as the scene stands, with why. See `use_variant`.

### `session.use_variant(name)`

Set the variables a variant names to its values, as one step to
undo -- as a slider sets one, so values the variables' limits refuse
are refused, and the scene is left as it was.

A variant may name fewer variables than the scene has: one written in
code may leave some out on purpose, and one saved before a variable
was added does not know it. Those it does not name keep their values,
and the answer lists them as `untouched`. An entry naming no variable
that holds a value -- renamed by an older studio, or a formula now --
is left out, and listed as `ignored`.

### `session.save_variant(name, values=None)`

Keep values for the scene's variables under a name: a variant, set
back in one step by `use_variant`.

With no `values`, every variable that holds a number or a choice, as
it is now -- what saving a variant from a panel means, so that using
it puts the scene back exactly. With `values`, those named, which may
be fewer; a numeral given as text is the number it spells. A formula
is what a variable is, so no variant holds one. Values the variables'
limits refuse -- the ones it sets, or a formula following them -- are
refused now, not when the variant is used. Saved over a variant of
the same name, it replaces it, in its place. The answer carries the
`values` kept.

### `session.load_scene(scene, base_dir=None)`

Open `scene` as the document, and start the undo history there: a
load is where a scene begins, not an edit of what was open, so the
first undo after it takes back the first edit, never the scene. For
a replacement that *is* an edit -- the script tab's save, a reset --
see `_replace`, which keeps the step.

`scene` is a document dict or a path to a JSON file containing one.
(Script -> document is deferred by design.)

### `session.list_examples()`

The built-in scenes. Each leans on a different feature, which is
the point of having more than one: an example is the shortest
documentation there is.

### `session.load_example(name='halbach', base_dir=None)`

Load one of the built-in scenes; see list_examples(). `base_dir` is
the folder a mesh added later is looked for in, as for load_scene.

### `session.to_builder_script()`

The scene as a `magpylib_studio.build` script which, run, builds
this document again -- variables, formulas and patterns included.
`to_script` is for anyone with magpylib; this is for whoever keeps
the scene as code. See decision 0017 in `docs/decisions.md`.
