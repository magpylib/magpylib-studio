"""A scene as a plain magpylib function, recorded: `docs/plans/recording.md`.

    from typing import Annotated, Literal

    import magpylib as magpy
    from magpylib_studio import Count, Length, derived, duplicate_around, scene


    @scene
    def ring(
        n: Annotated[int, Count(2, 60, slider=(4, 20))] = 10,
        radius: Annotated[float, Length(0.005, 0.08)] = 0.023,
        tilt_axis: Literal["x", "y", "z"] = "z",
    ):
        stagger = derived("stagger", 360 / (2 * n), unit="angle")
        magnets = magpy.Collection(style_label="Ring")
        magnet = magpy.magnet.Cuboid(
            dimension=(0.01, 0.01, 0.01), polarization=(1, 0, 0), position=(radius, 0, 0)
        )
        magnets.add(magnet)
        duplicate_around(magnet, count=n, axis="z", spin=360 / n)
        magnets.rotate_from_angax(stagger, tilt_axis, anchor=0)
        return magnets


    ring(n=12).getB((0, 0, 0))  # plain magpylib: real objects, a real field
    ring.build().save("ring.magpy.json")  # studio: the document, n and radius as sliders

One function, three callers. Called, it is the plain function: numbers in and
magpylib objects out, no studio anywhere. `ring.build()` calls it with the
parameters as handles and records what it does -- every construction,
assignment and transformation, through the operations the studio's own panel
uses -- into a `Scene`: the document, with its variables, bounds, units and
steps. `ring.build(values=path)` calls it with a saved scene's values, so the
sliders a person left survive the next run. And a notebook renders the same
signature as draggable numbers (wigglystuff's `TangleFunction`).

Inside `build()` a parameter is a handle: arithmetic on it writes an
expression, and `range(n)`, `if radius > 0.01` or `math.sin(radius)` raise at
their line, saying what to write instead -- a value settled once, for today's
number, would be wrong as soon as a slider moves. Whatever is constructed
during the call is the scene, whoever constructed it. A property read
(`magnet.position`) is today's number: writing it into another call records
that number, and a warning says so.

Studio's own words, each one step in the document: `derived` for a variable
defined by a formula, the patterns `duplicate_around`, `duplicate_along` and
`mirror`, `place` for a pose stated outright, `hide`, `show` and `remove`,
`sampled` for a run of points as a formula of the sample, `TriangularMesh` for
a mesh recorded as where it came from, and `name` for an id the label does not
give. Everything else is magpylib's.
"""

from __future__ import annotations

import contextlib
import dataclasses
import functools
import inspect
import math
import typing
import warnings
from contextvars import ContextVar

import annotated_types
import magpylib as magpy
import numpy as np
from scipy.spatial.transform import Rotation as R

from magpylib_studio import build, expressions, hook, meshes, style_compat
from magpylib_studio.build import BuildError, Expression, Sampled, _arg, _value

__all__ = [
    "Angle",
    "Bounds",
    "Count",
    "Length",
    "SceneFunction",
    "Slider",
    "TriangularMesh",
    "Unit",
    "derived",
    "duplicate_along",
    "duplicate_around",
    "hide",
    "mirror",
    "name",
    "place",
    "remove",
    "sampled",
    "scene",
    "show",
]

#: The recorder of the `build()` in progress, if any.
_BUILDING = ContextVar("magpylib_studio_building", default=None)


# --- a parameter's metadata ---------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Unit(annotated_types.BaseMetadata):
    """What a parameter measures: `"length"`, `"angle"`, `"field"`,
    `"current"` or `"dimensionless"`. Changes how the studio shows and reads
    the value; the number stays SI."""

    kind: str


@dataclasses.dataclass(frozen=True)
class Slider(annotated_types.BaseMetadata):
    """The range worth dragging through, inside the bounds."""

    low: float
    high: float


@dataclasses.dataclass(frozen=True)
class Bounds(annotated_types.GroupedMetadata):
    """A parameter's limits, as `annotated_types` constraints with studio's
    metadata beside them: `Annotated[float, Bounds(0, 1, slider=(0.2, 0.8),
    unit="length")]`. Expands to `Ge`, `Le` and a `MultipleOf` for any reader
    that follows the protocol, so pydantic and the like read the bounds; the
    `Unit` and `Slider` ride along for the studio. `Length`, `Angle` and
    `Count` are this with the kind filled in."""

    low: float | None = None
    high: float | None = None
    slider: tuple | None = None
    unit: str | None = None
    integer: bool = False

    def __iter__(self):
        if self.low is not None:
            yield annotated_types.Ge(self.low)
        if self.high is not None:
            yield annotated_types.Le(self.high)
        if self.low is not None and self.high is not None and not self.integer:
            yield annotated_types.MultipleOf(_decimal_step(self.high - self.low))
        if self.unit is not None:
            yield Unit(self.unit)
        if self.slider is not None:
            yield Slider(*self.slider)


