"""magpylib's recording hook, used where magpylib has it and put on magpylib
from outside where it does not (`docs/plans/recording.md` §5).

Inside a ``record`` block, every top-level construction, property assignment
and transformation of a magpylib object is reported to a callback with the
arguments as written, before magpylib turns them into numbers. Calls magpylib
makes on itself while doing that work (a constructor setting its properties, a
collection moving its children) are not reported.

An argument may be a value only the recorder can turn into a number -- a
variable of a parametric document. The recorder's ``resolve`` turns each such
value into a number before magpylib sees it, so magpylib computes with plain
numbers while the record keeps what was written.

This module is a copy of magpylib's ``_src/recording.py`` (the hook proposed
upstream) with one addition, ``install()``: on a magpylib without the hook it
wraps every object class once, from outside, which is the same thing
``BaseGeo.__init_subclass__`` does there. When magpylib ships the hook, the
native one is used and the copy is dead code.
"""

from __future__ import annotations

import contextlib
import functools
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

try:  # the hook, where magpylib has it
    from magpylib._src import recording as _native
except ImportError:
    _native = None

# Public methods that change an object, by name; wrapped where a class defines them.
RECORDED_METHODS = (
    "move",
    "rotate",
    "rotate_from_angax",
    "rotate_from_rotvec",
    "rotate_from_euler",
    "rotate_from_matrix",
    "rotate_from_mrp",
    "rotate_from_quat",
    "copy",
    "add",
    "remove",
    "reset_path",
)

if _native is not None:
    Event = _native.Event
    record = _native.record
    magpylib_class = _native.magpylib_class
    wrap_class = _native.wrap_class
    _RECORDER = _native._RECORDER
    _INSIDE = _native._INSIDE
else:
    _RECORDER = ContextVar("magpylib_recorder", default=None)
    _INSIDE = ContextVar("magpylib_recorder_inside", default=False)

    @dataclass(frozen=True)
    class Event:
        """One recorded call.

        ``kind`` is "new", "set" or "call": a construction, a property
        assignment, or a method call. ``obj`` is the object constructed,
        assigned to, or called on; ``name`` the class name for "new", else
        the property or method name; ``args`` and ``kwargs`` the arguments as
        written, before ``resolve``; ``result`` what the call returned (the
        new object for ``copy``).
        """

        kind: str
        obj: Any
        name: str
        args: tuple
        kwargs: dict
        result: Any = None

    class record:
        """Report magpylib calls made inside the block to ``on_event``.

        ``on_event`` is called with each ``Event``, after the call has run.
        ``resolve``, if given, is called with every argument leaf (inside
        tuples, lists and dicts) before magpylib sees it, and returns what
        magpylib should get instead.
        """

        def __init__(self, on_event, resolve=None, on_read=None):
            self.on_event = on_event
            self.resolve = resolve
            #: Called with (obj, name, value) when a property is read at top
            #: level: a value a script takes as a number. Not in magpylib's
            #: own hook; a recorder that wants it checks `supports_reads`.
            self.on_read = on_read
            self._token = None

        def __enter__(self):
            self._token = _RECORDER.set(self)
            return self

        def __exit__(self, *exc):
            _RECORDER.reset(self._token)

        def _resolved(self, value):
            if self.resolve is None:
                return value
            if isinstance(value, tuple | list):
                return type(value)(self._resolved(v) for v in value)
            if isinstance(value, dict):
                return {k: self._resolved(v) for k, v in value.items()}
            return self.resolve(value)

    def _recorded(fn, kind, name=None):
        """Wrap ``fn(self, *args, **kwargs)`` so a top-level call is recorded."""

        @functools.wraps(fn)
        def wrapper(self, *args, **kwargs):
            recorder = _RECORDER.get()
            if recorder is None or _INSIDE.get():
                return fn(self, *args, **kwargs)
            token = _INSIDE.set(True)
            try:
                result = fn(
                    self, *recorder._resolved(args), **recorder._resolved(kwargs)
                )
            finally:
                _INSIDE.reset(token)
            if kind == "new":
                label = magpylib_class(type(self)).__name__
            else:
                label = name or fn.__name__
            recorder.on_event(Event(kind, self, label, args, kwargs, result))
            return result

        wrapper._magpylib_recorded = True
        return wrapper

    def _recorded_read(fn, name):
        """Wrap a property's getter so a top-level read is reported."""

        @functools.wraps(fn)
        def wrapper(self):
            recorder = _RECORDER.get()
            if recorder is None or _INSIDE.get() or recorder.on_read is None:
                return fn(self)
            token = _INSIDE.set(True)
            try:
                result = fn(self)
            finally:
                _INSIDE.reset(token)
            recorder.on_read(self, name, result)
            return result

        return wrapper

    def magpylib_class(cls):
        """The nearest class in ``cls``'s hierarchy that magpylib defines."""
        return next(c for c in cls.__mro__ if c.__module__.startswith("magpylib."))

    def wrap_class(cls):
        """Wrap, in place and once, what ``cls`` itself defines: ``__init__``,
        property setters, and the methods in ``RECORDED_METHODS``.

        Only magpylib's own classes: a subclass written elsewhere is
        transparent, so the magpylib calls its methods make are what gets
        recorded, and its objects are reported as the magpylib class they
        extend.
        """
        if cls.__dict__.get("_magpylib_recording_wrapped"):
            return
        if not cls.__module__.startswith("magpylib."):
            return
        for attr, value in list(cls.__dict__.items()):
            if attr == "__init__" and callable(value):
                setattr(cls, attr, _recorded(value, "new"))
            elif (
                isinstance(value, property) and value.fset and not attr.startswith("_")
            ):
                fset = _recorded(value.fset, "set", attr)
                fget = _recorded_read(value.fget, attr) if value.fget else None
                setattr(cls, attr, property(fget, fset, value.fdel, value.__doc__))
            elif attr in RECORDED_METHODS and callable(value):
                setattr(cls, attr, _recorded(value, "call"))
        cls._magpylib_recording_wrapped = True


#: Whether this hook reports property reads (the copy does; magpylib's own
#: hook, when it ships, may not).
supports_reads = _native is None

_installed = False


def install():
    """Put the hook on every magpylib object class, once. A magpylib that has
    the hook needs nothing; one that does not gets each class under
    ``BaseGeo`` wrapped from outside, which is what its ``__init_subclass__``
    would have done."""
    global _installed
    if _installed or _native is not None:
        _installed = True
        return
    from magpylib._src.obj_classes.class_BaseGeo import BaseGeo

    seen = set()

    def walk(cls):
        for base in cls.__mro__:
            if base not in seen and base is not object:
                seen.add(base)
                wrap_class(base)
        for sub in cls.__subclasses__():
            walk(sub)

    walk(BaseGeo)
    _installed = True


def active():
    """The recorder listening right now, or None."""
    return _RECORDER.get()


@contextlib.contextmanager
def nested():
    """Calls made inside are magpylib's own as far as the recorder is
    concerned: not reported. For the copies a pattern makes."""
    token = _INSIDE.set(True)
    try:
        yield
    finally:
        _INSIDE.reset(token)
