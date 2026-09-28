"""Magpylib's display payload, converted for a scene-graph renderer.

The 3D view has been a Plotly figure re-rendered from Python on every edit.
That is fine for a chart and wrong for a scene: nothing in the browser is
addressable, so selecting, dragging or animating an object all mean asking
Python for a whole new figure.

This converts the same `Scene` magpylib hands a display backend into buffers a
three.js scene can be built from once and then *mutated* -- one mesh per
object, keyed by `object_id`.

Three things make that possible, each learned the hard way in the prototype
this is ported from (magpylib `feat/threejs-backend-prototype`, findings 1, 9
and 10):

* The geometry must depend on the objects alone, not on the scene as a whole.
  Magpylib scales sensors and dipoles to the scene extent and picks an SI
  prefix from it, so with the defaults an unrelated object moving changes
  everyone's vertices. `pin_scene_units` fixes both.
* A trace's colour arrives one of three mutually exclusive ways, and two of
  them are traps -- see `_mesh_payload`.
* The payload carries no transform, so a mesh has no origin to be rotated
  about. The session knows the objects and supplies them as anchors.
"""

from __future__ import annotations

import math
import warnings

import magpylib as magpy
import numpy as np

try:
    from magpylib.graphics.backend import DisplayBackend
except ImportError:  # pragma: no cover - depends on the magpylib installed
    try:
        # For magpylib 5.2.3 and the unreleased builds before magpylib#978,
        # where the public path was not importable from an entry point -- the
        # one place magpylib documents for shipping a backend. Discovery ran
        # from inside `defaults_classes` while magpylib was still importing,
        # and `magpylib.graphics.__init__` pulls the style and display stack,
        # which came back round to `default_settings` before it was bound:
        #
        #   ImportError: cannot import name 'default_settings' from partially
        #   initialized module magpylib._src.defaults.defaults_classes
        #
        # Discovery now waits for the import to finish, so the public path
        # above is the one taken. This stays while ">=5.2" is supported.
        # `_src.display.api` is where the public path re-exports from, and
        # `backend_registry` has already imported it by then, so it is there.
        from magpylib._src.display.api import DisplayBackend
    except ImportError:
        #: The display-backend API landed in magpylib after 5.2.3, and this
        #: module is the only thing here that needs it. Everything else the
        #: studio does works with the released version, so this is not a hard
        #: dependency: without it the scene graph is unavailable and the view
        #: draws the Plotly figure, which is what it drew before any of this
        #: existed.
        DisplayBackend = None

#: Magpylib's `line_width` and `marker_size` are nominal: every backend scales
#: them into its own units, and nothing in the contract says what a width of 2
#: should look like. These are Plotly's own factors, which transfer because
#: `Line2` and `PointsMaterial(sizeAttenuation=false)` also measure in pixels.
SIZE_FACTORS = {"line_width": 2.2, "marker_size": 0.7}

LUT_SIZE = 256

_BACKEND = "_studio_scene"

#: Classes whose mesh is *exactly* the base mesh scaled, so a resize can be
#: dragged with `node.scale` and the engine told only the value it came to.
#: Ported from the prototype, where every entry was checked by rendering twice
#: and comparing vertices.
#:
#: `constraint` records which scale axes are independent, which follows from
#: how many numbers the parameter has: a Cylinder's `dimension` is
#: (diameter, height), so x and y are locked together and z is free.
#:
#: A mesh has no dimension, but its vertices scale exactly -- checked the same
#: way -- so the parameter dragged there is the whole array, multiplied
#: row by row. Only while it is small enough to be worth sending: the array
#: rides in every payload, and a mesh of thousands of points is a lot of
#: numbers to ship on the chance that someone resizes it. Those keep the
#: Inspector, which edits the value in place.
#:
#: Excluded, and why:
#:  * `CylinderSegment` -- its angles do not scale with its radii.
#:  * `Sensor` -- a composite. Its pixels sit at real coordinates while the
#:    cross is styled, so `style.size` scales only part of the mesh.
#:
#: A Dipole has no physical size at all: its arrow is styled geometry and
#: `style.size` is one scalar, so the resize is uniform by construction. That
#: holds only under `sizemode="absolute"`, which `pin_scene_units` sets.
SCALE_COVARIANT = {
    "Cuboid": ("dimension", "free"),
    "Sphere": ("diameter", "uniform"),
    "Cylinder": ("dimension", "xy"),
    "Dipole": ("style.size", "uniform"),
    "Tetrahedron": ("vertices", "vertices"),
    "TriangularMesh": ("vertices", "vertices"),
}

