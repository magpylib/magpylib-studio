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
  everyone's vertices. `pinned_scene_units` fixes both, for the drawing's
  duration.
* A trace's colour arrives one of three mutually exclusive ways, and two of
  them are traps -- see `_mesh_payload`.
* The payload carries no transform, so a mesh has no origin to be rotated
  about. The session knows the objects and supplies them as anchors.
"""

from __future__ import annotations

import contextlib
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
#: holds only under `sizemode="absolute"`, which the studio draws under
#: (`pinned_scene_units`); `shape_of` is read while it draws.
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


#: How big a sensor, or a dipole, is drawn when its style says no size, in
#: metres: the size of a real Hall probe package. The studio draws them at
#: their stated size (`pinned_scene_units`), and magpylib's default size of 1
#: would then be one metre of glyph over assemblies measured in millimetres.
#: A size the style does say is kept, as it is.
SENSOR_SIZE = 0.005


@contextlib.contextmanager
def pinned_scene_units():
    """Draw with the geometry depending on the objects, not on the scene.

    Without this a scene-graph view cannot be kept between edits: moving one
    object changes the extent, which rescales every autosized object and can
    shift the SI prefix that scales *everything*. Measured in the prototype: a
    magnet's own vertices changed by 1000x because an unrelated object moved.

    A context, not a setting: magpylib's defaults are put back on the way
    out, so a notebook's own `magpy.show()` after the studio has drawn is as
    it was -- it used to find every bare sensor a metre across.
    """
    if not available():
        raise RuntimeError(UNAVAILABLE)
    display = magpy.defaults.display
    sensor, dipole = display.style.sensor, display.style.dipole
    was = (
        display.units.length,
        sensor.sizemode,
        sensor.size,
        dipole.sizemode,
        dipole.size,
    )
    display.units.length = "m"
    sensor.sizemode = dipole.sizemode = "absolute"
    sensor.size = dipole.size = SENSOR_SIZE
    try:
        yield
    finally:
        (
            display.units.length,
            sensor.sizemode,
            sensor.size,
            dipole.sizemode,
            dipole.size,
        ) = was


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


def _one_color(value, default="#2e91e5"):
    """A trace's colour, one for the whole trace: magpylib gives a sensor's
    2D pixel arrows a colour per point, and the view draws a scatter in one.
    The most common of them, then."""
    if value is None:
        return default
    if isinstance(value, str):
        return value or default
    if isinstance(value, np.ndarray | list | tuple):
        colors = [str(c) for c in np.asarray(value).ravel().tolist() if c]
        if not colors:
            return default
        return max(set(colors), key=colors.count)
    return str(value) or default


def _one_size(value, default):
    """A trace's width or size, one for the whole trace: the largest, where
    magpylib gives one per point."""
    if value is None:
        return float(default)
    if isinstance(value, np.ndarray | list | tuple):
        sizes = np.asarray(value, dtype=float).ravel()
        return float(np.nanmax(sizes)) if len(sizes) else float(default)
    return float(value or default)


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
        "line_color": _one_color(trace.get("line_color")),
        "line_width": _one_size(trace.get("line_width"), 1)
        * SIZE_FACTORS["line_width"],
        "marker_color": _one_color(trace.get("marker_color")),
        "marker_size": _one_size(trace.get("marker_size"), 3)
        * SIZE_FACTORS["marker_size"],
        # an object's path, not the object: see `_mark_paths`
        **({"path": True} if trace.get("path") else {}),
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
    # While a script is being opened in the studio, show() is a stand-in that
    # captures the script's own calls; the one it replaced still draws.
    show = getattr(magpy.show, "original", magpy.show)
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            show(
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
    if "scene" not in _captured:
        raise RuntimeError(
            "magpylib did not hand the scene to the studio's backend: show() "
            "has been replaced by something that does not draw"
        )
    scene = _captured.pop("scene")
    _mark_paths(scene, objects)
    return scene


def _mark_paths(scene, objects=None):
    """Mark each object's path line ``path``: the line magpylib draws through
    the positions of an object that has a path (its `make_path`).

    A view outlines a selected object and draws its path in the selection's
    colour instead: an outline round the path as well is a box the size of
    the orbit, and six of them are a cage that points at nothing. Only here
    can the two be told apart -- in the payload a path is a line like a
    current's loop -- and here by the one thing that makes it a path: its
    points are the object's positions. `objects` are those the scene was
    drawn from; without them, the ones magpylib handed its backend, where it
    hands them. A line that is not found to be one is drawn as it was, and
    so is a path that goes nowhere -- a collection turning where it stands,
    its every step one point -- which is a dot, not a line to follow.
    """
    if objects is None:
        objects = [o for panel in scene.panels for o in getattr(panel, "objects", ())]
    known = {}
    for obj in _given(objects):
        for each in (obj, *getattr(obj, "children_all", ())):
            known[id(each)] = each
    for frame in scene.frames:
        for trace in frame.traces:
            if trace.get("type") != "scatter3d" or "path" in trace:
                continue
            positions = getattr(known.get(trace.get("object_id")), "_position", None)
            x = trace.get("x")
            if positions is None or len(positions) < 2 or x is None:
                continue
            if len(x) != len(positions):
                continue
            points = np.column_stack([x, trace["y"], trace["z"]]).astype(float)
            trace["path"] = bool(
                np.ptp(positions, axis=0).max() > 0 and np.allclose(points, positions)
            )


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
            # a sensor's pixels as instances of one shape -- `_pixels_of`
            "pixels": [p for p in payload if p["kind"] == "pixels"],
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
    key_of = _key_map(live, derived)
    for item in payload:
        raw = item["object_id"]
        item["object_id"] = key_of(raw)
        own = key_of(raw, own=True)
        # a pattern's copy, drawn under its source: said which, so the view
        # can mark the source and its copies apart
        if own != item["object_id"]:
            item["copy"] = own
    return payload


def _key_map(live, derived=None):
    """The studio id a drawn object's traces go under, as a function of
    magpylib's own ``id(obj)``: the object's own key, else the key of the
    collection holding it, and a pattern's copy under its source's."""
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

    def key_of(raw, own=False):
        """The id to draw under -- or, with `own`, the object's own: a copy's
        names it among the traces its source's node holds."""
        key = studio_id.get(raw) or holding.get(raw)
        return key if own else source_of.get(key, key)

    return key_of


