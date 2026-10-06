"""Units: what a variable measures, said beside its number (`docs/fem.md` §6).

The document stays SI; a unit kind on a variable and a model unit on the
document are what a view needs to show `gap: 15 mm` and read `15` back."""

import io
import json

import pytest

from magpylib_studio import units
from magpylib_studio.build import Scene
from magpylib_studio.rpc import serve
from magpylib_studio.session import MagpylibStudioSession


def halbach():
    session = MagpylibStudioSession()
    session.load_example("halbach")
    return session


# --- reading what was typed ----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "kind", "model", "value"),
    [
        ("15", "length", "mm", 0.015),  # in the unit it is shown in
        ("15 mm", "length", "mm", 0.015),
        ("1.5cm", "length", "mm", 0.015),
        ("0.015 m", "length", "mm", 0.015),
        ("1.1", "length", "mm", 0.0011),  # exactly, not 1.1 * 0.001
        ("23.4", "length", "mm", 0.0234),
        ("2.5", "length", "cm", 0.025),
        ("15 µm", "length", "mm", 1.5e-5),
        ("-90°", "angle", "mm", -90),
        ("90 deg", "angle", "mm", 90),
        ("800 mT", "field", "mm", 0.8),
        ("3 kA", "current", "mm", 3000),
        ("10", None, "mm", 10),  # no unit: the number as typed, as always
        ("0.5", None, "mm", 0.5),
    ],
)
def test_typed_text_reads_as_the_documents_number(text, kind, model, value):
    assert units.parse(text, kind, model) == value


def test_radians_are_turned_into_the_degrees_magpylib_turns_by():
    assert units.parse("1.5707963267948966 rad", "angle", "mm") == pytest.approx(90)


@pytest.mark.parametrize(
    ("text", "kind", "said"),
    [
        ("5 kg", "length", "'kg' is not a unit of length (m, cm, mm, µm)"),
        ("5 mm", "angle", "'mm' is not a unit of angle"),
        ("5 mm", None, "has no unit, so 'mm' means nothing to it"),
        ("2*gap", "length", "is not a number, or a number and a unit"),
        # JSON has no infinity: the reply would never reach the view
        ("1e400", None, "is too large a number"),
        ("1e400 mm", "length", "is too large a number"),
        ("1" + "0" * 400, None, "is too large a number"),
    ],
)
def test_what_cannot_be_read_says_what_could(text, kind, said):
    with pytest.raises(ValueError, match=said.replace("(", r"\(").replace(")", r"\)")):
        units.parse(text, kind, "mm")


def test_a_length_is_shown_in_the_model_unit():
    assert units.shown("length", "mm") == {"symbol": "mm", "scale": 1000.0}
    assert units.shown("length", "µm") == {"symbol": "µm", "scale": 1e6}
    assert units.shown("angle", "mm") == {"symbol": "°", "scale": 1.0}
    assert units.shown("mystery", "mm") is None  # shown as the bare number it is


# --- the session -----------------------------------------------------------------


def test_a_variable_says_what_it_measures_and_its_value_stays_si():
    """SI unless the scene says otherwise: a length is shown in metres."""
    session = halbach()
    listed = {v["name"]: v for v in session.get_variables()["variables"]}
    assert session.get_variables()["model_unit"] == "m"
    assert listed["gap"]["value"] == 0.015
    assert listed["gap"]["shown"] == {"symbol": "m", "scale": 1.0}
    assert listed["stagger"]["shown"] == {"symbol": "°", "scale": 1.0}
    assert "shown" not in listed["n"]  # a count measures nothing


def test_every_kind_is_shown_in_si_unless_the_scene_says_otherwise():
    """Metres, tesla, amperes -- and degrees for an angle, which is what
    magpylib turns by and what the document holds."""
    shown = {k: units.shown(k, units.DEFAULT_MODEL_UNIT) for k in units.KINDS}
    assert {k: v["symbol"] for k, v in shown.items()} == {
        "length": "m",
        "angle": "°",
        "field": "T",
        "current": "A",
        "dimensionless": "",
    }
    assert all(v["scale"] == 1 for v in shown.values())


def test_a_unit_is_not_a_limit():
    """Setting or clearing a variable's limits -- what the panel's Allowed
    range does -- keeps what it measures."""
    session = halbach()
    assert session.set_variable_bounds("gap", min=0, max=0.1)["ok"]
    assert session.to_dict()["variable_bounds"]["gap"] == {
        "min": 0,
        "max": 0.1,
        "unit": "length",
    }
    assert session.set_variable_bounds("gap")["ok"]
    assert session.to_dict()["variable_bounds"]["gap"] == {"unit": "length"}
    assert session.set_variable_unit("gap", None)["ok"]
    assert "gap" not in session.to_dict()["variable_bounds"]


