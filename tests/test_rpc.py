"""One engine, a session per open scene: the requests a host sends over stdio,
driven through `serve` as `python -m magpylib_studio` is."""

import io
import json

from magpylib_studio.rpc import PROTOCOL, Engine, serve
from magpylib_studio.session import DOC_VERSION, MagpylibStudioSession


def cube(object_id):
    """The params of `add_object` for a small cube."""
    return {
        "object_id": object_id,
        "type": "magnet.Cuboid",
        "params": {"dimension": [0.01, 0.01, 0.01], "polarization": [0, 0, 1]},
    }


def ask(*requests, session=None):
    """Each request's answer, in order, from one engine."""
    lines = [json.dumps({"id": n, **r}) for n, r in enumerate(requests, 1)]
    out = io.StringIO()
    serve(session=session, inp=io.StringIO("\n".join(lines) + "\n"), out=out)
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_two_sessions_each_keep_their_own_scene_and_undo():
    """What one scene's edits and undos do stays in that scene."""
    answers = ask(
        {"method": "open_session", "params": {"session": "a"}},
        {"method": "open_session", "params": {"session": "b"}},
        {"session": "a", "method": "add_object", "params": cube("c1")},
        {"session": "a", "method": "add_object", "params": cube("c2")},
        {"session": "b", "method": "add_object", "params": cube("c1")},
        {"session": "a", "method": "undo"},
        {"session": "a", "method": "list_objects"},
        {"session": "b", "method": "list_objects"},
        {"session": "b", "method": "undo"},
        {"session": "b", "method": "list_objects"},
        {"session": "a", "method": "list_objects"},
    )
    assert [a["result"]["ok"] for a in answers[:6]] == [True] * 6
    count = lambda answer: len(answer["result"])  # noqa: E731
    assert count(answers[6]) == 1  # a: two added, one undone
    assert count(answers[7]) == 1  # b: its own one
    assert count(answers[9]) == 0  # b's undo took b's
    assert count(answers[10]) == 1  # and left a's alone
    # every answer to a session names it back
    assert [a.get("session") for a in answers[2:]] == list("aabaabbba")


def test_a_session_opens_with_its_scene():
    """Opened from a document or from a file, in the one call: nothing to undo
    back past, and a file's folder is where its meshes are looked for."""
    scene = MagpylibStudioSession()
    scene.load_example("halbach")
    document = scene.to_dict()
    answers = ask(
        {"method": "open_session", "params": {"session": "s", "scene": document}},
        {"session": "s", "method": "list_objects"},
        {"session": "s", "method": "undo"},
    )
    assert answers[0]["result"]["ok"] and answers[0]["result"]["session"] == "s"
    assert len(answers[1]["result"]) == len(scene.list_objects())
    assert answers[2]["result"]["ok"] is False  # the load is where it begins


def test_opening_from_a_file(tmp_path):
    path = tmp_path / "one.magpy.json"
    scene = MagpylibStudioSession()
    scene.add_object(**cube("c"))
    path.write_text(json.dumps(scene.to_dict()))
    answers = ask(
        {"method": "open_session", "params": {"session": "f", "path": str(path)}},
        {"session": "f", "method": "list_objects"},
    )
    assert answers[0]["result"]["ok"]
    assert len(answers[1]["result"]) == 1


def test_a_load_that_fails_opens_nothing():
    """It says why, as `load_scene` does, and the name stays free to try again."""
    answers = ask(
        {"method": "open_session", "params": {"session": "x", "scene": {"no": 1}}},
        {"session": "x", "method": "list_objects"},
        {"method": "open_session", "params": {"session": "x"}},
    )
    assert answers[0]["result"]["ok"] is False
    assert "not a scene document" in answers[0]["result"]["error"]
    assert answers[1]["error"]["type"] == "SessionError"
    assert answers[2]["result"]["ok"]