#: What a sensor's pixels are drawn as, by the style's `pixel.field.symbol`,
#: when the field colours or orients them: one shape, that many times. The
#: 2D ``arrow`` is lines, and stays magpylib's.
_PIXEL_SHAPES = {"arrow3d": "arrow3d", "cone": "cone", "none": "cube", None: "cube"}

#: Below this a reading is no direction: magpylib's own threshold.
_NULL_VECTOR = 1e-12


def _reading_sensors(objects):
    """The sensors among `objects`, collections opened up, whose pixels the
    field colours or orients -- and that have pixels, drawn to a size, in a
    shape the view can instance."""
    found, seen = [], set()
    for obj in _given(objects):
        for each in (obj, *getattr(obj, "children_all", ())):
            if id(each) in seen or not _reads_the_field(each):
                continue
            seen.add(id(each))
            if getattr(each, "pixel", None) is None:
                continue
            if _resolve(each, "style.pixel.field.symbol") not in _PIXEL_SHAPES:
                continue
            if not (_resolve(each, "style.pixel.size") or 0) > 0:
                continue
            found.append(each)
    return found


def _instanced_pixels(objects, key_of):
    """The ``pixels`` items for the sensors `_reading_sensors` finds, and a
    function that puts their styles back.

    A sensor whose pixels read the field was one mesh of every arrow -- the
    7 x 7 probe of the Halbach example 100 KB of a 127 KB frame, and most of
    the engine's time drawing it. Its pixels are the same shape that many
    times: a position, a direction, a size and a colour each, which the view
    draws as instances of one geometry. magpylib is kept from drawing them
    itself by a pixel size of 0 for the length of the capture, which leaves
    the sensor its axes; the field it reads is computed as magpylib computes
    it, and sized and coloured as magpylib does -- see `_pixels_of`.
    """
    sensors = [] if key_of is None else _reading_sensors(objects)
    if not sensors:
        return [], lambda: None
    from magpylib._src.display.traces_generic import get_sensor_pixel_field

    fields = get_sensor_pixel_field(list(_given(objects)))
    items = []
    for sensor in sensors:
        key = key_of(id(sensor))
        read = fields.get(sensor) or {}
        if key is None or not read:
            continue
        items.extend(_pixels_of(sensor, next(iter(read.values())), key))
    was = [(sensor, sensor.style.pixel.size) for sensor in sensors]
    for sensor, _ in was:
        sensor.style.pixel.size = 0

    def restore():
        for sensor, size in was:
            sensor.style.pixel.size = size

    return items, restore