def _decimal_step(span):
    """A step a drag moves a value by: a power of ten about a hundredth of
    the range, so 0.005 to 0.08 m steps by 0.0001 and 0 to 360° by 1."""
    if not span > 0:
        return 1
    return 10.0 ** math.floor(math.log10(span / 100))


def Length(low=None, high=None, *, slider=None):
    """A length in metres: `Annotated[float, Length(0.005, 0.08)]`."""
    return Bounds(low, high, slider=slider, unit="length")


def Angle(low=None, high=None, *, slider=None):
    """An angle in degrees, as magpylib turns."""
    return Bounds(low, high, slider=slider, unit="angle")


def Count(low=None, high=None, *, slider=None):
    """A whole number of things: `Annotated[int, Count(2, 60)]`."""
    return Bounds(low, high, slider=slider, integer=True)


def _metadata(annotation):
    """(base type, [metadata]) of an annotation, grouped metadata expanded."""
    if typing.get_origin(annotation) is typing.Annotated:
        base, *meta = typing.get_args(annotation)
    else:
        base, meta = annotation, []
    flat = []
    for item in meta:
        if isinstance(item, annotated_types.GroupedMetadata):
            flat.extend(item)
        else:
            flat.append(item)
    return base, flat


def _parameter(parameter, annotation):
    """One parameter of a scene function as `Scene.variable` takes it."""
    name = parameter.name
    if parameter.kind not in (
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
        inspect.Parameter.KEYWORD_ONLY,
    ):
        raise TypeError(
            f"a scene's parameters are named, with a default each: {name!r} "
            f"cannot be *args or **kwargs"
        )
    if parameter.default is inspect.Parameter.empty:
        raise TypeError(
            f"{name!r} needs a default: it is the variable's value when the "
            f"scene is first built, and the studio's slider starts there"
        )
    spec = {"name": name, "value": parameter.default}
    base, meta = _metadata(annotation)
    if base is bool or isinstance(parameter.default, bool):
        raise TypeError(
            f"{name!r} is a yes or no, which a scene has no variable for: "
            f"decide it in Python, or make it a Literal of names"
        )
    if typing.get_origin(base) is typing.Literal:
        spec["options"] = list(typing.get_args(base))
    elif isinstance(parameter.default, str):
        raise TypeError(
            f"{name!r} holds a name, so say which names it can hold: "
            f"Literal['x', 'y', 'z']"
        )
    elif base is int:
        spec["integer"] = True
    low = high = None
    for item in meta:
        if isinstance(item, annotated_types.Ge | annotated_types.Gt):
            low = item.ge if isinstance(item, annotated_types.Ge) else item.gt
        elif isinstance(item, annotated_types.Le | annotated_types.Lt):
            high = item.le if isinstance(item, annotated_types.Le) else item.lt
        elif isinstance(item, Slider):
            spec["slider"] = (item.low, item.high)
        elif isinstance(item, Unit):
            spec["unit"] = item.kind
    if low is not None or high is not None:
        spec["bounds"] = (low, high)
    return spec


# --- the decorator ------------------------------------------------------------


