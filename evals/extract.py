"""Load a design an agent left behind, and say what it is and what field it makes.

    python evals/extract.py <request.json> <answer.json>

The checks run this as a subprocess, so an agent's script runs in a process of
its own, under a time limit, with its prints kept off the answer. The request
names the design -- a plain magpylib script and the variable it leaves the
assembly in, or a studio scene -- and what to report: the points to compute B
at, variables to set first (a scene's), and whether to look for magnets that
overlap. The answer lists every source with its type, where it is, which way it
points and the parameters a check reads, all in world coordinates.
"""

import contextlib
import json
import pathlib
import runpy
import sys

import magpylib as magpy
import numpy as np

# Parameters a check may read, as magpylib names them.
_PARAMETERS = ("dimension", "diameter", "current", "moment", "vertices")


def _plain(path, name):
    """The sources and sensors a plain magpylib script leaves in `name`."""
    import matplotlib

    matplotlib.use("Agg")
    magpy.show = lambda *args, **kwargs: None  # a script that shows draws nothing
    with contextlib.redirect_stdout(sys.stderr):
        namespace = runpy.run_path(str(path), run_name="__main__")
    if name not in namespace:
        raise LookupError(f"the script leaves no variable named {name!r}")
    held = namespace[name]
    if isinstance(held, magpy.Collection):
        return list(held.sources_all), list(held.sensors_all), None
    items = list(held) if isinstance(held, list | tuple) else [held]
    sources = [i for i in items if not isinstance(i, magpy.Sensor | magpy.Collection)]
    for item in items:
        if isinstance(item, magpy.Collection):
            sources.extend(item.sources_all)
    return sources, [i for i in items if isinstance(i, magpy.Sensor)], None


def _studio(path, sets):
    """The sources and sensors of a saved studio scene, after `sets`."""
    from magpylib_studio.session import MagpylibStudioSession

    session = MagpylibStudioSession()
    loaded = session.load_scene(str(path))
    if not loaded.get("ok", True):
        raise ValueError(f"the scene does not open: {loaded.get('error')}")
    for name, value in (sets or {}).items():
        result = session.set_variable(name, value)
        if not result.get("ok"):
            raise ValueError(f"setting {name} = {value} fails: {result['error']}")
    sensors = [o for o in session._objs.values() if isinstance(o, magpy.Sensor)]
    return session._leaf_sources(), sensors, session.to_dict()


def _last(value):
    """A path-valued quantity at its last step, as a list."""
    array = np.asarray(value, dtype=float)
    return (array[-1] if array.ndim > 1 else array).tolist()


def _describe(obj):
    rotation = obj.orientation
    if not rotation.single:
        rotation = rotation[-1]
    entry = {
        "type": type(obj).__name__,
        "position": _last(obj.position),
        "rotvec": rotation.as_rotvec(degrees=True).tolist(),
        # the direction of the local z axis: what a loop's normal is
        "axis": rotation.apply([0.0, 0.0, 1.0]).tolist(),
    }
    polarization = getattr(obj, "polarization", None)
    if polarization is not None:
        entry["polarization"] = rotation.apply(_last(polarization)).tolist()
    for name in _PARAMETERS:
        value = getattr(obj, name, None)
        if value is not None:
            entry[name] = np.asarray(value, dtype=float).tolist()
    return entry


def _overlapping(sources):
    """Pairs of cuboids that share volume: points well inside one of them,
    where another's polarization is not zero."""
    cuboids = [s for s in sources if isinstance(s, magpy.magnet.Cuboid)]
    grid = (np.indices((4, 4, 4)).reshape(3, -1).T + 0.5) / 4 - 0.5  # in -0.375..0.375
    pairs = []
    for i, cuboid in enumerate(cuboids):
        local = grid * 0.95 * np.asarray(cuboid.dimension, dtype=float)
        rotation = cuboid.orientation
        if not rotation.single:
            rotation = rotation[-1]
        points = rotation.apply(local) + np.asarray(_last(cuboid.position))
        for j, other in enumerate(cuboids):
            if j > i and np.any(np.linalg.norm(other.getJ(points), axis=-1) > 0):
                pairs.append([i, j])
    return pairs


def main(request_path, answer_path):
    request = json.loads(pathlib.Path(request_path).read_text(encoding="utf-8"))
    if request["kind"] == "plain":
        sources, sensors, document = _plain(
            request["path"], request.get("name", "design")
        )
    else:
        sources, sensors, document = _studio(request["path"], request.get("set"))
    answer = {
        "sources": [_describe(s) for s in sources],
        "sensors": [_describe(s) for s in sensors],
    }
    if document is not None:
        answer["document"] = document
    if request.get("points") is not None:
        points = np.asarray(request["points"], dtype=float).reshape(-1, 3)
        field = (
            magpy.getB(sources, points, sumup=True)
            if sources
            else np.zeros_like(points)
        )
        answer["B"] = np.asarray(field, dtype=float).reshape(-1, 3).tolist()
    if request.get("overlaps"):
        answer["overlaps"] = _overlapping(sources)
    pathlib.Path(answer_path).write_text(json.dumps(answer), encoding="utf-8")


if __name__ == "__main__":
    main(*sys.argv[1:3])
