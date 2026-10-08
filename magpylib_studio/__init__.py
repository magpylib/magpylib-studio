"""magpylib-studio: magpylib scenes that keep their variables.

A scene is one parametric document, saved as `.magpy.json`: magnets, currents
and sensors, the variables they are written in, and the steps that placed them.
The studio -- a VS Code panel, a notebook widget -- edits it, with a slider per
variable. In Python, write one with the builder, in magpylib's spelling, and
open one with a session:

    from magpylib_studio.build import Scene

    s = Scene()
    n = s.variable("n", 12, bounds=(4, 48), integer=True)
    ring = s.Collection(id="ring")
    magnet = s.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.01), polarization=(1.2, 0, 0), position=(0.03, 0, 0)
    )
    ring.add(magnet)
    magnet.duplicate_around(count=n, axis="z", spin=360 / n)  # n stays a variable
    s.save("ring.magpy.json")

    from magpylib_studio.session import MagpylibStudioSession

    session = MagpylibStudioSession()
    session.load_scene("ring.magpy.json")
    session.get_field(points=[(0, 0, 0)])  # B in tesla, every source summed
    session.sweep("n", [8, 12, 16], points=[(0, 0, 0)])
    print(session.to_builder_script())  # the scene as builder code, to edit

A `.magpy.json` is the log of the steps that built a scene, not a list of
objects: make one with `Scene`, never by hand. Values are SI -- metres, tesla,
amperes, degrees. The guide for coding agents -- the builder's rules, the field,
what each refusal means -- is `magpylib_studio.guide()`, and ships beside this
file, in `.agents/skills/magpylib-studio/SKILL.md`; `uvx library-skills` links it
into a project.
"""

__all__ = ["MagpylibStudioSession", "guide"]


def __dir__():
    return ["MagpylibStudioSession", "build", "guide", "session"]


def guide():
    """Print the guide for coding agents: the builder's rules, the field, what
    each refusal means. The same text as the package's `SKILL.md`."""
    import pathlib

    skill = pathlib.Path(__file__).parent / ".agents/skills/magpylib-studio/SKILL.md"
    print(skill.read_text(encoding="utf-8"))


def __getattr__(name):
    """Resolve the session on first use rather than on import (PEP 562).

    `backend.py` is a magpylib entry point, and magpylib loads entry points
    while something asks it about a backend name -- so whatever is reachable
    from that module is paid for by anyone who gets that far. Reaching it goes
    through this one, and importing the session here brought the whole engine
    with it -- the same cost that keeping `viewer.py` apart from
    `plotly_view.py` was meant to avoid.
    """
    if name == "MagpylibStudioSession":
        from magpylib_studio.session import MagpylibStudioSession

        return MagpylibStudioSession
    if name in ("build", "session"):
        import importlib

        return importlib.import_module(f"{__name__}.{name}")
    msg = f"module {__name__!r} has no attribute {name!r}"
    if not name.startswith("_"):
        # most often an agent guessing how to open a scene: name the way
        msg += (
            ". To open a saved .magpy.json -- its field, a sweep, an edit -- use "
            "MagpylibStudioSession().load_scene(path), then get_field or sweep; "
            "to write a scene, magpylib_studio.build.Scene. "
            "magpylib_studio.guide() prints the whole guide"
        )
    raise AttributeError(msg)