class SceneFunction:
    """A function that is a scene: see the module. Call it for plain magpylib
    objects at the values you pass; `build()` for the document."""

    def __init__(self, fn, *, model_unit=None, field_unit=None):
        functools.update_wrapper(self, fn)
        self._fn = fn
        self.model_unit = model_unit
        self.field_unit = field_unit
        try:
            hints = typing.get_type_hints(fn, include_extras=True)
        except Exception:  # noqa: BLE001 - a forward reference the module lacks
            hints = dict(getattr(fn, "__annotations__", {}))
        self.parameters = [
            _parameter(parameter, hints.get(parameter.name))
            for parameter in inspect.signature(fn).parameters.values()
        ]

    def __repr__(self):
        names = ", ".join(spec["name"] for spec in self.parameters)
        return f"<scene {self.__name__}({names})>"

    def __call__(self, *args, **kwargs):
        return self._fn(*args, **kwargs)

    def build(self, values=None):
        """Call the function with its parameters as handles, recording what
        it does, and return the `Scene` it built: the document, to `save`,
        to show (`SceneWidget(s, editable=True)`), or to read the field of
        through `s.session`.

        `values` is where the parameters' values come from when there are
        some: a saved scene (its path) or a mapping of names to values. A
        default in the signature is the value when nothing says otherwise;
        a slider dragged in the panel and saved wins, so the next run keeps
        it. A `derived` variable is a definition, and the function's wins."""
        hook.install()
        document = build.Scene(
            values=values, model_unit=self.model_unit, field_unit=self.field_unit
        )
        recorder = _Recorder(document)
        handles = {
            spec["name"]: document.variable(
                spec["name"],
                spec["value"],
                **{k: v for k, v in spec.items() if k not in ("name", "value")},
            )
            for spec in self.parameters
        }
        token = _BUILDING.set(recorder)
        listening = (
            hook.record(
                recorder.on_event, resolve=recorder.resolve, on_read=recorder.on_read
            )
            if hook.supports_reads
            else hook.record(recorder.on_event, resolve=recorder.resolve)
        )
        try:
            with listening:
                self._fn(**handles)
            recorder.finish()
        finally:
            _BUILDING.reset(token)
        document._built_from = self
        return document

    def save(self, path, values=None):
        """`build(values).save(path)`: the document, as the studio saves one."""
        return self.build(values).save(path)

    def controls(self):
        """Each parameter's range, step and choices, for a control that reads
        the signature but not studio's metadata: wigglystuff's
        `TangleFunction(fn, fn.controls())` renders the call with the slider
        range the scene gives each number, where it gives one, else its
        bounds; a `Literal` as its choices."""
        out = {}
        for spec in self.parameters:
            control = {"value": spec["value"]}
            if "options" in spec:
                control["options"] = list(spec["options"])
                out[spec["name"]] = control
                continue
            low, high = spec.get("slider") or spec.get("bounds") or (None, None)
            if low is not None:
                control["min_value"] = low
            if high is not None:
                control["max_value"] = high
            if spec.get("integer"):
                control["step"] = 1
            elif low is not None and high is not None:
                step = _decimal_step(high - low)
                control["step"] = step
                control["digits"] = max(0, -math.floor(math.log10(step)))
            out[spec["name"]] = control
        return out


def scene(fn=None, *, model_unit=None, field_unit=None):
    """Mark a function as a scene: its parameters are the variables, its body
    is plain magpylib, and `build()` records it. `@scene`, or
    `@scene(model_unit="mm", field_unit="mT")` for the units the studio
    shows the scene in (the numbers stay SI)."""
    if fn is None:
        return functools.partial(scene, model_unit=model_unit, field_unit=field_unit)
    if isinstance(fn, SceneFunction):
        return SceneFunction(fn._fn, model_unit=model_unit, field_unit=field_unit)
    return SceneFunction(fn, model_unit=model_unit, field_unit=field_unit)


# --- the recorder -------------------------------------------------------------


_TRANSFORMS = (
    "rotate",
    "rotate_from_euler",
    "rotate_from_matrix",
    "rotate_from_mrp",
    "rotate_from_quat",
)


def _type_path(cls):
    """magpylib's class -> the document's type: 'magnet.Cuboid', 'Sensor'."""
    if cls is magpy.Sensor:
        return "Sensor"
    if cls is magpy.Collection:
        return "Collection"
    for module in ("magnet", "current", "misc"):
        if getattr(getattr(magpy, module), cls.__name__, None) is cls:
            return f"{module}.{cls.__name__}"
    return None


def _flat_style(given, prefix=""):
    """A style as given -- nested dicts, or `style_label`-shaped keys -- as
    dotted paths."""
    out = {}
    for key, value in (given or {}).items():
        path = prefix + key.replace("_", ".")
        if isinstance(value, dict):
            out.update(_flat_style(value, path + "."))
        else:
            out[path] = value
    return out


def _style_set(obj):
    """The style `obj` was given, without making one it never had: reading
    `obj.style` creates it, and `copy()` then labels the copy."""
    if getattr(obj, "_style", None) is None:
        return _flat_style(getattr(obj, "_style_kwargs", None))
    return style_compat.set_values(obj)


def _same(a, b):
    try:
        same = a == b
        return bool(np.all(same)) if isinstance(same, np.ndarray) else bool(same)
    except Exception:  # noqa: BLE001 - a value whose == raises: compare the text
        return repr(a) == repr(b)


def _rotvec(rotation):
    return np.asarray(rotation.as_rotvec(degrees=True)).tolist()


