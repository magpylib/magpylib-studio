"""The document builder underneath a scene function: a `Scene` is a studio
document written one operation at a time, through the session the panel uses.

    from magpylib_studio.build import Scene

    s = Scene()
    radius = s.variable("radius", 0.023, bounds=(0.005, 0.08))

`radius` is a handle, not a number: arithmetic on it writes an expression
(`"=radius / 2"`), and anything that needs the value now -- `if radius > 0.01`,
`range(n)`, `float(radius)`, `math.sin(radius)` -- raises at that line and
says what to write instead. Evaluating quietly would hand back a scene that
looks right and has lost its variables.

Objects are not made here. A scene is written as a plain magpylib function
(`magpylib_studio.recording`): its parameters are the variables, and the
recorder turns each magpylib call the function makes into a step on this
document, through `Object` and `Collection` below. `scenes_in` finds the scene
a script left behind, and `script_of` writes a document back as such a
function, which run builds the same document.
"""

from __future__ import annotations

import ast
import contextlib
import json
import pathlib
import sys

import numpy as np

from magpylib_studio import expressions, hook, units
from magpylib_studio.session import (
    _HIDE_STYLE,
    MagpylibStudioSession,
    _arange_lit,
    _linspace_lit,
)


class BuildError(Exception):
    """The scene refused a call. The message is the session's own."""


# --- values decided later ---------------------------------------------------


def _operand(value):
    """`value` as expression text, or None when it cannot be one."""
    if isinstance(value, Expression):
        return f"({value._source})"
    if isinstance(value, np.ndarray) and value.ndim == 0:
        value = value.item()
    if isinstance(value, bool):
        return None
    if isinstance(value, int | np.integer):
        return f"({int(value)!r})"
    if isinstance(value, float | np.floating):
        return f"({float(value)!r})"
    return None


def _binary(op, reflected=False):
    def method(self, other):
        text = _operand(other)
        if text is None:
            return NotImplemented
        mine = _operand(self)
        return Expression._of(
            f"{text} {op} {mine}" if reflected else f"{mine} {op} {text}"
        )

    return method


def _call(name, *args):
    texts = [_operand(arg) for arg in args]
    if None in texts:
        bad = args[texts.index(None)]
        raise TypeError(f"{name}() in a scene takes numbers and variables, not {bad!r}")
    return Expression._of(f"{name}({', '.join(texts)})")


class Expression:
    """A value decided when the scene is built, and again whenever a variable
    it names changes: a variable, or arithmetic over variables.

    It refuses to be a number, a truth value, a count or text, because each of
    those would be settled once, for today's value, and then be wrong."""

    __slots__ = ("_source",)

    def __init__(self, source):
        self._source = source

    @classmethod
    def _of(cls, source):
        # Canonical from the start, as the document writes it: redundant
        # brackets gone, spacing as the panel would show it.
        return cls(expressions.normalized(expressions.PREFIX + source)[1:])

    def __repr__(self):
        return f"<expression {self._source}>"

    __add__, __radd__ = _binary("+"), _binary("+", reflected=True)
    __sub__, __rsub__ = _binary("-"), _binary("-", reflected=True)
    __mul__, __rmul__ = _binary("*"), _binary("*", reflected=True)
    __truediv__, __rtruediv__ = _binary("/"), _binary("/", reflected=True)
    __floordiv__, __rfloordiv__ = _binary("//"), _binary("//", reflected=True)
    __mod__, __rmod__ = _binary("%"), _binary("%", reflected=True)
    __pow__, __rpow__ = _binary("**"), _binary("**", reflected=True)

    def __neg__(self):
        return Expression._of(f"-{_operand(self)}")

    def __pos__(self):
        return self

    def __abs__(self):
        return _call("abs", self)

    def __round__(self, ndigits=None):
        return (
            _call("round", self) if ndigits is None else _call("round", self, ndigits)
        )

    # numpy: its arithmetic and the functions an expression has are written
    # as expressions (so `np.pi * radius` and `np.sin(tilt)` work); anything
    # else would need the value, and says so.
    def __array_ufunc__(self, ufunc, method, *inputs, **kwargs):
        if method == "__call__" and not kwargs:
            if ufunc in _UFUNC_OPERATORS and len(inputs) == 2:
                a, b = (_operand(value) for value in inputs)
                if a is not None and b is not None:
                    return Expression._of(f"{a} {_UFUNC_OPERATORS[ufunc]} {b}")
            elif ufunc is np.negative:
                return -inputs[0]
            elif ufunc is np.positive:
                return inputs[0]
            elif ufunc in _UFUNC_FUNCTIONS:
                if all(_operand(value) is not None for value in inputs):
                    return _call(_UFUNC_FUNCTIONS[ufunc], *inputs)
        if any(isinstance(value, np.ndarray) and value.ndim for value in inputs):
            raise TypeError(
                f"numpy cannot take `{self._source}` into an array: write a vector "
                f"a component at a time, as position=({self._source}, 0, 0)"
            )
        raise TypeError(
            f"numpy's {ufunc.__name__} has no counterpart in a scene's "
            f"expressions, so `{self._source}` cannot go through it: "
            f"see expressions.reference() for what can"
        )

    def __array__(self, *args, **kwargs):
        raise TypeError(
            f"numpy cannot make an array of `{self._source}`: an array holds "
            f"numbers, and this is decided later. Write a vector a component at "
            f"a time -- position=({self._source}, 0, 0) -- and keep np.linspace "
            f"to fixed ends"
        )

    def _undecided(self, *args):
        raise TypeError(
            f"`{self._source}` has no value to decide with: an `if` or a "
            f"comparison on it would be settled once, for today's value, and be "
            f"wrong as soon as it changes. Branch on something fixed"
        )

    __bool__ = _undecided
    __lt__ = __le__ = __gt__ = __ge__ = __eq__ = __ne__ = _undecided
    __hash__ = None

    def __index__(self):
        raise TypeError(
            f"`{self._source}` cannot count a loop or index a list: that would "
            f"run once, for today's value, and nothing would follow it. A "
            f"pattern stays parametric: duplicate_around(count={self._source}, "
            f"spin=...) -- spin is each copy's extra turn about its own axis, on "
            f"top of going round the ring -- or duplicate_along(count="
            f"{self._source}, step=...)"
        )

    def _not_a_number(self, *args):
        raise TypeError(
            f"`{self._source}` is not a number here: it stays a variable in the "
            f"document. Pass it where a value goes (position=({self._source}, 0, 0)); "
            f"for maths use numpy or the scene's functions -- np.sin(x) or "
            f"s.sin(x) -- not the math module"
        )

    __float__ = __int__ = __complex__ = _not_a_number

    def _not_text(self, *args):
        raise TypeError(
            f"`{self._source}` is not text: a label is written once, and would "
            f"not follow it"
        )

    __str__ = __format__ = _not_text

    def __iter__(self):
        raise TypeError(
            f"`{self._source}` is one value, not a sequence: write a vector a "
            f"component at a time, as ({self._source}, 0, 0)"
        )


