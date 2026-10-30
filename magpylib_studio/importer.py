"""Import existing magpylib scripts by running them, not parsing them.

The script is executed in this process (same trust as the user running it),
`show()` patched to a no-op; the magpylib objects left in the namespace are
then introspected into a studio document: variable names become ids (nested
children included, whenever the script binds them to a name of their own),
Collections keep their nesting, orientation becomes a `rotations` entry.
The known cost: parametric structure flattens (a loop building 10 magnets
imports as 10 concrete objects).
"""

from __future__ import annotations

import contextlib
import dis
import io
import json
import keyword
import re
import sys
from collections import Counter

import magpylib as magpy
import numpy as np

from magpylib_studio import units
from magpylib_studio.session import (
    _HIDE_STYLE,
    _is_data,
    _style_values,
    external_params,
    type_name,
)
from magpylib_studio.threejs import has_style, is_sealed, sealed_own

# Constructor kwargs worth introspecting, tried in order per object.
# magnetization is intentionally absent: it is derived from polarization.
_PARAM_ATTRS = (
    "polarization",
    "dimension",
    "diameter",
    "vertices",
    "faces",
    "current",
    # TriangleSheet's current, and not optional: leaving it out built the
    # object as TriangleSheet(vertices=..., faces=...), which magpylib rejects
    # outright — so importing one lost it to `broken` while the import still
    # reported ok. `meshing` and `magnetization` stay out on purpose: the
    # first is a getFT parameter rather than state, the second is derived.
    "current_densities",
    "moment",
    "pixel",
)


def _dotted_type(obj):
    """Live object -> 'magnet.Cuboid' / 'Sensor' / ... or None if unsupported."""
    if isinstance(obj, magpy.Sensor):
        return "Sensor"
    return None if isinstance(obj, magpy.Collection) else type_name(type(obj))


def _is_scene_object(obj):
    return isinstance(obj, magpy.Collection) or _dotted_type(obj) is not None


def _class_of(obj):
    """An object's class as a person finds it: its name, and the package it
    comes from where that is not magpylib -- `MySource from my_package`."""
    cls = type(obj)
    package = cls.__module__.partition(".")[0]
    return cls.__name__ if package == "magpylib" else f"{cls.__name__} from {package}"


def _zeroed(array):
    """+0.0 turns IEEE negative zero back into plain zero. Without it a scene
    re-rendered as a script flip-flops between `0.0` and `-0.0` on every
    round trip — the tiny residue of a rotation, rounded, keeps its sign."""
    return array + 0.0 if array.dtype.kind == "f" else array


def _tolist(value):
    return _zeroed(value).tolist() if isinstance(value, np.ndarray) else value


class _Ids(set):
    """Ids in use, and per base the number `_unique_id` gave last: every
    number below it is taken, and the set only grows, so the next one is
    looked for from there -- a thousand cells all called ``obj`` would
    otherwise each count up from ``obj`` again."""

    def __init__(self, *args):
        super().__init__(*args)
        self.last = {}


def _unique_id(base, used):
    base = re.sub(r"\W|^(?=\d)", "_", str(base)) or "obj"
    if keyword.iskeyword(base):
        base += "_"
    n = used.last.get(base, 1) if isinstance(used, _Ids) else 1
    candidate = base if n == 1 else f"{base}_{n}"
    while candidate in used:
        n += 1
        candidate = f"{base}_{n}"
    used.add(candidate)
    if isinstance(used, _Ids):
        used.last[base] = n
    return candidate