def _pixels_of(sensor, field, key, path_ind=-1):
    """A sensor's pixels as ``pixels`` items: one for its readings, and one
    of cubes for the pixels that read nothing, where the style shows those.

    Mirrors `make_Sensor` and `make_Pixels` in magpylib's `traces_core`, so
    the sizes and the colours are magpylib's own: the size from the pixel
    spacing and the sensor's size, scaled by the reading where the style
    says so; the colour from the colormap over the reading. What differs is
    the shape: no mesh, a position, a direction, a size and a colour per
    pixel. A reading is in the sensor's own frame, as magpylib hands it
    over, and the sensor's pose takes it into the world's.
    """
    from magpylib._src.display.traces_core import _apply_scaling_transformation
    from magpylib._src.display.traces_utility import get_hexcolors_from_colormap
    from scipy.spatial.distance import pdist

    style = sensor.style
    pixel = np.asarray(sensor.pixel, dtype=float).reshape(-1, 3)
    one_pix = pixel.shape[0] == 1
    hull = np.concatenate([[[0, 0, 0]], pixel]) if one_pix else pixel
    dimension = getattr(sensor, "dimension", None)
    if dimension is None:
        dimension = _resolve(sensor, "style.size")
    dim = np.array(
        [dimension] * 3 if isinstance(dimension, float | int) else dimension[:3],
        dtype=float,
    )
    hull_dim = hull.max(axis=0) - hull.min(axis=0)
    dim_ext = max(float(np.mean(dim)), float(np.min(hull_dim)))
    px_dim = 1.0
    if _resolve(sensor, "style.pixel.sizemode") == "scaled":
        if len(pixel) < 1000:
            min_dist = float(np.min(pdist(pixel))) if len(pixel) > 1 else 0.0
        else:
            vol = float(np.prod(np.ptp(pixel, axis=0)))
            min_dist = (vol / len(pixel)) ** (1 / 3)
        px_dim = dim_ext / 5 if min_dist == 0 else min_dist / 2
    sizes = np.full(len(pixel), px_dim * float(_resolve(sensor, "style.pixel.size")))

    source = _resolve(sensor, "style.pixel.field.source")
    _, *coords_str = source  # "B", or "Bxy" for two of its components
    coords_str = coords_str or "xyz"
    coords = list({"xyz".index(v) for v in coords_str if v in "xyz"})
    other = [i for i in range(3) if i not in coords]
    field = np.array(field, dtype=float)
    field[..., other] = 0
    norms = np.linalg.norm(field, axis=-1)
    is_null = np.logical_or(norms == 0, np.isnan(norms))
    norms[is_null] = np.nan
    # Nothing read anywhere -- no source, or every pixel on a null -- is no
    # reading to scale by: the sizes stay the style's, the colours the null
    # colour. magpylib's own scaling would warn over the all-NaN slice.
    any_reading = not is_null.all()
    if any_reading:
        nmin, nmax = np.nanmin(norms), np.nanmax(norms)
        ptp = nmax - nmin
        norms = (norms - nmin) / ptp if ptp != 0 else np.full_like(norms, 0.5)
    sizescaling = _resolve(sensor, "style.pixel.field.sizescaling")
    if any_reading and sizescaling != "uniform":
        scaled = _apply_scaling_transformation(
            norms,
            sizescaling,
            is_null,
            path_ind,
            min_=_resolve(sensor, "style.pixel.field.sizemin"),
        )
        scaled[is_null[path_ind]] = 1
        sizes = sizes * scaled
    pixel_color = _resolve(sensor, "style.pixel.color")
    colors = "black" if pixel_color is None else str(pixel_color)
    colorscaling = _resolve(sensor, "style.pixel.field.colorscaling")
    if any_reading and colorscaling != "uniform":
        graded = _apply_scaling_transformation(norms, colorscaling, is_null, path_ind)
        colors = [
            str(c)
            for c in get_hexcolors_from_colormap(
                values=graded,
                colormap=_resolve(sensor, "style.pixel.field.colormap"),
                cmin=0,
                cmax=1,
            )
        ]

    # into the world: the pixels sit in the sensor's frame, and so does the
    # reading, which magpylib rotates into it
    pose = np.atleast_2d(np.asarray(sensor._position, dtype=float))[path_ind]
    turn = sensor._orientation[path_ind]
    origins = turn.apply(pixel) + pose
    vectors = turn.apply(field[path_ind])
    null = (np.abs(field[path_ind]) < _NULL_VECTOR).all(axis=1)
    shape = _PIXEL_SHAPES[_resolve(sensor, "style.pixel.field.symbol")]
    label = (style.label if style.label is not None else type(sensor).__name__) or ""
    # on the style itself: opacity has no sensor default to fall back on
    opacity = float(style.opacity if style.opacity is not None else 1)

    def item(chosen, symbol, oriented):
        chosen = np.flatnonzero(chosen)
        if not len(chosen):
            return None
        return {
            "kind": "pixels",
            "name": label,
            "object_id": key,
            "opacity": opacity,
            "symbol": symbol,
            "origins": np.round(origins[chosen], 9).ravel().tolist(),
            "vectors": np.round(vectors[chosen], 6).ravel().tolist()
            if oriented
            else None,
            "sizes": np.round(sizes[chosen], 9).tolist(),
            "colors": colors
            if isinstance(colors, str)
            else [colors[i] for i in chosen],
        }

    items = []
    if shape == "cube":
        items.append(item(np.ones(len(pixel), dtype=bool), "cube", False))
    else:
        items.append(item(~null, shape, True))
        if _resolve(sensor, "style.pixel.field.shownull"):
            items.append(item(null, "cube", False))
    return [i for i in items if i is not None]