class Variable(Expression):
    """A variable of the document, as `Scene.variable` returned it."""

    __slots__ = ()

    def __repr__(self):
        return f"<variable {self._source}>"


_UFUNC_OPERATORS = {
    np.add: "+",
    np.subtract: "-",
    np.multiply: "*",
    np.true_divide: "/",
    np.floor_divide: "//",
    np.remainder: "%",
    np.power: "**",
}
_UFUNC_FUNCTIONS = {
    np.sin: "sin",
    np.cos: "cos",
    np.tan: "tan",
    np.arcsin: "asin",
    np.arccos: "acos",
    np.arctan: "atan",
    np.arctan2: "atan2",
    np.sqrt: "sqrt",
    np.exp: "exp",
    np.log: "log",
    np.hypot: "hypot",
    np.radians: "radians",
    np.deg2rad: "radians",
    np.degrees: "degrees",
    np.rad2deg: "degrees",
    np.absolute: "abs",
    np.minimum: "min",
    np.maximum: "max",
}


def _function(name):
    """One of the functions an expression may call, taking variables: with
    none among its arguments it just computes, as the builtin would."""
    compute = expressions._FUNCTIONS[name]

    def function(*args):
        if any(isinstance(arg, Expression) for arg in args):
            return _call(name, *args)
        return compute(*args)

    function.__name__ = name
    function.__doc__ = f"`{name}` over numbers and variables."
    return staticmethod(function)


#: `degrees(x)` over a number or a handle, for a turn given in radians.
_degrees = _function("degrees").__func__


class Sampled:
    """A run of points stated as a formula of a sample: the document's
    sampled node, as `Scene.sampled` makes it."""

    __slots__ = ("_spec",)

    def __init__(self, spec):
        self._spec = spec

    def __repr__(self):
        return f"<sampled {self._spec['of']} over {self._spec.get('over', [0, 1])}>"


def _value(value):
    """`value` as the document writes it: an expression as `=` text, a
    vector as a list, a numpy number as a Python one."""
    if isinstance(value, Expression):
        return expressions.PREFIX + value._source
    if isinstance(value, Sampled):
        return {expressions.SAMPLED: value._spec}
    if isinstance(value, np.ndarray):
        return _value(value.tolist())
    if isinstance(value, list | tuple):
        return [_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _value(item) for key, item in value.items()}
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, Object):
        raise TypeError(f"{value!r} is an object, not a value")
    return value


def _arg(value):
    return None if value is None else expressions.normalized(_value(value))


# --- objects ------------------------------------------------------------------


