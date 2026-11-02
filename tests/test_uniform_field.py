"""A `UniformField` (magpylib-material-response) in a scene (#108): a source
like a coil, with a value and a turn and no place or body. The view says the sum
of them in its corner, or of those selected, and a document holds each."""

from __future__ import annotations

import json
import warnings
from typing import Annotated

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio import Bounds, build, grid, importer, scene, session
from magpylib_studio.recording import BuildError
from magpylib_studio.session import MagpylibStudioSession
from magpylib_studio.widget import SceneWidget

material_response = pytest.importorskip("magpylib_material_response")
if not hasattr(material_response, "UniformField"):
    pytest.skip(
        "this magpylib-material-response has no UniformField", allow_module_level=True
    )
UniformField = material_response.UniformField

POINTS = np.array([(0.02, 0, 0.01), (-0.03, 0.01, 0)])


def scene_of():
    """A magnet half a metre off the origin, and two fields, one turned."""
    magnet = magpy.magnet.Cuboid(
        polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01), position=(0.5, 0, 0)
    )
    upward = UniformField(B=(0, 0, 0.1))
    turned = UniformField(B=(0.02, 0, 0))
    turned.rotate_from_angax(30, "z")
    return magnet, upward, turned


def read(where):
    sources = [
        obj
        for obj in where.scene.sources_all
        if not isinstance(obj, magpy.Sensor | magpy.Collection)
    ]
    return magpy.getB(sources, POINTS, sumup=True)


def fields_in(where):
    return {f["id"]: f["B"] for f in where.get_scene()["fields"]}


@pytest.mark.parametrize("route", ["saved", "script", "scene function"])
def test_a_document_keeps_each_field(route, tmp_path):
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # "not supported in a document" was one
        here = SceneWidget(*scene_of(), editable=True)._session
    if route == "saved":
        back = MagpylibStudioSession()
        back.load_scene(json.loads(json.dumps(here.to_dict())))
    elif route == "script":
        path = tmp_path / "scene.py"
        path.write_text(here.to_script(), encoding="utf-8")
        namespace, captured, _ = importer.run_script(path)
        doc, said = importer.document_from_objects(captured[0], namespace)
        assert said == []
        back = MagpylibStudioSession()
        back.load_scene(doc)
    else:
        back = build.rebuilt(here)
    assert back._broken == []
    np.testing.assert_array_equal(read(back), read(here))
    assert fields_in(back) == fields_in(here)
    assert len(fields_in(back)) == 2


def test_to_json_reads_a_scene_with_fields():
    here = SceneWidget(*scene_of(), editable=True)._session
    again = material_response.from_json(material_response.to_json(here.scene))
    np.testing.assert_allclose(magpy.getB(again, POINTS), read(here), rtol=1e-12)


@pytest.mark.parametrize("editable", [True, False], ids=["session", "no session"])
def test_the_view_is_told_each_in_the_global_frame_and_frames_without_them(editable):
    magnet, upward, turned = scene_of()
    alone = SceneWidget(magnet.copy(), editable=editable)
    view = SceneWidget(magnet, upward, turned, editable=editable)
    told = {tuple(np.round(f["B"], 12)) for f in view.payload["fields"]}
    assert told == {(0, 0, 0.1), (round(0.02 * np.cos(np.pi / 6), 12), 0.01, 0)}
    assert view.payload["ranges"] == alone.payload["ranges"]
    # drawn nowhere in the scene: the corner says it, and no marker stands for it
    drawn = {
        item["object_id"]
        for items in view.payload.values()
        if isinstance(items, list)
        for item in items
        if isinstance(item, dict) and "object_id" in item
    }
    assert not drawn & {f["id"] for f in view.payload["fields"]}
    assert upward.style.set_values() == {}  # the object as it was given
    assert "get_trace" not in vars(upward)


def test_a_field_given_beside_its_collection_counts_once():
    magnet, upward, _ = scene_of()
    held = magpy.Collection(magnet, upward)
    assert [f["B"] for f in SceneWidget(held, upward).payload["fields"]] == [
        [0, 0, 0.1]
    ]