def _ranges_with_pixels(ranges, pixels):
    """`ranges` reaching every pixel and what it is drawn with: an arrow or a
    cone runs a size either way of its pixel, a cube half of one."""
    if not pixels:
        return ranges
    low = (
        np.array([r[0] for r in ranges], dtype=float) if ranges else np.full(3, np.inf)
    )
    high = (
        np.array([r[1] for r in ranges], dtype=float) if ranges else np.full(3, -np.inf)
    )
    for item in pixels:
        origins = np.asarray(item["origins"], dtype=float).reshape(-1, 3)
        reach = np.asarray(item["sizes"], dtype=float) * (
            0.5 if item["symbol"] == "cube" else 1.0
        )
        low = np.minimum(low, (origins - reach[:, None]).min(axis=0))
        high = np.maximum(high, (origins + reach[:, None]).max(axis=0))
    return np.stack([low, high], axis=1).tolist()


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


#: How tall a view is drawn when nobody says: tall enough for a scene to be
#: legible in a notebook column, short enough to leave the next cell on screen.
DEFAULT_HEIGHT = 420

#: How much of a run -- as JSON, every frame of it -- a view is handed whole
#: when it cannot be played as motion and changes and there is nothing left
#: to serve it a frame at a time: the studio's panel, a page a script opens.
#: A 200-step run of a big scene is hundreds of megabytes, which the panel
#: would read again each time its tab came back. Past this the view shows
#: the run's first step, still, and says so.
WHOLE_RUN_LIMIT: int = 50_000_000


