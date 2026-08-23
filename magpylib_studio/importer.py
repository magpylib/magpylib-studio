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

import keyword
import re

import magpylib as magpy
import numpy as np
from magpylib._src.display import display as _display_module

from magpylib_studio import style_compat

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
    name = type(obj).__name__
    for modname in ("magnet", "current", "misc"):
        if getattr(getattr(magpy, modname), name, None) is type(obj):
            return f"{modname}.{name}"
    return None


def _is_scene_object(obj):
    return isinstance(obj, magpy.Collection) or _dotted_type(obj) is not None


def _zeroed(array):
    """+0.0 turns IEEE negative zero back into plain zero. Without it a scene
    re-rendered as a script flip-flops between `0.0` and `-0.0` on every
    round trip — the tiny residue of a rotation, rounded, keeps its sign."""
    return array + 0.0 if array.dtype.kind == "f" else array


def _tolist(value):
    return _zeroed(value).tolist() if isinstance(value, np.ndarray) else value


def _unique_id(base, used):
    base = re.sub(r"\W|^(?=\d)", "_", str(base)) or "obj"
    if keyword.iskeyword(base):
        base += "_"
    candidate, n = base, 1
    while candidate in used:
        n += 1
        candidate = f"{base}_{n}"
    used.add(candidate)
    return candidate


def _spec_from(obj, object_id, used_ids, unnamed, names):
    # An object the script never bound to a variable was built inline — in a
    # loop, a comprehension, a helper. Executing the script keeps what it
    # built and loses how, so this is the one trace of the structure that went
    # missing, and the caller is told rather than left to notice.
    if id(obj) not in names:
        unnamed.append(
            "Collection" if isinstance(obj, magpy.Collection) else _dotted_type(obj)
        )
    if isinstance(obj, magpy.Collection):
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
                )
                for child in obj.children
            ],
        }
    else:
        params = {}
        for attr in _PARAM_ATTRS:
            value = getattr(obj, attr, None)
            if value is not None:
                params[attr] = _tolist(value)
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
    style = style_compat.set_values(obj)
    if style:
        spec["style"] = style
    return spec


def _document_from_named(named, names):
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
    if not unique_top:
        raise ValueError("script produced no magpylib objects")
    used_ids, unnamed = set(), []
    objects = [
        _spec_from(obj, _unique_id(name, used_ids), used_ids, unnamed, names)
        for name, obj in unique_top
    ]
    return {"objects": objects}, _flattening_warnings(unnamed) + _inert_warnings(
        objects
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
            yield from walk(spec.get("children", ()))

    names = list(walk(objects))
    if not names:
        return []
    return [
        f"{', '.join(names)}: a CustomSource's field function cannot be written "
        "to a document, so it did not come across. The object is here, but it "
        "contributes nothing and is left out of field calculations."
    ]


def _flattening_warnings(unnamed):
    """What executing the script cost, in the words of what it built.

    Reported per type and only from two upwards: one inline object is how
    anybody writes a one-off, while eight unnamed Circles are a loop that no
    longer exists. Saying so matters most to a caller that is about to edit
    them — they are eight separate objects now, and changing one changes one.
    """
    warnings = []
    for type_name in dict.fromkeys(unnamed):  # first-seen order, deduplicated
        count = unnamed.count(type_name)
        if count > 1:
            warnings.append(
                f"{count} {type_name} objects were built without a variable of "
                "their own — a loop or comprehension, which running the script "
                "cannot preserve. They are separate objects here: editing one "
                "does not change the others. Pattern them instead to get that "
                "back."
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


def document_from_objects(objects, namespace):
    """The objects of one captured show() call, named from the namespace
    where possible (falling back to style labels / generated ids)."""
    names = _name_map(namespace)
    named = [(names.get(id(obj)) or obj.style.label or "obj", obj) for obj in objects]
    return _document_from_named(named, names)


# --- reading a script back by parsing it ---------------------------------
#
# Executing a script tells you what it built; parsing tells you how it was
# written. Only the latter can recover a variable or the order of a transform
# sequence, because both are gone by the time the objects exist. So the shape
# `to_script` emits — assignments and calls, no control flow — is parsed
# instead, and anything outside that shape falls back to running it.


#: The reverse of session._VECTORISED: `np.cos` is how a template is written
#: over a whole sample, `cos` is how the document holds it.


#: The classmethods a mesh source is written with, and the keyword each one
#: carries its source in. See session._mesh_source_lit for the other half.


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
        radius = 0.023  # min 0.016, slider 0.016 to 0.04
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
    """Everywhere a script can reach show(): the magpy/module functions plus
    the base classes whose `show` attribute obj.show() binds."""
    targets = [(magpy, "show"), (_display_module, "show")]
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

    Returns (namespace, captured) where captured holds the objects of each
    show() call — every call the script makes is a scene candidate. Note:
    docs are built AFTER execution, so objects shown mid-script import with
    their final state.
    """
    with open(path, encoding="utf-8") as f:
        source = f.read()
    namespace = {"__name__": "__main__", "__file__": str(path)}
    captured: list[list] = []

    def _capture_show(*args, **kwargs):
        objects = _flatten_show_args(args)
        if objects:
            captured.append(objects)

    targets = _show_patch_targets()
    originals = [getattr(owner, name) for owner, name in targets]
    for owner, name in targets:
        setattr(owner, name, _capture_show)
    try:
        exec(compile(source, str(path), "exec"), namespace)  # noqa: S102 - the point
    finally:
        for (owner, name), original in zip(targets, originals, strict=True):
            setattr(owner, name, original)
    return namespace, captured