class Object:
    """A magpylib object as the document records it: one step per call,
    through the session operation the panel uses. The recorder
    (`magpylib_studio.recording`) makes one for each magpylib object a scene
    function constructs, and calls these as the function calls magpylib."""

    def __init__(self, scene, type_, object_id, params, style):
        self._scene = scene
        self._type = type_
        self.id = object_id
        self._params = params
        self._style = style
        self._entered = False

    def __repr__(self):
        return f"<{self._type} {self.id!r}>"

    def _enter(self, parent=None):
        """Its create step, at the scene's root, once."""
        if self._entered:
            return
        self._scene._create(self, parent)

    def move(self, displacement, start="auto", spacing=None):
        """As magpylib's `move`, recorded as a step. `spacing="arange"` says
        a path was built from a step, as the script will write it."""
        self._enter()
        self._scene._call(
            "move", self.id, _arg(displacement), start=start, spacing=spacing
        )
        return self

    def rotate_from_angax(
        self, angle, axis, anchor=None, start="auto", degrees=True, spacing=None
    ):
        """As magpylib's `rotate_from_angax`, recorded as a step."""
        if not degrees:
            angle = _degrees(angle)
        self._enter()
        self._scene._call(
            "rotate",
            self.id,
            _arg(angle),
            axis=_arg(axis),
            anchor=_arg(anchor),
            start=start,
            spacing=spacing,
        )
        return self

    def rotate_from_rotvec(self, rotvec, anchor=None, start="auto", degrees=True):
        """As magpylib's `rotate_from_rotvec`, recorded as a step."""
        if not degrees:
            rotvec = [_degrees(component) for component in rotvec]
        op = {"op": "rotate_from_rotvec", "rotvec": _arg(rotvec)}
        if anchor is not None:
            op["anchor"] = _arg(anchor)
        if start != "auto":
            op["start"] = start
        self._enter()
        self._scene._call("_append_ops", self.id, [op], f"rotate {self.id}")
        return self

    def set_transform(self, position=None, orientation=None):
        """Put it at `position` and turn it to `orientation`, in world
        coordinates -- the studio's own step for a pose stated outright, which
        is what a drag records. `orientation` is a rotation vector in degrees,
        or a scipy `Rotation`."""
        if hasattr(orientation, "as_rotvec"):
            orientation = orientation.as_rotvec(degrees=True).tolist()
        self._enter()
        self._scene._call(
            "set_transform",
            self.id,
            position=_arg(position),
            orientation=_arg(orientation),
        )
        return self

    def reparent(self, parent):
        """Move it into `parent` -- or to the scene's root, given None --
        keeping where it is in the world, as the studio's tree does. Unlike
        `parent.add(it)` for something already in the scene, this is what it
        says, so it does not warn."""
        self._enter()
        if parent is not None:
            parent._enter()
        self._scene._call(
            "move_object", self.id, parent=None if parent is None else parent.id
        )
        return self

    def remove(self):
        """Take it out of the scene, as a step: what happened while it was
        there still happened."""
        self._enter()
        self._scene._call("remove_object", self.id)

    def hide(self):
        """Hide it in the 3D view. It still counts in the field."""
        self._enter()
        self._scene._call("set_visible", self.id, False)
        return self

    def show(self):
        """Show it again in the 3D view, after `hide` -- its own, or that of a
        collection it sits in."""
        self._enter()
        self._scene._call("set_visible", self.id, True)
        return self

    def duplicate_around(self, count, axis="z", anchor=0, spin=0):
        """`count` of it about `axis` through `anchor`, each copy turned by
        `spin` degrees more than the last: one step, which stays a pattern.

        Going round the ring already turns each copy with it. `spin` is the extra
        turn about the copy's own axis, on top of that: a Halbach ring, whose
        magnets turn twice as fast as they go round, takes `spin=360 / count`."""
        self._enter()
        self._scene._call(
            "duplicate_around",
            self.id,
            _arg(count),
            axis=_arg(axis),
            anchor=_arg(anchor),
            spin=_arg(spin),
        )
        return self

    def duplicate_along(self, count, step):
        """`count` of it in a row, each `step` on from the last."""
        self._enter()
        self._scene._call("duplicate_along", self.id, _arg(count), _arg(step))
        return self

    def mirror(self, plane="xy", normal=None, anchor=0):
        """A reflected copy across `plane` (or the plane with `normal`)."""
        self._enter()
        self._scene._call(
            "mirror", self.id, plane=plane, normal=_arg(normal), anchor=_arg(anchor)
        )
        return self


class Collection(Object):
    """magpylib's `Collection`, as the document records it. What is in it is
    the recorder's to say: a child made at the root is moved in as it is
    added (`session._adopt_fresh`)."""

    def __init__(self, scene, object_id, style, children=()):
        super().__init__(scene, "Collection", object_id, {}, style)
        if children:
            raise TypeError(
                "a recorded collection is given its children by the recorder"
            )


# --- the scene ----------------------------------------------------------------


