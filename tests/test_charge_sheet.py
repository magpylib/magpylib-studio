"""A solved face-charge sheet (`ChargeSheet`, magpylib-material-response) in a
scene (#100): its field is its arrays, so a document holds them, and the sheet
is drawn with its charge beside field lines, saved, written and read back."""

from __future__ import annotations

import json
import warnings

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio import build, fieldlines, importer, scene, session
from magpylib_studio.session import MagpylibStudioSession
from magpylib_studio.widget import SceneWidget

material_response = pytest.importorskip(
    "magpylib_material_response", minversion="0.9.1"
)
face_charge = pytest.importorskip("magpylib_material_response.face_charge")

POINTS = np.array([(0, 0, 0.01), (0.01, 0.005, -0.004), (0.03, 0, 0)])


def solved():
    """The issue's scene: a magnet on a soft-iron plate, the plate solved
    into a sheet."""
    magnet = magpy.magnet.Cuboid(
        polarization=(0, 0, 1.2), dimension=(0.01, 0.01, 0.005), position=(0, 0, 0.0055)
    )
    plate = magpy.magnet.Cuboid(polarization=(0, 0, 0), dimension=(0.04, 0.04, 0.006))
    plate.susceptibility = 1000
    return face_charge.solve_face_charge(magpy.Collection(magnet, plate), level=1)


def sheet_of(collection):
    (sheet,) = [
        obj
        for obj in collection.children_all
        if isinstance(obj, face_charge.ChargeSheet)
    ]
    return sheet


def test_a_view_draws_the_sheet_beside_field_lines():
    given = solved()
    probe = magpy.Sensor(
        pixel=[(x, 0, z) for x in np.linspace(-0.03, 0.03, 5) for z in (-0.01, 0.015)]
    )
    probe.style.pixel.field.source = "B"
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # "unknown object type None" was one
        view = SceneWidget(given, probe, field_lines=True)
    scene = view._session.scene
    sheet = sheet_of(scene)
    np.testing.assert_array_equal(magpy.getB(scene, POINTS), given.getB(POINTS))
    assert sheet.style.charge.level == sheet_of(given).style.charge.level
    (sheet_id,) = [
        o["id"] for o in view._session.list_objects() if o["type"].endswith("Sheet")
    ]
    (mesh,) = [m for m in view.payload["meshes"] if m["object_id"] == sheet_id]
    assert mesh["lut"]  # coloured by its charge
    assert view.payload["fieldlines"]
    # a result: moved as a whole, its arrays not offered for editing
    assert view._session.get_params(sheet_id) == []


@pytest.mark.parametrize(
    "route", ["saved", "script", "scene function", "update", "from_json in a scene"]
)
def test_the_sheet_comes_back(route, tmp_path):
    given = solved()
    if route == "update":
        view = SceneWidget(magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=0.01))
        view.update(given)
        view.field_lines = True  # copies the cell's objects into a session
        back = view._session
    elif route == "from_json in a scene":
        text = material_response.to_json(given)
        back = (
            scene(lambda: tuple(material_response.from_json(text)[0].children))
            .build()
            .session
        )
    else:
        here = SceneWidget(given, editable=True)._session
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
            assert back.to_dict()["events"] == here.to_dict()["events"]
    assert back._broken == []
    np.testing.assert_array_equal(back.scene.getB(POINTS), given.getB(POINTS))
    # the solve's colour level, kept as the sheet's style
    level = sheet_of(given).style.charge.level
    assert level is not None
    assert sheet_of(back.scene).style.charge.level == level


@pytest.mark.parametrize(
    "call", ["mesh_all", "solve_cells", "solve_face_charge", "ChargeSheet.part"]
)
def test_a_scene_function_refuses_what_material_response_makes_by_name(call):
    # #114: recorded, a solve's working copies added their field to the scene,
    # 0.69 T for 0.43 T; unrecorded, a part was said to be made outside
    from magpylib_material_response.meshing import mesh_all

    outside = solved()

    def plate():
        soft = magpy.magnet.Cuboid(
            polarization=(0, 0, 0), dimension=(0.04, 0.04, 0.006)
        )
        soft.susceptibility = 1000
        return magpy.Collection(soft)

    calls = {
        "mesh_all": lambda: mesh_all(plate(), target_elems=8),
        "solve_cells": lambda: material_response.solve_cells(plate()),
        "solve_face_charge": solved,
        "ChargeSheet.part": lambda: sheet_of(outside).part.move((0.001, 0, 0)),
    }
    with pytest.raises(build.BuildError, match=call):
        scene(lambda: (calls[call](),)).build()