#: Above this many points a mesh keeps its vertices to itself; see above.
MAX_DRAGGABLE_VERTICES = 256

#: And above this many frames a path is not carried either. A drag has to
#: move the whole path or it replaces it -- a single position where a path
#: was is magpylib deleting the path -- so the frames have to come along.
MAX_DRAGGABLE_PATH = 1024


def _resolve(obj, path):
    """Read a dotted attribute path, falling back to the library default.

    An unset style property reads as `None` on the object and only takes its
    value from `magpy.defaults.display.style.<family>` when the figure is
    drawn. `merged()` does not help: it resolves set-vs-inherited *within* the
    object's own tree, so `Dipole().style.merged().size` is still `None` while
    the effective size is 1.
    """
    value = obj
    for part in path.split("."):
        value = getattr(value, part)
    if value is None and path.startswith("style."):
        node = magpy.defaults.display.style
        for part in (type(obj).__name__.lower(), *path.split(".")[1:]):
            node = getattr(node, part)
        value = node
    return value


def shape_of(obj):
    """The scale-covariant shape parameter of `obj`, or None if it has none."""
    entry = SCALE_COVARIANT.get(type(obj).__name__)
    if entry is None:
        return None
    attr, constraint = entry
    value = _resolve(obj, attr)
    if constraint == "vertices" and len(value) > MAX_DRAGGABLE_VERTICES:
        return None
    return {
        "attr": attr,
        "value": value.tolist() if hasattr(value, "tolist") else float(value),
        "constraint": constraint,
    }


def pin_scene_units():
    """Make the emitted geometry depend on the objects, not on the scene.

    Without this a scene-graph view cannot be kept between edits: moving one
    object changes the extent, which rescales every autosized object and can
    shift the SI prefix that scales *everything*. Measured in the prototype: a
    magnet's own vertices changed by 1000x because an unrelated object moved.
    """
    if not available():
        raise RuntimeError(UNAVAILABLE)
    magpy.defaults.display.units.length = "m"
    magpy.defaults.display.style.sensor.sizemode = "absolute"
    magpy.defaults.display.style.dipole.sizemode = "absolute"


def _hex_to_rgb(color):
    """'#rrggbb' -> (r, g, b) floats in 0..1."""
    color = color.lstrip("#")
    return tuple(int(color[i : i + 2], 16) / 255 for i in (0, 2, 4))


def _colorscale_lut(colorscale):
    """A Magpylib colorscale as a flat RGBA lookup table.

    The scale is *piecewise* -- the tricolor default holds green to 0.16, grey
    from 0.26 to 0.74, then red -- so it cannot be sampled per vertex. A Cuboid
    has eight vertices whose intensities are all 0 or 1, so none of them lands
    on the grey plateau and interpolating their colours gives a flat green-red
    ramp with no grey at all. What is interpolated across a face has to be the
    *intensity*, with the colour looked up per fragment: hence a texture,
    indexed by an intensity-valued UV. Plotly's shader does the same.
    """
    stops = np.array([s for s, _ in colorscale], dtype=float)
    colors = np.array([_hex_to_rgb(c) for _, c in colorscale], dtype=float)
    samples = np.linspace(0.0, 1.0, LUT_SIZE)
    lut = np.stack(
        [np.interp(samples, stops, colors[:, channel]) for channel in range(3)]
        # RGBA: three.js dropped RGBFormat in r137
        + [np.ones_like(samples)],
        axis=1,
    )
    return np.round(lut * 255).astype(int).ravel().tolist()


