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

import json
import math
import warnings

import magpylib as magpy
import numpy as np
from scipy.spatial.transform import Rotation

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


def _points(trace):
    """A trace's vertices as rows of x, y, z -- NaN where a line lifts its pen."""
    return np.stack([np.asarray(trace[a], dtype=float) for a in "xyz"], axis=1)


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
    position = _points(trace)
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
    position = _points(trace)
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


#: What a view draws, and what converts each kind -- in the order `_keyed`
#: lists them, meshes then scatters.
_CONVERT = {"mesh3d": _mesh_payload, "scatter3d": _scatter_payload}
_DRAWN = tuple(_CONVERT)

#: How far a vertex may sit from where a rigid motion puts it, and still be
#: that motion: a fraction of its own trace's size -- not the scene's, or a
#: millimetre magnet a kilometre out would be allowed to change by its own
#: size -- plus, for where it is, what rounding at that distance can do.
#: Frames are computed afresh from rotated vertices, so they agree with a
#: motion to rounding; anything that changes shape misses by a visible amount.
_RIGID_TOLERANCE = 1e-6
_ROUNDING = 1e-11

#: The keys a trace moves by; everything else about it has to hold still.
_WHERE = frozenset("xyz")

#: What `played_payload` tags a trace with before it is converted, and the
#: conversion carries over: the motion it follows, or the changes it goes
#: through.
_ROLES = ("track", "changes")

#: How much of a run's changing traces -- as JSON -- a view is handed along
#: with the scene, so that it plays with nothing to ask for: in a notebook
#: read without its kernel, a docs page, a saved view. Past this they are
#: served a frame at a time instead, as every frame of every trace once was.
#: Plotly carries its whole run in the figure; this carries only what poses
#: cannot say, which is usually a small part of it.
_CARRY_LIMIT: int = 5_000_000


def played_payload(scene):
    """`view_payload` for a run a view can play on its own -- with the motion
    and the changes it needs to -- or None when it cannot.

    Magpylib animates by drawing every frame again: every vertex of every
    trace, at every step. Most of that is repetition. A magnet on a path is,
    in each frame, its first-frame self turned and shifted, to rounding; a
    path line, the same line in every frame. Sent as poses, a run is a few
    kilobytes where the frames were megabytes. What poses cannot say -- a
    dimension that sweeps, pixels coloured by the field they pass through --
    is carried as it is, frame by frame, but only for the traces it concerns:
    a ring of magnets passing a field-coloured probe carries the probe.

    Which trace is which is not taken from what magpylib says about its
    objects but found in what it drew: each trace in each frame is fitted to
    its first-frame self. None when the frames do not hold the same traces to
    match up, or when what changes is more than `_CARRY_LIMIT`: the view then
    asks python for frames, as before.

    Adds, to what `view_payload(scene, 0)` holds: ``tracks``, each a pose per
    frame as ``[x, y, z, qx, qy, qz, qw]`` -- the move from the first frame,
    about the world's origin -- with, on each item that moves, ``track``, the
    index of its own; traces that move together share one. And ``changes``,
    each a changing trace's item at every frame, with, on the first frame's
    item, ``changes``, the index of its own. A run in which nothing drawn
    moves -- a current that ramps -- has empty ``tracks``, and still plays.
    """
    motion = run_motion(scene)
    if motion is None:
        return None
    tracks, track_of, changing = motion
    runs = _runs(scene)
    if changing and _weight(runs[n] for n in changing) > 2 * _CARRY_LIMIT:
        return None  # not worth converting to find out exactly
    role = {n: {"changes": c} for c, n in enumerate(changing)}
    role.update({n: {"track": t} for n, t in enumerate(track_of) if t is not None})
    # Tagged before they are converted, so each item carries its own role
    # whatever order the conversion lists them in.
    tagged = [trace | role.get(n, {}) for n, trace in enumerate(r[0] for r in runs)]
    payload = view_payload(scene, traces=tagged)
    payload["tracks"] = tracks
    if changing:
        payload["changes"] = [_keyed(runs[n]) for n in changing]
        if len(json.dumps(payload["changes"], allow_nan=False)) > _CARRY_LIMIT:
            return None
        _shared(payload)
    return payload


def _runs(scene):
    """Each drawn trace through the run: its dict in every frame, in order."""
    frames = [[t for t in f.traces if t["type"] in _DRAWN] for f in scene.frames]
    return [[traces[n] for traces in frames] for n in range(len(frames[0]))]


def _weight(runs):
    """Roughly what `runs` come to as JSON: coordinates are most of it, at
    about twenty characters a number, and a mesh's triangles the rest."""
    size = 0
    for run in runs:
        for trace in run:
            size += 60 * len(trace["x"]) + 15 * len(trace.get("i", ()))
    return size


