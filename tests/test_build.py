"""The builder: a scene written in code, with variables that stay variables
(`docs/builder.md`)."""

import json
import math
import pathlib

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio.build import BuildError, Scene
from magpylib_studio.session import MagpylibStudioSession

CUBE = {"dimension": (0.01, 0.01, 0.01), "polarization": (0, 0, 1)}
CUBE_POL = {"polarization": [0, 0, 1]}


def halbach():
    """The built-in halbach example, written with the builder -- the listing
    `docs/builder.md` §2 shows."""
    s = Scene()
    n = s.variable("n", 10, bounds=(2, 60), slider=(4, 20), integer=True)
    radius = s.variable("radius", 0.023, bounds=(0.005, 0.08), slider=(0.016, 0.04))
    gap = s.variable("gap", 0.015, bounds=(0, 0.06), slider=(0.01, 0.03))
    stagger = s.variable("stagger", 360 / (2 * n))
    tilt = s.variable("tilt", 0.0, bounds=(-180, 180), slider=(-90, 90))
    tilt_axis = s.variable("tilt_axis", "z", options=("x", "y", "z"))

    halbach = s.Collection(id="halbach", style_label="Halbach stack")
    rings, magnets = {}, {}
    for number, z in ((1, 0.0), (2, gap)):
        rings[number] = s.Collection(id=f"ring{number}", style_label=f"Ring {number}")
        halbach.add(rings[number])
        magnets[number] = s.magnet.Cuboid(
            id=f"r{number}",
            style_label=f"Magnet {number}",
            dimension=(0.01, 0.01, 0.01),
            polarization=(1, 0, 0),
            position=(radius, 0, z),
        )
        rings[number].add(magnets[number])
    s.Sensor(
        id="sensor",
        style_label="Sensor",
        style_size=0.005,
        position=np.linspace((0, 0, -0.015), (0, 0, 0.03), 25),
    )
    for magnet in magnets.values():
        magnet.duplicate_around(count=n, axis="z", spin=360 / n)
    rings[2].rotate_from_angax(stagger, "z", anchor=0)
    halbach.rotate_from_angax(tilt, tilt_axis, anchor=0)
    return s


def field(session, points=((0.03, 0.02, 0.01), (-0.05, 0.01, 0.02), (0, 0, 0.005))):
    return np.asarray(
        session.get_field(points=[list(p) for p in points])["values"], dtype=float
    )


def cuboids(session):
    return sum(isinstance(o, magpy.magnet.Cuboid) for o in session._objs.values())


def test_the_halbach_example_written_in_code_is_the_example():
    """Same variables, same limits, same field -- and each ring is still the
    pattern that makes it, not the ten copies it made."""
    s = halbach()
    example = MagpylibStudioSession()
    example.load_example("halbach")
    built, want = s.to_dict(), example.to_dict()
    assert built["variables"] == want["variables"]
    assert built["variable_bounds"] == want["variable_bounds"]
    patterns = [e for e in built["events"] if e["op"] == "duplicate_around"]
    assert [(e["target"], e["count"], e["spin"]) for e in patterns] == [
        ("r1", "=n", "=360 / n"),
        ("r2", "=n", "=360 / n"),
    ]
    assert np.allclose(field(s.session), field(example), rtol=1e-9, atol=1e-15)


def test_a_scene_written_in_code_follows_its_variables():
    """What a script run cannot give back: change a variable and the scene
    changes with it."""
    session = halbach().session
    assert session._objs["r1"].position == pytest.approx([0.023, 0, 0])
    assert session.set_variable("radius", 0.03) == {"ok": True}
    assert session._objs["r1"].position == pytest.approx([0.03, 0, 0])
    assert cuboids(session) == 20
    assert session.set_variable("n", 4) == {"ok": True}
    assert cuboids(session) == 8