def _mesh_payload(trace):
    """One `mesh3d` trace as buffers.

    Colour arrives one of three mutually exclusive ways, and only the first is
    what it looks like:

    * a flat ``color``;
    * ``intensity`` per vertex with a ``colorscale`` -- see `_colorscale_lut`;
    * ``facecolor``, one colour per triangle, used where a single object needs
      several. A Sensor is one trace of 216 face colours: its arrow bodies, its
      red/green/blue axis heads and its black pixels. **Such a trace has
      ``color = None``**, so reading only ``color`` draws it as a uniform blob
      without erroring. Rendering it means giving up the index buffer.
    """
    position = np.stack([np.asarray(trace[a], dtype=float) for a in "xyz"], axis=1)
    index = np.stack([np.asarray(trace[a], dtype=int) for a in ("i", "j", "k")], axis=1)
    intensity = trace.get("intensity")
    colorscale = trace.get("colorscale")
    graded = intensity is not None and colorscale is not None
    facecolor = trace.get("facecolor")

    uv = None
    if graded:
        intensity = np.clip(np.asarray(intensity, dtype=float), 0, 1)
        uv = np.stack([intensity, np.full(len(position), 0.5)], axis=1)

    return {
        "kind": "mesh",
        "name": trace.get("name") or "",
        "object_id": trace.get("object_id"),
        "opacity": float(trace.get("opacity", 1) or 1),
        "position": _json_coordinates(position),
        "index": index.ravel().tolist(),
        "color": trace.get("color"),
        "uv": None if uv is None else uv.ravel().tolist(),
        "lut": _colorscale_lut(colorscale) if graded else None,
        # mixes CSS names with hex, so THREE.Color parses them rather than us
        "facecolor": None if facecolor is None else [str(c) for c in facecolor],
    }


def _json_coordinates(values):
    """A coordinate run as JSON can actually carry it.

    Magpylib separates the segments of a trace with NaN -- plotly's way of
    lifting the pen between, say, the arrows along a current path. NaN is not
    JSON: `json.dumps` writes a bare `NaN` token, which strict parsers reject,
    `JSON.parse` among them. The extension's reader then drops the whole
    response *and never resolves the request that asked for it*, so the 3D
    view of any scene holding such a trace stayed empty with nothing said --
    the helical winding, 120 separators in 540 points, was exactly that.

    `null` is what JSON has for a value that is not one, and the view puts the
    NaN back when it fills the buffer. Applied to meshes too, where a NaN
    would be a bug rather than a pen-lift: the cost when there is none to find
    is one pass, and the alternative is the same silent empty view.
    """
    flat = np.asarray(values, dtype=float).ravel()
    if not np.isnan(flat).any():  # the usual case, and the cheap one
        return flat.tolist()
    return [None if value != value else value for value in flat.tolist()]


def _scatter_payload(trace):
    """One `scatter3d` trace: currents, paths and `show(markers=...)`.

    ``mode`` is a combination rather than an enum -- "markers+text+lines"
    occurs -- so it is split into tokens.
    """
    position = np.stack([np.asarray(trace[a], dtype=float) for a in "xyz"], axis=1)
    modes = set(str(trace.get("mode") or "lines").split("+"))
    return {
        "kind": "scatter",
        "name": trace.get("name") or "",
        "object_id": trace.get("object_id"),
        "opacity": float(trace.get("opacity", 1) or 1),
        "position": _json_coordinates(position),
        "lines": "lines" in modes,
        "markers": "markers" in modes,
        "line_color": trace.get("line_color") or "#2e91e5",
        "line_width": float(trace.get("line_width") or 1) * SIZE_FACTORS["line_width"],
        "marker_color": trace.get("marker_color") or "#2e91e5",
        "marker_size": float(trace.get("marker_size") or 3)
        * SIZE_FACTORS["marker_size"],
    }


#: What to say when the installed magpylib cannot do this, once, in the words
#: of the thing to do about it.
UNAVAILABLE = (
    "The scene graph needs magpylib's display-backend API, which is newer "
    "than the installed magpylib. Draw with the chart instead, or install "
    "magpylib from git."
)


def available():
    """Whether the installed magpylib can do what the scene graph needs.

    Two things, both newer than 5.2.3 and both from the same magpylib
    release: a backend can be registered and handed a `Scene`, and the length
    unit the scene is drawn in can be pinned. Without the second the geometry
    follows the scene extent rather than the objects, which is the thing a
    kept scene graph cannot survive -- so it is as much a requirement as the
    first, and checked here rather than failing later inside a redraw.
    """
    return DisplayBackend is not None and hasattr(magpy.defaults.display, "units")


