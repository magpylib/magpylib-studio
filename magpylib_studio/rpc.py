"""Newline-delimited JSON-RPC over stdio — the transport the VS Code extension
(or any host) drives its sessions through. One JSON object per line:

    -> {"id": 1, "method": "get_schema", "params": {"object_id": "cube"}}
    <- {"id": 1, "result": {...}}
    <- {"id": 2, "error": {"type": "KeyError", "message": "..."}}

One engine serves a session per open scene, each named by the host: a request
names its session beside the method, and the answer names it back.

    -> {"id": 3, "method": "open_session", "params": {"session": "4f2a9c", "path": "ring.magpy.json"}}
    -> {"id": 4, "session": "4f2a9c", "method": "undo"}
    <- {"id": 4, "session": "4f2a9c", "result": {...}}

No dependencies, no ports, no framework — the host spawns `python -m
magpylib_studio` and reads/writes its stdio.
"""

from __future__ import annotations

import json
import sys
from importlib import metadata

from magpylib_studio.session import DOC_VERSION, MagpylibStudioSession

#: What a host checks before it trusts this engine with its scenes, bumped
#: whenever a request or an answer changes shape. 2: requests name their
#: session. An engine from before ignores `session` and would serve every
#: scene from one, without a word -- which is why there is a number to check.
PROTOCOL = 2

# Only these methods are callable over the wire (no dunders / private helpers).
_PUBLIC = {
    "list_objects",
    "object_tree",
    "restore_variable",
    "get_schema",
    "get_values",
    "get_figure",
    "get_scene",
    "get_field",
    "get_field_figure",
    "get_field_map",
    "set_pixel_grid",
    "apply_edit",
    "add_object",
    "remove_object",
    "move_object",
    "copy_object",
    "set_visible",
    "begin_interaction",
    "end_interaction",
    "apply_edits",
    "set_param",
    "get_params",
    "get_transform",
    "inspect_mesh",
    "set_base_dir",
    "move",
    "rotate",
    "set_transform",
    "clear_path",
    "duplicate_around",
    "duplicate_along",
    "mirror",
    "reset_style",
    "load_scene",
    "replace_scene",
    "load_script",
    "load_captured",
    "apply_builder_script",
    "load_example",
    "list_examples",
    "clear_scene",
    "batch",
    "undo",
    "redo",
    "get_history",
    "goto_history",
    "sweep",
    "get_sweep_figure",
    "get_variables",
    "unknown_variables",
    "expression_help",
    "check_expression",
    "set_variable",
    "set_variables",
    "set_variable_bounds",
    "set_variable_unit",
    "set_model_unit",
    "set_field_unit",
    "get_units",
    "quantity",
    "read_values",
    "unit_kinds",
    "field_units",
    "rename_variable",
    "remove_variable",
    "use_variant",
    "save_variant",
    "rename_variant",
    "remove_variant",
    "get_events",
    "set_rollback",
    "edit_event",
    "remove_event",
    "move_event",
    "to_dict",
    "to_script",
    "to_builder_script",
}


def handle(session, request):
    """Dispatch one JSON-RPC request dict, return the response dict."""
    rid = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}
    if method not in _PUBLIC:
        return {
            "id": rid,
            "error": {"type": "MethodError", "message": f"unknown method {method!r}"},
        }
    try:
        result = getattr(session, method)(**params)
        return {"id": rid, "result": result}
    except Exception as e:  # noqa: BLE001 - report every failure to the caller
        return {"id": rid, "error": {"type": type(e).__name__, "message": str(e)}}


def _error(rid, kind, message):
    return {"id": rid, "error": {"type": kind, "message": message}}