def run_motion(scene):
    """Each drawn trace of `scene`'s run: still, moved rigidly, or changing.

    Returns ``(tracks, track_of, changing)``: the distinct motions, each a
    pose per frame; for each drawn trace of the first frame, the index of
    the motion it follows -- None for one that stays put, or that changes;
    and the traces that change, which no motion can play. None altogether
    when the frames do not hold the same traces, in the same order, to be
    matched up.

    Everything but the vertices is compared first, for every trace: that is
    cheaper than fitting, and it is where a trace that changes -- pixels that
    change colour -- is usually found out. The rest are fitted in one go,
    every frame at once.
    """
    frames = [[t for t in f.traces if t["type"] in _DRAWN] for f in scene.frames]
    layout = [(t["type"], t.get("object_id")) for t in frames[0]]
    for traces in frames[1:]:
        if [(t["type"], t.get("object_id")) for t in traces] != layout:
            return None
    runs = _runs(scene)
    firsts = [_points(run[0]) for run in runs]
    finite = [p[np.isfinite(p).all(axis=1)] for p in firsts]
    size = max((float(np.abs(p).max()) for p in finite if len(p)), default=0.0)
    # Poses to a billionth of the scene, whatever its unit: far below what
    # can be seen, and exact enough that traces moving together agree on
    # their motion and share one track.
    places = max(0, 9 - math.floor(math.log10(size or 1.0)))

    tracks, seen, track_of, changing = [], {}, [], []
    for n, run in enumerate(runs):
        fitted = None
        same_count = all(len(t["x"]) == len(run[0]["x"]) for t in run)
        if same_count and _unchanged(run):
            fitted = _fits(np.stack([_points(t) for t in run]))
        if fitted is None:
            track_of.append(None)
            changing.append(n)
            continue
        turn, shift, tolerance = fitted
        if np.abs(turn - np.eye(3)).max() <= 1e-9 and np.abs(shift).max() <= tolerance:
            track_of.append(None)
            continue
        # position, then quaternion x, y, z, w, as three.js composes one;
        # adding zero turns -0.0 into 0.0, which would keep two traces that
        # move as one from sharing a track
        track = (
            np.hstack(
                [
                    np.round(shift, places),
                    np.round(Rotation.from_matrix(turn).as_quat(), 9),
                ]
            )
            + 0.0
        )
        key = track.tobytes()
        if key not in seen:
            seen[key] = len(tracks)
            tracks.append(track.tolist())
        track_of.append(seen[key])
    return tracks, track_of, changing


def _unchanged(run):
    """Whether a trace, through the run, changes nothing but where its
    vertices are. Values are nearly always the very objects or exactly equal;
    a float array that is neither is allowed rounding."""
    first = run[0]
    if any(trace.keys() != first.keys() for trace in run):
        return False
    for key, value in first.items():
        if key in _WHERE:
            continue
        values = [trace[key] for trace in run]
        if all(v is value for v in values):
            continue
        arrays = [isinstance(v, np.ndarray) for v in values]
        if not any(arrays):
            if any(v != value for v in values):
                return False
            continue
        if not all(arrays) or any(v.shape != value.shape for v in values):
            return False
        stacked = np.stack(values)
        if np.array_equal(stacked, np.broadcast_to(value, stacked.shape)):
            continue
        if value.dtype.kind != "f" or not np.allclose(
            stacked, value, rtol=0, atol=1e-9, equal_nan=True
        ):
            return False
    return True


def _fits(stack):
    """The rigid motions taking a trace's first frame to each of its frames
    -- `stack` is frames by vertices by xyz -- or None if, in any frame, no
    rotation and shift puts every vertex where it is. Kabsch, every frame at
    once. Returns the turns, the shifts, and the tolerance they met.

    NaN separates the segments of a line, and has to separate the same ones
    in every frame. Fewer than three points in a line leave a turn about that
    line free; any of them fits, and any is right for what is drawn.
    """
    count = len(stack)
    gaps = ~np.isfinite(stack[0]).all(axis=1)
    if (~np.isfinite(stack).all(axis=2) != gaps).any():
        return None
    a, b = stack[0][~gaps], stack[:, ~gaps]
    if not len(a):
        return np.broadcast_to(np.eye(3), (count, 3, 3)), np.zeros((count, 3)), 0.0
    tolerance = _RIGID_TOLERANCE * float(np.ptp(a, axis=0).max()) + _ROUNDING * float(
        np.abs(a).max()
    )
    ca, cb = a.mean(axis=0), b.mean(axis=1)
    u, _, vt = np.linalg.svd((a - ca).T @ (b - cb[:, None]))  # (frames, 3, 3)
    v, ut = np.swapaxes(vt, 1, 2), np.swapaxes(u, 1, 2)
    flip = np.where(np.linalg.det(v @ ut) < 0, -1.0, 1.0)
    turn = (v * np.stack([np.ones(count), np.ones(count), flip], axis=1)[:, None]) @ ut
    shift = cb - turn @ ca
    moved = a @ np.swapaxes(turn, 1, 2) + shift[:, None]
    if np.abs(moved - b).max() > tolerance:
        return None
    return turn, shift, tolerance