#: Where the capture backend below leaves the scene it was handed, for
#: `_capture` to read back. Module level so that the backend can be an
#: ordinary registered class: a closure over a per-call dict would have to be
#: swapped into it on every call.
_captured = {}

if DisplayBackend is None:  # pragma: no cover - depends on magpylib
    SceneGraphBackend = None
else:

    class SceneGraphBackend(DisplayBackend):
        """What a three.js view of a magpylib scene can draw, declared once.

        The panel, the notebook widget and the capture below are all the one
        renderer, so they can all draw the same things. Nameless, so it
        registers nothing itself: magpylib registers the subclasses that
        name themselves.
        """

        #: three.js interpolates vertex colours, so the gradient arrives whole
        #: rather than sliced into one mesh per colour band.
        supports_colorgradient = True
        #: One mesh per object, so each object's traces hang on one node and
        #: highlight together -- and a click lands on an object, not a band.
        merge_traces = False
        handles_traces = frozenset({"mesh3d", "scatter3d"})
        #: Pinned, not inherited. Inheriting takes whatever the installed
        #: magpylib emits, so the two can never disagree and the mismatch
        #: warning this exists for could never fire. This is the version the
        #: payload was written against; raise it when it has been checked.
        api_version = 1
        supports_subplots = False

    class _CaptureBackend(SceneGraphBackend):
        """Hands the scene back instead of drawing it. See `_capture`."""

        name = _BACKEND
        description = "Magpylib Studio — captures a scene for its own views"
        supports_animation = True
        accepts_options = frozenset()

        def show(self, scene):
            # `setdefault`: a backend called twice for one figure yields the
            # first scene rather than the last.
            return _captured.setdefault("scene", scene)

    # Out of magpylib's registry until a capture needs it. Registered, its
    # internal name was offered to users as a backend to choose -- in the
    # list magpylib gives when one cannot animate -- which it is not.
    _CAPTURE = DisplayBackend.backends.pop(_BACKEND)


def _capture(objects, animation=False, *, on_behalf_of="widget", **kwargs):
    """The `Scene` magpylib would hand a display backend, for `objects`.

    With `animation`, that scene carries one frame per step of the longest
    path, each holding the whole scene *as computed at that step* -- which is
    the only way to get what a pose cannot express: a shape that changes
    along its path, or pixels coloured by the field they pass through.

    Taken out of `_captured` as it is read, not left there: a scene holds
    every trace of every frame, and -- where magpylib hands its backends the
    objects -- the objects themselves, which a module-level reference would
    keep alive until the next capture.

    What magpylib warns about along the way -- an unexpected keyword, say --
    is said again in the name of the backend the capture is `on_behalf_of`:
    the user asked for a widget, and has never heard of this one.
    """
    # `available()` says as much; saying it again is what tells a type checker
    # that the display-backend API is there to register with.
    if not available() or DisplayBackend is None:
        raise RuntimeError(UNAVAILABLE)
    _captured.clear()
    DisplayBackend.backends[_BACKEND] = _CAPTURE
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            magpy.show(
                objects,
                backend=_BACKEND,
                return_fig=True,
                animation=animation,
                **kwargs,
            )
    finally:
        DisplayBackend.backends.pop(_BACKEND, None)
    for warning in caught:
        warnings.warn(
            str(warning.message).replace(_BACKEND, on_behalf_of),
            warning.category,
            stacklevel=3,
        )
    return _captured.pop("scene")


