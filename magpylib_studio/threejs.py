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

import magpylib as magpy
import numpy as np
from magpylib.graphics.backend import DisplayBackend

#: Magpylib's `line_width` and `marker_size` are nominal: every backend scales
#: them into its own units, and nothing in the contract says what a width of 2
#: should look like. These are Plotly's own factors, which transfer because
#: `Line2` and `PointsMaterial(sizeAttenuation=false)` also measure in pixels.
SIZE_FACTORS = {"line_width": 2.2, "marker_size": 0.7}

LUT_SIZE = 256

_BACKEND = "_studio_scene"


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


def _capture(objects):
    """The `Scene` magpylib would hand a display backend, for `objects`."""
    captured = {}
    if _BACKEND not in DisplayBackend.backends:
        magpy.register_backend(
            _BACKEND,
            lambda scene: captured.setdefault("scene", scene),
            supports_colorgradient=True,  # three.js interpolates vertex colours
            merge_traces=False,  # one mesh per object, so each is addressable
            handles_traces=frozenset({"mesh3d", "scatter3d"}),
            accepts_options=frozenset(),
        )
    else:  # re-registering would replace the closure each call
        DisplayBackend.backends[_BACKEND].show = lambda scene: captured.setdefault(
            "scene", scene
        )
    magpy.show(objects, backend=_BACKEND, return_fig=True)
    return captured["scene"]


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
    * **The anchors.** The payload carries no transform, so a mesh arrives with
      an identity matrix and a gizmo attached to it lands at the world origin.
      The only alternative is the bounding-box centre, which is wrong for
      anything whose origin is not its centroid -- 0.678 off for a Sensor,
      measured. The object knows; the picture does not.
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
    studio_id = {id(obj): key for key, obj in live.items()}
    source_of = {copy: src for src, copies in derived.items() for copy in copies}
    # Patterning a Collection copies its children too, and those copies are
    # real magnets that nothing registered an id for. The Collection holding
    # one is the nearest thing that has an id, so the trace is drawn there --
    # innermost first, hence the sort by size.
    holding = {
        id(child): key
        for key, obj in sorted(
            live.items(), key=lambda kv: -len(getattr(kv[1], "children_all", ()))
        )
        for child in getattr(obj, "children_all", ())
    }
    anchors = {
        key: np.atleast_2d(np.asarray(obj.position, dtype=float))[-1].tolist()
        for key, obj in live.items()
        if key not in source_of  # a copy is drawn on its source's node
    }

    payload = [_mesh_payload(t) for t in traces if t["type"] == "mesh3d"]
    payload += [_scatter_payload(t) for t in traces if t["type"] == "scatter3d"]
    for item in payload:
        raw = item["object_id"]
        key = studio_id.get(raw) or holding.get(raw)
        item["object_id"] = source_of.get(key, key)

    return {
        "meshes": [p for p in payload if p["kind"] == "mesh"],
        "scatters": [p for p in payload if p["kind"] == "scatter"],
        "ranges": None if panel.ranges is None else panel.ranges.tolist(),
        "labels": panel.labels,
        "anchors": anchors,
        "patterned": sorted(derived),
    }