def _by_kind(payload):
    """Converted traces, sorted into the two lists every payload carries --
    with their colour tables shared, see `_shared`."""
    return _shared(
        {
            "meshes": [p for p in payload if p["kind"] == "mesh"],
            "scatters": [p for p in payload if p["kind"] == "scatter"],
        }
    )


def _shared(payload):
    """`payload` with each distinct colour table once, in ``luts``, and each
    mesh naming its own by index -- the meshes of a run's ``changes`` too.

    A magnetization's colour table is the same for every magnet, and was
    copied into each one, in every frame: a third of what a run weighed.
    Tables already shared are left as they are, so this can be asked again
    of a payload that has gained items.
    """
    luts = payload.setdefault("luts", [])
    index = {tuple(lut): n for n, lut in enumerate(luts)}
    items = [
        *payload["meshes"],
        *(i for steps in payload.get("changes", ()) for i in steps),
    ]
    for item in items:
        lut = item.get("lut")
        if lut is None or isinstance(lut, int):
            continue
        key = tuple(lut)
        if key not in index:
            index[key] = len(luts)
            luts.append(lut)
        item["lut"] = index[key]
    return payload


def _keyed(traces, live=None, derived=None):
    """Traces converted, each under the id the view will address it by.

    With `live` -- the session's ``{studio id: object}`` map -- that is the
    studio id, for the reasons `scene_payload` gives. Without it there is
    nothing to key to, and magpylib's own ``id(obj)`` is kept, as a string:
    enough to hang one object's traces on one node, and no more. See
    `view_payload`.
    """
    payload = [
        _CONVERT[kind](t) | {role: t[role] for role in _ROLES if role in t}
        for kind in _DRAWN
        for t in traces
        if t["type"] == kind
    ]
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


def _given(objects):
    """The objects as passed, lists opened up and collections left whole."""
    for obj in objects:
        if isinstance(obj, list | tuple | set):
            yield from _given(obj)
        else:
            yield obj


def object_tree(objects):
    """The Collection hierarchy under `objects`, and every object in it by id:
    nodes of ``{id, label, kind, children}``, what a legend draws. Here
    rather than beside the widget that first needed it, because the studio's
    panel draws one too, and loading the widget loads ipywidgets.

    It has to come from the objects. The payload cannot carry it: every trace
    under a Collection is stamped with the *outermost* one's legendgroup, so
    three levels of nesting arrive looking like one.

    Each object appears once, where it sits in its collection. One that was
    passed and is also inside another that was passed is shown in its
    collection rather than a second time at the top.
    """
    given = list(_given(objects))
    inside = {id(child) for obj in given for child in getattr(obj, "children_all", ())}
    found = {}

    def node(obj):
        key = str(id(obj))
        found[key] = obj
        return {
            "id": key,
            "label": getattr(obj.style, "label", None) or type(obj).__name__,
            "kind": type(obj).__name__,
            "children": [node(child) for child in getattr(obj, "children", ())],
        }

    roots = [
        node(obj)
        for obj in given
        if id(obj) not in inside and str(id(obj)) not in found
    ]
    return roots, found


def widget_state(scene, height=420):
    """The notebook widget's saved state for `scene`, and its run: what
    `SceneWidget.write_html` puts in a page, made from the scene alone.

    For a view with no python behind it -- the studio's panel, drawing the
    figure a script left before it exited. The widget there plays what it
    is handed and asks for nothing, so a run too big to carry as changes
    travels whole, every frame, as a saved page carries it. The legend comes
    from the objects magpylib hands its backends, where it does.

    Returns ``{"state": ..., "run": [...]}``, the shape `_saved` has.
    """
    animated = len(scene.frames) > 1
    played = played_payload(scene) if animated else None
    objects = [obj for panel in scene.panels for obj in getattr(panel, "objects", ())]
    tree, _ = object_tree(objects)
    state = {
        "payload": played or view_payload(scene, index=0),
        "tree": tree,
        "selected": [],
        "hidden": [],
        "axes": True,
        "theme": "auto",
        "height": height,
        "frames": len(scene.frames),
        "duration": float(scene.animation.time),
        "repeat": bool(scene.animation.repeat),
        "camera": None,
        # no python behind it, so nothing to ask for an export
        "standalone": True,
    }
    run = []
    if animated and played is None:
        run = [frame_payload(scene, i) for i in range(len(scene.frames))]
    return {"state": state, "run": run}


def view_payload(scene, index=None, traces=None):
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
    once the view asks for them. `traces`, when given, are drawn instead of
    any frame's: the first frame's, tagged with their tracks, for
    `played_payload`.
    """
    panel = scene.panel(1, 1)
    if traces is None:
        frames = scene.frames if index is None else [scene.frames[_clamp(scene, index)]]
        traces = [t for frame in frames for t in frame.traces]
    return {
        **_by_kind(_keyed(traces)),
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