def test_a_unit_is_one_the_studio_knows_and_a_choice_has_none():
    session = halbach()
    unknown = session.set_variable_unit("gap", "weight")
    assert unknown["ok"] is False and "length, angle" in unknown["error"]
    choice = session.set_variable_unit("tilt_axis", "angle")
    assert choice["ok"] is False and "which no unit measures" in choice["error"]
    assert session.set_variable_unit("nowhere", "length")["ok"] is False


def test_the_model_unit_is_the_documents_and_undoes():
    session = halbach()
    assert "model_unit" not in session.to_dict()  # metres, unsaid
    assert session.set_model_unit("cm")["ok"]
    assert session.to_dict()["model_unit"] == "cm"
    listed = {v["name"]: v for v in session.get_variables()["variables"]}
    assert listed["gap"]["shown"] == {"symbol": "cm", "scale": 100.0}
    assert listed["gap"]["value"] == 0.015  # drawn in cm, still metres
    assert session.set_model_unit("furlong")["ok"] is False
    assert session.undo()["ok"]
    assert "model_unit" not in session.to_dict()


def test_a_model_unit_the_studio_does_not_know_is_carried_not_shown_in():
    """A file from a newer version, or edited by hand: its lengths are shown
    in metres, and the unit it says stays in it."""
    session = halbach()
    doc = session.to_dict()
    doc["model_unit"] = "km"
    assert session.load_scene(doc)["ok"]
    assert session.get_variables()["model_unit"] == "m"
    assert session.quantity("gap", "15")["value"] == 15
    assert session.field_units("move", {"displacement": "=gap2"})["units"] == {
        "gap2": {"unit": "length", "symbol": "m"}
    }
    assert session.to_dict()["model_unit"] == "km"


def test_typed_text_is_read_for_the_variable_it_is_typed_into():
    """A bare number in the unit shown -- metres, unless the scene is shown
    in something else -- and one with a unit in its own."""
    session = halbach()
    assert session.quantity("gap", "0.02") == {"ok": True, "value": 0.02}
    assert session.quantity("gap", "20 mm") == {"ok": True, "value": 0.02}
    assert session.quantity("gap", "2 cm") == {"ok": True, "value": 0.02}
    assert session.set_model_unit("mm")["ok"]
    assert session.quantity("gap", "20") == {"ok": True, "value": 0.02}
    assert session.quantity("tilt", "45") == {"ok": True, "value": 45}
    assert session.quantity("n", "12") == {"ok": True, "value": 12}
    assert session.quantity("gap", "radius / 2")["ok"] is False  # an expression


def test_a_scene_without_units_is_as_it_was():
    """Zero migration: a document that never said what anything measures
    opens, lists and saves exactly as before."""
    session = MagpylibStudioSession()
    assert session.set_variable("r", 0.02)["ok"]
    assert session.set_variable_bounds("r", min=0, max=0.1)["ok"]
    doc = session.to_dict()
    assert "model_unit" not in doc
    assert doc["variable_bounds"] == {"r": {"min": 0, "max": 0.1}}
    (r,) = session.get_variables()["variables"]
    assert "shown" not in r


def test_limits_are_written_in_one_order_however_they_were_set():
    session = MagpylibStudioSession()
    assert session.set_variable("r", 0.02)["ok"]
    assert session.set_variable_unit("r", "length")["ok"]
    assert session.set_variable_bounds("r", soft_max=0.05, min=0)["ok"]
    assert list(session.to_dict()["variable_bounds"]["r"]) == [
        "min",
        "soft_max",
        "unit",
    ]


def test_a_renamed_variable_keeps_its_unit():
    session = halbach()
    assert session.rename_variable("gap", "spacing")["ok"]
    assert session.to_dict()["variable_bounds"]["spacing"]["unit"] == "length"


# --- scripts -----------------------------------------------------------------------


def test_a_script_says_what_a_number_measures():
    script = halbach().to_script()
    assert "gap = 0.015  # metres, 0 to 0.06, slider 0.01 to 0.03" in script
    assert "tilt = 0.0  # degrees, -180 to 180, slider -90 to 90" in script


def test_units_come_back_from_builder_code():
    s = Scene(model_unit="cm")
    s.variable("gap", 0.015, slider=(0.01, 0.03), unit="length")
    script = s.session.to_builder_script()
    assert "s = Scene(model_unit='cm')" in script
    assert (
        "gap = s.variable('gap', 0.015, slider=(0.01, 0.03), unit='length')" in script
    )
    namespace = {}
    exec(compile(script, "<builder>", "exec"), namespace)  # noqa: S102
    back = namespace["s"].to_dict()
    assert back["model_unit"] == "cm"
    assert back["variable_bounds"] == s.to_dict()["variable_bounds"]


def test_a_unit_the_studio_does_not_know_is_named_not_written():
    """From a hand-written document or a newer studio: as code it would fail
    the whole script at its line."""
    session = MagpylibStudioSession()
    doc = session.to_dict()
    doc.update(
        variables={"m": 2.0},
        variable_bounds={"m": {"unit": "mass"}},
        model_unit="furlong",
    )
    assert session.load_scene(doc)["ok"]
    script = session.to_builder_script()
    assert "# not written: unit on m ('mass')" in script
    assert "# not written: model_unit ('furlong')" in script
    assert "unit=" not in script.split("\n\n", 2)[-1]


