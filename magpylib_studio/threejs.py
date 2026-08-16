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

import magpylib as magpy
import numpy as np

try:
    from magpylib.graphics.backend import DisplayBackend
except ImportError:  # pragma: no cover - depends on the magpylib installed
    #: The public display-backend API landed in magpylib after 5.2.3, and this
    #: module is the only thing here that needs it. Everything else the studio
    #: does works with the released version, so this is not a hard dependency:
    #: without it the scene graph is unavailable and the view draws the Plotly
    #: figure, which is what it drew before any of this existed.
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
        "position": position.ravel().tolist(),
        "index": index.ravel().tolist(),
        "color": trace.get("color"),
        "uv": None if uv is None else uv.ravel().tolist(),
        "lut": _colorscale_lut(colorscale) if graded else None,
        # mixes CSS names with hex, so THREE.Color parses them rather than us
        "facecolor": None if facecolor is None else [str(c) for c in facecolor],
    }


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
        "position": position.ravel().tolist(),
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
    """Whether the installed magpylib can hand out a scene to convert."""
    return DisplayBackend is not None


def _capture(objects, animation=False, **kwargs):
    """The `Scene` magpylib would hand a display backend, for `objects`.

    With `animation`, that scene carries one frame per step of the longest
    path, each holding the whole scene *as computed at that step* -- which is
    the only way to get what a pose cannot express. A sensor's arrows are
    read from the field, so they turn as the magnet that makes them turns,
    and no amount of moving meshes about will show it.
    """
    if not available():
        raise RuntimeError(UNAVAILABLE)
    captured = {}
    if _BACKEND not in DisplayBackend.backends:
        magpy.register_backend(
            _BACKEND,
            lambda scene: captured.setdefault("scene", scene),
            supports_colorgradient=True,  # three.js interpolates vertex colours
            merge_traces=False,  # one mesh per object, so each is addressable
            handles_traces=frozenset({"mesh3d", "scatter3d"}),
            accepts_options=frozenset(),
            supports_animation=True,
        )
    else:  # re-registering would replace the closure each call
        DisplayBackend.backends[_BACKEND].show = lambda scene: captured.setdefault(
            "scene", scene
        )
    magpy.show(
        objects, backend=_BACKEND, return_fig=True, animation=animation, **kwargs
    )
    return captured["scene"]


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
        # the budget is min(time x fps, maxframes); both have to clear the path
        animation_fps=math.ceil(steps / magpy.defaults.display.animation.time),
        animation_maxfps=math.ceil(steps / magpy.defaults.display.animation.time),
        animation_maxframes=steps,
    )


def frame_payload(scene, index, live=None, derived=None):
    """One frame of a captured run, in the shape `scene_payload` returns.

    Only what is drawn: the poses, shapes and paths a view needs are the same
    from frame to frame, and it already has them.
    """
    frames = scene.frames
    frame = frames[max(0, min(int(index), len(frames) - 1))]
    payload = _keyed(list(frame.traces), live or {}, derived or {})
    return {
        "frame": max(0, min(int(index), len(frames) - 1)),
        "frames": len(frames),
        # how long the whole run should take, which is what the view paces to
        "duration": magpy.defaults.display.animation.time,
        "meshes": [p for p in payload if p["kind"] == "mesh"],
        "scatters": [p for p in payload if p["kind"] == "scatter"],
    }


def _keyed(traces, live, derived):
    """Traces converted and re-keyed from magpylib's ids to studio's."""
    studio_id = {id(obj): key for key, obj in live.items()}
    source_of = {copy: src for src, copies in derived.items() for copy in copies}
    holding = {
        id(child): key
        for key, obj in sorted(
            live.items(), key=lambda kv: -len(getattr(kv[1], "children_all", ()))
        )
        for child in getattr(obj, "children_all", ())
    }
    payload = [_mesh_payload(t) for t in traces if t["type"] == "mesh3d"]
    payload += [_scatter_payload(t) for t in traces if t["type"] == "scatter3d"]
    for item in payload:
        raw = item["object_id"]
        key = studio_id.get(raw) or holding.get(raw)
        item["object_id"] = source_of.get(key, key)
    return payload


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
    scene = _capture(objects)
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

    payload = _keyed(traces, live, derived)

    return {
        "meshes": [p for p in payload if p["kind"] == "mesh"],
        "scatters": [p for p in payload if p["kind"] == "scatter"],
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