def sealed_parts(collection, object_id, left_out, to_frame=None):
    """A sealed collection's children as its parts, and the style they share.

    Parts are specs with no id, which no edit, pick or legend row can name;
    a nested collection is a part made of parts. What every part that has a
    style property sets alike is said once, as the collection's
    ``parts_style``, and each part keeps only what is its own: a body meshed
    into cells made alike carries one style, a collection of differing
    objects keeps their differences. Its own label, description, legend and
    traces are the collection's, and are not shared (`sealed_own`).

    `to_frame` takes a part's pose where it stands to the one it is kept
    as: the collection's frame where it was made, for a collection with
    steps of its own (`recording._frame`). Without it, where it stands."""
    leaves = []
    parts = _parts_of(collection, object_id, left_out, leaves, to_frame)
    shared = {}
    candidates = {path for part, _ in leaves for path in part.get("style", {})}
    for path in sorted(candidates):
        if sealed_own(path):
            continue
        holders = [part for part, child in leaves if has_style(child, path)]
        values = [part.get("style", {}).get(path, _UNSET) for part in holders]
        if any(value is _UNSET or value != values[0] for value in values):
            continue  # mixed: each part keeps its own
        shared[path] = values[0]
        for part in holders:
            del part["style"][path]
            if not part["style"]:
                del part["style"]
    return parts, shared


_UNSET = object()


def _parts_of(collection, object_id, left_out, leaves, to_frame=None):
    """`sealed_parts`'s parts, with each that is no collection put in
    `leaves` beside the object it was read from."""
    parts = []
    for child in collection.children:
        if isinstance(child, magpy.Collection):
            part = {
                "type": "Collection",
                "parts": _parts_of(child, object_id, left_out, leaves, to_frame),
            }
        elif _dotted_type(child) is None:
            # a class a document cannot name: said, as a style it cannot hold
            left_out.append(f"{object_id}'s part {_class_of(child)} (left out)")
            continue
        else:
            part = _part_spec(child, to_frame)
            leaves.append((part, child))
        style = _style_values(child)
        for path in [path for path, value in style.items() if not _is_data(value)]:
            del style[path]
            left_out.append(f"{object_id}'s parts' {path}")
        if style:
            part["style"] = style
        parts.append(part)
    return parts


def _params_of(obj):
    """What an object is made of, as its constructor takes it, apart from
    where it stands: magpylib's by `_PARAM_ATTRS`, one of a class from
    beside magpylib by its own arguments (`session.external_params`)."""
    given = external_params(obj) or {
        attr: getattr(obj, attr, None) for attr in _PARAM_ATTRS
    }
    return {attr: _tolist(value) for attr, value in given.items() if value is not None}


def _part_spec(obj, to_frame=None):
    """A part that holds none: its type and parameters, its pose among them.
    A part has no steps of its own to be moved and turned by, as an object
    has, so where it stands is as plain as what it is: `position`, a path's
    every step where it has one, and `orientation` as a rotation vector in
    degrees."""
    params = _params_of(obj)
    position, orientation = np.asarray(obj.position, dtype=float), obj.orientation
    if to_frame is not None:
        position, orientation = to_frame(position, orientation)
    position = np.where(np.abs(position) < 1e-15, 0.0, position)  # a round trip's dust
    if np.any(position):
        params["position"] = _tolist(position)
    rotvec = orientation.as_rotvec(degrees=True)
    if np.any(np.abs(rotvec) > 1e-9):
        params["orientation"] = _zeroed(rotvec.round(9)).tolist()
    return {"type": _dotted_type(obj), "params": params}


