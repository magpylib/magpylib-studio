"""A script, run in a process of its own: what `load_script` and the script
tab's save run, handed back to the engine as documents.

    python -m magpylib_studio.runner import|builder SCRIPT BASE_DIR MESHES

The engine serves every open scene from one process, and a script is code
anyone wrote: one that loops for ever, calls `os._exit` or sets
`magpy.defaults` would take every scene with it. Here it takes this process,
which the engine started for it and reads one line of JSON from, the last
on stdout marked as `session.RUNNER_ANSWER`; what the script prints goes
to stderr. MESHES is a file of the
engine's resolved meshes, read before the script runs and written back after,
so that a part is checked once and not on every save. The process ends with
the engine: a script still running when the engine goes is not left behind.
"""

from __future__ import annotations

import json
import os
import pickle
import sys
import threading
import time


def _follow_parent():
    """End this process once the engine that started it has gone."""
    parent = os.getppid()

    def watch():
        while True:
            time.sleep(1)
            if os.getppid() != parent:
                os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def imported(path):
    """The scenes a script makes, as `load_script` offers them: the scene a
    scene function built, whole; else one per `show()` call, and every object
    the script made when that is another."""
    from magpylib_studio import build, importer

    folder = os.path.dirname(os.path.abspath(path))
    candidates = []
    try:
        # Where the script is, a relative mesh path in it is: an exported
        # builder script sits beside its scene and the parts the scene names.
        with build.resolving_against(folder):
            namespace, captured, code = importer.run_script(path)
            # A script that defined a scene function made a document, not
            # objects to guess one from: that is the scene, whole --
            # variables, formulas and patterns -- and nothing has to be said
            # about what running it lost, because nothing was.
            built = build.scenes_in(namespace)
            if built:
                return {
                    "ok": True,
                    "candidates": [
                        {
                            "label": f"{name} (the scene the script built)",
                            "doc": written.to_dict(),
                            "warnings": [],
                            "base_dir": folder,
                        }
                        for name, written in built
                    ],
                }
        for i, objects in enumerate(captured):
            try:
                doc, warnings = importer.document_from_objects(objects, namespace)
            except ValueError:
                continue
            candidates.append(
                {
                    "label": f"show() call {i + 1} ({len(doc['objects'])} top-level)",
                    "doc": doc,
                    "warnings": warnings,
                }
            )
        try:
            doc, warnings = importer.document_from_namespace(namespace)
            if all(c["doc"] != doc for c in candidates):
                candidates.append(
                    {
                        "label": f"all script objects ({len(doc['objects'])} top-level)",
                        "doc": doc,
                        "warnings": warnings,
                    }
                )
        except ValueError:
            pass
    except Exception as e:  # noqa: BLE001 - report script errors, don't crash
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if not candidates:
        return {"ok": False, "error": "script produced no magpylib objects"}
    # Whichever scene is taken, the script's numbers are numbers in it.
    lost = importer.variables_lost(namespace, code)
    for candidate in candidates:
        candidate["warnings"] = candidate["warnings"] + lost
    return {"ok": True, "candidates": candidates}


def builder(path, base_dir):
    """The one scene a builder script builds, as a document, or the refusal
    to report: a line it raised at, plain magpylib, no scene or several."""
    from magpylib_studio import build, importer
    from magpylib_studio.session import _script_failure

    try:
        with build.resolving_against(base_dir):
            namespace, captured, _ = importer.run_script(path)
            built = build.scenes_in(namespace)
    except Exception as e:  # noqa: BLE001 - report script errors, don't crash
        return _script_failure(e, path)
    if not built:
        plain = captured or any(
            not name.startswith("_") and importer._is_scene_object(value)
            for name, value in namespace.items()
        )
        if plain:
            return {
                "ok": False,
                "error": "this is plain magpylib, which would come back "
                "flattened: every variable a number and every pattern its "
                "copies. Saving applies builder code, a script that builds a "
                "Scene (from magpylib_studio.build import Scene). To bring "
                "plain magpylib in, save it as a file of its own and use "
                "Open in Magpylib Studio",
            }
        return {
            "ok": False,
            "error": "the script built no Scene "
            "(from magpylib_studio.build import Scene; s = Scene())",
        }
    if len(built) > 1:
        names = ", ".join(name for name, _ in built)
        return {
            "ok": False,
            "error": f"the script built {len(built)} scenes ({names}), "
            "and there is one scene to replace",
        }
    try:
        # Objects nothing touched enter the scene here, so a refusal can come
        # this late -- with no line to point at, having none.
        return {"ok": True, "doc": built[0][1].to_dict()}
    except Exception as e:  # noqa: BLE001 - report it like any other refusal
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def main(argv):
    mode, path, base_dir, meshes = argv[1:5]
    answer = sys.stdout
    sys.stdout = sys.stderr  # what the script prints is its own
    _follow_parent()
    from magpylib_studio import session

    cache = {}
    if meshes and os.path.exists(meshes):
        with open(meshes, "rb") as f:
            cache = pickle.load(f)  # noqa: S301 - the engine's own, just written
    session.SHARED_MESH_CACHE = cache
    try:
        result = imported(path) if mode == "import" else builder(path, base_dir or None)
    except SystemExit as e:
        result = {"ok": False, "error": f"the script called exit({e.code})"}
    if meshes:
        with open(meshes, "wb") as f:
            pickle.dump(cache, f)
    try:
        text = json.dumps(result)
    except (TypeError, ValueError) as e:
        # Said here, where the cause is known: raised, it ended the process,
        # and all the engine could tell was that no scene came back.
        text = json.dumps(
            {"ok": False, "error": f"the scene holds what a document cannot: {e}"}
        )
    # on a line of its own, marked: what else reached stdout is not it
    answer.write(f"\n{session.RUNNER_ANSWER}{text}\n")
    answer.flush()


if __name__ == "__main__":
    main(sys.argv)