def test_field_lines_stop_at_a_solved_body():
    # two soft cubes touching, solved as one: each sheet leaves out the face
    # they share, so only both together enclose the body
    cubes = [
        magpy.magnet.Cuboid(
            polarization=(0, 0, 0), dimension=(0.01,) * 3, position=(x, 0, 0)
        )
        for x in (0, 0.01)
    ]
    for cube in cubes:
        cube.susceptibility = 1000
    magnet = magpy.magnet.Cuboid(
        polarization=(1, 0, 0), dimension=(0.005,) * 3, position=(-0.02, 0, 0)
    )
    out = face_charge.solve_face_charge(magpy.Collection(magnet, *cubes), level=1)
    out.rotate_from_angax(30, "z", anchor=0)
    points = np.random.default_rng(0).uniform(-0.02, 0.02, (2000, 3))
    local = out.orientation.apply(points, inverse=True) - (0.005, 0, 0)
    body = np.all(np.abs(local) <= (0.01, 0.005, 0.005), axis=1)
    sheets = [s for s in out.children if isinstance(s, face_charge.ChargeSheet)]
    assert len(sheets) == 2
    np.testing.assert_array_equal(fieldlines.inside(sheets, points), body)


def test_without_material_response_the_sheet_says_what_it_needs(monkeypatch):
    doc = json.loads(
        json.dumps(SceneWidget(solved(), editable=True)._session.to_dict())
    )
    monkeypatch.setitem(
        session._EXTERNAL_TYPES,
        "face_charge.ChargeSheet",
        ("no_such_module", "magpylib-material-response", ()),
    )
    monkeypatch.delitem(session._CLASSES, "face_charge.ChargeSheet", raising=False)
    back = MagpylibStudioSession()
    back.load_scene(doc)
    (broken,) = back._broken
    assert "needs magpylib-material-response" in broken["error"]
    assert [o["type"] for o in back.list_objects()] == ["Collection", "magnet.Cuboid"]


def _following_view():
    """A magnet on a plate, in a view that solves the plate again at each edit,
    and the solves its `follow_edits` made."""
    view = SceneWidget(solved(), editable=True)
    sent = []
    view.send = lambda message, *_, **__: sent.append(message)
    solves = []

    def follow(objects):
        magnet = next(o for o in objects.values() if type(o) is magpy.magnet.Cuboid)
        plate = magpy.magnet.Cuboid(
            polarization=(0, 0, 0), dimension=(0.04, 0.04, 0.006)
        )
        plate.susceptibility = 1000
        out = face_charge.solve_face_charge(
            magpy.Collection(magnet.copy(), plate),
            level=1,
            reuse=solves[-1] if solves else True,
        )
        solves.append(out)
        new = sheet_of(out)
        key = next(
            k for k, o in objects.items() if isinstance(o, face_charge.ChargeSheet)
        )
        return {
            key: {
                "vertices": new.vertices,
                "faces": new.faces,
                "panels": new.panels,
                "charge_densities": new.charge_densities,
                "mean_polarization": new.mean_polarization,
            }
        }

    view.follow_edits(follow)
    return view, solves, sent


def _drag(view, object_id, *positions):
    view._reply({"id": 1, "method": "begin_interaction"})
    for position in positions:
        edit = {"objectId": object_id, "position": list(position)}
        call = {"edits": [edit]}
        answer = view._reply(
            {"id": 1, "method": "apply_edits", "params": call, "scene": True}
        )[0]
        assert answer["result"]["ok"]
    view._reply({"id": 1, "method": "end_interaction"})
    view._show({"by": "drag"})


def test_an_edit_followed_is_solved_in_its_step():
    view, solves, sent = _following_view()
    key = next(k for k, o in view.objects.items() if type(o) is magpy.magnet.Cuboid)
    session = view._session
    before = magpy.getB(session.scene, POINTS)
    faces = len(sheet_of(session.scene).faces)
    level = sheet_of(session.scene).style.charge.level
    # off the plate: a mesh not graded toward the magnet, and with it a charge
    # that fits no other, and then the factorization kept, with only the charge
    # new, step after step
    _drag(view, key, (0, 0, 0.02), (0.001, 0, 0.02), (0.002, 0, 0.02))
    assert [s.face_charge_info["reused"] for s in solves] == [False, True, True]
    assert sent == []
    assert len(sheet_of(session.scene).faces) != faces
    moved = magpy.getB(session.scene, POINTS)
    np.testing.assert_array_equal(moved, solves[-1].getB(POINTS))
    assert sheet_of(session.scene).style.charge.level == level
    np.testing.assert_array_equal(
        sheet_of(session.scene).mean_polarization,
        sheet_of(solves[-1]).mean_polarization,
    )
    # the document holds it: built from it, the same field
    np.testing.assert_array_equal(
        magpy.getB(build.rebuilt(session).scene, POINTS), moved
    )

    # one undo, and neither the magnet nor its solve is left, with no solve more
    assert view.undo()
    assert len(solves) == 3
    np.testing.assert_array_equal(magpy.getB(session.scene, POINTS), before)
    assert view._step("redo")
    np.testing.assert_array_equal(magpy.getB(session.scene, POINTS), moved)


def test_a_new_charge_is_set_outside_a_gesture():
    studio = SceneWidget(solved(), editable=True)._session
    (key,) = [
        k for k, o in studio._objs.items() if isinstance(o, face_charge.ChargeSheet)
    ]
    charge = studio._objs[key].charge_densities * 2
    assert studio.set_params({key: {"charge_densities": charge.tolist()}})["ok"]
    np.testing.assert_array_equal(studio._objs[key].charge_densities, charge)