def capture_frames(objects, steps):
    """Every step of the scene's paths, computed. Kept by the session and
    served a frame at a time: the whole run is megabytes, and one frame is
    the only part anyone is looking at.

    `animation=True` alone does not give every step. Magpylib is composing a
    film: `time` x `fps` is the frame budget, so with the defaults a 250-step
    path arrives as 99 frames. That is the right answer for a film and the
    wrong one for a scrubber, which has to be able to stop on any step -- the
    steps *are* the path, each one a pose someone asked for. So the budget is
    raised to the length of the path, and the whole run is kept.

    `animation.time` is untouched by that, and it is not a frame count: it is
    how long the animation lasts, five seconds by default. The view paces its
    playback to it and drops frames it cannot keep up with, which is what
    keeps a 600-step path taking the same five seconds as a 25-step one.

    Beyond `MAX_DRAGGABLE_PATH` magpylib subsamples as it sees fit, and the
    view is told how many frames it actually got.
    """
    steps = max(2, min(int(steps), MAX_DRAGGABLE_PATH))
    return _capture(
        objects,
        animation=True,
        on_behalf_of="studio",
        # the budget is min(time x fps, maxframes); both have to clear the path
        animation_fps=math.ceil(steps / magpy.defaults.display.animation.time),
        animation_maxfps=math.ceil(steps / magpy.defaults.display.animation.time),
        animation_maxframes=steps,
    )


def frame_payload(scene, index, live=None, derived=None):
    """One frame of a captured run, in the shape `renderFrame` takes.

    Only what is drawn: the poses, shapes, paths, ranges and axes a view needs
    are the same from frame to frame, and it already has them. `live` and
    `derived` key the traces as `scene_payload` does; without them they keep
    magpylib's own addresses, as `view_payload` does -- see `_keyed`.
    """
    index = _clamp(scene, index)
    return {
        "frame": index,
        "frames": len(scene.frames),
        # how long the whole run should take, which is what the view paces to
        "duration": scene.animation.time,
        **_by_kind(_keyed(scene.frames[index].traces, live, derived)),
    }


def _clamp(scene, index):
    """`index` as a frame the scene has."""
    return max(0, min(int(index), len(scene.frames) - 1))


#: The trace types a view draws -- what `_keyed` converts, in its order.
_DRAWN = ("mesh3d", "scatter3d")

#: How far a vertex may sit from where a rigid motion puts it, as a fraction
#: of the scene's size, and still be that motion. Frames are computed afresh
#: from rotated vertices, so they agree with a motion to rounding -- 1e-15,
#: measured -- and anything that changes shape misses by a visible amount.
_RIGID_TOLERANCE = 1e-6


def played_payload(scene):
    """`view_payload` for a run that is its first frame moved about -- with
    the motion, so a view can play it with nothing to ask for -- or None.

    Magpylib animates by drawing every frame again: every vertex of every
    trace, at every step. For a magnet on a path, each of those frames is the
    first one turned and shifted, to rounding. Sent as poses instead, a run is
    a few kilobytes where the frames were megabytes, and it plays where there
    is no python to serve frames: a docs page, a notebook read without its
    kernel, a saved view.

    Whether a run is that is not taken from what magpylib says about its
    objects but found in what it drew: each trace in each frame is fitted to
    its first-frame self. A shape that changes along its path -- a dimension
    that sweeps -- fails the fit, and so does a trace whose colours change;
    either way the run is not motion, and this answers None. The view then
    asks for frames, as before.

    Adds, to what `view_payload(scene, 0)` holds: ``tracks``, each a pose per
    frame as ``[x, y, z, qx, qy, qz, qw]`` -- the move from the first frame,
    about the world's origin -- and on each item that moves, ``track``, the
    index of its own. Traces that move together share one.
    """
    motion = rigid_motion(scene)
    if motion is None:
        return None
    tracks, track_of = motion
    payload = view_payload(scene, index=0)
    # Meshes then scatters, each in the order the frame holds them: the
    # order `_keyed` converts them in, and the order `track_of` follows.
    items = {"mesh3d": iter(payload["meshes"]), "scatter3d": iter(payload["scatters"])}
    kinds = [t["type"] for t in scene.frames[0].traces if t["type"] in _DRAWN]
    for kind, track in zip(kinds, track_of, strict=True):
        item = next(items[kind])
        if track is not None:
            item["track"] = track
    payload["tracks"] = tracks
    return payload