class Scene:
    """A studio document, written in code.

    `Scene()` builds one of its own; `Scene(session)` writes into a session
    that already holds a scene, as another way to edit it. Read it with
    `to_dict`, `to_script` or `save`, or show it: `SceneWidget(s, editable=True)`.
    To open a saved `.magpy.json` -- its field, a sweep of a variable -- use
    the session: `MagpylibStudioSession().load_scene(path)`, then `get_field`
    or `sweep`.

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
    """

    def __init__(self, session=None, *, values=None, model_unit=None, field_unit=None):
        if session is None:
            session = MagpylibStudioSession()
            session._base_dir = _base_dir
        self._session = session
        if model_unit is not None:
            self._call("set_model_unit", model_unit)
        if field_unit is not None:
            self._call("set_field_unit", field_unit)
        if isinstance(values, str | pathlib.PurePath):
            path = pathlib.Path(values)
            saved = (
                json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            )
            values = saved.get("variables") or {}
        self._values = dict(values or {})
        #: Constructed, in order, for the ones never added or touched: they
        #: enter at the root when the scene is read.
        self._objects = []
        self._ids = {spec["id"] for spec, _ in self._session._iter_specs()}
        #: The scene function this was built from, if any.
        self._built_from = None

    def variable(
        self,
        name,
        value,
        *,
        bounds=None,
        slider=None,
        integer=None,
        options=None,
        unit=None,
    ):
        """Define a variable and return it, to write the scene in.

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
        must not be undone by the file it last saved."""
        if any(v["name"] == name for v in self._session.get_variables()["variables"]):
            raise BuildError(f"there is already a variable {name!r}")
        if name in self._values and not isinstance(value, Expression):
            value = self._values[name]
        self._call("set_variable", name, _value(value))
        limits = {}
        # Either end may be open: `bounds=(0, None)` is a floor and no ceiling.
        for pair, (low, high) in (
            (bounds, ("min", "max")),
            (slider, ("soft_min", "soft_max")),
        ):
            if pair is not None:
                for key, end in zip((low, high), _value(pair), strict=True):
                    if end is not None:
                        limits[key] = end
        if integer is not None:
            limits["integer"] = integer
        if options is not None:
            limits["options"] = list(options)
        if limits:
            self._call("set_variable_bounds", name, **limits)
        if unit is not None:
            self._call("set_variable_unit", name, unit)
        return Variable(name)

    def sampled(self, of, *, count=None, over=None):
        """A run of points as a formula: `of(t)`, for `t` running across
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
        numpy would, so `min` and `max` -- not elementwise -- are refused."""
        sample = Expression(expressions.SAMPLE)
        made = of(sample)
        spec = {}
        if count is not None:
            spec["count"] = _arg(count)
        if over is not None:
            spec["over"] = _arg(list(over))
        spec["of"] = _arg(list(made) if isinstance(made, tuple) else made)
        return Sampled(spec)

    @property
    def session(self):
        """The session the scene is written into, with everything
        constructed so far in it."""
        for obj in list(self._objects):
            obj._enter()
        return self._session

    def to_dict(self):
        return self.session.to_dict()

    def to_script(self):
        """Plain magpylib, for anyone: see `MagpylibStudioSession.to_script`."""
        return self.session.to_script()

    def save(self, path):
        """Write the document as the studio saves one, to open in the panel
        (Open Scene) or a notebook (`SceneWidget(path, editable=True)`)."""
        path = pathlib.Path(path)
        text = json.dumps(self.to_dict(), indent=2, ensure_ascii=False) + "\n"
        path.write_text(text, encoding="utf-8")
        return path

    # -- what the recorder calls

    def _named(self, object_id, type_, style, kwargs):
        """The object's id, reserved now so that a clash is reported at the
        line that made it, and its style: `style=` merged with magpylib's
        `style_label=`-shaped keywords, which are taken out of `kwargs`."""
        from magpylib_studio import importer

        style = json.loads(json.dumps(_value(style or {})))
        for key in [k for k in kwargs if k.startswith("style_")]:
            *path, last = key.split("_")[1:]
            node = style
            for part in path:
                node = node.setdefault(part, {})
            node[last] = _value(kwargs.pop(key))
        if object_id is None:
            base = style.get("label") or type_.rsplit(".", 1)[-1].lower()
            return importer._unique_id(base, self._ids), style
        if object_id in self._ids:
            raise BuildError(f"object id {object_id!r} already exists")
        self._ids.add(object_id)
        return object_id, style

    def _create(self, obj, parent):
        if parent is not None:
            parent._enter()
        obj._entered = True  # before the call: a collection's children follow it
        try:
            self._call(
                "add_object",
                obj.id,
                obj._type,
                params=obj._params or None,
                style=obj._style or None,
                parent=None if parent is None else parent.id,
            )
        except BuildError:
            obj._entered = False
            raise

    def _call(self, method, *args, **kwargs):
        # In the order written: a step after a pattern comes after it, as in
        # magpylib, where the panel's drag goes in front so the copies follow.
        session = self._session
        before, session._in_order = session._in_order, True
        try:
            # The session builds magpylib objects of its own on every call;
            # with a scene function recording, those are not the script's.
            with hook.nested():
                result = getattr(session, method)(*args, **kwargs)
        finally:
            session._in_order = before
        if isinstance(result, dict) and result.get("ok") is False:
            raise BuildError(result.get("error"))
        return result


#: What a relative mesh path in a `Scene()` of its own is relative to; see
#: `resolving_against`. None is the session's default, the working directory.
_base_dir = None


