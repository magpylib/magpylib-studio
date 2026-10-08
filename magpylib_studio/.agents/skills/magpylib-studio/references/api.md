# A scene function, its words, and the session, as the skill uses them

Generated from the code by `tools/write-skill-reference.py`: edit the
docstrings, not this file. What follows is what this version of
magpylib-studio has.

## The mark

### `scene(fn=None, *, model_unit=None, field_unit=None)`

Mark a function as a scene: its parameters are the variables, its body
is plain magpylib, and `build()` records it. `@scene`, or
`@scene(model_unit="mm", field_unit="mT")` for the units the studio
shows the scene in (the numbers stay SI).

What `@scene` makes:

### `fn.build(values=None)`

Call the function with its parameters as handles, recording what
it does, and return the `Scene` it built: the document, to `save`,
to show (`SceneWidget(s, editable=True)`), or to read the field of
through `s.session`.

`values` is where the parameters' values come from when there are
some: a saved scene (its path) or a mapping of names to values. A
default in the signature is the value when nothing says otherwise;
a slider dragged in the panel and saved wins, so the next run keeps
it. A `derived` variable is a definition, and the function's wins.

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

### `hide(obj)`

Hide `obj` in the 3D view. It still counts in the field.

### `show(obj)`

Show `obj` again in the 3D view, after `hide`.

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

Give an object the id `object_id` in the document, where its label (or
its class) would give another. Rarely needed by hand: the script tab
writes it where a scene's ids are not what its labels give.

## What an expression may call

`abs`, `acos`, `asin`, `atan`, `atan2`, `cos`, `degrees`, `exp`, `hypot`, `log`, `max`, `min`, `radians`, `round`, `sin`, `sqrt`, `tan`, and the constants `e`, `pi`, `tau`: the expression
allow-list's own names, and all a scene can hold. Over a variable,
numpy's `np.sin`, `np.cos`, `np.tan`, `np.arcsin`, `np.arccos`, `np.arctan`, `np.arctan2`, `np.sqrt`, `np.exp`, `np.log`, `np.hypot`, `np.radians`, `np.deg2rad`, `np.degrees`, `np.rad2deg`, `np.absolute`, `np.minimum`, `np.maximum` write these expressions, as does arithmetic, and
the builtins `abs` and `round`; any other numpy function refuses. The
constants as handles are `from magpylib_studio.recording import pi, tau, e`.

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

### `session.get_variables()`

The document's variables, as written, as resolved, and as heeded.

`inert` marks one nothing in the scene follows any more, and
`shadowed` says where it is being overruled, by which steps or by
which value written over it — enough for a view to explain a slider
that moves nothing, and to offer the way back. See `restore_variable`.

### `session.load_scene(scene, base_dir=None)`

Replace the whole document. `scene` is a document dict or a path to
a JSON file containing one. (Script -> document is deferred by design.)

A host with its own filesystem access should pass the dict: reading
the file here only works where this process can open() it, which is
not everywhere a document can live. It should pass `base_dir` with
it — the directory the document was read from, which is what a
relative mesh path is relative to. Passing the *path* fills it in;
passing the dict cannot, which is why the parameter exists.

Versions: older documents (including every one written before the
field existed) are migrated; a newer one is refused, because reading
it with this engine's vocabulary and saving it back would drop
whatever it added. See DOC_VERSION.

### `session.list_examples()`

The built-in scenes. Each leans on a different feature, which is
the point of having more than one: an example is the shortest
documentation there is.

### `session.load_example(name='halbach')`

Load one of the built-in scenes; see list_examples().

### `session.to_builder_script()`

The scene as a `magpylib_studio.build` script which, run, builds
this document again -- variables, formulas and patterns included.
`to_script` is for anyone with magpylib; this is for whoever keeps
the scene as code. See `docs/plans/builder.md`.