def rigid_motion(scene):
    """Each drawn trace of `scene`'s run as a rigid motion of its first frame.

    Returns ``(tracks, track_of)``: the distinct motions, each a pose per
    frame, and for each drawn trace of the first frame, the index of its
    motion -- None for one that stays put. None altogether when any trace
    does something a motion cannot: changes shape, colour or anything else,
    or is not there in every frame.
    """
    frames = [[t for t in f.traces if t["type"] in _DRAWN] for f in scene.frames]
    first = frames[0]
    layout = [(t["type"], t.get("object_id"), len(t["x"])) for t in first]
    for traces in frames[1:]:
        if [(t["type"], t.get("object_id"), len(t["x"])) for t in traces] != layout:
            return None
    points = [_points(t) for t in first]
    finite = [p[np.isfinite(p).all(axis=1)] for p in points]
    size = max((float(np.abs(p).max()) for p in finite if len(p)), default=0.0)
    size = size or 1.0
    tolerance = _RIGID_TOLERANCE * size
    # Poses to a billionth of the scene, whatever its unit: far below what
    # can be seen, and exact enough that traces moving together agree on
    # their motion and share one track.
    places = max(0, 9 - math.floor(math.log10(size)))

    tracks, seen, track_of = [], {}, []
    for n, trace in enumerate(first):
        poses = []
        for traces in frames:
            if not _alike(trace, traces[n]):
                return None
            pose = _fit(points[n], _points(traces[n]), tolerance)
            if pose is None:
                return None
            poses.append(pose)
        if all(_still(pose, tolerance) for pose in poses):
            track_of.append(None)
            continue
        track = [_pose_list(pose, places) for pose in poses]
        key = str(track)
        if key not in seen:
            seen[key] = len(tracks)
            tracks.append(track)
        track_of.append(seen[key])
    return tracks, track_of


def _points(trace):
    return np.stack([np.asarray(trace[a], dtype=float) for a in "xyz"], axis=1)


def _alike(a, b):
    """Whether two traces differ in nothing but where their vertices are."""
    if a.keys() != b.keys():
        return False
    for key in a:
        if key in ("x", "y", "z"):
            continue
        x, y = a[key], b[key]
        if isinstance(x, np.ndarray | list | tuple) or isinstance(
            y, np.ndarray | list | tuple
        ):
            x, y = np.asarray(x), np.asarray(y)
            if x.shape != y.shape:
                return False
            if x.dtype.kind == "f" and y.dtype.kind == "f":
                if not np.allclose(x, y, rtol=0, atol=1e-9, equal_nan=True):
                    return False
            elif not np.array_equal(x, y):
                return False
        elif x != y:
            return False
    return True


def _fit(a, b, tolerance):
    """The rigid motion taking points `a` to `b` -- Kabsch -- or None if no
    rotation and shift puts every one of them within `tolerance`.

    NaN separates the segments of a line, and has to separate the same ones
    in both. Fewer than three points in a line leave a turn about that line
    free; any of them fits, and any is right for what is drawn.
    """
    gaps = ~np.isfinite(a).all(axis=1)
    if not np.array_equal(gaps, ~np.isfinite(b).all(axis=1)):
        return None
    a, b = a[~gaps], b[~gaps]
    if not len(a):
        return np.eye(3), np.zeros(3)
    ca, cb = a.mean(axis=0), b.mean(axis=0)
    u, _, vt = np.linalg.svd((a - ca).T @ (b - cb))
    flip = np.sign(np.linalg.det(vt.T @ u.T)) or 1.0
    turn = vt.T @ np.diag([1.0, 1.0, flip]) @ u.T
    shift = cb - turn @ ca
    if np.abs(a @ turn.T + shift - b).max() > tolerance:
        return None
    return turn, shift


def _still(pose, tolerance):
    turn, shift = pose
    return np.allclose(turn, np.eye(3), atol=1e-9) and np.abs(shift).max() <= tolerance


def _pose_list(pose, places):
    """A pose as three.js composes one: position, then quaternion x, y, z, w.
    The position to `places` decimals, the quaternion -- unit length -- to
    nine. Adding zero turns -0.0 into 0.0, which would otherwise keep two
    traces that move as one from sharing a track."""
    turn, shift = pose
    return [round(float(v), places) + 0.0 for v in shift] + [
        round(float(v), 9) + 0.0 for v in _quaternion(turn)
    ]


