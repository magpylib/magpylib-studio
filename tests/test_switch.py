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
):
    """A core that differs between the versions, an inlay patterned in v2
    only, and a coil both share."""
    versions = choose(version, style_label="versions")
    core1 = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.03), polarization=(0, 0, 1), style_label="core"
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
    document. The choice decides something, so it is no inert slider."""
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
    assert not any(v.get("inert") for v in session.get_variables()["variables"])
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