def run_payload(scene):
    """What a view draws `scene` from, and the run kept to serve it a frame
    at a time: None when there is no run, or it plays on its own, as motion
    and carried changes -- see `played_payload`."""
    _mark_paths(scene)  # a script's scene, which `_capture` did not make
    animated = len(scene.frames) > 1
    played = played_payload(scene) if animated else None
    payload = played or view_payload(scene, index=0)
    return payload, (scene if animated and played is None else None)


def whole_run(scene, limit=None):
    """Every frame of `scene`'s run, for a view with nobody to ask for them --
    or None when that would come to more than `limit`."""
    # Weighed frame by frame, not trace by trace through the run (`_runs`):
    # a run that is served may be one whose frames hold different traces.
    frames = [[t for t in f.traces if t["type"] in _DRAWN] for f in scene.frames]
    if limit is not None and _weight(frames) > limit:
        return None
    return [frame_payload(scene, i) for i in range(len(scene.frames))]


def saved_state(
    payload,
    tree,
    frames,
    duration,
    repeat,
    *,
    selected=(),
    hidden=(),
    axes=True,
    theme="auto",
    height=DEFAULT_HEIGHT,
    camera=None,
):
    """What a saved view's model holds: the widget's traits, as a page or the
    studio's panel reads them. One layout, for `SceneWidget._saved` and for
    `widget_state`, so the two cannot drift apart."""
    return {
        "payload": payload,
        "tree": tree,
        "selected": list(selected),
        "hidden": list(hidden),
        "axes": axes,
        "theme": theme,
        "height": height,
        "frames": frames,
        "duration": duration,
        "repeat": repeat,
        "camera": camera,
        # no python behind the view, so nothing to ask for an export
        "standalone": True,
    }


def too_big_to_carry(frames):
    """Say, once, that a run is shown as its first step, and why."""
    warnings.warn(
        f"magpylib-studio: this run's {frames} steps change more than can be "
        "carried to a view with no python behind it, so it shows the first "
        "step, still. Draw it in a notebook, where frames are served one at a "
        "time, or with fewer steps (animation_maxframes).",
        stacklevel=2,
    )