def _quaternion(turn):
    """A rotation matrix as a unit quaternion ``(x, y, z, w)``."""
    trace = np.trace(turn)
    if trace > 0:
        s = 2.0 * math.sqrt(trace + 1.0)
        w = 0.25 * s
        x = (turn[2, 1] - turn[1, 2]) / s
        y = (turn[0, 2] - turn[2, 0]) / s
        z = (turn[1, 0] - turn[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(turn)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = 2.0 * math.sqrt(1.0 + turn[i, i] - turn[j, j] - turn[k, k])
        q = [0.0, 0.0, 0.0]
        q[i] = 0.25 * s
        q[j] = (turn[j, i] + turn[i, j]) / s
        q[k] = (turn[k, i] + turn[i, k]) / s
        w = (turn[k, j] - turn[j, k]) / s
        x, y, z = q
    return x, y, z, w


def _by_kind(payload):
    """Converted traces, sorted into the two lists every payload carries."""
    return {
        "meshes": [p for p in payload if p["kind"] == "mesh"],
        "scatters": [p for p in payload if p["kind"] == "scatter"],
    }


def _keyed(traces, live=None, derived=None):
    """Traces converted, each under the id the view will address it by.

    With `live` -- the session's ``{studio id: object}`` map -- that is the
    studio id, for the reasons `scene_payload` gives. Without it there is
    nothing to key to, and magpylib's own ``id(obj)`` is kept, as a string:
    enough to hang one object's traces on one node, and no more. See
    `view_payload`.
    """
    payload = [_mesh_payload(t) for t in traces if t["type"] == "mesh3d"]
    payload += [_scatter_payload(t) for t in traces if t["type"] == "scatter3d"]
    if live is None:
        for item in payload:
            item["object_id"] = str(item["object_id"])
        return payload
    derived = derived or {}
    studio_id = {id(obj): key for key, obj in live.items()}
    source_of = {copy: src for src, copies in derived.items() for copy in copies}
    holding = {
        id(child): key
        for key, obj in sorted(
            live.items(), key=lambda kv: -len(getattr(kv[1], "children_all", ()))
        )
        for child in getattr(obj, "children_all", ())
    }
    for item in payload:
        raw = item["object_id"]
        key = studio_id.get(raw) or holding.get(raw)
        item["object_id"] = source_of.get(key, key)
    return payload


def view_payload(scene, index=None):
    """Everything a three.js view needs for a scene nobody is editing.

    `scene_payload` below is for the studio, where the engine owns the objects:
    it re-keys traces onto studio ids and works out the poses a gizmo turns
    about. A script owns its own objects and then exits, so there is nothing to
    key to and nothing to drag. What is left is the picture, plus enough
    identity to hang one object's several traces on one node — a current draws
    its loop and its arrows separately, and they should highlight as one thing.

    That identity is magpylib's own `id(obj)`, a CPython address. It is valid
    for exactly as long as this payload is, which is the point: by the time the
    panel draws it, the process that owned those objects has usually gone. It
    is not an id to send anywhere expecting it to still mean something.

    Takes the `Scene` a display backend is handed, rather than the objects,
    because that is all a backend gets. The poses `scene_payload` reads off the
    objects are the ones a read-only view has no use for.

    `index` picks one frame of an animated scene. Without it every frame is
    drawn at once, which is right for the static case -- one frame -- and a
    smear of two hundred poses for a run. `frame_payload` carries the others,
    once the view asks for them.
    """
    panel = scene.panel(1, 1)
    frames = scene.frames if index is None else [scene.frames[_clamp(scene, index)]]
    return {
        **_by_kind(_keyed([t for frame in frames for t in frame.traces])),
        "ranges": None if panel.ranges is None else panel.ranges.tolist(),
        "labels": panel.labels,
        # The studio's view carries these; this one has no gizmo to place, no
        # shape to resize, no polarization to aim and no path to scrub. The
        # renderer reads each as empty and skips all four.
        "centroids": {},
        "anchors": {},
        "orientations": {},
        "paths": {},
        "shapes": {},
        "polarizations": {},
        "patterned": [],
    }


def scene_payload(objects, live=None, derived=None):
    """Everything a three.js view needs to build the scene once.

    `live` is the session's ``{studio id: magpylib object}`` map, and
    `derived` its ``{source id: copy ids}`` one. Three things depend on them,
    and all three are why they are parameters rather than something this
    module could work out for itself:

    * **The ids.** Magpylib stamps each trace with ``id(obj)``, which is a
      CPython address: it is stable only until the next rebuild, and studio
      rebuilds the whole scene from the document on every edit. Traces are
      therefore re-keyed to studio's own ids, which survive rebuilds and are
      what `move`, `rotate`, `apply_edit` and `set_visible` already take. A
      picked mesh then names an object the existing protocol understands, with
      no new methods and no second identity scheme.
    * **The poses.** The payload carries no transform, so a mesh arrives with
      an identity matrix and a gizmo attached to it lands at the world origin.
      The only alternative is the bounding-box centre, which is wrong for
      anything whose origin is not its centroid -- 0.678 off for a Sensor,
      measured. The object knows; the picture does not. `anchors` gives each
      object its own origin to turn about, and `orientations` the rotation
      already baked into its vertices -- which is what lets a drag report the
      pose it reached rather than the turn it made, and so be recorded as one
      construction step however many frames it took.
    * **The copies.** A pattern's copies are drawn, and they live in `live`
      under ids like ``r2#1``, but no spec was ever recorded for them: asking
      the engine to rotate one raises ``unknown object id``. They are re-keyed
      to the source that generated them, which keeps every id in this payload
      one the protocol accepts, and draws a patterned ring as the single
      object it is meant to read as.

    `patterned` names the sources that have copies. An edit to one of those
    lands at the end of the event log, after the duplication that made the
    copies, so the source moves and the copies stay where they were. A view
    that offers drag handles has to know not to offer them there.
    """
    scene = _capture(objects, on_behalf_of="studio")
    panel = scene.panel(1, 1)
    traces = [t for frame in scene.frames for t in frame.traces]

    live = live or {}
    derived = derived or {}
    source_of = {copy: src for src, copies in derived.items() for copy in copies}
    anchors, centroids, orientations, shapes, polarizations = {}, {}, {}, {}, {}
    paths = {}
    for key, obj in live.items():
        if key in source_of:
            continue  # a copy is drawn on its source's node
        anchors[key] = np.atleast_2d(np.asarray(obj.position, dtype=float))[-1].tolist()
        # Where the object *looks* like it is, which is not always where it
        # is: a Tetrahedron's position is the origin its vertices are written
        # against, and handles drawn there float off the corner of the shape.
        # The two agree for everything that is centred on its own position.
        centroid = getattr(obj, "centroid", None)
        centroids[key] = (
            anchors[key]
            if centroid is None
            else np.atleast_2d(np.asarray(centroid, dtype=float))[-1].tolist()
        )
        orientations[key] = np.atleast_2d(obj.orientation.as_rotvec(degrees=True))[
            -1
        ].tolist()
        # The whole path, when there is one. A drag reports the pose it
        # reached, and reporting one pose for an object that has a path is
        # magpylib being told the path is now a single point -- which is how
        # dragging a sensor used to make its track disappear.
        frames = np.atleast_2d(np.asarray(obj.position, dtype=float))
        turns = np.atleast_2d(obj.orientation.as_rotvec(degrees=True))
        if 1 < len(frames) <= MAX_DRAGGABLE_PATH:
            paths[key] = {
                "position": frames.tolist(),
                "orientation": turns.tolist(),
            }

        shape = shape_of(obj)
        if shape is not None:
            shapes[key] = shape
        # In the object's own frame, which is how magpylib stores it. The
        # rendered colour is the vertex projected on the *world* vector, so
        # reading this as world-space is wrong by the object's orientation --
        # 0.44 out at 50 degrees, measured in the prototype.
        polarization = getattr(obj, "polarization", None)
        if polarization is not None:
            polarizations[key] = np.asarray(polarization, dtype=float).tolist()

    return {
        **_by_kind(_keyed(traces, live, derived)),
        "ranges": None if panel.ranges is None else panel.ranges.tolist(),
        "labels": panel.labels,
        "anchors": anchors,
        "centroids": centroids,
        "orientations": orientations,
        "paths": paths,
        "shapes": shapes,
        "polarizations": polarizations,
        "patterned": sorted(derived),
    }