def _spec_from(obj, object_id, used_ids, unnamed, names, left_out):
    # An object the script never bound to a variable was built inline — in a
    # loop, a comprehension, a helper. Executing the script keeps what it
    # built and loses how, so this is the one trace of the structure that went
    # missing, and the caller is told rather than left to notice: a leaf with
    # what it is made of, so that `_flattening_warnings` can tell copies apart.
    # A sealed collection's parts are none of that: they are what it is made
    # of, and come across as its data.
    if is_sealed(obj):
        parts, shared = sealed_parts(obj, object_id, left_out)
        hidden = _hidden_parts(parts, shared)
        spec = {
            "id": object_id,
            "type": "Collection",
            "sealed": True,
            "parts": parts,
            **({"parts_style": shared} if shared else {}),
        }
    elif isinstance(obj, magpy.Collection):
        spec = {
            "id": object_id,
            "type": "Collection",
            "children": [
                _spec_from(
                    child,
                    _unique_id(
                        names.get(id(child)) or child.style.label or "obj", used_ids
                    ),
                    used_ids,
                    unnamed,
                    names,
                    left_out,
                )
                for child in obj.children
                if _is_scene_object(child) or _left_out(child, left_out)
            ],
        }
        if id(obj) not in names:
            unnamed.append(("Collection", _made_of(spec)))
    else:
        params = _params_of(obj)
        position = np.array(obj.position)
        moved = None
        if position.ndim > 1:
            # A path, not a place. Baking it into `position` was how a
            # four-line script came back as one line of three hundred
            # numbers: every step of the animation became a constructor
            # argument, and the move that made it disappeared. The document
            # holds transforms as the magpylib calls that were made — it says
            # so at the top of session.py — so a path is a move, recorded
            # from the origin the object starts at.
            moved = (position - position[0]).tolist()
            position = position[0]
        if np.any(position):
            params["position"] = position.tolist()
        spec = {"id": object_id, "type": _dotted_type(obj), "params": params}
        if id(obj) not in names:
            unnamed.append((spec["type"], _made_of(spec)))
        if moved is not None:
            spec["transforms"] = [{"op": "move", "displacement": moved, "start": 0}]
        rotvec = np.atleast_2d(obj.orientation.as_rotvec(degrees=True))
        if len(rotvec) > 1:
            # orientation path: reproduced exactly, elementwise over the path
            if np.linalg.norm(rotvec) > 1e-9:
                spec["rotations"] = [
                    {"rotvec": _zeroed(rotvec.round(6)).tolist(), "start": 0}
                ]
        else:
            angle = float(np.linalg.norm(rotvec[0]))
            if angle > 1e-9:
                spec["rotations"] = [
                    {
                        "angle": round(angle, 6),
                        "axis": _zeroed((rotvec[0] / angle).round(9)).tolist(),
                    }
                ]
    style = _style_values(obj)
    for path in [path for path, value in style.items() if not _is_data(value)]:
        del style[path]
        left_out.append(f"{object_id}'s {path}")
    if is_sealed(obj) and hidden:
        style.update(_HIDE_STYLE)  # the parts' hiding is the body's
    if style:
        spec["style"] = style
    return spec


def _left_out(obj, left_out):
    """An object of a class a document cannot name, said rather than built
    as a step that fails with "unknown object type None". False, for the
    filter it is called from."""
    label = obj.style.label
    named = f"{label} ({_class_of(obj)})" if label else _class_of(obj)
    left_out.append(f"{named} (not held)")
    return False


def _hidden_parts(parts, shared):
    """Whether every part of a sealed collection is hidden, by the switches
    `set_visible` hides a leaf with, on each or in the style they share
    (`shared`): the body is, as a script writes it (`session.to_script`).
    If so, they come off the parts and the shared style, the body's own
    style to carry."""
    leaves = []

    def walk(parts):
        for part in parts:
            if part["type"] == "Collection":
                walk(part.get("parts") or [])
            else:
                leaves.append(part)

    walk(parts)
    if not leaves or not all(
        shared.get(path) == value
        or all((part.get("style") or {}).get(path) == value for part in leaves)
        for path, value in _HIDE_STYLE.items()
    ):
        return False
    for path in _HIDE_STYLE:
        shared.pop(path, None)
        for part in leaves:
            (part.get("style") or {}).pop(path, None)
    for part in leaves:
        if "style" in part and not part["style"]:
            del part["style"]
    return True


def _document_from_named(named, names, script=True):
    """[(name, obj), ...] -> (document, warnings). `names` maps id(obj) -> the
    script's variable name, so nested children keep their script identity too
    (a Collection's children are not in `named`, only reachable through it)."""
    # Objects reachable inside a listed Collection are emitted there, not twice.
    contained = set()
    for _, obj in named:
        if isinstance(obj, magpy.Collection):
            for child in obj.children_all:
                contained.add(id(child))
    top = [(name, obj) for name, obj in named if id(obj) not in contained]
    # Same object under several names: keep the first name only.
    seen, unique_top = set(), []
    for name, obj in top:
        if id(obj) not in seen:
            seen.add(id(obj))
            unique_top.append((name, obj))
    used_ids, unnamed, left_out = _Ids(), [], []
    unique_top = [
        (name, obj)
        for name, obj in unique_top
        if _is_scene_object(obj) or _left_out(obj, left_out)
    ]
    if not unique_top:
        raise ValueError(
            "script produced no magpylib objects"
            + "".join(f"; {w}" for w in _style_warnings(left_out))
        )
    objects = [
        _spec_from(obj, _unique_id(name, used_ids), used_ids, unnamed, names, left_out)
        for name, obj in unique_top
    ]
    return {"objects": objects}, (
        _flattening_warnings(unnamed, script)
        + _inert_warnings(objects)
        + _style_warnings(left_out)
    )