def test_arithmetic_on_a_variable_writes_an_expression():
    """In the document's own notation, as the panel would show it."""
    s = Scene()
    n = s.variable("n", 10)
    r = s.variable("r", 0.02)
    cases = [
        (360 / (2 * n), "360 / (2 * n)"),
        ((r + 1) * 2, "(r + 1) * 2"),
        (-r, "-r"),
        (2**n, "2 ** n"),
        (n // 3 % 2, "n // 3 % 2"),
        (abs(r - 1), "abs(r - 1)"),
        (round(r, 3), "round(r, 3)"),
        (s.pi * r, "pi * r"),
        (np.pi * r, f"{np.pi!r} * r"),
        (np.float64(2) * r, "2.0 * r"),
        (np.sin(r), "sin(r)"),
        (np.deg2rad(n), "radians(n)"),
        (s.sin(r), "sin(r)"),
        (s.max(r, 0.01), "max(r, 0.01)"),
        (s.hypot(r, n), "hypot(r, n)"),
    ]
    for expression, text in cases:
        assert expression._source == text
    # With no variable among its arguments, a function just computes.
    assert s.sin(0.5) == math.sin(0.5)


@pytest.mark.parametrize(
    ("attempt", "says"),
    [
        (lambda n, r: bool(r), "Branch on something fixed"),
        (lambda n, r: r > 0.01, "Branch on something fixed"),
        (lambda n, r: list(range(n)), r"duplicate_around\(count=n\)"),
        (lambda n, r: float(r), "not a number"),
        (lambda n, r: math.sin(r), r"np\.sin"),
        (lambda n, r: np.linspace(0, r, 3), "fixed ends"),
        (lambda n, r: f"Magnet {n}", "not text"),
        (lambda n, r: tuple(r), "one value"),
        (lambda n, r: np.array([1, 0, 0]) * r, "a component at a time"),
        (lambda n, r: np.floor(r), "no counterpart"),
    ],
)
def test_what_needs_a_value_now_is_refused_at_its_line(attempt, says):
    """Evaluated quietly, each would give a scene that looks right and has
    lost its variables. Refused, the message says what to write instead."""
    s = Scene()
    n, r = s.variable("n", 10), s.variable("r", 0.02)
    with pytest.raises(TypeError, match=says):
        attempt(n, r)


def test_a_refused_call_raises_with_the_sessions_reason():
    s = Scene()
    s.variable("n", 10)
    with pytest.raises(BuildError, match="already a variable"):
        s.variable("n", 3)
    s.magnet.Cuboid(id="m", **CUBE)
    with pytest.raises(BuildError, match="already exists"):
        s.magnet.Cuboid(id="m", **CUBE)
    with pytest.raises(AttributeError, match=r"magpylib has no magnet\.Cube"):
        s.magnet.Cube(**CUBE)


def test_a_child_is_created_inside_its_collection_and_never_moved():
    """Constructed before its collection, touched before it is added: still
    created inside, with its position in variables, and no reparent step."""
    s = Scene()
    r = s.variable("r", 0.02)
    magnet = s.magnet.Cuboid(id="m", position=(r, 0, 0), **CUBE)
    s.Collection(magnet, id="ring")
    magnet.move((0, 0, 0.01))
    events = s.to_dict()["events"]
    assert [(e["op"], e["target"]) for e in events] == [
        ("create", "ring"),
        ("create", "m"),
        ("move", "m"),
    ]
    assert events[1]["parent"] == "ring"
    assert events[1]["params"]["position"] == ["=r", 0, 0]


def test_adding_an_object_something_already_touched_moves_it_and_says_so():
    """The session's reparent keeps the world pose as numbers, so a position
    written in variables would quietly stop following them."""
    s = Scene()
    magnet = s.magnet.Cuboid(id="m", **CUBE).move((0.01, 0, 0))
    ring = s.Collection(id="ring")
    with pytest.warns(UserWarning, match="stops following"):
        ring.add(magnet)
    assert "reparent" in [e["op"] for e in s.to_dict()["events"]]


def test_an_angle_in_radians_is_written_in_degrees():
    s = Scene()
    tilt = s.variable("tilt", 0.1)
    magnet = s.magnet.Cuboid(id="m", **CUBE)
    magnet.rotate_from_angax(tilt, "x", degrees=False)
    magnet.rotate_from_angax(np.pi / 2, "y", degrees=False)
    angles = [
        e["angle"] for e in s.to_dict()["events"] if e["op"] == "rotate_from_angax"
    ]
    assert angles[0] == "=degrees(tilt)"
    assert angles[1] == pytest.approx(90)


def test_ids_come_from_the_label_or_the_class_and_never_clash():
    s = Scene()
    ids = [
        s.magnet.Cuboid(**CUBE).id,
        s.magnet.Cuboid(**CUBE).id,
        s.magnet.Cuboid(style_label="Probe magnet", **CUBE).id,
    ]
    assert ids == ["cuboid", "cuboid_2", "Probe_magnet"]


def test_a_scene_can_be_written_into_a_session_that_holds_one():
    """`Scene(session)`: another way to edit a scene, which knows its ids."""
    session = MagpylibStudioSession()
    session.load_example("halbach")
    s = Scene(session)
    with pytest.raises(BuildError, match="already exists"):
        s.magnet.Cuboid(id="r1", **CUBE)
    with pytest.raises(BuildError, match="already a variable"):
        s.variable("radius", 0.01)
    s.magnet.Cuboid(id="extra", position=(0, 0, 0.05), **CUBE)
    assert "extra" in s.session._objs


def test_a_saved_scene_opens_as_the_same_document(tmp_path):
    s = halbach()
    path = s.save(tmp_path / "halbach.magpy.json")
    again = MagpylibStudioSession()
    assert again.load_scene(str(path))["ok"]
    assert again.to_dict() == s.to_dict()


def test_the_script_of_a_scene_written_in_code_is_plain_magpylib():
    script = halbach().to_script()
    assert "import magpylib as magpy" in script
    assert "radius = 0.023" in script
    assert "for i in range(1, n):" in script


def test_a_formula_over_a_variable_stays_one():
    """The quiver's grid, written as the formula it is: `density` decides how
    many arrows there are, which `np.linspace` over a variable cannot say."""
    s = Scene()
    lift = s.variable("lift", 0.01, bounds=(0.001, 0.1), slider=(0.005, 0.03))
    width = s.variable("width", 0.03, bounds=(0.001, 0.1), slider=(0.01, 0.05))
    density = s.variable("density", 12, bounds=(2, 40), slider=(4, 20), integer=True)
    magnet = s.magnet.Cuboid(
        id="magnet",
        style_label="Turning magnet",
        polarization=(0, 0, 1),
        dimension=(0.01, width, 0.01),
    )
    grid = s.sampled(
        lambda t: (
            -0.02 + 0.04 * (t % density) / (density - 1),
            -0.02 + 0.04 * (t // density) / (density - 1),
            0,
        ),
        count=density**2,
        over=(0, density**2 - 1),
    )
    s.Sensor(id="field", position=(0, 0, lift), pixel=grid, style_size=0.005)
    magnet.rotate_from_angax(np.linspace(0, 360, 51), "y", start=0)

    example = MagpylibStudioSession()
    example.load_example("quiver")

    def pixel(doc):
        (create,) = [
            e for e in doc["events"] if e["op"] == "create" and e["target"] == "field"
        ]
        return create["params"]["pixel"]

    assert pixel(s.to_dict()) == pixel(example.to_dict())
    assert np.allclose(field(s.session), field(example), rtol=1e-9, atol=1e-15)
    session = s.session
    assert np.asarray(session._objs["field"].pixel).reshape(-1, 3).shape[0] == 144
    assert session.set_variable("density", 5) == {"ok": True}
    assert np.asarray(session._objs["field"].pixel).reshape(-1, 3).shape[0] == 25


def test_a_saved_value_is_kept_across_runs_and_a_definition_is_not(tmp_path):
    """The script says what the scene is; the file says where its sliders
    were left. A number in the script is a default, an expression is what the
    variable *is* -- so a slider survives a re-run, and a definition the
    script changes is not undone by the file it saved last."""
    path = tmp_path / "scene.magpy.json"

    def run(half_is="=n / 2"):
        s = Scene(values=path)  # not there on the first run: the defaults
        n = s.variable("n", 10)
        s.variable("half", n / 2 if half_is == "=n / 2" else n / 3)
        s.save(path)
        return s.to_dict()["variables"]

    assert run() == {"n": 10, "half": "=n / 2"}
    # the panel drags both, and saves
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["variables"].update(n=14, half=3)
    path.write_text(json.dumps(doc), encoding="utf-8")
    assert run() == {"n": 14, "half": "=n / 2"}
    assert run(half_is="=n / 3") == {"n": 14, "half": "=n / 3"}
    # and a mapping does as a file does
    mapped = Scene(values={"n": 4})
    mapped.variable("n", 10)
    assert mapped.to_dict()["variables"] == {"n": 4}


# --- the other way: a scene as a builder script (B2) -------------------------


def rebuilt(session):
    """Run `session`'s builder script; the scene it builds."""
    namespace = {}
    exec(compile(session.to_builder_script(), "<builder>", "exec"), namespace)  # noqa: S102
    (scene,) = [v for v in namespace.values() if isinstance(v, Scene)]
    return scene


def same_document(a, b):
    """The same scene, step for step -- event ids aside, which are only the
    log's own numbering."""
    steps = lambda doc: [  # noqa: E731
        {k: v for k, v in e.items() if k != "id"} for e in doc.get("events", [])
    ]
    keys = ("variables", "variable_bounds", "objects")
    return steps(a) == steps(b) and all(a.get(k) == b.get(k) for k in keys)


@pytest.mark.parametrize(
    "example", [e["name"] for e in MagpylibStudioSession().list_examples()["examples"]]
)
def test_an_example_run_from_its_builder_script_is_the_same_document(example):
    """Patterns stay patterns, formulas stay formulas, the slider limits stay
    -- what running a plain magpylib export cannot give back."""
    session = MagpylibStudioSession()
    session.load_example(example)
    assert same_document(rebuilt(session).to_dict(), session.to_dict())


def test_a_scene_edited_in_the_panel_comes_back_from_its_script():
    """A drag pinned in front of a pattern, a move, a turn, a reparent and the
    pose that keeps it in place, an object made and removed, a hidden ring and
    a slider moved: each the step the panel recorded."""
    session = MagpylibStudioSession()
    session.load_example("halbach")
    for method, args, kwargs in [
        ("set_transform", ("sensor",), {"position": [0.001, 0.0, 0.0]}),
        ("move", ("r2", [0, 0, 0.002]), {}),
        ("rotate", ("ring1", 15), {"axis": "x"}),
        (
            "set_transform",
            ("r1",),
            {"position": [0.024, 0.001, 0], "orientation": [0, 0, 10]},
        ),
        ("move_object", ("sensor",), {"parent": "ring2"}),
        ("set_visible", ("ring2", False), {}),
        ("add_object", ("probe", "Sensor"), {"params": {"position": [0, 0, 0.05]}}),
        ("remove_object", ("probe",), {}),
        ("set_variable", ("radius", 0.027), {}),
    ]:
        assert getattr(session, method)(*args, **kwargs).get("ok", True)
    script = session.to_builder_script()
    assert "sensor.reparent(ring2)" in script
    assert "ring2.hide()" in script
    assert same_document(rebuilt(session).to_dict(), session.to_dict())


def test_an_expressions_functions_and_constants_are_the_scenes():
    session = MagpylibStudioSession()
    assert session.set_variable("r", 0.02)["ok"]
    assert session.set_variable("w", "=sin(pi / 4) * r")["ok"]
    assert session.add_object(
        "m", "magnet.Cuboid", params={"dimension": ["=w", 0.01, 0.01], **CUBE_POL}
    )["ok"]
    script = session.to_builder_script()
    assert "w = s.variable('w', s.sin(s.pi / 4) * r)" in script
    assert same_document(rebuilt(session).to_dict(), session.to_dict())


def test_what_no_call_can_say_is_named_not_dropped():
    """A resize over an expression keeps the expression aside, for the
    Variables panel to give back -- editor state, which the script names at
    the top rather than writing or losing without a word."""
    session = MagpylibStudioSession()
    session.load_example("halbach")
    assert session.set_param("r1", "position", [0.03, 0, 0])["ok"]
    script = session.to_builder_script()
    assert script.startswith("# not written: overridden on r1")
    rebuilt(session)  # and it still runs


def test_a_builder_script_opens_in_the_studio_as_the_scene_it_built(tmp_path, capsys):
    """Open in Magpylib Studio runs the script, and a script that built a
    Scene is that scene: nothing to guess from objects, nothing lost, and
    nothing to warn about. What it prints is its own, on stderr -- stdout is
    the channel the engine answers on."""
    path = tmp_path / "ring.py"
    path.write_text(
        "from magpylib_studio.build import Scene\n"
        "s = Scene()\n"
        "n = s.variable('n', 6, bounds=(2, 20), integer=True)\n"
        "r = s.variable('r', 0.02)\n"
        "m = s.magnet.Cuboid(id='m', dimension=(0.005,) * 3, polarization=(1, 0, 0),\n"
        "                    position=(r, 0, 0))\n"
        "s.Collection(m, id='ring')\n"
        "m.duplicate_around(count=n, axis='z', spin=360 / n)\n"
        "print('built it')\n",
        encoding="utf-8",
    )
    studio = MagpylibStudioSession()
    result = studio.load_script(str(path))
    assert result["ok"] is True
    assert "warnings" not in result
    printed = capsys.readouterr()
    assert "built it" in printed.err and "built it" not in printed.out
    namespace = {}
    exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), namespace)  # noqa: S102
    assert same_document(studio.to_dict(), namespace["s"].to_dict())


def test_the_demo_opens_in_the_studio():
    """What the demo's first line promises, kept true: no notebook, no
    browser, nothing a kernel-less engine cannot run."""
    demo = pathlib.Path(__file__).parent.parent / "examples" / "builder_demo.py"
    studio = MagpylibStudioSession()
    assert studio.load_script(str(demo))["ok"] is True
    variables = studio.to_dict()["variables"]
    assert {"n", "radius", "gap", "stagger", "density"} <= set(variables)
    assert studio.get_scene()["readings"] == ["bore"]