@contextlib.contextmanager
def resolving_against(base_dir):
    """Scenes made from scratch inside this resolve a relative mesh path
    against `base_dir`, as the document they stand for does. The script tab
    is a file in the editor's storage and the engine runs wherever the editor
    started it; neither is where the scene's STL sits."""
    global _base_dir  # a module's, not a thread's: the engine runs one thing at a time
    previous, _base_dir = _base_dir, base_dir
    try:
        yield
    finally:
        _base_dir = previous


def scenes_in(namespace):
    """The scenes a script left behind, as (name, scene), each once however
    many names it has."""
    from magpylib_studio.recording import SceneFunction

    found = []
    for name, value in namespace.items():
        if name.startswith("_") or not isinstance(value, Scene):
            continue
        if all(value is not scene for _, scene in found):
            found.append((name, value))
    # A scene function is a scene once built; one the script built itself
    # (`ring.build()` left in a name) counts once.
    for name, value in namespace.items():
        if name.startswith("_") or not isinstance(value, SceneFunction):
            continue
        if any(scene._built_from is value for _, scene in found):
            continue
        found.append((name, value.build()))
    return found


# --- the other way: a document as a builder script ----------------------------


def script_of(session):
    """`session`'s scene as a builder script which, run, builds it again.

    One call per step of the log, in its order, so what comes back is the
    same document -- variables, formulas and patterns included -- and not
    the flattened scene running a plain magpylib export gives. Nothing reads
    this back: it is executed, through the operations the panel uses (see
    `docs/plans/builder.md` §5). What has no call of its own -- an expression a
    resize set aside, a key this engine does not know, a step that no longer
    applies -- is named in a comment at the top rather than written.
    """
    return _ScriptWriter(session.to_dict(), session._broken).write()


def not_written(session):
    """What `script_of` names at the top of the script rather than writing:
    what a scene built from that script will not have."""
    writer = _ScriptWriter(session.to_dict(), session._broken)
    writer.write()
    return writer.unwritten


def rebuilt(session):
    """`session`'s scene built again from its own builder script, as a
    session: what the script tab says the scene is, to set beside what it
    is. Raises whatever running the script raises."""
    namespace = {"__name__": "__main__"}
    code = compile(script_of(session), "<the scene's builder script>", "exec")
    with (
        resolving_against(session._base_dir),
        contextlib.redirect_stdout(sys.stderr),
    ):
        exec(code, namespace)  # noqa: S102 - code this module wrote
        ((_, scene),) = scenes_in(namespace)
    return scene.session


#: A variable's limits as `Scene.variable` takes them.
_LIMITS = ("min", "max", "soft_min", "soft_max", "integer", "options", "unit")

#: What a step of each kind may say in the function form. A key outside the
#: list is one this engine does not know: named at the top, not written.
_STEP_KEYS = {
    "move": ("displacement", "start", "spacing"),
    "rotate_from_angax": ("angle", "axis", "anchor", "start", "spacing"),
    "rotate_from_rotvec": ("rotvec", "anchor", "start"),
    "duplicate_around": ("count", "axis", "anchor", "spin"),
    "duplicate_along": ("count", "step"),
    "mirror": ("plane", "normal", "anchor"),
    "reparent": ("parent",),
    "remove": (),
}

#: The expression functions as numpy spells them over a handle. `abs` and
#: `round` are builtins a handle answers, and stay as written.
_NUMPY_NAMES = {
    "sin": "sin",
    "cos": "cos",
    "tan": "tan",
    "asin": "arcsin",
    "acos": "arccos",
    "atan": "arctan",
    "atan2": "arctan2",
    "sqrt": "sqrt",
    "exp": "exp",
    "log": "log",
    "hypot": "hypot",
    "radians": "radians",
    "degrees": "degrees",
    "min": "minimum",
    "max": "maximum",
}

#: Studio's words, imported as used; a variable of the same name has the
#: import aliased, so the script's own names and the scene's never clash.
_WORDS = (
    "scene",
    "derived",
    "name",
    "sampled",
    "place",
    "hide",
    "show",
    "remove",
    "duplicate_around",
    "duplicate_along",
    "mirror",
    "TriangularMesh",
    "Length",
    "Angle",
    "Count",
    "Bounds",
)
_RESERVED = (*_WORDS, "pi", "tau", "e", "Annotated", "Literal", "np", "magpy")


def _nested(flat):
    """A style with dotted paths, as magpylib's constructor takes it."""
    root = {}
    for path, value in flat.items():
        node = root
        *parts, last = path.split(".")
        for part in parts:
            node = node.setdefault(part, {})
        node[last] = value
    return root