def _inert_warnings(objects):
    """What a CustomSource loses on the way in, said at the moment it happens.

    Its physics is a Python function, and a document holds JSON — so the
    object arrives with its geometry, its position and its style, and without
    the only thing that made it a source. It used to arrive silently, draw in
    the 3D view like anything else, and then end every field calculation in
    the scene; the engine now leaves it out of those instead, which is only
    honest if the import said so first.
    """

    def walk(specs):
        for spec in specs:
            if spec.get("type") == "misc.CustomSource":
                yield spec["id"]
            if any(_custom_parts(spec.get("parts") or ())):
                yield f"{spec['id']}'s parts"
            yield from walk(spec.get("children", ()))

    def _custom_parts(parts):
        for part in parts:
            yield part["type"] == "misc.CustomSource"
            yield from _custom_parts(part.get("parts") or ())

    names = list(walk(objects))
    if not names:
        return []
    return [
        f"{', '.join(names)}: a CustomSource's field function cannot be written "
        "to a document, so it did not come across. The object is here, but it "
        "contributes nothing and is left out of field calculations."
    ]


def _style_warnings(left_out):
    """The style a document cannot hold, said rather than failing the import.

    A `model3d` trace is data, and comes across to be drawn; one made by a
    function when `show()` runs (`updatefunc`) is code. Writing it into the
    document ended the import with a TypeError the caller never saw.
    """
    parts = [
        what.removesuffix(" (left out)")
        for what in left_out
        if what.endswith(" (left out)")
    ]
    objects = [
        what.removesuffix(" (not held)")
        for what in left_out
        if what.endswith(" (not held)")
    ]
    styles = [
        what for what in left_out if not what.endswith((" (left out)", " (not held)"))
    ]
    out = []
    if objects:
        # an object of a class from outside magpylib that a document has
        # no name for (`session.OBJECT_TYPES`)
        out.append(
            f"{', '.join(objects)}: not supported in a document, so it was "
            "left out. The rest of the scene came across."
        )
    if styles:
        out.append(
            f"{', '.join(styles)}: made by a function, which a document cannot "
            "hold, so it did not come across. The object is drawn without it."
        )
    if parts:
        # a sealed collection's part of a class a scene has no name for
        out.append(
            f"{', '.join(parts)}: a kind of object a scene cannot hold, so it "
            "did not come across. The rest of the body did."
        )
    return out


def _made_of(spec):
    """What an object is made of apart from where it stands -- a leaf its
    parameters, a collection what it holds -- the same for copies of one."""
    if spec["type"] == "Collection":
        return json.dumps([_made_of(child) for child in spec.get("children", [])])
    params = {k: v for k, v in (spec.get("params") or {}).items() if k != "position"}
    return json.dumps([spec["type"], params], sort_keys=True)


