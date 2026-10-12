"""Copying across scenes: `export_object` writes an object as a scene of its
own, and `import_fragment` merges one into another scene as one step."""

import numpy as np

from magpylib_studio.session import MagpylibStudioSession
from tests.test_meshes import add_mesh, cube_stl, file_source  # noqa: F401


def cube(session, object_id, parent=None, position=(0, 0, 0)):
    assert session.add_object(
        object_id,
        "magnet.Cuboid",
        params={
            "dimension": [0.01, 0.01, 0.01],
            "polarization": [0, 0, 1],
            "position": list(position),
        },
        parent=parent,
    )["ok"]


def family(session, object_id):
    """Every pose of an object and its pattern's copies, in mm and degrees."""
    poses = [
        (
            np.round(np.atleast_2d(obj.position)[-1] * 1000, 6).tolist(),
            np.round(obj.orientation.as_rotvec(degrees=True), 6).tolist(),
        )
        for name, obj in session._objs.items()
        if name == object_id or name.startswith(object_id + "#")
    ]
    return sorted(poses)


def copy(source, object_id, target, parent=None, origin=None):
    out = source.export_object(object_id)
    assert out["ok"], out
    result = target.import_fragment(out["scene"], parent, out["base_dir"], origin)
    assert result["ok"], result
    return result


def test_the_copy_stands_where_the_object_stands():
    """What its groups did to it comes as one rigid step: the Halbach's r2,
    turned 18° by its ring, is copied with every magnet of its pattern where
    it was, not at 0°."""
    source = MagpylibStudioSession()
    source.load_example("halbach")
    target = MagpylibStudioSession()
    result = copy(source, "r2", target)
    assert family(target, "r2") == family(source, "r2")
    position = np.array(target._objs["r2"].position) * 1000
    assert np.allclose(position, [21.87, 7.11, 15], atol=0.01)
    # a pattern needs a group: its source comes in one named after it
    (group,) = result["ids"]
    assert target._spec(group)["type"] == "Collection"
    assert target._objs[group].style.label == source._objs["r2"].style.label


def test_a_group_comes_whole_into_a_group():
    source = MagpylibStudioSession()
    source.load_example("halbach")
    target = MagpylibStudioSession()
    assert target.add_object("holder", "Collection")["ok"]
    copy(source, "halbach", target, parent="holder")
    for magnet in ("r1", "r2"):
        assert family(target, magnet) == family(source, magnet)
    assert target._parents["halbach"] == "holder"


def test_its_variables_come_with_it_renamed_where_taken():
    """Never the target's own: a clash is a new name, and every formula that
    names it follows, the variables' own included."""
    source = MagpylibStudioSession()
    source.set_variable("a", 0.01)
    source.set_variable("b", "=2 * a")
    cube(source, "m", position=("=b", 0, 0))
    target = MagpylibStudioSession()
    target.set_variable("a", 0.5)
    result = copy(source, "m", target)
    assert result["renamed"] == {"a": "a_2"}
    variables = target.to_dict()["variables"]
    assert variables["a"] == 0.5  # the target's own, untouched
    assert variables["a_2"] == 0.01
    assert variables["b"] == "=2 * a_2"
    assert np.allclose(target._objs["m"].position, [0.02, 0, 0])
    # and it moves with its own, not with the target's
    target.set_variable("a", 1)
    assert np.allclose(target._objs["m"].position, [0.02, 0, 0])


def test_only_the_variables_it_uses_come():
    source = MagpylibStudioSession()
    source.set_variable("used", 0.01)
    source.set_variable("unused", 3)
    cube(source, "m", position=("=used", 0, 0))
    target = MagpylibStudioSession()
    copy(source, "m", target)
    assert set(target.to_dict()["variables"]) == {"used"}


def test_a_second_paste_shares_the_variable_the_first_made():
    """From the same origin: the twin it made, not a third. From elsewhere,
    or once the twin has changed, a new one."""
    source = MagpylibStudioSession()
    source.set_variable("a", 0.01)
    cube(source, "m", position=("=a", 0, 0))
    target = MagpylibStudioSession()
    target.set_variable("a", 0.5)
    assert copy(source, "m", target, origin="one")["renamed"] == {"a": "a_2"}
    assert copy(source, "m", target, origin="one")["renamed"] == {"a": "a_2"}
    assert copy(source, "m", target, origin="two")["renamed"] == {"a": "a_3"}
    target.set_variable("a_2", 0.7)
    assert copy(source, "m", target, origin="one")["renamed"] == {"a": "a_4"}


def test_ids_the_target_has_used_are_new():
    """Live or removed: one id names one object in a log."""
    source = MagpylibStudioSession()
    cube(source, "m")
    cube(source, "k")
    target = MagpylibStudioSession()
    cube(target, "m")
    cube(target, "k")
    assert target.remove_object("k")["ok"]
    assert copy(source, "m", target)["ids"] == ["m_1"]
    assert copy(source, "k", target)["ids"] == ["k_1"]


def test_a_step_pointing_outside_the_copy_is_left_out():
    """A reparent onto a group that is not copied: the copy goes where the
    paste puts it."""
    source = MagpylibStudioSession()
    assert source.add_object("g", "Collection")["ok"]
    cube(source, "m")
    assert source.move_object("m", "g")["ok"]
    out = source.export_object("m")
    assert all(event.get("op") != "reparent" for event in out["scene"]["events"])
    assert MagpylibStudioSession().load_scene(out["scene"])["ok"]


def test_a_paste_is_one_step_to_undo():
    source = MagpylibStudioSession()
    source.set_variable("a", 0.01)
    cube(source, "m", position=("=a", 0, 0))
    target = MagpylibStudioSession()
    copy(source, "m", target)
    assert target.undo()["ok"]
    assert "m" not in target._objs
    assert not target.to_dict().get("variables")


def test_variants_stay_with_their_scene():
    source = MagpylibStudioSession()
    source.set_variable("a", 0.01)
    cube(source, "m", position=("=a", 0, 0))
    assert source.save_variant("wide")["ok"]
    out = source.export_object("m")
    assert "variants" not in out["scene"]


def test_mesh_paths_name_the_same_file_from_the_new_folder(cube_stl, tmp_path):  # noqa: F811
    here = tmp_path / "parts"
    here.mkdir()
    (here / "cube.stl").write_bytes(cube_stl.read_bytes())
    source = MagpylibStudioSession()
    source.set_base_dir(str(here))
    assert add_mesh(source, "part", file_source("cube.stl"))["ok"]
    elsewhere = tmp_path / "scenes" / "deep"
    elsewhere.mkdir(parents=True)
    target = MagpylibStudioSession()
    target.set_base_dir(str(elsewhere))
    copy(source, "part", target)
    (create,) = [
        e
        for e in target.to_dict()["events"]
        if e.get("op") == "create" and e["target"] == "part"
    ]
    assert create["params"]["mesh_source"]["path"] == "../../parts/cube.stl"


def test_what_cannot_be_copied_says_so():
    source = MagpylibStudioSession()
    source.load_example("halbach")
    refused = source.export_object("r1#1")  # a pattern's copy
    assert refused["ok"] is False
    assert refused["error"] == "unknown object id 'r1#1'"
    out = source.export_object("sensor")
    target = MagpylibStudioSession()
    cube(target, "m")
    assert target.import_fragment(out["scene"], "m")["ok"] is False
    assert target.import_fragment(out["scene"], "nope")["ok"] is False
    assert target.import_fragment({"no": 1})["ok"] is False