def _numbers_only(value, what):
    if expressions.contains_expression(_value(value)) or any(
        isinstance(leaf, Expression) for leaf in _leaves(value)
    ):
        raise BuildError(
            f"{what} cannot take a variable: the turn has to be computed now. "
            f"Write it as rotate_from_angax or rotate_from_rotvec, which keep "
            f"the variable"
        )


def _leaves(value):
    if isinstance(value, list | tuple):
        for item in value:
            yield from _leaves(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _leaves(item)
    else:
        yield value


class _Recorder:
    """Maps the hook's events onto the builder's steps, one `Scene` at a
    time. The objects are real magpylib objects, built from the resolved
    arguments; the document keeps the arguments as written."""

    def __init__(self, document):
        self.document = document
        self.session = document._session
        self.objects = {}  # id(magpylib object) -> builder Object
        self.live = {}  # object id -> magpylib object
        self.seen = {}  # object id -> the style last recorded, flat
        self.warned = set()
        #: Objects a step with a variable in it has placed: their pose is
        #: the variables' now, and a read of it is a number.
        self.moved_by_variables = set()

    # -- values

    def resolve(self, value):
        """A handle or a formula -> what magpylib computes with."""
        if isinstance(value, Expression | Sampled):
            return self.session._resolve(_value(value))
        return value

    def resolved(self, value):
        """`resolve`, inside tuples, lists and dicts."""
        if isinstance(value, tuple | list):
            return type(value)(self.resolved(item) for item in value)
        if isinstance(value, dict):
            return {key: self.resolved(item) for key, item in value.items()}
        return self.resolve(value)

    # -- objects

    def known(self, obj):
        found = self.objects.get(id(obj))
        if found is None:
            raise BuildError(
                f"{obj!r} was made before this scene started recording, or "
                f"outside the function: make it inside, so the scene knows it"
            )
        return found

    def register(self, obj, type_, params, style_kwargs, style):
        """A new object: its create step, at the scene's root for now. The
        style is kept as the document keeps it, by dotted path, whether it
        was given nested or as `style_label`-shaped keywords."""
        style = {
            **_flat_style(_value(style or {})),
            **_flat_style({k[len("style_") :]: v for k, v in style_kwargs.items()}),
        }
        object_id, style = self.document._named(None, type_, style, {})
        if type_ == "Collection":
            recorded = build.Collection(self.document, object_id, style, ())
        else:
            recorded = build.Object(
                self.document, type_, object_id, expressions.normalized(params), style
            )
        self.document._objects.append(recorded)
        recorded._enter()
        self.objects[id(obj)] = recorded
        self.live[object_id] = obj
        self.seen[object_id] = _flat_style(style)
        return recorded

    def rename(self, obj, object_id):
        recorded = self.known(obj)
        if object_id == recorded.id:
            return
        if object_id in self.document._ids:
            raise BuildError(f"object id {object_id!r} already exists")
        with hook.nested():
            result = self.session._rename_fresh(recorded.id, object_id)
        if not result["ok"]:
            raise BuildError(result["error"])
        self.document._ids.discard(recorded.id)
        self.document._ids.add(object_id)
        self.live[object_id] = self.live.pop(recorded.id)
        self.seen[object_id] = self.seen.pop(recorded.id)
        recorded.id = object_id

    def adopt(self, child, parent):
        """`parent.add(child)`: a child nothing has touched since it was made
        is created inside the collection; one with steps is moved there,
        which keeps its pose as numbers, and says so."""
        recorded, group = self.known(child), self.known(parent)
        with hook.nested():
            result = self.session._adopt_fresh(recorded.id, group.id)
        if not result["ok"]:
            raise BuildError(result["error"])
        if not result["fresh"]:
            warnings.warn(
                f"{recorded.id!r} is already placed, so adding it to "
                f"{group.id!r} moves it and keeps its pose as numbers: a "
                f"position written in variables stops following them. Add "
                f"it before anything else touches it.",
                stacklevel=4,
            )
            self.call(recorded, "move_object", recorded.id, parent=group.id)

    def call(self, recorded, method, *args, **kwargs):
        return self.document._call(method, *args, **kwargs)

    # -- events

    def on_read(self, obj, attr, value):
        """A property read at top level is today's number. Where the scene
        holds a variable there, say so once: written into another call, the
        number will not follow the variable."""
        recorded = self.objects.get(id(obj))
        if recorded is None or (recorded.id, attr) in self.warned:
            return
        written = (
            recorded._params.get(attr)
            if attr not in ("position", "orientation")
            else None
        )
        symbolic = expressions.contains_expression(written) or (
            attr in ("position", "orientation")
            and recorded.id in self.moved_by_variables
        )
        if symbolic:
            self.warned.add((recorded.id, attr))
            warnings.warn(
                f"{recorded.id}.{attr} read inside the scene is today's number: "
                f"written into another call it will not follow the variable it "
                f"was placed by. Pass the variable itself instead",
                stacklevel=3,
            )

    def on_event(self, event):
        self.flush_styles()
        getattr(self, f"_on_{event.kind}")(event)

    def _on_new(self, event):
        cls = hook.magpylib_class(type(event.obj))
        type_ = _type_path(cls)
        if type_ is None:
            raise BuildError(f"a scene has no step for a {cls.__name__}")
        bound = inspect.signature(cls.__init__).bind(
            event.obj, *event.args, **event.kwargs
        )
        # In the order written, as the document keeps them: what was passed
        # by position first, then the keywords as they came.
        given = {
            key: value
            for key, value in bound.arguments.items()
            if key not in event.kwargs and key != "self"
        }
        given.update(
            (key, value)
            for key, value in event.kwargs.items()
            if key in bound.arguments
        )
        children = given.pop("children", ())
        magic = given.pop("kwargs", {})
        style_kwargs = {k: v for k, v in magic.items() if k.startswith("style_")}
        if len(style_kwargs) != len(magic):
            unknown = sorted(set(magic) - set(style_kwargs))
            raise BuildError(f"{cls.__name__} does not take {', '.join(unknown)}")
        style = given.pop("style", None)
        orientation = given.pop("orientation", None)
        given.pop("override_parent", None)
        params = {
            key: _value(value) for key, value in given.items() if value is not None
        }
        if type_ == "misc.CustomSource":
            raise BuildError(
                "a CustomSource holds Python code (its field_func), which a document "
                "cannot: compute with it plainly, outside the scene"
            )
        recorded = self.register(event.obj, type_, params, style_kwargs, style)
        if expressions.contains_expression(params.get("position")):
            self.moved_by_variables.add(recorded.id)
        if orientation is not None:
            # The pose it was made with, not a turn: a path of orientations
            # is the object's path, as `obj.orientation = ...` sets it.
            recorded.set_transform(orientation=_rotvec(orientation))
        for child in children:
            self.adopt(child, event.obj)

    def _note_symbolic(self, recorded, *values):
        if any(
            isinstance(leaf, Expression) for value in values for leaf in _leaves(value)
        ):
            self.moved_by_variables.add(recorded.id)

    def _on_set(self, event):
        recorded = self.known(event.obj)
        (value,) = event.args
        attr = event.name
        if attr in ("position", "orientation"):
            self._note_symbolic(recorded, value)
        if attr == "style":
            return  # what it set is read at the next flush
        if attr == "position":
            recorded.set_transform(position=value)
        elif attr == "orientation":
            recorded.set_transform(orientation=_rotvec(value))
        elif attr == "parent":
            # Said outright, a move: the object keeps its world pose, as the
            # tree's drag does. `group.add(obj)` is where a fresh object is
            # created inside its group instead.
            recorded.reparent(None if value is None else self.known(value))
        elif attr == "children":
            # `group.children = [...]`: what is in the group now. Those gone
            # from it leave for the root; those new to it are added.
            now = {id(child) for child in value or ()}
            spec = self.session._spec(recorded.id)
            inside = []
            for child_spec in spec.get("children") or []:
                live = self.live.get(child_spec["id"])
                if live is None:
                    continue
                inside.append(id(live))
                if id(live) not in now:
                    self.known(live).reparent(None)
            for child in value or ():
                if id(child) not in inside:
                    self.adopt(child, event.obj)
        elif attr == "centroid":
            raise BuildError(
                "a scene places an object by its position, not its centroid"
            )
        else:
            self.call(recorded, "set_param", recorded.id, attr, _arg(value))

    def _on_call(self, event):
        recorded = self.known(event.obj)
        method = getattr(hook.magpylib_class(type(event.obj)), event.name)
        bound = inspect.signature(method).bind(event.obj, *event.args, **event.kwargs)
        given = dict(bound.arguments)
        given.pop("self", None)
        what = event.name
        self._note_symbolic(recorded, *given.values())
        if what == "move":
            recorded.move(given["displacement"], start=given.get("start", "auto"))
        elif what == "rotate_from_angax":
            recorded.rotate_from_angax(
                given["angle"],
                given["axis"],
                anchor=given.get("anchor"),
                start=given.get("start", "auto"),
                degrees=given.get("degrees", True),
            )
        elif what == "rotate_from_rotvec":
            recorded.rotate_from_rotvec(
                given["rotvec"],
                anchor=given.get("anchor"),
                start=given.get("start", "auto"),
                degrees=given.get("degrees", True),
            )
        elif what in _TRANSFORMS:
            turn = self._rotation(what, given)
            recorded.rotate_from_rotvec(
                _rotvec(turn),
                anchor=given.get("anchor"),
                start=given.get("start", "auto"),
            )
        elif what == "reset_path":
            recorded.set_transform(position=[0, 0, 0], orientation=[0, 0, 0])
        elif what == "add":
            for child in given.get("children", ()):
                self.adopt(child, event.obj)
        elif what == "remove":
            for child in given.get("children", ()):
                self.known(child).reparent(None)
        elif what == "copy":
            self._copied(recorded, event.obj, event.result, given.get("kwargs") or {})
        else:
            raise BuildError(f"a scene has no step for {what}")

    def _rotation(self, what, given):
        if what == "rotate":
            return given["rotation"]
        if what == "rotate_from_euler":
            _numbers_only(given["angle"], "rotate_from_euler")
            return R.from_euler(
                given["seq"], given["angle"], degrees=given.get("degrees", True)
            )
        key = {
            "rotate_from_matrix": "matrix",
            "rotate_from_mrp": "mrp",
            "rotate_from_quat": "quat",
        }[what]
        _numbers_only(given[key], what)
        return getattr(R, f"from_{key}")(given[key])

    def _copied(self, recorded, source, result, overrides):
        """magpylib's `copy()`: the document's copy, with the same overrides."""
        made = self.call(recorded, "copy_object", recorded.id, parent=None)
        new_id = made["id"]
        copies = [result, *_descendants(result)]
        specs = [
            spec for spec, _ in self.session._iter_specs([self.session._spec(new_id)])
        ]
        if len(specs) != len(copies):
            raise BuildError(
                f"the copy of {recorded.id!r} came back with a different shape"
            )
        for live, spec in zip(copies, specs, strict=True):
            twin = (
                build.Collection(self.document, spec["id"], {}, ())
                if spec["type"] == "Collection"
                else build.Object(self.document, spec["type"], spec["id"], {}, {})
            )
            twin._entered = True
            self.document._ids.add(spec["id"])
            self.objects[id(live)] = twin
            self.live[spec["id"]] = live
            self.seen[spec["id"]] = dict(spec.get("style") or {})
        twin = self.objects[id(result)]
        # A copy of an object with steps carries those steps: an override of
        # its pose comes after them, as magpylib applied it, pinned. A fresh
        # object's override is what the copy *is*, on its create, and the copy
        # stays fresh to add to a group.
        new_ids = {spec["id"] for spec in specs}
        carried = any(
            e.get("op") != "create" and e.get("target") in new_ids
            for e in self.session.doc.get("events") or []
        )
        for key, value in overrides.items():
            if key.startswith("style") or key == "style":
                continue  # read at the next flush
            if key == "orientation":
                twin.set_transform(orientation=_rotvec(value))
            elif key == "position" and carried:
                twin.set_transform(position=value)
            else:
                self.call(twin, "set_param", twin.id, key, _arg(value))

    # -- style, read between the calls

    def flush_styles(self):
        for object_id, obj in list(self.live.items()):
            now, before = _style_set(obj), self.seen.get(object_id, {})
            for path in sorted(now):
                if path in before and _same(before[path], now[path]):
                    continue
                try:
                    value = _value(now[path])
                except TypeError:
                    value = now[path]
                if not _encodable(value):
                    if (object_id, path) not in self.warned:
                        self.warned.add((object_id, path))
                        warnings.warn(
                            f"{object_id}'s style {path} holds data a document "
                            f"cannot: not recorded",
                            stacklevel=3,
                        )
                    continue
                self.call(None, "apply_edit", object_id, path, value)
            for path in before:
                if path not in now:
                    self.call(None, "reset_style", object_id, path)
            self.seen[object_id] = now

    def finish(self):
        self.flush_styles()


def _descendants(obj):
    out = []
    for child in getattr(obj, "children", ()) or ():
        out += [child, *_descendants(child)]
    return out


def _encodable(value):
    if isinstance(value, list | tuple):
        return all(_encodable(item) for item in value)
    if isinstance(value, dict):
        return all(_encodable(item) for item in value.values())
    return value is None or isinstance(value, bool | int | float | str)


# --- studio's words -----------------------------------------------------------


def derived(name, formula, *, unit=None):
    """A variable defined by a formula of the others, shown in the panel as
    one: `stagger = derived("stagger", 360 / (2 * n), unit="angle")`. Called
    plainly, it is the formula's value."""
    recorder = _BUILDING.get()
    if recorder is None:
        return formula
    return recorder.document.variable(name, formula, unit=unit)


def name(obj, object_id):
    """Give an object the id `object_id` in the document, where its label (or
    its class) would give another. Rarely needed by hand: the script tab
    writes it where a scene's ids are not what its labels give."""
    recorder = _BUILDING.get()
    if recorder is not None:
        recorder.rename(obj, object_id)
    return obj


def sampled(of, *, count=None, over=None):
    """A run of points as a formula: `of(t)` for `t` running across `over`
    (0 to 1 unless said) in `count` steps. Where a value is a run of points
    -- a sensor's pixels, a path -- this keeps it a formula of the
    variables, count included, which `np.linspace` over a variable cannot.
    Called plainly, it is the points."""
    recorder = _BUILDING.get()
    if recorder is not None:
        return recorder.document.sampled(of, count=count, over=over)
    start, stop = (0, 1) if over is None else over
    sample = np.linspace(start, stop, 2 if count is None else int(count))
    made = of(sample)
    if isinstance(made, tuple | list):
        return np.column_stack(
            [
                np.broadcast_to(np.asarray(item, dtype=float), sample.shape)
                for item in made
            ]
        )
    return np.asarray(made, dtype=float)


def _recording_step(obj, method, *args, **kwargs):
    """Record one of studio's own steps on `obj`, if a scene is being built;
    return the recorder, or None when called plainly."""
    recorder = _BUILDING.get()
    if recorder is not None:
        recorder.flush_styles()
        getattr(recorder.known(obj), method)(*args, **kwargs)
    return recorder


def _resolve_all(recorder, *values):
    return tuple(recorder.resolved(value) if recorder else value for value in values)


def duplicate_around(obj, count, axis="z", anchor=0, spin=0):
    """`count` of `obj` about `axis` through `anchor`, each copy turned by
    `spin` degrees more than the last: one step, which stays a pattern.
    `obj` must sit in a collection, which the copies join.

    Going round the ring already turns each copy with it. `spin` is the extra
    turn about the copy's own axis, on top of that: a Halbach ring, whose
    magnets turn twice as fast as they go round, takes `spin=360 / count`."""
    recorder = _recording_step(
        obj, "duplicate_around", count, axis=axis, anchor=anchor, spin=spin
    )
    count, axis, anchor, spin = _resolve_all(recorder, count, axis, anchor, spin)
    with hook.nested():
        _copies(obj, count, lambda copy, i: _orbit(copy, i, count, axis, anchor, spin))
    return obj


def duplicate_along(obj, count, step):
    """`count` of `obj` in a row, each `step` on from the last. Twice -- on
    the object, then on its collection -- for a grid."""
    recorder = _recording_step(obj, "duplicate_along", count, step)
    count, step = _resolve_all(recorder, count, step)
    with hook.nested():
        _copies(obj, count, lambda copy, i: copy.move([i * float(c) for c in step]))
    return obj


def mirror(obj, plane="xy", normal=None, anchor=0):
    """A reflected copy of `obj` across `plane` (or the plane with `normal`),
    polarization and all. Only shapes with a mirror symmetry of their own:
    cuboids, cylinders and their segments, spheres, dipoles and sensors."""
    recorder = _recording_step(obj, "mirror", plane=plane, normal=normal, anchor=anchor)
    normal, anchor = _resolve_all(recorder, normal, anchor)
    from magpylib_studio import session

    with hook.nested():
        copy = session.reflected(obj, plane, normal, anchor)
        session.name_copy(copy, obj, 1)
        _container(obj).add(copy)
    return obj


def _copies(obj, count, place_copy):
    from magpylib_studio import session

    n = session._whole(count, "duplicate count")
    container = _container(obj)
    copies = []
    for i in range(1, n):
        copy = obj.copy()
        place_copy(copy, i)
        session.name_copy(copy, obj, i)
        copies.append(copy)
    if copies:
        container.add(*copies)


def _orbit(copy, i, count, axis, anchor, spin):
    copy.rotate_from_angax(i * 360 / count, axis, anchor=anchor)
    if spin:
        copy.rotate_from_angax(i * float(spin), axis, anchor=None)


def _container(obj):
    if obj.parent is None:
        label = getattr(
            getattr(obj, "_style_kwargs", None) or {}, "get", lambda k: None
        )("label")
        raise ValueError(
            f"{label or type(obj).__name__!r} is not inside a Collection, so its "
            f"copies have no group to join"
        )
    return obj.parent


def place(obj, position=None, orientation=None):
    """Put `obj` at `position` and turn it to `orientation`, in world
    coordinates: the studio's own step for a pose stated outright, which is
    what a drag records. `orientation` is a rotation vector in degrees."""
    recorder = _recording_step(
        obj, "set_transform", position=position, orientation=orientation
    )
    position, orientation = _resolve_all(recorder, position, orientation)
    with hook.nested():
        if position is not None:
            obj.position = position
        if orientation is not None:
            obj.orientation = R.from_rotvec(orientation, degrees=True)
    return obj


def hide(obj):
    """Hide `obj` in the 3D view. It still counts in the field."""
    recorder = _recording_step(obj, "hide")
    _switch(obj, False, recorder)
    return obj


def show(obj):
    """Show `obj` again in the 3D view, after `hide`."""
    recorder = _recording_step(obj, "show")
    _switch(obj, True, recorder)
    return obj


def _switch(obj, shown, recorder=None):
    """magpylib's own switches, on every leaf, as the studio hides: the
    object keeps its slot in the colour sequence. What the step set is not a
    style edit for the recorder to find at its next look."""
    inside = _descendants(obj) if isinstance(obj, magpy.Collection) else [obj]
    leaves = [leaf for leaf in inside if not isinstance(leaf, magpy.Collection)]
    with hook.nested():
        for leaf in leaves:
            leaf.style.model3d.showdefault = shown
            leaf.style.path.show = shown
    if recorder is not None:
        for leaf in leaves:
            known = recorder.objects.get(id(leaf))
            if known is not None:
                recorder.seen[known.id] = _style_set(leaf)


def remove(obj):
    """Take `obj` out of the scene, as a step: what happened while it was
    there still happened."""
    _recording_step(obj, "remove")
    with hook.nested():
        if obj.parent is not None:
            obj.parent.remove(obj)
    return obj


def TriangularMesh(mesh_source, **kwargs):
    """magpylib's `TriangularMesh`, recorded as where its mesh came from
    rather than as its vertices: `mesh_source={"from": "file", "path":
    "rotor.stl", "scale": 0.001}`, `{"from": "hull", "points": [...]}` or
    `{"from": "superquadric", "size": ..., "roundness": ...}`. The other
    keywords are magpylib's (`polarization`, `position`, `style_label`)."""
    recorder = _BUILDING.get()
    source = recorder.resolved(mesh_source) if recorder else mesh_source
    session = recorder.session if recorder else None
    given = recorder.resolved(kwargs) if recorder else kwargs
    with hook.nested():  # the resolver checks the mesh on an object of its own
        mesh = meshes.resolve(
            source,
            base_dir=session._base_dir if session else None,
            cache=session._mesh_cache if session else None,
        )
        obj = magpy.magnet.TriangularMesh(**meshes.constructor_kwargs(mesh), **given)
        meshes.stamp_status(obj, mesh["status"])  # the checks ran in the resolver
    if recorder is not None:
        recorder.flush_styles()
        style_kwargs = {k: v for k, v in kwargs.items() if k.startswith("style_")}
        params = {
            key: _value(value)
            for key, value in kwargs.items()
            if key not in style_kwargs and key != "style" and value is not None
        }
        orientation = params.pop("orientation", None)
        recorded = recorder.register(
            obj,
            "magnet.TriangularMesh",
            {**params, "mesh_source": _value(mesh_source)},
            style_kwargs,
            kwargs.get("style"),
        )
        if orientation is not None:
            recorded.set_transform(orientation=_rotvec(orientation))
    return obj


# --- what an expression may say -----------------------------------------------

#: The constants an expression has, as handles: `pi * radius` stays `pi`.
pi = Expression("pi")
tau = Expression("tau")
e = Expression("e")

for _fname in expressions._FUNCTIONS:
    globals()[_fname] = build._function(_fname).__func__
del _fname


@contextlib.contextmanager
def building(recorder):
    """For the session: make `recorder` the build in progress."""
    token = _BUILDING.set(recorder)
    try:
        yield
    finally:
        _BUILDING.reset(token)