def test_a_field_is_edited_as_a_source():
    view = SceneWidget(*scene_of(), editable=True)
    studio = view._session
    (name,) = [f for f in fields_in(studio) if fields_in(studio)[f] == [0, 0, 0.1]]
    param = studio.get_params(name)
    assert [p["name"] for p in param] == ["B"]
    assert param[0]["unit"] == "T"
    assert param[0]["shown"]["unit"] == studio._shown("field")["unit"]
    assert studio.get_transform(name)["placed"] is False
    assert list(studio.get_schema(name)["properties"]) == ["label"]
    (magnet,) = [o["id"] for o in studio.list_objects() if o["type"] == "magnet.Cuboid"]
    assert studio.get_transform(magnet)["placed"] is True

    view.set(name, B=(0, 0, 0.2))
    assert fields_in(studio)[name] == [0, 0, 0.2]
    assert view.undo()
    assert fields_in(studio)[name] == [0, 0, 0.1]
    # hidden, the corner leaves it out; the field stays in the sum of the lines
    before = read(studio)
    studio.set_visible(name, False)
    assert name not in fields_in(studio)
    np.testing.assert_array_equal(read(studio), before)
    assert studio.remove_object(name)["ok"]
    assert name not in fields_in(studio)


def test_field_lines_and_a_gesture_follow_a_variable():
    @scene(field_unit="mT")
    def design(strength: Annotated[float, Bounds(-1, 1, unit="field")] = 0.1):
        magnet = magpy.magnet.Cuboid(
            polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01)
        )
        probe = magpy.Sensor(
            pixel=grid(0.03, 5, plane="xz"),
            style={"pixel": {"size": 0, "field": {"source": "B"}}},
        )
        driven = UniformField(B=(0, 0, strength))
        given = UniformField(H=(1000, 0, 0))  # written in the one form, as B
        return magnet, probe, driven, given

    studio = design.build().session
    assert studio._broken == []
    said = studio.get_params("driven")[0]
    assert said["written"] == [0, 0, "=strength"]
    np.testing.assert_allclose(fields_in(studio)["given"], (1000 * magpy.mu_0, 0, 0))

    studio.set_field_lines(True)
    lines = studio.get_scene()["fieldlines"]
    studio.begin_interaction()
    assert studio.set_variable("strength", 0.5)["ok"]
    step = studio.get_scene(partial=True)
    studio.end_interaction()
    assert {f["id"]: f["B"] for f in step["fields"]}["driven"] == [0, 0, 0.5]
    assert step["fieldlines"] != lines


def test_what_is_set_on_a_field_is_recorded():
    @scene
    def design(strength: Annotated[float, Bounds(-1, 1)] = 0.3):
        by_b = UniformField(B=(0, 0, 0.1))
        by_b.B = (0, 0, strength)
        by_h = UniformField(B=(0, 0, 0.1))
        by_h.H = (0, 0, 1000)
        return by_b, by_h

    studio = design.build().session
    assert fields_in(studio)["by_b"] == [0, 0, 0.3]
    np.testing.assert_allclose(fields_in(studio)["by_h"], (0, 0, 1000 * magpy.mu_0))
    assert studio.set_variable("strength", 0.5)["ok"]
    assert fields_in(studio)["by_b"] == [0, 0, 0.5]


def test_h_takes_no_variable():
    @scene
    def made(strength: Annotated[float, Bounds(-1, 1)] = 0.1):
        return UniformField(H=(0, 0, strength))

    @scene
    def set_after(strength: Annotated[float, Bounds(-1, 1)] = 0.1):
        field = UniformField(B=(0, 0, 0.1))
        field.H = (0, 0, strength)
        return field

    for design in (made, set_after):
        with pytest.raises(BuildError, match="give it as B"):
            design.build()


def test_a_solved_model_keeps_its_fields_and_an_old_h_ext_stays_apart():
    soft = magpy.magnet.Cuboid(polarization=(0, 0, 0), dimension=(0.01, 0.01, 0.01))
    soft.susceptibility = 1000
    solved = material_response.solve_face_charge(
        magpy.Collection(soft, UniformField(B=(0, 0, 0.1))), level=1
    )
    view = SceneWidget(solved, editable=True)
    np.testing.assert_array_equal(read(view._session), magpy.getB(solved, POINTS))
    assert [f["B"] for f in view.payload["fields"]] == [[0, 0, 0.1]]
    assert view.payload["applied"] is None

    old = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01))
    old.H_ext = (0.05, 0, 0)
    both = SceneWidget(old, UniformField(B=(0, 0, 0.1))).payload
    assert both["applied"] == [0.05, 0, 0]
    assert [f["B"] for f in both["fields"]] == [[0, 0, 0.1]]