class Engine:
    """The sessions one engine process serves, by the names the host gives
    them.

    A request names its session beside the method. One that names none goes
    to a session of its own, made when first asked -- the one-scene host, the
    "Try it" in architecture.md -- but only on a connection that has never
    opened one by name: once a host drives scenes by name, a request that
    forgets the name is a mistake, and answering it from an empty scene would
    hide it. Names are never used twice, closed ones included, so a stale
    name can only miss.

    Every session resolves meshes through one cache: its keys are what the
    mesh source read, so a part in two scenes is reoriented once.
    """

    #: Asked of the engine itself rather than of a session.
    METHODS = frozenset({"open_session", "close_session", "version"})

    def __init__(self, default=None):
        self._meshes: dict = {}
        self._default = default
        self._sessions: dict[str, MagpylibStudioSession] = {}
        self._named: set[str] = set()

    def open_session(self, session, scene=None, path=None, base_dir=None, example=None):
        """Open a session named `session` and load it in the same call: from
        `scene`, a document, `path`, a file holding one (and the folder its
        relative mesh paths are relative to), or `example`, the name of a
        built-in scene. None of them opens an empty scene; either way it is
        in `base_dir` when given.
        A load that fails opens nothing and says why, as `load_scene` does.
        """
        if not isinstance(session, str) or not session:
            raise ValueError("a session is named by a non-empty string")
        if session in self._sessions:
            raise ValueError(f"session {session!r} is open already")
        if session in self._named:
            raise ValueError(f"session {session!r} was closed; a name is used once")
        if sum(given is not None for given in (scene, path, example)) > 1:
            raise ValueError("open a session from a scene, a path or an example: one")
        opened = MagpylibStudioSession(mesh_cache=self._meshes)
        result = {"ok": True}
        if scene is not None or path is not None or example is not None:
            if example is not None:
                result = opened.load_example(example, base_dir)
            else:
                result = opened.load_scene(path if scene is None else scene, base_dir)
            if not result["ok"]:
                return result
        elif base_dir is not None:
            # an empty scene still has a folder: a mesh added to it later
            # resolves a relative path against it
            opened.set_base_dir(base_dir)
        self._sessions[session] = opened
        self._named.add(session)
        return {**result, "session": session}

    def close_session(self, session):
        """Drop the session named `session`, its undo history with it."""
        if self._sessions.pop(session, None) is None:
            raise KeyError(f"no session {session!r} is open")
        return {"ok": True}

    def version(self):
        """The package's version, the protocol's and the newest document this
        engine reads: what a host checks before it opens a scene here."""
        try:
            package = metadata.version("magpylib-studio")
        except metadata.PackageNotFoundError:
            package = None
        return {"package": package, "protocol": PROTOCOL, "document": DOC_VERSION}

    def handle(self, request):
        """Dispatch one request to the engine or to the session it names."""
        rid = request.get("id")
        method = request.get("method")
        if method in self.METHODS:
            params = request.get("params") or {}
            try:
                return {"id": rid, "result": getattr(self, method)(**params)}
            except Exception as e:  # noqa: BLE001 - report every failure to the caller
                return _error(rid, type(e).__name__, str(e))
        name = request.get("session")
        if name is not None:
            session = self._sessions.get(name)
            if session is None:
                return {
                    **_error(rid, "SessionError", f"no session {name!r} is open"),
                    "session": name,
                }
            return {**handle(session, request), "session": name}
        if self._named:
            return _error(
                rid,
                "SessionError",
                f"{method!r} names no session, and this engine serves its "
                "scenes by name: say which",
            )
        if self._default is None:
            self._default = MagpylibStudioSession(mesh_cache=self._meshes)
        return handle(self._default, request)


def serve(session=None, inp=None, out=None):
    """Read requests line-by-line, write one response line each. `session`,
    when given, answers the requests that name none."""
    engine = Engine(default=session)
    inp = inp or sys.stdin
    out = out or sys.stdout
    for line in inp:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            out.write(
                json.dumps(
                    {
                        "id": None,
                        "error": {"type": "JSONDecodeError", "message": str(e)},
                    }
                )
                + "\n"
            )
            out.flush()
            continue
        out.write(json.dumps(engine.handle(request)) + "\n")
        out.flush()
