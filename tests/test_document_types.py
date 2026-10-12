"""A document is data: its `type` names one of the classes a scene holds, from
a fixed table, and nothing else is reached, let alone called (#34)."""

import json
import pathlib

import magpylib as magpy
import pytest

from magpylib_studio.rpc import Engine
from magpylib_studio.session import _CLASSES, OBJECT_TYPES, MagpylibStudioSession

SCHEMA = (
    pathlib.Path(__file__).parents[1]
    / "vscode-extension"
    / "schemas"
    / "magpy-scene.schema.json"
)

CUBE = {"dimension": [0.01, 0.01, 0.01], "polarization": [0, 0, 1]}


def document(type_name):
    """A scene of a good cube and one object of `type_name`."""
    return {
        "events": [
            {
                "id": "e1",
                "op": "create",
                "target": "good",
                "type": "magnet.Cuboid",
                "params": CUBE,
            },
            {
                "id": "e2",
                "op": "create",
                "target": "bad",
                "type": type_name,
                "params": {},
            },
        ]
    }


@pytest.fixture
def called(monkeypatch):
    """A function on magpylib that records being called: what a crafted
    document would reach for."""
    calls = []
    monkeypatch.setattr(
        magpy, "sneaky", lambda *a, **k: calls.append((a, k)), raising=False
    )
    return calls


REFUSED = [
    "sneaky",  # a function placed on magpylib
    "getB",  # one of magpylib's own
    "magnet",  # a module
    "Collection.__init__",  # a dunder path
    "_src",  # a private one
    "magnet.Cuboid.__init__",
    "nope",  # nothing at all
]


@pytest.mark.parametrize("name", REFUSED)
def test_a_type_outside_the_table_is_refused_uncalled(name, called):
    session = MagpylibStudioSession()
    session.load_scene(document(name))
    assert called == []
    ids = {o["id"] for o in session.list_objects()}
    assert "good" in ids  # the rest of the scene loads
    assert "bad" not in ids
    (broken,) = [b for b in session._broken if "bad" in json.dumps(b)]
    assert f"unknown object type {name!r}" in broken["error"]


@pytest.mark.parametrize("name", ["sneaky", "getB", "magnet"])
def test_add_object_refuses_it_too(name, called):
    session = MagpylibStudioSession()
    result = session.add_object("bad", name)
    assert result["ok"] is False
    assert f"unknown object type {name!r}" in result["error"]
    assert called == []


def test_and_over_rpc(called):
    engine = Engine()
    answer = engine.handle(
        {"id": 1, "method": "load_scene", "params": {"scene": document("sneaky")}}
    )
    assert "result" in answer
    assert called == []
    listed = engine.handle({"id": 2, "method": "list_objects"})["result"]
    assert [o["id"] for o in listed] == ["good"]


def test_every_name_of_the_table_is_a_class_this_magpylib_has_or_none():
    assert set(_CLASSES) <= set(OBJECT_TYPES)
    for name, cls in _CLASSES.items():
        assert isinstance(cls, type), name
    for required in ("magnet.Cuboid", "current.Circle", "Sensor", "Collection"):
        assert required in _CLASSES


def test_the_schema_names_the_same_types():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert schema["definitions"]["objectType"]["enum"] == list(OBJECT_TYPES)


def test_one_call_is_held_to_the_batchable_list_as_several_are():
    session = MagpylibStudioSession()
    result = session.apply_calls(
        [{"method": "load_script", "params": {"path": "x.py"}}]
    )
    assert result == {"ok": False, "error": "method 'load_script' not batchable"}