def test_a_part_solved_again_while_a_drag_goes_keeps_the_fields():
    soft = magpy.magnet.Cuboid(polarization=(0, 0, 0), dimension=(0.02, 0.02, 0.02))
    soft.susceptibility = 1000
    magnet = magpy.magnet.Cuboid(
        polarization=(1, 0, 0),
        dimension=(0.01, 0.01, 0.01),
        position=(0, 0, 0.05),
        style_label="magnet",
    )
    field = UniformField(B=(0, 0, 0.1))

    def solved_with(*drives, reuse=False):
        again = soft.copy()
        again.susceptibility = 1000
        return material_response.solve_face_charge(
            magpy.Collection(again, *drives), level=1, reuse=reuse
        )

    view = SceneWidget(solved_with(magnet.copy(), field.copy()), editable=True)
    last = [True]

    def follow(objects):
        drives = [
            obj.copy()
            for obj in objects.values()
            if isinstance(obj, magpy.magnet.Cuboid | UniformField)
        ]
        last[0] = solved_with(*drives, reuse=last[0])
        (key, new) = next(
            (key, sheet)
            for key, old in objects.items()
            for sheet in last[0].sources_all
            if type(old).__name__ == type(sheet).__name__ == "ChargeSheet"
        )
        return {key: {"charge_densities": new.charge_densities}}

    view.follow_edits(follow)
    (name,) = [
        o["id"] for o in view._session.list_objects() if o["type"] == "magnet.Cuboid"
    ]
    view._reply({"id": 1, "method": "begin_interaction"})
    answer = view._reply(
        {
            "id": 1,
            "method": "apply_edits",
            "params": {"edits": [{"objectId": name, "position": [0.01, 0, 0.05]}]},
            "scene": True,
        }
    )[0]
    view._reply({"id": 1, "method": "end_interaction"})
    assert [f["B"] for f in answer["result"]["scene"]["fields"]] == [[0, 0, 0.1]]
    moved = magnet.copy()
    moved.position = (0.01, 0, 0.05)
    np.testing.assert_allclose(
        read(view._session),
        magpy.getB(solved_with(moved, field.copy()), POINTS),
        rtol=1e-9,
    )


def test_an_older_package_is_said(monkeypatch):
    # no UniformField on a magpylib-material-response before 0.9
    monkeypatch.delitem(session._CLASSES, "UniformField", raising=False)
    monkeypatch.setitem(
        session._EXTERNAL_TYPES,
        "UniformField",
        ("json", "magpylib-material-response", ("B",)),
    )
    with pytest.raises(ValueError, match="needs a newer magpylib-material-response"):
        session._resolve_type("UniformField")


def _with_h_ext(*values):
    objects = [
        magpy.magnet.Cuboid(
            polarization=(0, 0, 1), dimension=(0.01,) * 3, position=(x, 0, 0)
        )
        for x, _ in enumerate(values)
    ]
    for each, value in zip(objects, values, strict=True):
        each.H_ext = value
    return objects


@pytest.mark.parametrize("writer", ["to_script", "to_builder_script"])
def test_a_script_writes_h_ext_as_a_field_it_can_be_one_of(writer, tmp_path):
    def written(*objects):
        doc, _ = importer.document_from_objects(objects, {}, script=False)
        here = MagpylibStudioSession(doc)
        return here, getattr(here, writer)()

    here, script = written(*_with_h_ext((0, 0, 0.1), (0, 0, 0.1)))
    assert ".H_ext" not in script
    assert "applied_field = UniformField(B=(0.0, 0.0, 0.1))" in script
    path = tmp_path / "scene.py"
    path.write_text(script, encoding="utf-8")
    if writer == "to_script":
        namespace, captured, _ = importer.run_script(path)
        doc, _ = importer.document_from_objects(captured[0], namespace)
        back = MagpylibStudioSession(doc)
    else:
        found = {}
        exec(compile(script, str(path), "exec"), found)  # noqa: S102 - the point
        back = found["design"].build().session
    assert back._broken == []
    assert [f["B"] for f in back.get_scene()["fields"]] == [[0, 0, 0.1]]
    assert back.get_scene()["applied"] is None
    np.testing.assert_allclose(
        read(back) - read(here), np.tile((0, 0, 0.1), (len(POINTS), 1))
    )

    # what one field cannot say stays, and says so
    for objects in (
        _with_h_ext((0, 0, 0.1), (0, 0.2, 0)),
        [*_with_h_ext((0, 0, 0.1)), UniformField(B=(0, 0, 0.1))],
    ):
        _, script = written(*objects)
        assert ".H_ext = (0.0, 0.0, 0.1)  # one UniformField cannot say this" in script
        assert "applied_field" not in script
