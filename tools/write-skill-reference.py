"""Write the agent skill's API reference from the code it describes.

    python tools/write-skill-reference.py

The skill (`magpylib_studio/.agents/skills/magpylib-studio/`) is what a coding
agent reads before it writes a scene, and the agent takes what it reads there as
true. A reference written by hand drifts from the code the first time a keyword
is renamed, and goes on reading as authoritative (`docs/fem.md` §13.1, §13.4).
So this one is generated: each entry is the signature and the docstring of what
it names, read off the code, and `tests/test_skill.py` fails when the file is
not what this would write today -- as `expression_help` is read off the
allow-list that enforces it.
"""

import inspect
import pathlib

from magpylib_studio import build, expressions
from magpylib_studio.session import MagpylibStudioSession

OUT = (
    pathlib.Path(build.__file__).parent
    / ".agents"
    / "skills"
    / "magpylib-studio"
    / "references"
    / "api.md"
)

# What the skill teaches, in the order it teaches it. A name the code no longer
# has fails here, and so does the test.
SCENE = (
    "variable",
    "sampled",
    "Collection",
    "Sensor",
    "add",
    "session",
    "save",
    "to_script",
)
OBJECT = (
    "move",
    "rotate_from_angax",
    "rotate_from_rotvec",
    "set_transform",
    "reparent",
    "hide",
    "show",
    "remove",
    "duplicate_around",
    "duplicate_along",
    "mirror",
)
SESSION = (
    "get_field",
    "sweep",
    "set_variable",
    "get_variables",
    "load_scene",
    "list_examples",
    "load_example",
    "to_builder_script",
)


def _doc(member, name):
    doc = inspect.getdoc(member)
    if not doc:
        raise ValueError(f"{name} has no docstring, so the skill would say nothing")
    return doc


def _entry(owner, name, prefix):
    member = inspect.getattr_static(owner, name)
    if isinstance(member, property):
        return f"### `{prefix}{name}`\n\n{_doc(member, name)}\n"
    function = getattr(owner, name)
    signature = inspect.signature(function)
    parameters = list(signature.parameters.values())
    if parameters and parameters[0].name == "self":
        signature = signature.replace(parameters=parameters[1:])
    return f"### `{prefix}{name}{signature}`\n\n{_doc(function, name)}\n"


def reference():
    """The reference, as the file should hold it."""
    allowed = expressions.reference()
    functions = ", ".join(f"`s.{name}`" for name in allowed["functions"])
    constants = ", ".join(f"`s.{name}`" for name in allowed["constants"])
    numpy = ", ".join(f"`np.{ufunc.__name__}`" for ufunc in build._UFUNC_FUNCTIONS)
    parts = [
        "# The builder and the session, as the skill uses them\n",
        "Generated from the code by `tools/write-skill-reference.py`: edit the\n"
        "docstrings, not this file. What follows is what this version of\n"
        "magpylib-studio has.\n",
        "## The scene\n",
        f"### `Scene{inspect.signature(build.Scene)}`\n\n"
        f"{_doc(build.Scene, 'Scene')}\n",
        *(_entry(build.Scene, name, "s.") for name in SCENE),
        "## Objects\n",
        "### `s.magnet.<Class>(id=None, style=None, **kwargs)`, "
        "`s.current.<Class>(...)`, `s.misc.<Class>(...)`\n\n"
        "Any class of `magpylib.magnet`, `magpylib.current` or `magpylib.misc`,\n"
        "taking magpylib's own keywords. `id=` names the object, unique in the\n"
        "scene (left out: its label, else its class); `style=` takes magpylib's\n"
        "style as a dict, and each `style_label=`-shaped keyword sets one field\n"
        "of it.\n\n"
        f"{_doc(build.Object, 'Object')}\n",
        *(_entry(build.Object, name, "obj.") for name in OBJECT),
        _entry(build.Collection, "add", "group."),
        "## What an expression may call\n",
        f"{functions}, and the constants {constants}. Each takes numbers and\n"
        "variables alike; these are the expression allow-list's own names, and\n"
        f"all a scene can hold. On a variable, numpy's {numpy} write the same\n"
        "expressions, as does its arithmetic; any other numpy function refuses.\n",
        "## The session\n",
        "`s.session` is the scene's `MagpylibStudioSession`;\n"
        "`MagpylibStudioSession()` is an empty one, to open a saved scene into.\n"
        "Most of its calls report a refusal rather than raise it:\n"
        '`{"ok": False, "error": ...}`. Reading the field raises `ValueError`\n'
        "when there is nothing to read.\n",
        *(_entry(MagpylibStudioSession, name, "session.") for name in SESSION),
        "## When a call fails\n",
        f"### `BuildError`\n\n{_doc(build.BuildError, 'BuildError')}\n",
    ]
    return "\n".join(parts)


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(reference(), encoding="utf-8")
    print(f"wrote {OUT}")
