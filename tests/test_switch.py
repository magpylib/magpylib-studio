"""A switch (`choose`, #119): every branch in the document, the chosen one in
the scene."""

from __future__ import annotations

import warnings
from typing import Annotated, Literal

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio import Length, build, choose, duplicate_around, importer, scene
from magpylib_studio.session import MagpylibStudioSession
from magpylib_studio.widget import SceneWidget

POINTS = np.array([(0.003, 0.002, 0.03), (0.02, 0.0, 0.0), (0.0, 0.015, -0.01)])


@scene(model_unit="mm")
def unit(
    version: Literal["v1", "v2"] = "v1",
    shift: Annotated[float, Length(-0.02, 0.02)] = 0.0,
    lift: Annotated[float, Length(-0.01, 0.01)] = 0.0,
):
    """A core that differs between the versions, the first `lift` up, an
    inlay patterned in v2 only, and a coil both share."""
    versions = choose(version, style_label="versions")
    core1 = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.03),
        polarization=(0, 0, 1),
        position=(0, 0, lift),
        style_label="core",
    )
    core2 = magpy.magnet.Cuboid(
        dimension=(0.012, 0.01, 0.03), polarization=(0, 0, 1), style_label="core"
    )
    inlay = magpy.magnet.Cuboid(
        dimension=(0.005,) * 3,
        polarization=(1, 0, 0),
        position=(0.01, 0, 0.02),
        style_label="inlay",
    )
    versions.add("v1", core1)
    versions.add("v2", core2, inlay)
    duplicate_around(inlay, count=3, axis="z")
    coil = magpy.current.Circle(
        current=10, diameter=0.04, position=(shift, 0, -0.02), style_label="coil"
    )
    return versions, coil


def field(session):
    """As the session gives it: to six digits."""
    return np.asarray(session.get_field(points=POINTS.tolist())["values"])


def plainly(version):
    return magpy.getB(magpy.Collection(*unit(version=version)), POINTS)


@pytest.mark.parametrize("version", ["v1", "v2"])
def test_the_scene_holds_the_chosen_branch(version):
    """Drawn, listed and in the field: the branch chosen, as the function
    called plainly at that version gives it, the others kept in the
    document. The choice decides something, so it is no inert slider; a
    variable only another version reads decides nothing now, and is."""
    built = unit.build()
    session = built.session
    if version == "v2":
        assert session.set_variable("version", "v2")["ok"]
    listed = [o["id"] for o in session.list_objects()]
    held = {"v1": ["core1"], "v2": ["core2", "inlay", "inlay#1", "inlay#2"]}
    assert listed == ["versions", *held[version], "coil"]
    np.testing.assert_allclose(field(session), plainly(version), rtol=1e-5, atol=1e-12)
    every = {spec["id"] for spec, _ in session._iter_specs()}
    assert {"core1", "core2", "inlay"} <= every
    listed = {v["name"]: v for v in session.get_variables()["variables"]}
    inert = {name for name, v in listed.items() if v.get("inert")}
    assert inert == ({"lift"} if version == "v2" else set())
    if version == "v2":  # and what it waits for
        assert listed["lift"]["waits"] == [{"version": "v1"}]
    view = SceneWidget(built)
    drawn = {mesh["object_id"] for mesh in view.payload["meshes"]}
    assert drawn == set(held[version]) - {"inlay#1", "inlay#2"}


@pytest.mark.parametrize("route", ["saved", "builder script", "plain script"])
def test_a_switch_comes_back(route, tmp_path):
    """Saved, a document keeps every branch, and so does the scene function
    written back; plain magpylib has no switch, and holds the branch in the
    scene."""
    session = unit.build().session
    session.set_variable("version", "v2")
    if route == "saved":
        back = MagpylibStudioSession()
        back.load_scene(session.to_dict())
        assert back.to_dict()["events"] == session.to_dict()["events"]
    elif route == "builder script":
        back = build.rebuilt(session)
        assert back.to_dict()["events"] == session.to_dict()["events"]
        assert "versions.add('v2', core2)" in session.to_builder_script()
    else:
        path = tmp_path / "scene.py"
        path.write_text(session.to_script(), encoding="utf-8")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # the script's own show()
            namespace, captured, _ = importer.run_script(path)
        doc, _ = importer.document_from_objects(captured[0], namespace)
        back = MagpylibStudioSession()
        back.load_scene(doc)
        assert "core1" not in session.to_script()
    np.testing.assert_allclose(field(back), plainly("v2"), rtol=1e-5, atol=1e-12)


def test_a_branch_keeps_its_edits_while_it_is_out():
    session = unit.build().session
    session.set_variable("version", "v2")
    session.move("inlay", [0, 0.005, 0])
    moved = session.get_transform("inlay")["position"]
    session.set_variable("version", "v1")
    assert "inlay" not in [o["id"] for o in session.list_objects()]
    session.set_variable("version", "v2")
    assert session.get_transform("inlay")["position"] == moved


def test_a_switch_is_not_patterned():
    """Its copies would copy every branch, none of them chosen."""

    @scene
    def copied(version: Literal["a", "b"] = "a"):
        versions = choose(version)
        versions.add("a", magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=0.01))
        magpy.Collection(versions)
        duplicate_around(versions, count=2, axis="z")

    with pytest.raises(build.BuildError, match="holds a switch"):
        copied.build()