def test_units_are_reachable_over_the_wire():
    session = halbach()
    requests = [
        {"id": 1, "method": "quantity", "params": {"name": "gap", "text": "2 cm"}},
        {"id": 2, "method": "set_variable_unit", "params": {"name": "n", "unit": None}},
        {"id": 3, "method": "set_model_unit", "params": {"unit": "cm"}},
        {"id": 4, "method": "unit_kinds"},
    ]
    out = io.StringIO()
    serve(
        session=session,
        inp=io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n"),
        out=out,
    )
    responses = [json.loads(line) for line in out.getvalue().splitlines()]
    assert responses[0]["result"] == {"ok": True, "value": 0.02}
    assert responses[1]["result"]["ok"] and responses[2]["result"]["ok"]
    kinds = {k["kind"]: k["units"] for k in responses[3]["result"]["kinds"]}
    assert kinds["length"] == ["m", "cm", "mm", "µm"]


def test_a_sweep_is_plotted_along_the_variables_unit():
    """Along a `gap (m)` axis, and in a scene shown in mm along `gap (mm)`
    from 10 to 30 -- not 0.01 to 0.03 along a bare `gap`."""
    session = halbach()
    sweep = [0.01, 0.02, 0.03]
    figure = session.get_sweep_figure("gap", sweep, points=[[0, 0, 0]])
    assert figure["layout"]["xaxis"]["title"]["text"] == "gap (m)"
    assert figure["data"][0]["x"] == pytest.approx(sweep)
    assert session.set_model_unit("mm")["ok"]
    figure = session.get_sweep_figure("gap", sweep, points=[[0, 0, 0]])
    assert figure["layout"]["xaxis"]["title"]["text"] == "gap (mm)"
    assert figure["data"][0]["x"] == pytest.approx([10, 20, 30])
    plain = session.get_sweep_figure("n", [8, 10], points=[[0, 0, 0]])
    assert plain["layout"]["xaxis"]["title"]["text"] == "n"


def test_greek_mu_is_read_as_the_micro_sign():
    assert units.parse("15 μm", "length", "mm") == 1.5e-5


def test_a_tab_save_that_changes_only_the_length_unit_applies(tmp_path):
    """The script tab writes `Scene(model_unit='cm')`; an edit to that alone is
    an edit, not a save that changes nothing."""
    session = halbach()
    script = session.to_builder_script()
    assert script.count("s = Scene()") == 1
    tab = tmp_path / "scene.py"
    tab.write_text(script.replace("s = Scene()", "s = Scene(model_unit='cm')"))

    assert session.apply_builder_script(str(tab)) == {"ok": True}
    assert session.to_dict()["model_unit"] == "cm"


# --- a variable born in a box -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "params", "units"),
    [
        (  # a position is a length, component by component
            "set_param",
            {"object_id": "r1", "name": "position", "value": ["=lift", 0, "=h"]},
            {"lift": "length", "h": "length"},
        ),
        (
            "set_param",
            {"object_id": "r1", "name": "polarization", "value": [0, 0, "=jz"]},
            {"jz": "field"},
        ),
        (
            "rotate",
            {"object_id": "r1", "angle": "=phi", "axis": "=ax"},
            {"phi": "angle"},
        ),
        (
            "move",
            {"object_id": "r1", "displacement": [[0, 0, "=dz"]]},
            {"dz": "length"},
        ),
        (  # a CylinderSegment's dimension is three lengths and two angles
            "add_object",
            {
                "object_id": "seg",
                "type": "magnet.CylinderSegment",
                "params": {"dimension": ["=r_in", 0.02, 0.01, 0, "=sweep"]},
            },
            {"r_in": "length", "sweep": "angle"},
        ),
        # a count measures nothing, and an expression says nothing about its names
        (
            "duplicate_around",
            {"object_id": "r1", "count": "=k", "spin": "=360 / k"},
            {},
        ),
    ],
)
def test_a_variable_typed_into_a_box_measures_what_the_box_does(method, params, units):
    found = halbach().field_units(method, params)["units"]
    assert {name: entry["unit"] for name, entry in found.items()} == units


def test_a_new_variables_value_is_read_in_the_unit_it_will_have():
    session = halbach()
    assert session.quantity("lift", "0.012", unit="length") == {
        "ok": True,
        "value": 0.012,
    }
    assert session.quantity("lift", "12 mm", unit="length") == {
        "ok": True,
        "value": 0.012,
    }
    assert session.quantity("jz", "1", unit="field") == {"ok": True, "value": 1}
    # not defined yet and no unit said: a plain number, as New Variable asks
    assert session.quantity("lift", "12") == {"ok": True, "value": 12}
    assert session.quantity("lift", "12 mm")["ok"] is False