def _flattening_warnings(unnamed, script=True):
    """What executing the script cost, in the words of what it built.

    Reported per type and only from two upwards: one inline object is how
    anybody writes a one-off, while eight unnamed Circles are a loop that no
    longer exists. Saying so matters most to a caller that is about to edit
    them — they are eight separate objects now, and changing one changes one.

    Copies -- made of the same values, placed apart (`_made_of`) -- are what
    a loop of one object built and a pattern builds back, and are told so.
    Objects each made of their own values, a meshed body's solved cells or a
    coil whose windings differ, no pattern makes: from a `script` they are
    only said to be separate now, and from a notebook's own objects, which
    lose no loop by being copied into a view, nothing is said. `unnamed`
    holds ``(type, what it is made of)``.
    """
    made = {}
    for kind, made_of in unnamed:
        made.setdefault(kind, []).append(made_of)
    warnings = []
    for what, values in made.items():  # first-seen order
        times = Counter(values)
        copies = sum(1 for value in values if times[value] > 1)
        if copies > 1:
            warnings.append(
                f"{copies} {what} objects were built without a variable of "
                "their own — a loop or comprehension, which running the script "
                "cannot preserve. They are separate objects here: editing one "
                "does not change the others. Pattern them instead to get that "
                "back."
            )
        elif script and len(values) > 1:
            warnings.append(
                f"{len(values)} {what} objects were built without a "
                "variable of their own. They are separate objects here: "
                "editing one does not change the others."
            )
    return warnings


def _name_map(namespace):
    """id(obj) -> first variable name bound to it in the script."""
    mapping = {}
    for name, obj in namespace.items():
        if not name.startswith("_") and _is_scene_object(obj):
            mapping.setdefault(id(obj), name)
    return mapping


def document_from_namespace(namespace):
    """Every magpylib object the script left behind, as one document."""
    named = [
        (name, obj)
        for name, obj in namespace.items()
        if not name.startswith("_") and _is_scene_object(obj)
    ]
    return _document_from_named(named, _name_map(namespace))


def document_from_objects(objects, namespace, script=True):
    """The objects of one captured show() call, named from the namespace
    where possible (falling back to style labels / generated ids). `script`:
    whether they come from running a script, rather than a notebook's own
    objects copied into a view (`_flattening_warnings`)."""
    names = _name_map(namespace)
    named = [(names.get(id(obj)) or obj.style.label or "obj", obj) for obj in objects]
    return _document_from_named(named, names, script)


def _loop_names(code):
    """The names a top-level `for` binds: a loop's index, left behind holding
    its last value, which nobody meant as a variable. Read off the compiled
    script -- the target is what is stored straight after `FOR_ITER` -- so
    nothing is parsed, and a tuple target (`for a, b in ...`) gives both."""
    names, binding = set(), False
    for instruction in dis.get_instructions(code):
        if instruction.opname == "FOR_ITER":
            binding = True
        elif binding and instruction.opname in ("UNPACK_SEQUENCE", "UNPACK_EX"):
            continue
        elif binding and instruction.opname == "STORE_NAME":
            names.add(instruction.argval)
        else:
            binding = False
    return names


def variables_lost(namespace, code):
    """The script's own numbers, said as what they became.

    `lift = 0.01` at the top of a script is a variable to whoever wrote it,
    and running the script cannot tell: what it leaves behind is a magnet
    0.01 up, not a name for that. Imported without a word, a scene with
    sliders came back with none and said nothing -- so the names are said.
    A loop's index is not one of them (see `_loop_names`): `to_script`'s
    patterns leave an `i`, and a script's own loops their own.
    """
    loops = _loop_names(code)
    names = [
        name
        for name, value in namespace.items()
        if not name.startswith("_")
        and name not in loops
        and isinstance(value, int | float | np.integer | np.floating)
        and not isinstance(value, bool)
    ]
    if not names:
        return []
    return [
        f"{', '.join(names)} came back as the numbers they held: running a "
        "script keeps what it built, not how it was written, so nothing here "
        "follows them any more. A scene written with magpylib_studio.build "
        "keeps its variables."
    ]


def _number_text(value):
    """A number as a script would write it, so what the comment says and what
    the assignment says are the same number."""
    return repr(value)


def _span(low, high, prefix=""):
    """The two ends of a range, said the way a person would: both of them, or
    whichever one exists."""
    if low is not None and high is not None:
        return f"{prefix}{_number_text(low)} to {_number_text(high)}"
    if low is not None:
        return f"{prefix}min {_number_text(low)}"
    return None if high is None else f"{prefix}max {_number_text(high)}"