def test_without_a_name_only_until_one_is_opened():
    """A host that drives one scene names none; once scenes are opened by
    name, a request that names none is refused rather than answered from an
    empty scene -- even after they are all closed again."""
    answers = ask(
        {"method": "add_object", "params": cube("c")},
        {"method": "list_objects"},
        {"method": "open_session", "params": {"session": "a"}},
        {"method": "list_objects"},
        {"method": "close_session", "params": {"session": "a"}},
        {"method": "list_objects"},
    )
    assert answers[0]["result"]["ok"]
    assert len(answers[1]["result"]) == 1
    assert answers[2]["result"]["ok"]
    for refused in (answers[3], answers[5]):
        assert refused["error"]["type"] == "SessionError"
        assert "names no session" in refused["error"]["message"]


def test_the_given_session_answers_the_unnamed_requests():
    """As `serve(session=...)` did before there were names."""
    session = MagpylibStudioSession()
    session.add_object(**cube("c"))
    (answer,) = ask({"method": "list_objects"}, session=session)
    assert len(answer["result"]) == 1


def test_a_name_is_used_once():
    """Open twice, or again after a close: refused, so a stale name only
    misses and never reaches another scene."""
    answers = ask(
        {"method": "open_session", "params": {"session": "a"}},
        {"method": "open_session", "params": {"session": "a"}},
        {"method": "close_session", "params": {"session": "a"}},
        {"session": "a", "method": "list_objects"},
        {"method": "open_session", "params": {"session": "a"}},
        {"method": "close_session", "params": {"session": "a"}},
        {"method": "open_session", "params": {"session": ""}},
    )
    assert answers[0]["result"]["ok"]
    assert "open already" in answers[1]["error"]["message"]
    assert answers[2]["result"] == {"ok": True}
    assert answers[3]["error"]["type"] == "SessionError"
    assert answers[3]["session"] == "a"
    assert "used once" in answers[4]["error"]["message"]
    assert answers[5]["error"]["type"] == "KeyError"
    assert answers[6]["error"]["type"] == "ValueError"


def test_the_engine_says_what_it_speaks():
    (answer,) = ask({"method": "version"})
    assert answer["result"]["protocol"] == PROTOCOL
    assert answer["result"]["document"] == DOC_VERSION
    assert "package" in answer["result"]


def test_one_mesh_cache_for_every_session():
    """A part in two scenes is reoriented once: every session the engine
    opens resolves through the same cache, the unnamed one too."""
    engine = Engine()
    engine.open_session("a")
    engine.open_session("b")
    caches = {id(s._mesh_cache) for s in engine._sessions.values()}
    assert caches == {id(engine._meshes)}
    fresh = Engine()
    fresh.handle({"id": 1, "method": "list_objects"})
    assert fresh._default._mesh_cache is fresh._meshes


def test_an_empty_scene_opens_in_its_folder(tmp_path):
    """An untitled scene has a folder too: a mesh added later finds its file
    there."""
    engine = Engine()
    engine.open_session("u", base_dir=str(tmp_path))
    assert engine._sessions["u"]._base_dir == str(tmp_path)


def test_a_replaced_scene_is_one_undo_away():
    """A Revert replaces the scene as a step: undo brings back what it had."""
    first = MagpylibStudioSession()
    first.add_object(**cube("a"))
    other = MagpylibStudioSession()
    other.add_object(**cube("b"))
    answers = ask(
        {
            "method": "open_session",
            "params": {"session": "s", "scene": first.to_dict()},
        },
        {
            "session": "s",
            "method": "replace_scene",
            "params": {"scene": other.to_dict()},
        },
        {"session": "s", "method": "list_objects"},
        {"session": "s", "method": "undo"},
        {"session": "s", "method": "list_objects"},
    )
    assert answers[1]["result"]["ok"]
    assert [o["id"] for o in answers[2]["result"]] == ["b"]
    assert answers[3]["result"]["ok"]
    assert [o["id"] for o in answers[4]["result"]] == ["a"]
