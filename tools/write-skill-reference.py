"""Write the agent skill's API reference from the code it describes.

    python tools/write-skill-reference.py

The skill (`magpylib_studio/.agents/skills/magpylib-studio/`) is what a coding
agent reads before it writes a scene, and the agent takes what it reads there as
true. A reference written by hand drifts from the code the first time a keyword
is renamed, and goes on reading as authoritative (`docs/plans/fem.md` §13.1, §13.4).
So this one is generated: each entry is the signature and the docstring of what
it names, read off the code, and `tests/test_skill.py` fails when the file is
not what this would write today -- as `expression_help` is read off the
allow-list that enforces it.
"""

import inspect
import pathlib

from magpylib_studio import build, expressions, recording
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
MARK = ("scene",)
FUNCTION = ("build", "save")
KINDS = ("Length", "Angle", "Count", "Bounds")
WORDS = (
    "derived",
    "duplicate_around",
    "duplicate_along",
    "mirror",
    "place",
    "sampled",
    "hide",
    "show",
    "remove",
    "TriangularMesh",
    "name",
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
    functions = ", ".join(f"`{name}`" for name in allowed["functions"])
    constants = ", ".join(f"`{name}`" for name in allowed["constants"])
    numpy = ", ".join(f"`np.{ufunc.__name__}`" for ufunc in build._UFUNC_FUNCTIONS)
    parts = [
        "# A scene function, its words, and the session, as the skill uses them\n",
        "Generated from the code by `tools/write-skill-reference.py`: edit the\n"
        "docstrings, not this file. What follows is what this version of\n"
        "magpylib-studio has.\n",
        "## The mark\n",
        *(_entry(recording, name, "") for name in MARK),
        "What `@scene` makes:\n",
        *(_entry(recording.SceneFunction, name, "fn.") for name in FUNCTION),
        "## A parameter's kind and bounds\n",
        "Inside `Annotated[float, ...]` or `Annotated[int, ...]`; a choice of\n"
        "names is `Literal[...]`. A parameter without an annotation is a plain\n"
        "number with no bounds.\n",
        *(_entry(recording, name, "") for name in KINDS),
        "## Studio's words\n",
        "Imported from `magpylib_studio`. Each is one step in the document when\n"
        "the scene is built, and plain magpylib when the function is called.\n",
        *(_entry(recording, name, "") for name in WORDS),
        "## What an expression may call\n",
        f"{functions}, and the constants {constants}: the expression\n"
        "allow-list's own names, and all a scene can hold. Over a variable,\n"
        f"numpy's {numpy} write these expressions, as does arithmetic, and\n"
        "the builtins `abs` and `round`; any other numpy function refuses. The\n"
        "constants as handles are `from magpylib_studio.recording import pi, tau, e`.\n",
        "## The session\n",
        "`fn.build().session` is the scene's `MagpylibStudioSession`;\n"
        "`MagpylibStudioSession()` is an empty one, to open a saved scene into.\n"
        "Most of its calls report a refusal rather than raise it:\n"
        '`{"ok": False, "error": "..."}`.\n',
        *(_entry(MagpylibStudioSession, name, "session.") for name in SESSION),
    ]
    return "\n".join(parts)


if __name__ == "__main__":
    OUT.write_text(reference(), encoding="utf-8")
    print(f"wrote {OUT}")
