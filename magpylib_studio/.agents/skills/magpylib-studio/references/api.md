# The builder and the session, as the skill uses them

Generated from the code by `tools/write-skill-reference.py`: edit the
docstrings, not this file. What follows is what this version of
magpylib-studio has.

## The scene

### `Scene(session=None, *, values=None, model_unit=None, field_unit=None)`

A studio document, written in code.

`Scene()` builds one of its own; `Scene(session)` writes into a session
that already holds a scene, as another way to edit it. Read it with
`to_dict`, `to_script` or `save`, or show it: `SceneWidget(s, editable=True)`.

`values` is where the variables' values come from when there are some: a
saved scene, or a mapping of names to values. The script says what the
scene is; a slider dragged in the panel and saved says what a variable is
set to, and the next run keeps it -- see `variable`. A path to a file not
there yet is no values, so a script can read the file it is about to save.

`model_unit` is the length unit the scene is shown in (`"m"`, the
default, `"cm"`, `"mm"` or `"µm"`): what a view shows a length variable
in, and what an export to a CAD or FEM tool writes. The numbers written
here stay metres either way. `field_unit` is the unit a field is shown
in (`"T"`, the default, `"mT"` or `"µT"`): a polarization, a field
variable, the field plots. The numbers stay tesla.

### `s.variable(name, value, *, bounds=None, slider=None, integer=None, options=None, unit=None)`

Define a variable and return it, to write the scene in.

`value` is a number, a name (for a variable like an axis, with its
`options`), or an expression over earlier variables. `bounds` are
the hard limits, `slider` the range worth dragging through. `unit`
says what it measures -- `"length"`, `"angle"`, `"field"`,
`"current"`, `"dimensionless"` -- so a view shows `gap: 0.015 m`, or
15 mm in a scene shown in mm, and reads `15 mm` typed; the
value itself stays in SI (degrees for an angle), as everything here
is: `s.variable("gap", 0.015, unit="length")`.

With `values` given to the scene, a number or a name here is a
default, and the saved value wins: that is a slider's position, kept
across runs. An expression is not a default but what the variable
*is*, so the script's wins -- a definition changed in the script
must not be undone by the file it last saved.

### `s.sampled(of, *, count=None, over=None)`

A run of points as a formula: `of(t)`, for `t` running across
`over` in `count` steps (the document's defaults, given neither: two,
across 0 to 1). Where a value is a run of points -- a
sensor's pixels, a path, a mesh's vertices -- this keeps it a formula
of the variables, count included, which `np.linspace` over a variable
cannot (it would need the count now):

    grid = s.sampled(
        lambda t: (t % n / (n - 1), t // n / (n - 1), 0),
        count=n**2, over=(0, n**2 - 1),
    )

`of` is called once, with `t` a variable like the others, and
returns one value for a run of numbers or one per component for a
run of points. Each is computed for the whole sample at once, as
numpy would, so `min` and `max` -- not elementwise -- are refused.

### `s.Collection(*children, id=None, style=None, **kwargs)`

magpylib's `Collection`, as the scene's.

### `s.Sensor(id=None, style=None, **kwargs)`

magpylib's `Sensor`, as the scene's.

### `s.add(*objects)`

Put these in the scene at its root, now. Most never need it --
an object enters when it is first used, or when the scene is read --
but a script that wants one created at this point in the log says
so, which is what `to_builder_script` writes.

### `s.session`

The session the scene is written into, with everything
constructed so far in it.

### `s.save(path)`

Write the document as the studio saves one, to open in the panel
(Open Scene) or a notebook (`SceneWidget(path, editable=True)`).

### `s.to_script()`

Plain magpylib, for anyone: see `MagpylibStudioSession.to_script`.

## Objects

### `s.magnet.<Class>(id=None, style=None, **kwargs)`, `s.current.<Class>(...)`, `s.misc.<Class>(...)`

Any class of `magpylib.magnet`, `magpylib.current` or `magpylib.misc`,
taking magpylib's own keywords. `id=` names the object, unique in the
scene (left out: its label, else its class); `style=` takes magpylib's
style as a dict, and each `style_label=`-shaped keyword sets one field
of it.

A magpylib object as the scene records it.

Constructing one records nothing. Its create step is written when it
first enters the scene -- added to a collection, touched by any other
call, or when the scene is read -- because magpylib groups after it
builds (`ring.add(magnet)`), and the session's reparent keeps a moved
object's world pose as numbers: a position written in variables would
stop following them. Created inside its collection, it never moves.

### `obj.move(displacement, start='auto', spacing=None)`

As magpylib's `move`, recorded as a step. `spacing="arange"` says
a path was built from a step, as the script will write it.

### `obj.rotate_from_angax(angle, axis, anchor=None, start='auto', degrees=True, spacing=None)`

As magpylib's `rotate_from_angax`, recorded as a step.

### `obj.rotate_from_rotvec(rotvec, anchor=None, start='auto', degrees=True)`

As magpylib's `rotate_from_rotvec`, recorded as a step.

### `obj.set_transform(position=None, orientation=None)`

Put it at `position` and turn it to `orientation`, in world
coordinates -- the studio's own step for a pose stated outright, which
is what a drag records. `orientation` is a rotation vector in degrees,
or a scipy `Rotation`.

### `obj.reparent(parent)`

Move it into `parent` -- or to the scene's root, given None --
keeping where it is in the world, as the studio's tree does. Unlike
`parent.add(it)` for something already in the scene, this is what it
says, so it does not warn.

### `obj.hide()`

Hide it in the 3D view. It still counts in the field.

### `obj.show()`

Show it again in the 3D view, after `hide` -- its own, or that of a
collection it sits in.

### `obj.remove()`

Take it out of the scene, as a step: what happened while it was
there still happened.

### `obj.duplicate_around(count, axis='z', anchor=0, spin=0)`

`count` of it about `axis` through `anchor`, each copy turned by
`spin` degrees more than the last: one step, which stays a pattern.

### `obj.duplicate_along(count, step)`

`count` of it in a row, each `step` on from the last.

### `obj.mirror(plane='xy', normal=None, anchor=0)`

A reflected copy across `plane` (or the plane with `normal`).

### `group.add(*children)`

As magpylib's `add`. A child that is already in the scene is
reparented, which keeps its world pose as numbers; the builder warns,
since a position written in variables then stops following them.

## What an expression may call

`s.abs`, `s.acos`, `s.asin`, `s.atan`, `s.atan2`, `s.cos`, `s.degrees`, `s.exp`, `s.hypot`, `s.log`, `s.max`, `s.min`, `s.radians`, `s.round`, `s.sin`, `s.sqrt`, `s.tan`, and the constants `s.e`, `s.pi`, `s.tau`. Each takes numbers and
variables alike; these are the expression allow-list's own names, and
all a scene can hold. On a variable, numpy's `np.sin`, `np.cos`, `np.tan`, `np.arcsin`, `np.arccos`, `np.arctan`, `np.arctan2`, `np.sqrt`, `np.exp`, `np.log`, `np.hypot`, `np.radians`, `np.deg2rad`, `np.degrees`, `np.rad2deg`, `np.absolute` write the same
expressions, as does its arithmetic; any other numpy function refuses.

## The session

`s.session` is the scene's `MagpylibStudioSession`;
`MagpylibStudioSession()` is an empty one, to open a saved scene into.
Most of its calls report a refusal rather than raise it:
`{"ok": False, "error": ...}`. Reading the field raises `ValueError`
when there is nothing to read.

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
the scene as code. See `docs/builder.md`.

## When a call fails

### `BuildError`

The scene refused a call. The message is the session's own.