def widget_state(scene, height=DEFAULT_HEIGHT):
    """The notebook widget's saved state for `scene`, and its run: what
    `SceneWidget.write_html` puts in a page, made from the scene alone.

    For a view with no python behind it -- the studio's panel, drawing the
    figure a script left before it exited. The widget there plays what it
    is handed and asks for nothing, so a run it cannot play as motion and
    changes travels whole, up to `WHOLE_RUN_LIMIT`, and past that as its
    first step. The legend comes from the objects magpylib hands its
    backends, where it does.

    Returns ``{"state": ..., "run": [...]}``, the shape `_saved` has.
    """
    payload, served = run_payload(scene)
    objects = [obj for panel in scene.panels for obj in getattr(panel, "objects", ())]
    tree, _ = object_tree(objects)
    frames, run = len(scene.frames), []
    if served is not None:
        run = whole_run(served, WHOLE_RUN_LIMIT)
        if run is None:
            too_big_to_carry(frames)
            frames, run = 1, []
    state = saved_state(
        payload,
        tree,
        frames,
        float(scene.animation.time),
        bool(scene.animation.repeat),
        height=height,
    )
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
        # shape to resize, no polarization to aim, no path to scrub and no
        # collection to carry. The renderer reads each as empty and skips them.
        "centroids": {},
        "anchors": {},
        "orientations": {},
        "paths": {},
        "shapes": {},
        "polarizations": {},
        "patterned": [],
        "collections": {},
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
    that offers drag handles has to know not to offer them there. It names
    too the collections that hold only part of a pattern -- see
    `_collections` -- whose drag a view cannot draw by carrying either.

    `readings` names the objects whose drawing is their own reading of the
    field -- see `_reads_the_field` -- which a view redraws while they are
    dragged, rather than carrying the picture along with the handles.

    `collections` gives each Collection what it holds, by the ids above: a
    collection draws nothing of its own, so a view that puts handles on one
    makes it a node, and carries these on it while it is dragged.
    """
    live = live or {}
    derived = derived or {}
    pixels, restore = _instanced_pixels(
        objects, _key_map(live, derived) if live else None
    )
    try:
        scene = _capture(objects, on_behalf_of="studio")
    finally:
        restore()
    panel = scene.panel(1, 1)
    traces = [t for frame in scene.frames for t in frame.traces]

    source_of = {copy: src for src, copies in derived.items() for copy in copies}
    anchors, centroids, orientations, shapes, polarizations = {}, {}, {}, {}, {}
    paths, readings = {}, []
    for key, obj in live.items():
        if key in source_of:
            continue  # a copy is drawn on its source's node
        if _reads_the_field(obj):
            readings.append(key)
        anchors[key] = np.atleast_2d(np.asarray(obj.position, dtype=float))[-1].tolist()
        # Where the object *looks* like it is, which is not always where it
        # is: a Tetrahedron's position is the origin its vertices are written
        # against, and handles drawn there float off the corner of the shape.
        # The two agree for everything that is centred on its own position.
        try:
            centroid = getattr(obj, "centroid", None)
        except ValueError:
            # magpylib cannot say, for a Collection whose members move along
            # a path: it adds each member's centroid, one per step, into a
            # single point, and raises. Its position is the next best place
            # for the handles -- and failing here left the whole scene, and
            # the studio's Edit view with it, undrawn.
            centroid = None
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

    collections, split = _collections(live, derived, source_of)
    return {
        **_by_kind([*_keyed(traces, live, derived), *pixels]),
        "ranges": _ranges_with_pixels(
            None if panel.ranges is None else panel.ranges.tolist(), pixels
        ),
        "labels": panel.labels,
        "anchors": anchors,
        "centroids": centroids,
        "orientations": orientations,
        "paths": paths,
        "shapes": shapes,
        "polarizations": polarizations,
        "patterned": sorted({*derived, *split}),
        "readings": sorted(readings),
        "collections": collections,
    }


def _collections(live, derived, source_of):
    """Each Collection's contents, nested ones included, by the ids a view
    draws them under -- a copy is drawn on its source's node, so it is held
    as its source -- and the collections that split a pattern.

    Carried on a collection's node, a pattern moves as one piece with its
    source: right when the collection holds the source and every copy, and
    not otherwise -- only the rebuild knows where half a pattern goes. Those
    collections are listed with the patterned sources, and a view draws their
    drag from the engine instead.
    """
    key_of = {id(obj): key for key, obj in live.items()}
    collections, split = {}, []
    for key, obj in live.items():
        children = getattr(obj, "children_all", None)
        if children is None or key in source_of:
            continue
        held = [key_of[id(child)] for child in children if id(child) in key_of]
        collections[key] = list(dict.fromkeys(source_of.get(k, k) for k in held))
        inside = set(held)
        if any(
            (k in derived and not set(derived[k]) <= inside)
            or (k in source_of and source_of[k] not in inside)
            for k in held
        ):
            split.append(key)
    return collections, split


def _reads_the_field(obj):
    """Whether what `obj` draws is its own reading of the field: a sensor
    whose pixels are coloured, or drawn as arrows, by what they measure.

    Such a drawing is not right where a drag puts it, as a magnet's is: what
    it shows depends on where it is. A view redraws it while it is dragged,
    rather than carrying the picture from where the drag began."""
    pixel = getattr(getattr(obj, "style", None), "pixel", None)
    return getattr(getattr(pixel, "field", None), "source", None) is not None