def test_a_switch_at_its_edges():
    """From the review of #124: a turned magnet goes into a branch as a
    placed one goes into a collection; one moved out of a branch is in every
    one; a choice of numbers is compared as the document compares it; a
    switch whose choice cannot be read breaks alone; and a removed one no
    longer keeps its choice live."""
    from scipy.spatial.transform import Rotation

    from magpylib_studio import remove

    def cube(**kwargs):
        return magpy.magnet.Cuboid(
            dimension=(0.01,) * 3, polarization=(0, 0, 1), **kwargs
        )

    @scene
    def edges(v: Literal["a", "b"] = "b", n: Literal[1, 2] = 1):
        versions = choose(v)
        turned = cube(orientation=Rotation.from_euler("z", 30, degrees=True))
        versions.add("a", turned)
        moved = cube(position=(0.03, 0, 0))
        versions.add("a", moved)
        versions.remove(moved)
        versions.add(moved)
        counts = choose(n)
        counts.add(1, cube(position=(0, 0.03, 0)))
        gone = choose(v)
        gone.add("a", cube(position=(0, 0, 0.03)))
        remove(gone)

    with pytest.warns(UserWarning, match="already placed"):
        session = edges.build().session
    assert [o["id"] for o in session.list_objects()] == [
        "versions",
        "moved",
        "counts",
        "cuboid",
    ]
    edges(v="b", n=1)  # and plainly, the move out of a branch included
    session.set_variable("v", "a")
    assert "turned" in [o["id"] for o in session.list_objects()]
    broken = MagpylibStudioSession()
    doc = {
        "variables": {"v": "a"},
        "events": [
            {"op": "create", "target": "sw", "type": "Collection", "switch": "=nope"},
            {
                "op": "create",
                "target": "m",
                "type": "magnet.Sphere",
                "params": {"diameter": 0.01, "polarization": [0, 0, 1]},
            },
        ],
    }
    assert broken.load_scene(doc)["ok"]
    assert [o["id"] for o in broken.list_objects()] == ["m"]
    assert [entry["target"] for entry in broken._broken] == ["sw"]


def test_a_host_adds_to_the_branch_it_shows():
    """From a panel, what goes into a switch goes into the branch in the
    scene, so it is in the view: made there, moved there, pasted there; a
    copy beside its source stays in the source's branch. The listing says
    what each switch shows, and what its other branches hold."""
    session = unit.build().session
    session.set_variable("version", "v2")
    cube = {"dimension": [0.004] * 3, "polarization": [0, 0, 1]}
    assert session.add_object("extra", "magnet.Cuboid", cube, parent="versions")["ok"]
    assert session.move_object("coil", "versions")["ok"]
    assert session.copy_object("core2")["ok"]
    pasted = session.copy_object("core1", parent="versions")
    assert pasted["ok"]
    listed = {o["id"]: o for o in session.list_objects()}
    for each in ("extra", "coil", "core2_1", pasted["id"]):
        assert listed[each]["parent"] == "versions", each
    shows = listed["versions"]["shows"]
    assert shows["choice"] == "version" and shows["branch"] == "v2"
    assert set(shows["out"]) == {"core1"}
    session.set_variable("version", "v1")
    shown = [o["id"] for o in session.list_objects()]
    assert "extra" not in shown and "coil" not in shown and "core1" in shown


def test_what_lands_in_a_switch_from_elsewhere():
    """From the review: code says every branch, `m.parent = versions` too,
    and the script tab keeps it so; a paste from another scene lands in the
    branch shown, and an object exported out of a branch takes its branch
    nowhere -- into a plain collection, its script still runs."""

    @scene
    def placed(v: Literal["a", "b"] = "b"):
        versions = choose(v)
        m = magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=0.01)
        m.move((0.01, 0, 0))
        m.parent = versions
        versions.add("a", magpy.magnet.Sphere(polarization=(0, 0, 1), diameter=0.004))

    session = placed.build().session
    assert "m" in [o["id"] for o in session.list_objects()]
    assert build.rebuilt(session).to_dict()["events"] == session.to_dict()["events"]

    session = unit.build().session
    session.set_variable("version", "v2")
    other = MagpylibStudioSession()
    other.add_object(
        "ball", "magnet.Sphere", {"diameter": 0.01, "polarization": [0, 0, 1]}
    )
    fragment = other.export_object("ball")
    pasted = session.import_fragments([fragment], parent="versions")
    assert pasted["ok"]
    session.set_variable("version", "v1")
    assert pasted["ids"][0] not in [o["id"] for o in session.list_objects()]

    out = session.export_object("core1")
    assert all("branch" not in e for e in out["scene"]["events"] if e["op"] == "create")
    session.add_object("grp", "Collection", parent=None)
    assert session.import_fragments([out], parent="grp")["ok"]
    assert build.rebuilt(session).to_dict()["events"] == session.to_dict()["events"]
    refused = session.add_object("x", "magnet.Sphere", parent="grp", branch="v1")
    assert not refused["ok"]