def test_a_failed_answer_is_said_and_the_edit_stays():
    view, _, sent = _following_view()
    key = next(k for k, o in view.objects.items() if type(o) is magpy.magnet.Cuboid)

    def refuses(objects):
        raise ValueError("no solve")

    view.follow_edits(refuses)
    _drag(view, key, (0.002, 0, 0.02))
    assert sent == [{"kind": "refused", "message": "Not followed: no solve"}]
    assert view._session._objs[key].position[0] == 0.002


def _solved_scene():
    """A magnet above a soft plate, solved, and a probe, in an editable view
    that hears of its edits as a panel does."""
    probe = magpy.Sensor(pixel=[(0.03, 0, 0)], style_label="probe")
    view = SceneWidget(solved_above(0.02), probe, editable=True)
    view.send = lambda *_, **__: None
    objects = view._session.list_objects()
    name = next(o["id"] for o in objects if o["type"] == "magnet.Cuboid")
    return view, name, next(o["id"] for o in objects if o["type"] == "Sensor")


def solved_above(height, level=1):
    """The issue's scene with the magnet up off the plate, solved."""
    magnet = magpy.magnet.Cuboid(
        polarization=(0, 0, 1.2),
        dimension=(0.01, 0.01, 0.005),
        position=(0, 0, height),
    )
    plate = magpy.magnet.Cuboid(polarization=(0, 0, 0), dimension=(0.04, 0.04, 0.006))
    plate.susceptibility = 1000
    return face_charge.solve_face_charge(magpy.Collection(magnet, plate), level=level)


def test_the_engine_solves_a_sheet_again_in_the_edits_step():
    view, name, probe = _solved_scene()
    studio = view._session
    before = magpy.getB(sheet_of(studio.scene), POINTS)
    assert studio.doc["solve_level"] == 1

    # a probe is no part of the solve: no solve, no step of its own
    _drag(view, probe, (0.03, 0.01, 0))
    assert "solves" not in view.last_edit

    _drag(view, name, (0, 0, 0.021), (0.002, 0, 0.022))
    solves = view.last_edit["solves"]
    assert [s["reused"] for s in solves] == [False, True]
    assert all(s["solved_by"] == "face_charge" for s in solves)
    moved = solved_above(0.022)
    magnet = next(s for s in moved.sources_all if type(s) is magpy.magnet.Cuboid)
    magnet.position = (0.002, 0, 0.022)
    fresh = face_charge.solve_face_charge(
        magpy.Collection(
            magnet.copy(),
            *(
                s.part
                for s in moved.sources_all
                if isinstance(s, face_charge.ChargeSheet)
            ),
        ),
        level=1,
    )
    np.testing.assert_allclose(
        sheet_of(studio.scene).charge_densities,
        sheet_of(fresh).charge_densities,
        atol=1e-6,
    )
    # the part is still there to solve from, and the undo takes back both, once
    assert sheet_of(studio.scene).part is not None
    assert view.undo()
    assert studio.take_solves() == []
    assert sheet_of(studio.scene).part is not None
    np.testing.assert_array_equal(magpy.getB(sheet_of(studio.scene), POINTS), before)


def test_a_slow_solve_waits_for_the_end_of_the_gesture(monkeypatch):
    view, name, _ = _solved_scene()
    studio = view._session
    monkeypatch.setattr(session, "_SLOW_STEP", -1.0)  # every solve is slow
    _drag(
        view,
        name,
        (0, 0, 0.021),
        (0, 0, 0.022),
        (0, 0, 0.023),
        (0, 0, 0.024),
    )
    # two steps, then none, and the one at the end, at where it was let go
    assert len(view.last_edit["solves"]) == 3
    fresh = solved_above(0.024)
    np.testing.assert_allclose(
        sheet_of(studio.scene).charge_densities,
        sheet_of(fresh).charge_densities,
        atol=1e-6,
    )


@pytest.mark.parametrize("route", ["saved", "script", "scene function"])
def test_a_document_keeps_the_part_to_solve_from(route, tmp_path):
    here = SceneWidget(solved_above(0.02), editable=True)._session
    if route == "saved":
        back = MagpylibStudioSession()
        back.load_scene(json.loads(json.dumps(here.to_dict())))
    elif route == "script":
        path = tmp_path / "scene.py"
        path.write_text(here.to_script(), encoding="utf-8")
        namespace, captured, _ = importer.run_script(path)
        doc, _ = importer.document_from_objects(captured[0], namespace)
        back = MagpylibStudioSession()
        back.load_scene(doc)
    else:
        back = build.rebuilt(here)
        assert back.doc["solve_level"] == 1
    assert back._broken == []
    part = sheet_of(back.scene).part
    assert part.susceptibility == 1000
    np.testing.assert_array_equal(part.dimension, (0.04, 0.04, 0.006))
