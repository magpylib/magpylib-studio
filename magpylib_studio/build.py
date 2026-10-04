"""Write a studio scene in Python: magpylib's spelling, with variables that
stay variables.

    from magpylib_studio.build import Scene

    s = Scene()
    radius = s.variable("radius", 0.023, bounds=(0.005, 0.08))
    n = s.variable("n", 10, integer=True)
    magnet = s.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.01), polarization=(1, 0, 0), position=(radius, 0, 0)
    )
    magnet.duplicate_around(count=n, axis="z", spin=360 / n)

`radius` is not a number. Arithmetic on it writes an expression, and the
document keeps `"=radius"` where a script run would have kept 0.023 -- so the
scene stays parametric: change `radius` in the panel and the ring follows, and
an export to Maxwell has a design variable to write. Anything that needs the
value now (an `if`, `range(n)`, `float(radius)`, `math.sin`) raises at that
line and says what to write instead. Evaluating quietly would hand back a scene
that looks right and has lost its variables, which is the cliff this replaces.

Every call goes through the session operation the panel uses, so there is one
implementation of what an edit means. A call the session refuses raises
`BuildError` with the session's own message. See `docs/builder.md`.
"""

from __future__ import annotations

import json
import pathlib
import warnings

import magpylib as magpy
import numpy as np

from magpylib_studio import expressions
from magpylib_studio.session import MagpylibStudioSession


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
            f"pattern stays parametric: duplicate_around(count={self._source}) "
            f"or duplicate_along(count={self._source})"
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


class Sampled:
    """A run of points stated as a formula of a sample: the document's
    sampled node, as `Scene.sampled` makes it."""

    __slots__ = ("_spec",)

    def __init__(self, spec):
        self._spec = spec

    def __repr__(self):
        return f"<sampled {self._spec['of']} over {self._spec['over']}>"


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
    """A magpylib object as the scene records it.

    Constructing one records nothing. Its create step is written when it
    first enters the scene -- added to a collection, touched by any other
    call, or when the scene is read -- because magpylib groups after it
    builds (`ring.add(magnet)`), and the session's reparent keeps a moved
    object's world pose as numbers: a position written in variables would
    stop following them. Created inside its collection, it never moves."""

    def __init__(self, scene, type_, object_id, params, style):
        self._scene = scene
        self._type = type_
        self.id = object_id
        self._params = params
        self._style = style
        self._entered = False
        #: The collection it was given to at construction, which creates it.
        self._owner = None

    def __repr__(self):
        return f"<{self._type} {self.id!r}>"

    def _enter(self, parent=None):
        if self._entered:
            return
        if parent is None and self._owner is not None:
            self._owner._enter()  # which creates it, inside
            if self._entered:
                return
        self._scene._create(self, parent)

    def move(self, displacement, start="auto"):
        """As magpylib's `move`, recorded as a step."""
        self._enter()
        self._scene._call("move", self.id, _arg(displacement), start=start)
        return self

    def rotate_from_angax(self, angle, axis, anchor=None, start="auto", degrees=True):
        """As magpylib's `rotate_from_angax`, recorded as a step."""
        if not degrees:
            angle = Scene.degrees(angle)
        self._enter()
        self._scene._call(
            "rotate",
            self.id,
            _arg(angle),
            axis=_arg(axis),
            anchor=_arg(anchor),
            start=start,
        )
        return self

    def duplicate_around(self, count, axis="z", anchor=0, spin=0):
        """`count` of it about `axis` through `anchor`, each copy turned by
        `spin` degrees more than the last: one step, which stays a pattern."""
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
    """magpylib's `Collection`: `Collection(*children)`, and `add`."""

    def __init__(self, scene, object_id, style, children):
        super().__init__(scene, "Collection", object_id, {}, style)
        self._children = []
        for child in children:
            self._claim(child)

    def _claim(self, child):
        if not isinstance(child, Object):
            raise TypeError(f"a collection holds objects, not {child!r}")
        if not child._entered:
            child._owner = self
        self._children.append(child)

    def add(self, *children):
        """As magpylib's `add`. A child that is already in the scene is
        reparented, which keeps its world pose as numbers; the builder warns,
        since a position written in variables then stops following them."""
        for child in children:
            if not isinstance(child, Object):
                raise TypeError(f"a collection holds objects, not {child!r}")
            child._owner = None
        self._enter()
        for child in children:
            if child._entered:
                warnings.warn(
                    f"{child.id!r} is already in the scene, so adding it to "
                    f"{self.id!r} moves it and keeps its pose as numbers: a "
                    f"position written in variables stops following them. Add "
                    f"it before anything else touches it.",
                    stacklevel=2,
                )
                self._scene._call("move_object", child.id, parent=self.id)
            else:
                child._enter(parent=self)
        return self