def bounds_comment(limits):
    """What a variable's limits look like at the end of its line in a script:

        n = 10  # 4 to 20, whole
        radius = 0.023  # metres, min 0.016, slider 0.016 to 0.04
        tilt_axis = 'z'  # one of 'x', 'y', 'z'

    Limits used to be editor-only metadata, dropped by every script the studio
    wrote — so a script said less about a variable than the panel beside it
    did, and a scene that travelled as a script arrived with its sliders gone.
    Written for a reader, not for us: generation is one-way, so nothing here
    parses this back. A script states what it can about a variable because a
    person opening it should not have to guess.
    """
    if not limits:
        return ""
    parts = [
        part
        for part in (
            # first: what the numbers that follow are numbers of
            units.NAMES.get(limits.get("unit")) if limits.get("unit") else None,
            _span(limits.get("min"), limits.get("max")),
            _span(limits.get("soft_min"), limits.get("soft_max"), "slider "),
        )
        if part
    ]
    if limits.get("integer"):
        parts.append("whole")
    # Last, because it is the one part that runs to the end of the line: a
    # list of choices contains the commas that separate everything else.
    if limits.get("options"):
        parts.append("one of " + ", ".join(repr(o) for o in limits["options"]))
    return f"  # {', '.join(parts)}" if parts else ""


def _show_patch_targets():
    """Everywhere a script can reach show(): the magpy function plus the
    base classes whose `show` attribute obj.show() binds."""
    targets = [(magpy, "show")]
    for cls in (magpy.magnet.Cuboid, magpy.Collection, magpy.Sensor):
        owner = next(k for k in cls.__mro__ if "show" in vars(k))
        if all(o is not owner for o, _ in targets):
            targets.append((owner, "show"))
    return targets


def _flatten_show_args(args):
    objects = []
    for arg in args:
        if isinstance(arg, list | tuple):
            objects.extend(a for a in arg if _is_scene_object(a))
        elif _is_scene_object(arg):
            objects.append(arg)
    return objects


def run_script(path):
    """Execute a magpylib script with show() intercepted.

    Returns (namespace, captured, code) where captured holds the objects of
    each show() call — every call the script makes is a scene candidate —
    and code is what ran, for what can be read off it without running it
    again (`variables_lost`). Note: docs are built AFTER execution, so
    objects shown mid-script import with their final state.
    """
    with open(path, encoding="utf-8") as f:
        source = f.read()
    namespace = {"__name__": "__main__", "__file__": str(path)}
    captured: list[list] = []

    def _capture_show(*args, **kwargs):
        objects = _flatten_show_args(args)
        if objects:
            captured.append(objects)

    # Compiled before show() is patched, not after: a syntax error raised
    # between the patch and the `try` that undoes it left magpylib's show()
    # capturing into a dead list for the rest of the engine's life.
    code = compile(source, str(path), "exec")
    targets = _show_patch_targets()
    originals = [getattr(owner, name) for owner, name in targets]
    # The studio's own drawing goes through show() too (a `SceneWidget` a
    # notebook script makes at its end): it finds the real one here.
    _capture_show.original = originals[0]
    for owner, name in targets:
        setattr(owner, name, _capture_show)
    # And stdin is the channel the engine is asked on: a script's input()
    # would swallow the editor's next request, and exit() and quit() close
    # stdin on their way out, which left the engine nothing to read.
    asked_on, sys.stdin = sys.stdin, io.StringIO()
    try:
        # What the script prints is the script's to say, on stderr: stdout is
        # the channel the engine answers on, and a print there is a line the
        # editor has to read past.
        with contextlib.redirect_stdout(sys.stderr):
            exec(code, namespace)  # noqa: S102 - the point
    except SystemExit as stop:
        # exit() ends the script, not the engine running it: let through, it
        # left the editor with no engine and no answer. A clean exit is a
        # script that finished; any other is one that failed, at its line.
        if stop.code not in (None, 0):
            error = RuntimeError(f"the script exited with {stop.code!r}")
            raise error.with_traceback(stop.__traceback__) from None
    finally:
        sys.stdin = asked_on
        for (owner, name), original in zip(targets, originals, strict=True):
            setattr(owner, name, original)
    return namespace, captured, code