class _ScriptWriter:
    """The document as a scene function: `@scene def design(...)`, its
    parameters the variables, its body plain magpylib and studio's words,
    one line per step of the log, in its order."""

    def __init__(self, doc, broken=()):
        self.doc = doc
        self.variables = doc.get("variables") or {}
        self.limits = doc.get("variable_bounds") or {}
        self.events = doc.get("events") or []
        #: Steps the last build could not apply, by event id: written as a
        #: note, since run they would fail the whole script at their line.
        self.broken = {entry["id"]: entry for entry in broken}
        self.numpy = False
        self.unwritten = []
        self.words = set()
        self.typing = set()
        self.constants = set()
        self.ids = set()
        from magpylib_studio import importer

        self._unique_id = importer._unique_id
        self.alias = {
            word: f"{word}_" if word in self.variables else word for word in _RESERVED
        }
        taken = set(self.variables) | set(self.alias.values())
        self.function = next(
            fn for fn in ("design", "the_scene", "studio_scene") if fn not in taken
        )
        taken.add(self.function)
        self.names = {}
        for event in self.events:
            if event.get("op") == "create" and event["target"] not in self.names:
                self.names[event["target"]] = importer._unique_id(
                    event["target"], taken
                )

    # -- names

    def word(self, word):
        self.words.add(word)
        return self.alias[word]

    def np(self):
        self.numpy = True
        return self.alias["np"]

    def constant(self, name):
        self.constants.add(name)
        return self.alias[name]

    # -- values

    def expression(self, source):
        """Document expression text as the function's code: the variables are
        its parameters, a function is numpy's, a constant the scene's."""
        tree = ast.parse(source, mode="eval")
        variables, writer = self.variables, self

        class Rewrite(ast.NodeTransformer):
            def visit_Call(self, node):
                self.generic_visit(node)
                if (
                    isinstance(node.func, ast.Name)
                    and node.func.id in expressions._FUNCTIONS
                    and node.func.id in _NUMPY_NAMES
                ):
                    node.func = ast.Attribute(
                        value=ast.Name(writer.np(), ast.Load()),
                        attr=_NUMPY_NAMES[node.func.id],
                        ctx=ast.Load(),
                    )
                return node

            def visit_Name(self, node):
                if node.id in expressions._CONSTANTS and node.id not in variables:
                    return ast.Name(writer.constant(node.id), ast.Load())
                return node

        return ast.unparse(Rewrite().visit(tree).body)

    def value(self, value, table=False):
        """A document value as code. `table` lets a run of points be written
        as the call that made it, as `to_script` does -- never a vector:
        `(1, 1, 1)` is one box, not a ramp from 1 to 1."""
        if expressions.is_expression(value):
            return self.expression(expressions.source_of(value))
        if expressions.is_sampled(value):
            return self.sampled(value[expressions.SAMPLED])
        if isinstance(value, dict):
            items = ", ".join(
                f"{key!r}: {self.value(item)}" for key, item in value.items()
            )
            return "{" + items + "}"
        if isinstance(value, list):
            if table and value and isinstance(value[0], list):
                ramp = _linspace_lit(value)
                if ramp:
                    self.np()
                    return ramp
            inner = ", ".join(self.value(item) for item in value)
            return f"({inner},)" if len(value) == 1 else f"({inner})"
        return repr(value)

    def path(self, value, spacing=None):
        """A step's argument, which may be a path made by one call."""
        ramp = None
        if isinstance(value, list) and value:
            ramp = (
                _arange_lit(value) if spacing == "arange" else None
            ) or _linspace_lit(value)
        if ramp:
            self.np()
            return ramp
        return self.value(value)

    def sampled(self, spec):
        of = spec.get("of")
        body = self.value(of)
        parts = [f"lambda {expressions.SAMPLE}: {body}"]
        for key in ("count", "over"):
            if key in spec:
                parts.append(f"{key}={self.value(spec[key])}")
        return f"{self.word('sampled')}({', '.join(parts)})"

    @staticmethod
    def keywords(pairs):
        return ", ".join(f"{key}={code}" for key, code in pairs)

    # -- the script

    def write(self):
        decorator = []
        for key, known in (
            ("model_unit", units.MODEL_UNITS),
            ("field_unit", units.FIELD_UNITS),
        ):
            unit = self.doc.get(key)
            if unit in known:
                decorator.append(f"{key}={unit!r}")
            elif unit is not None:
                self.unwritten.append(f"{key} ({unit!r})")
        parameters, derived = self.write_variables()
        steps, creates = self.write_events()
        body = [*derived, *steps]
        shown = self.write_visibility(creates)
        if shown:
            body += ["", "# hidden in the view, as the scene was saved", *shown]
        roots = [
            self.names[target]
            for target, parent in self.parents_at_end().items()
            if parent is None and target in creates
        ]
        if roots:
            body += ["", f"return {', '.join(roots)}"]
        if not body:
            body = ["pass"]
        mark = self.word("scene")
        head = f"@{mark}({', '.join(decorator)})" if decorator else f"@{mark}"
        if parameters:
            signature = [
                f"def {self.function}(",
                *(f"    {p}," for p in parameters),
                "):",
            ]
        else:
            signature = [f"def {self.function}():"]
        function = [head, *signature, *(f"    {line}" if line else "" for line in body)]
        notes = [f"# not written: {what}" for what in self.unwritten]
        return (
            "\n".join(
                [*notes, *([""] if notes else []), *self.header(), "", "", *function]
            )
            + "\n"
        )

    def header(self):
        lines = []
        if self.typing:
            lines.append(f"from typing import {', '.join(sorted(self.typing))}")
        if self.numpy:
            lines.append(self._import("numpy", "np"))
        lines.append(self._import("magpylib", "magpy"))
        words = ", ".join(
            word if self.alias[word] == word else f"{word} as {self.alias[word]}"
            for word in sorted(self.words)
        )
        lines.append(f"from magpylib_studio import {words}")
        if self.constants:
            constants = ", ".join(
                name if self.alias[name] == name else f"{name} as {self.alias[name]}"
                for name in sorted(self.constants)
            )
            lines.append(f"from magpylib_studio.recording import {constants}")
        return lines

    def _import(self, module, word):
        return f"import {module} as {self.alias[word]}"

    def write_variables(self):
        """The parameters, and the `derived` lines for variables defined by
        a formula, each after the variables it names."""
        parameters, derived, done, order = [], [], set(), []

        def visit(name, seen=()):
            if name in done or name not in self.variables or name in seen:
                return
            for needed in expressions.referenced_names([self.variables[name]]):
                visit(needed, (*seen, name))
            done.add(name)
            order.append(name)

        for name in self.variables:
            visit(name)
        for name in order:
            limits = self.limits.get(name) or {}
            for key, item in limits.items():
                if key not in _LIMITS:
                    self.unwritten.append(f"{key} on {name}'s limits ({item!r})")
            unit = limits.get("unit")
            if unit is not None and unit not in units.KINDS:
                self.unwritten.append(f"unit on {name} ({unit!r})")
                unit = None
            value = self.variables[name]
            if expressions.is_expression(value):
                parts = [repr(name), self.expression(expressions.source_of(value))]
                if unit:
                    parts.append(f"unit={unit!r}")
                derived.append(f"{name} = {self.word('derived')}({', '.join(parts)})")
            else:
                annotation = self.annotation(limits, unit)
                parameters.append(f"{name}: {annotation} = {self.value(value)}")
        return parameters, derived

    def annotation(self, limits, unit):
        if "options" in limits:
            self.typing.add("Literal")
            return f"Literal[{', '.join(repr(o) for o in limits['options'])}]"
        integer = bool(limits.get("integer"))
        base = "int" if integer else "float"
        bounded = "min" in limits or "max" in limits
        slider = "soft_min" in limits or "soft_max" in limits
        if not (bounded or slider or unit):
            return base
        args = []
        if bounded:
            args.append(self.value(limits.get("min")))
            if "max" in limits:
                args.append(self.value(limits["max"]))
        if slider:
            args.append(
                f"slider={self.value([limits.get('soft_min'), limits.get('soft_max')])}"
            )
        if integer and unit is None:
            call = self.word("Count")
        elif unit == "length" and not integer:
            call = self.word("Length")
        elif unit == "angle" and not integer:
            call = self.word("Angle")
        else:
            call = self.word("Bounds")
            if unit is not None:
                args.append(f"unit={unit!r}")
            if integer:
                args.append("integer=True")
        self.typing.add("Annotated")
        return f"Annotated[{base}, {call}({', '.join(args)})]"

    def write_events(self):
        lines, creates = [], {}
        events = self.events
        index = 0
        while index < len(events):
            event = events[index]
            op, name = event.get("op"), self.names.get(event.get("target"))
            if event.get("id") in self.broken:
                broken = self.broken[event["id"]]
                self.unwritten.append(
                    f"{broken['source']}, which no longer applies ({broken['error']})"
                )
            elif op == "create":
                lines += self.write_create(event, name)
                creates[event["target"]] = event
            elif op in ("position", "orientation"):
                # A pose stated outright is one step of the studio's, and one
                # call: `place`, with both halves where the panel pinned both.
                pose = {op: event}
                following = events[index + 1] if index + 1 < len(events) else {}
                if (
                    op == "position"
                    and following.get("op") == "orientation"
                    and following.get("target") == event.get("target")
                ):
                    pose["orientation"] = following
                    index += 1
                parts = []
                if "position" in pose:
                    parts.append(("position", self.path(pose["position"]["value"])))
                if "orientation" in pose:
                    parts.append(
                        ("orientation", self.value(pose["orientation"]["rotvec"]))
                    )
                lines.append(f"{self.word('place')}({name}, {self.keywords(parts)})")
            else:
                lines.append(self.write_step(event, name))
            index += 1
        return lines, creates

    def parents_at_end(self):
        """What is in what when the log has run: present objects, each with
        its parent or None."""
        parent = {}
        for event in self.events:
            if event.get("id") in self.broken:
                continue
            op, target = event.get("op"), event.get("target")
            if op in ("create", "reparent"):
                parent[target] = event.get("parent")
            elif op == "remove":  # and everything in it
                gone = {target}
                while True:
                    inside = {k for k, v in parent.items() if v in gone} - gone
                    if not inside:
                        break
                    gone |= inside
                for name in gone:
                    parent.pop(name, None)
        return parent

    def write_visibility(self, creates):
        """What is hidden, as calls at the end. Hiding a collection hides every
        leaf in it at the time, and a leaf can be shown again on its own or
        join the collection later, so the collections that were hidden are
        hidden first and each leaf is then put the way the scene has it:
        shown where it is shown, hidden (and marked hidden) where it is."""
        parent = self.parents_at_end()

        def ancestors(target):
            seen, up = set(), parent.get(target)
            while up is not None and up not in seen:
                seen.add(up)
                yield up
                up = parent.get(up)

        there = {target: event for target, event in creates.items() if target in parent}
        groups = [
            target
            for target, event in there.items()
            if event.get("type") == "Collection" and event.get("visible") is False
        ]
        lines = [f"{self.word('hide')}({self.names[target]})" for target in groups]
        for target, event in there.items():
            if event.get("type") == "Collection":
                continue
            hidden = "hidden_style" in event
            by_group = any(up in groups for up in ancestors(target))
            if hidden and (event.get("visible") is False or not by_group):
                lines.append(f"{self.word('hide')}({self.names[target]})")
            elif not hidden and by_group:
                lines.append(f"{self.word('show')}({self.names[target]})")
        return lines

    def write_create(self, event, name):
        kind = event["type"]
        style = dict(event.get("style") or {})
        # Hidden, its style holds the switches that hide it, and what they
        # replaced is set aside: written as it was, and hidden at the end.
        aside = event.get("hidden_style")
        if aside is not None:
            for path in _HIDE_STYLE:
                if path in aside:
                    style[path] = aside[path]
                else:
                    style.pop(path, None)
        for key in event:
            if key not in (
                "id",
                "op",
                "target",
                "type",
                "params",
                "style",
                "parent",
                "visible",
                "hidden_style",
            ):
                self.unwritten.append(f"{key} on {event['target']} ({event[key]!r})")
        params = dict(event.get("params") or {})
        parts = []
        if kind == "magnet.TriangularMesh" and "mesh_source" in params:
            call = self.word("TriangularMesh")
            parts.append(("mesh_source", self.value(params.pop("mesh_source"))))
        else:
            call = f"{self.alias['magpy']}.{kind}"
        parts += [(key, self.value(value, table=True)) for key, value in params.items()]
        if style:
            parts.append(("style", repr(_nested(style))))
        lines = [f"{name} = {call}({self.keywords(parts)})"]
        # The id the recorder would give it, from its label or its class; where
        # the document's differs, the script says so.
        base = style.get("label") or kind.rsplit(".", 1)[-1].lower()
        expected = self._unique_id(base, self.ids)
        if expected != event["target"]:
            self.ids.discard(expected)
            self.ids.add(event["target"])
            lines.append(f"{self.word('name')}({name}, {event['target']!r})")
        parent = event.get("parent")
        if parent:
            lines.append(f"{self.names[parent]}.add({name})")
        return lines

    def write_step(self, event, name):
        op, target = event.get("op"), event.get("target")
        given = {
            key: item
            for key, item in event.items()
            if key not in ("id", "op", "target")
        }
        allowed = _STEP_KEYS.get(op)
        if allowed is None:
            self.unwritten.append(f"a {op} step on {target}")
            return f"# {op} on {name}: no call says this yet"
        for key in [key for key in given if key not in allowed]:
            self.unwritten.append(
                f"{key} on a {op} step on {target} ({given.pop(key)!r})"
            )
        # magpylib's calls have no `spacing`: the ramp is written as the call
        # it came from, and the hint itself is let go of, with a word.
        spacing = given.pop("spacing", None)
        if spacing:
            self.unwritten.append(f"spacing on a {op} step on {target} ({spacing!r})")
        if op == "move":
            call = f"{name}.move"
            parts = [self.path(given.pop("displacement"), spacing)]
        elif op == "rotate_from_angax":
            call = f"{name}.rotate_from_angax"
            parts = [
                self.path(given.pop("angle"), spacing),
                self.value(given.pop("axis", "z")),
            ]
        elif op == "rotate_from_rotvec":
            call = f"{name}.rotate_from_rotvec"
            parts = [self.path(given.pop("rotvec"))]
        elif op == "duplicate_around":
            call = self.word("duplicate_around")
            parts = [name, self.value(given.pop("count"))]
        elif op == "duplicate_along":
            call = self.word("duplicate_along")
            parts = [
                name,
                self.value(given.pop("count")),
                self.value(given.pop("step")),
            ]
        elif op == "mirror":
            call = self.word("mirror")
            parts = [name]
        elif op == "reparent":
            parent = given.pop("parent", None)
            return f"{name}.parent = {self.names[parent] if parent else None}"
        else:  # remove
            return f"{self.word('remove')}({name})"
        rest = [
            (key, repr(item) if key in ("start", "plane") else self.value(item))
            for key, item in given.items()
        ]
        return f"{call}({', '.join([*parts, *(f'{k}={c}' for k, c in rest)])})"