class _Namespace:
    """`s.magnet`, `s.current`, `s.misc`: magpylib's classes, as the scene's."""

    def __init__(self, scene, name):
        self._scene = scene
        self._name = name

    def __getattr__(self, name):
        if name.startswith("_") or not isinstance(
            getattr(getattr(magpy, self._name), name, None), type
        ):
            raise AttributeError(f"magpylib has no {self._name}.{name}")
        type_ = f"{self._name}.{name}"

        def construct(id=None, style=None, **kwargs):  # noqa: A002 - the document's word
            return self._scene._object(type_, id, style, kwargs)

        construct.__name__ = name
        return construct


# --- the scene ----------------------------------------------------------------


class Scene:
    """A studio document, written in code.

    `Scene()` builds one of its own; `Scene(session)` writes into a session
    that already holds a scene, as another way to edit it. Read it with
    `to_dict`, `to_script` or `save`, or show it: `SceneWidget(s, editable=True)`.

    `values` is where the variables' values come from when there are some: a
    saved scene, or a mapping of names to values. The script says what the
    scene is; a slider dragged in the panel and saved says what a variable is
    set to, and the next run keeps it -- see `variable`. A path to a file not
    there yet is no values, so a script can read the file it is about to save.
    """

    def __init__(self, session=None, *, values=None):
        self._session = session if session is not None else MagpylibStudioSession()
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
        self.magnet = _Namespace(self, "magnet")
        self.current = _Namespace(self, "current")
        self.misc = _Namespace(self, "misc")

    # The constants an expression has; its functions are set below the class,
    # one per name in the allow-list, so the two cannot drift.
    pi = Expression("pi")
    tau = Expression("tau")

    def variable(
        self,
        name,
        value,
        *,
        bounds=None,
        slider=None,
        integer=None,
        options=None,
    ):
        """Define a variable and return it, to write the scene in.

        `value` is a number, a name (for a variable like an axis, with its
        `options`), or an expression over earlier variables. `bounds` are
        the hard limits, `slider` the range worth dragging through.

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
        if bounds is not None:
            limits["min"], limits["max"] = _value(bounds)
        if slider is not None:
            limits["soft_min"], limits["soft_max"] = _value(slider)
        if integer is not None:
            limits["integer"] = integer
        if options is not None:
            limits["options"] = list(options)
        if limits:
            self._call("set_variable_bounds", name, **limits)
        return Variable(name)

    def sampled(self, of, *, count, over=(0, 1)):
        """A run of points as a formula: `of(t)`, for `t` running across
        `over` in `count` steps. Where a value is a run of points -- a
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
        return Sampled(
            {
                "count": _arg(count),
                "over": _arg(list(over)),
                "of": _arg(list(made) if isinstance(made, tuple) else made),
            }
        )

    def Collection(self, *children, id=None, style=None, **kwargs):  # noqa: A002
        """magpylib's `Collection`, as the scene's."""
        if kwargs.keys() - {k for k in kwargs if k.startswith("style_")}:
            raise TypeError("a collection takes children and style, nothing else")
        object_id, style = self._named(id, "Collection", style, kwargs)
        obj = Collection(self, object_id, style, children)
        self._objects.append(obj)
        return obj

    def Sensor(self, id=None, style=None, **kwargs):  # noqa: A002
        """magpylib's `Sensor`, as the scene's."""
        return self._object("Sensor", id, style, kwargs)

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

    # -- what the objects call

    def _object(self, type_, object_id, style, kwargs):
        object_id, style = self._named(object_id, type_, style, kwargs)
        params = {key: _value(value) for key, value in kwargs.items()}
        obj = Object(self, type_, object_id, expressions.normalized(params), style)
        self._objects.append(obj)
        return obj

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
        if isinstance(obj, Collection):
            waiting = [child for child in obj._children if child._owner is obj]
            obj._children = []
            if waiting:
                obj.add(*waiting)

    def _call(self, method, *args, **kwargs):
        result = getattr(self._session, method)(*args, **kwargs)
        if isinstance(result, dict) and result.get("ok") is False:
            raise BuildError(result.get("error"))
        return result


# `s.sin(x)`, `s.max(a, b)`, ...: what an expression may call, taking variables.
for _name in expressions._FUNCTIONS:
    setattr(Scene, _name, _function(_name))
del _name
