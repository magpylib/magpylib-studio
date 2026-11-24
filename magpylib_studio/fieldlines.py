"""Field lines: the field on a grid, for a view to integrate. Prototype (#45).

The view draws lines of the field through the pixels of each sensor that
reads it -- B or H, as its ``style.pixel.field.source`` says, however its
pixels themselves are drawn: at ``style.pixel.size = 0`` the lines alone --
integrated in the browser, where a frame of lines costs a few milliseconds against tens in
numpy. What python sends is the field on a grid round the sensor, and what
the view needs to draw lines nobody has to tune:

- **Where.** A sensor whose pixels lie in a plane that the field keeps to --
  a plane of symmetry, where B has no part across it -- has its lines drawn
  in that plane, from the field sampled on the plane alone: the classic
  streamplot, and four times finer for the same points than a box. Any other
  sensor's lines run in 3D, through a box round it and the sources near it:
  lines kept to a plane the field leaves would be the field's shadow on it,
  not its lines.
- **How many.** As far apart as the pixels: a line stops where it comes
  within half a spacing of another, and a pixel already on a line starts
  none, so a uniform field shows a line per row and not one per pixel.
- **Where they end.** Leaving the grid, closing on itself, where the field
  fades out, or at a magnet -- the grid points inside one, from magpylib's
  own polarization (`getJ`), so every shape it knows; a cuboid's answered
  here as getJ answers it (`inside`), for a meshed body's thousands. The lines are of the
  field in the air: let through the magnets, 3D lines wandered on paths too
  unstable to trace. A solved face-charge sheet's body, which getJ does not
  see, stops them too (`_inside_sheets`).

During a gesture the grid is coarser and kept for its length, unless the
sensor itself moves: the field of what does not move is computed once and
only the moving sources' field added each frame, which is the whole field to
float precision. A sensor dragged past sources that all stand still keeps a
grid too, fixed in the world, and the field on it, until its pixels leave
it (`holds`) -- see `MagpylibStudioSession._field_lines`.
"""

import base64
import collections
import copy
import functools
import hashlib
import os
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import magpylib as magpy
import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

#: About how many points the grid holds at rest; while a gesture moves a few
#: sources, whose field alone is computed each frame; and while it moves
#: anything, as a variable does, when the whole field is.
REST_POINTS = 8_000
DRAG_POINTS = 2_500
DRAG_POINTS_ALL = 1_200
#: Colours in the table a line is coloured from by |B|.
LUT_STEPS = 64
#: Pixels offered as starts at most; the spacing keeps far fewer of them.
MAX_SEEDS = 400
#: How much of B may cross a sensor's plane, over the plane, for its lines to
#: be drawn in it. A plane of symmetry has none, so this is room for rounding
#: only: at 2 %, a sensor tilted by a degree (1.7 %) kept lines in its plane
#: that the field does not have. The Halbach demo's bore, whose rings are
#: turned half a step apart, has 40 %: its lines leave it.
ACROSS = 0.001
#: Points of the coarse look at the plane that decides it, before its grid.
PROBE_POINTS = 600


def sources_of(objects):
    """Every source among `objects`, collections opened up, sensors left out."""
    found, seen = [], set()
    for obj in objects:
        for each in (obj, *getattr(obj, "children_all", ())):
            if isinstance(each, magpy.Sensor | magpy.Collection) or id(each) in seen:
                continue
            seen.add(id(each))
            found.append(each)
    return found


def kind_of(sensor):
    """The field `sensor`'s lines are of: ``"B"`` or ``"H"``, as its pixels'
    source says; None for one that reads none, or M or J, which are nothing
    outside a magnet and draw no lines."""
    source = getattr(getattr(sensor.style.pixel, "field", None), "source", None)
    kind = (source or "")[:1]
    return kind if kind in ("B", "H") else None


def sensors_of(objects):
    """The sensors among `objects`, collections opened up, that have pixels
    and read B or H at them: those that draw lines."""
    found, seen = [], set()
    for obj in objects:
        for each in (obj, *getattr(obj, "children_all", ())):
            if not isinstance(each, magpy.Sensor) or id(each) in seen:
                continue
            seen.add(id(each))
            if each.pixel is not None and kind_of(each) is not None:
                found.append(each)
    return found


def seeds_of(sensor):
    """Where `sensor`'s pixels are in the world, at the last step of its path."""
    pixel = np.asarray(sensor.pixel, dtype=float).reshape(-1, 3)
    pose = np.atleast_2d(np.asarray(sensor.position, dtype=float))[-1]
    turn = Rotation.from_quat(np.atleast_2d(sensor.orientation.as_quat()))[-1]
    return turn.apply(pixel) + pose


def frame_of(seeds):
    """The axes the grid is laid along, as rows, and whether the seeds lie in
    a plane -- the plane of the first two. A line of pixels, or one, is not a
    plane: its lines have no plane to keep to.

    Only the plane's normal is the seeds' own; across it the grid is laid
    along the world's axis nearest the plane, and the one at right angles to
    it. The seeds' spread gives no direction where they are a square grid
    -- the SVD's two are any two at right angles -- and a grid turned 45°
    by chance put its points on a meshed core's plane of symmetry, along the
    edges of its cells.

    The normal points the way its largest component is positive: the SVD's
    sign is LAPACK's to pick, and the other one lays the grid mirrored -- by
    up to a step -- which a saved page, laying it again for a dragged
    sensor, could not follow (#176, `normalOf` in `pagefield.mjs`)."""
    if len(seeds) >= 3:
        _, spread, axes = np.linalg.svd(seeds - seeds.mean(axis=0))
        if spread[1] > 1e-3 * spread[0] and spread[2] <= 1e-6 * spread[0]:
            normal = axes[2] * np.sign(axes[2][np.argmax(np.abs(axes[2]))])
            world = np.eye(3)[np.argmin(np.abs(np.eye(3) @ normal))]
            across = world - (world @ normal) * normal
            across /= np.linalg.norm(across)
            return np.array([across, np.cross(normal, across), normal]), True
    return np.eye(3), False


def spacing_of(seeds, grid):
    """How far apart the lines are drawn: the seeds' own spacing -- the median
    distance to the nearest one -- or a thirtieth of a flat grid's larger
    side if that is finer, as matplotlib's streamplot spaces its lines by
    default; a few grid steps for a single pixel."""
    step = grid["step"]
    plane = grid["shape"][2] == 1
    finest = max(grid["shape"][:2]) * step / 30 if plane else np.inf
    own = _apart(seeds)
    return float(min(4 * step if own is None else own, finest))


def _apart(seeds):
    """The seeds' own spacing, the median distance to the nearest one; None
    for fewer than two, or all in one place."""
    if len(seeds) < 2:
        return None
    distance, _ = cKDTree(seeds).query(seeds, k=2)
    apart = distance[:, 1][distance[:, 1] > 0]
    return float(np.median(apart)) if len(apart) else None


def grid_around(sources, seeds, points, flat=None, every_step=False):
    """The grid for `seeds`: in their plane, if they lie in one and `flat` is
    not False, else a box;
    round them and the sources near them, padded by a quarter of its largest
    side, about `points` evenly spaced points. A source stands at its last
    step, or, `every_step`, at each of them: the grid a run's frames share.

    Near is within three times the seeds' own reach of their centre: the lines
    are about what the sensor sits in, and a grid stretched to a magnet
    dragged a metre off spreads its points so thin that the bore has none.
    """
    axes, planar = frame_of(seeds)
    if flat is False:
        axes, planar = np.eye(3), False
    centre = seeds.mean(axis=0)
    reach = 3 * max(float(np.max(np.linalg.norm(seeds - centre, axis=1))), 0.005)
    rows = slice(None) if every_step else slice(-1, None)
    centres = [
        centre
        for s in sources
        for centre in np.atleast_2d(np.asarray(s.position, dtype=float))[rows]
    ]
    near = [c for c in centres if np.linalg.norm(c - centre) <= reach]
    local = (np.vstack([*near, seeds]) - centre) @ axes.T
    low, high = local.min(axis=0), local.max(axis=0)
    pad = 0.25 * float(np.max(high - low)) or 0.01
    low, high = low - pad, high + pad
    depth = float(high[2] - low[2])  # across the plane, as a box would have it
    if planar:
        low[2] = high[2] = 0.0  # the plane through the seeds
        span = (high - low)[:2]
        step = float(np.sqrt(np.prod(span) / points))
        shape = [*np.maximum(np.ceil(span / step).astype(int) + 1, 2), 1]
    else:
        span = high - low
        step = float((np.prod(span) / points) ** (1 / 3))
        shape = list(np.maximum(np.ceil(span / step).astype(int) + 1, 2))
    grid = {
        "origin": centre + low @ axes,
        "axes": axes,
        "step": step,
        "shape": [int(n) for n in shape],
    }
    if planar:
        grid["depth"] = depth
    return grid


def pose_of(sensor):
    """Where `sensor` is and how it is turned, at the last step of its path."""
    pose = np.atleast_2d(np.asarray(sensor.position, dtype=float))[-1]
    turn = Rotation.from_quat(np.atleast_2d(sensor.orientation.as_quat()))[-1]
    return pose, turn


def box_of(grid):
    """The region `grid` covers, as a box in the world: its centre, its axes
    as rows and its sides. A flat grid's box is as deep as `grid_around`
    padded it across its plane, so that a region taken from it has room to
    run in 3D should the field leave the plane."""
    sides = grid["step"] * (np.asarray(grid["shape"], dtype=float) - 1)
    axes = np.asarray(grid["axes"], dtype=float)
    centre = np.asarray(grid["origin"], dtype=float) + (sides / 2) @ axes
    if is_flat(grid):
        sides[2] = float(grid.get("depth", 0.0))
    return {"centre": centre, "axes": axes, "size": sides}


def region_in_world(sensor, region):
    """`region`, set in `sensor`'s own frame -- ``{"centre", "axes",
    "size"}``, axes as rows -- as a box in the world, where the sensor is."""
    pose, turn = pose_of(sensor)
    return {
        "centre": turn.apply(np.asarray(region["centre"], dtype=float)) + pose,
        "axes": turn.apply(np.asarray(region["axes"], dtype=float)),
        "size": np.abs(np.asarray(region["size"], dtype=float)),
    }


def region_of(sensor, box):
    """A box in the world as a region in `sensor`'s own frame, for the
    document to keep: it turns and moves with the sensor from then on. The
    axes made a right-handed orthonormal set, as a view's drag may round
    them."""
    axes = np.asarray(box["axes"], dtype=float).reshape(3, 3)
    u, _, vt = np.linalg.svd(axes)
    axes = u @ vt
    if np.linalg.det(axes) < 0:
        axes[2] = -axes[2]
    pose, turn = pose_of(sensor)
    centre = turn.inv().apply(np.asarray(box["centre"], dtype=float) - pose)
    local = turn.inv().apply(axes)
    size = np.abs(np.asarray(box["size"], dtype=float))
    return {
        "centre": [round(float(v), 12) for v in centre],
        "axes": [[round(float(v), 12) for v in row] for row in local],
        "size": [round(float(v), 12) for v in size],
    }


def in_plane_of(box, seeds):
    """Whether `seeds` lie in the plane of `box`'s first two axes, through
    its centre: a region's lines may keep to it."""
    across = (np.asarray(seeds, dtype=float) - box["centre"]) @ box["axes"][2]
    return float(np.max(np.abs(across))) <= 1e-6 * max(float(box["size"].max()), 1e-9)


def grid_in(box, points, flat):
    """A grid over `box`, about `points` evenly spaced points, centred on
    it and covering it: one step on every axis, as a grid has, so its last
    row may stand a little past the box. In the plane of its first two axes
    if `flat`, else through it; a box with no depth is given a quarter of
    its largest side."""
    size = np.asarray(box["size"], dtype=float).copy()
    axes = np.asarray(box["axes"], dtype=float)
    largest = max(float(size.max()), 1e-9)
    size = np.maximum(size, 1e-3 * largest)
    if flat:
        span = size[:2]
        step = float(np.sqrt(np.prod(span) / points))
        shape = [*np.maximum(np.ceil(span / step - 1e-9).astype(int) + 1, 2), 1]
    else:
        if size[2] <= 1e-3 * largest * (1 + 1e-9):
            size[2] = 0.25 * largest
        step = float((np.prod(size) / points) ** (1 / 3))
        shape = list(np.maximum(np.ceil(size / step - 1e-9).astype(int) + 1, 2))
    covered = step * (np.asarray(shape, dtype=float) - 1)
    return {
        "origin": np.asarray(box["centre"], dtype=float) - (covered / 2) @ axes,
        "axes": axes,
        "step": step,
        "shape": [int(n) for n in shape],
    }


def within_box(box, points, flat):
    """Which of `points` lie in `box` -- in its rectangle, for a flat one."""
    local = (np.asarray(points, dtype=float) - box["centre"]) @ box["axes"].T
    half = box["size"] / 2 * (1 + 1e-9) + 1e-12
    keep = (np.abs(local[:, 0]) <= half[0]) & (np.abs(local[:, 1]) <= half[1])
    if not flat:
        keep &= np.abs(local[:, 2]) <= half[2]
    return keep


#: How far inside a kept grid its seeds must stay, as a share of its
#: largest side: about half the padding `grid_around` gives them, so a
#: line from a pixel near the edge still has some way to run.
HELD_MARGIN = 1 / 12


#: How far inside a grid kept from rest a sensor's seeds must be to be drawn
#: from it at rest again: three quarters of the sixth of its side that
#: `grid_around` pads them by. A sensor let go nearer an edge than that is
#: given a grid round where it is now, rather than lines with half the room
#: on that side; a gesture makes do with `HELD_MARGIN` while it lasts.
REST_MARGIN = 1 / 8


def holds(grid, seeds, margin=HELD_MARGIN):
    """Whether `grid` still serves `seeds`: they lie within it, kept
    `margin` of its largest side from its edges -- and in its plane, a flat
    one's."""
    local = (np.asarray(seeds, dtype=float) - grid["origin"]) @ np.asarray(
        grid["axes"]
    ).T
    sides = grid["step"] * (np.asarray(grid["shape"]) - 1)
    margin = margin * float(sides.max())
    if is_flat(grid):
        if np.abs(local[:, 2]).max() > 1e-3 * grid["step"]:
            return False
        local, sides = local[:, :2], sides[:2]
    return bool(((local >= margin) & (local <= sides - margin)).all())


def slide(kept, then, now):
    """`kept` moved with a sensor whose seeds stood at `then` and stand at
    `now`: by whole steps along its own axes, so that the seeds keep the
    room they had in it, and every point it shares with `kept` is one of
    `kept`'s exactly. ``(grid, was)``, `was` the index among `kept`'s points
    of each of the new grid's, or -1 where it has none -- only those are
    for the field to be computed at. None where the seeds have left a flat
    grid's plane, which another grid is for."""
    axes = np.asarray(kept["axes"])
    moved = (np.mean(now, axis=0) - np.mean(then, axis=0)) @ axes.T
    if is_flat(kept):
        local = (np.asarray(now, dtype=float) - kept["origin"]) @ axes.T
        if np.abs(local[:, 2]).max() > 1e-3 * kept["step"]:
            return None
        moved[2] = 0.0
    shift = np.rint(moved / kept["step"]).astype(int)
    shape = np.asarray(kept["shape"])
    index = np.indices(shape).reshape(3, -1).T + shift
    inside = np.all((index >= 0) & (index < shape), axis=1)
    was = np.full(len(index), -1)
    was[inside] = np.ravel_multi_index(index[inside].T, shape)
    grid = {**kept, "origin": kept["origin"] + (shift * kept["step"]) @ axes}
    return grid, was


def is_flat(grid):
    """Whether `grid` is a plane's."""
    return grid["shape"][2] == 1


def keeps_to(grid, values, within):
    """Whether the field `values` on a flat `grid` stays in its plane: what
    crosses it, against all of it, over the plane outside the magnets, under
    `ACROSS`."""
    across = np.abs(values @ grid["axes"][2])
    size = np.linalg.norm(values, axis=1)
    outside = ~within
    total = float(size[outside].sum())
    return total == 0 or float(across[outside].sum()) <= ACROSS * total


def points_of(grid):
    """The grid's points in the world, the first axis slowest, the last
    fastest -- the order the view reads."""
    steps = [grid["step"] * np.arange(n) for n in grid["shape"]]
    local = np.stack(np.meshgrid(*steps, indexing="ij"), axis=-1).reshape(-1, 3)
    return grid["origin"] + local @ grid["axes"]


#: Element-point pairs evaluated at once, all threads together; a wire's
#: segments and a mesh's faces are each an element (`_weight`). Magpylib
#: evaluates every pair of a call at once, with about a kilobyte of
#: temporaries each: a meshed body of a thousand cells against a grid at rest
#: took 8 GB in one call. Measured on that body (1,056 cells, 8,000 points):
#: 25,000 pairs a call took 6.7 s, 100,000 4.6 s, 200,000 4.4 s in 0.44 GB, and
#: 1 or 2 million no less time in 1.4 and 2.2 GB. Hence a constant and no
#: option: past the knee only memory grows. Set it at run time if you must;
#: each call reads it.
PAIRS_PER_CALL = 200_000
#: Threads the calls of `_in_chunks` run on, each with its share of
#: `PAIRS_PER_CALL`: magpylib's kernels are numpy, which lets go of the GIL.
#: Four, which a small laptop has too.
THREADS = min(4, os.cpu_count() or 1)


def _weight(source):
    """About how many elements magpylib evaluates `source` as: a mesh its
    faces, a wire its segments, anything else one."""
    faces = getattr(source, "faces", None)
    if faces is not None:
        return max(1, len(faces))
    vertices = getattr(source, "vertices", None)
    if vertices is not None and np.ndim(vertices) == 2:
        return max(1, len(vertices) - 1)
    return 1


def _in_chunks(get, sources, points):
    """`get(sources, points, sumup=True)` at the last step of every path, on
    `THREADS` threads: `PAIRS_PER_CALL` element-point pairs at once in all,
    the memory one call took before there were threads.

    A call takes a slice of the sources and as many points as it can --
    all of them, mostly: magpylib reads each source of a call in Python
    before it computes, so slicing the points instead read a body meshed
    into thousands of cells once per slice, a third of the time. A source
    on a path is answered step by step, and the last step is the one the
    view draws and a sensor's seeds stand at (`seeds_of`), so the calls are
    given each source at that step (`at_step`): one step computed, not
    every one, and nothing for magpylib to pad on an object the threads
    share, which it does in place (magpylib#1074, #122). One call is made
    where it is, and so are all where no thread can be started (Pyodide)."""
    sources = [at_step(source) for source in sources]
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    n = len(points)
    budget = max(1, PAIRS_PER_CALL // THREADS)
    groups, group, load = [], [], 0
    for source in sources:
        weight = _weight(source)
        if group and (load + weight) * n > budget:
            groups.append((group, load))
            group, load = [], 0
        group.append(source)
        load += weight
    if group:
        groups.append((group, load))
    calls = [
        (group, i, min(n, i + max(1, budget // load)))
        for group, load in groups
        for i in range(0, n, max(1, budget // load))
    ]

    def call(task):
        group, i, j = task
        answer = np.asarray(get(group, points[i:j], sumup=True))
        return i, j, answer.reshape(-1, j - i, 3)[-1]

    def answers():
        if THREADS == 1 or len(calls) < 2:
            return list(map(call, calls))
        try:
            with ThreadPoolExecutor(min(THREADS, len(calls))) as pool:
                return list(pool.map(call, calls))
        except RuntimeError:  # no thread to be had: one call after another
            return list(map(call, calls))

    out = np.zeros((n, 3))
    for i, j, part in answers():
        out[i:j] += part
    return out


def _reading_inside(fn):
    """`fn` with no word of an observer inside a solved part: a grid runs through
    the parts, which are left out of the lines by `inside`, and a warning from
    every step of a drag would say nothing the view does not show."""

    @functools.wraps(fn)
    def quiet(*args, **kwargs):
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Observers inside a solved part")
            return fn(*args, **kwargs)

    return quiet


@_reading_inside
def readings(objects):
    """What each sensor's pixels read, as magpylib's `pixel_fields` gives
    it: ``{sensor: (path_length, n_pixels, 3)}``, in the sensor's own frame,
    of the field its pixels' source names. On `THREADS` threads
    (`_in_chunks`) for sensors that stand still and read B or H: magpylib
    reads every source at every pixel on one, three quarters of a second
    for a probe past the U-core of material-response's docs, 5,888 cells.
    Magpylib's own for a sensor on a path or another field."""
    from magpylib.graphics.backend import pixel_fields

    objects = list(objects)
    sources = sources_of(objects)
    sensors, seen = [], set()
    for obj in objects:
        for each in (obj, *getattr(obj, "children_all", ())):
            if (
                isinstance(each, magpy.Sensor)
                and id(each) not in seen
                and each.style.pixel.field.source
            ):
                seen.add(id(each))
                sensors.append(each)
    if any(s._get_path_len() > 1 for s in sensors) or any(
        s.style.pixel.field.source[0] not in "BH" for s in sensors
    ):
        return pixel_fields(objects)
    out = {}
    if not sources:
        return out
    # A sensor that stands still reads what stands still once, whatever moves
    # beside it: a magnet sliding over a solved plate had magpylib read the
    # plate at every one of its steps, a sixth of a drag step in the solved
    # example. Only what moves is read along the path, by magpylib, which
    # gives it as `pixel_fields` would, padded to the longest path -- and
    # everything is, in one call, where the steps saved would cost less than
    # the second call (`APART_FROM`).
    moving = [s for s in sources if s._get_path_len() > 1]
    still = [s for s in sources if s._get_path_len() == 1]
    steps = max((s._get_path_len() for s in moving), default=1)
    weight = sum(_weight(s) for s in still)
    for sensor in sensors:
        source = sensor.style.pixel.field.source
        pixel = np.zeros(3) if sensor.pixel is None else sensor.pixel
        pixel = np.asarray(pixel, dtype=float).reshape(-1, 3)
        if moving and weight * len(pixel) * (steps - 1) < APART_FROM:
            values = _along_paths(sources, sensor, source[0])
        else:
            pose = np.atleast_2d(np.asarray(sensor.position, dtype=float))[-1]
            turn = Rotation.from_quat(np.atleast_2d(sensor.orientation.as_quat()))[-1]
            values = turn.inv().apply(
                _summed(still, turn.apply(pixel) + pose, source[0])
            )
            if getattr(sensor, "handedness", "right") == "left":
                values[:, 0] *= -1
            values = values.reshape(1, -1, 3)
            if moving:
                values = values + _along_paths(moving, sensor, source[0])
        named = source[1:] or "xyz"
        values[..., [i for i, axis in enumerate("xyz") if axis not in named]] = 0
        out[sensor] = values
    return out


#: The element-pixel readings at the steps of a path past the first below
#: which a still sensor reads what stands still along the path with what
#: moves, in one call: a second call costs about 0.15 ms, which twenty still
#: sensors of four pixels beside a cube on a path paid twice over.
APART_FROM = 10_000


def _along_paths(sources, sensor, field):
    """What `sensor`'s pixels read of `sources` at every step of their paths,
    ``(path_length, n_pixels, 3)`` in its own frame, as `pixel_fields` reads
    them -- the shorter paths at their last step."""
    get = magpy.getH if field == "H" else magpy.getB
    read = np.asarray(get(sources, sensor, sumup=True, squeeze=False))
    return read[0].reshape(read.shape[1], -1, 3)


@_reading_inside
def field(sources, points, kind="B"):
    """B, or H, at `points` from `sources`, summed; zero for no sources.
    Zero too where magpylib says NaN -- a point within rounding of a
    cuboid's edge, which it takes for one off it -- as it says on the edge
    itself: one NaN made the whole grid's scale NaN, and not a line was
    drawn."""
    if not sources:
        return np.zeros((len(points), 3))
    values = _summed(sources, points, kind)
    return np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)


def _summed(sources, points, kind):
    """B, or H, at `points` from `sources` at their last step: the solved
    sheets among them from a kept matrix where there is one
    (`_sheets_by_matrix`), the rest on the threads (`_in_chunks`)."""
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    kept, rest = _sheets_by_matrix(sources, points, kind)
    if not rest:
        return np.zeros((len(points), 3)) if kept is None else kept
    values = _in_chunks(magpy.getH if kind == "H" else magpy.getB, rest, points)
    return values if kept is None else values + kept


#: The memory, in bytes, the field matrices of solved sheets may take, all of
#: them together, the oldest let go first; 0 for none. A sheet solved again
#: where it stands keeps its mesh and changes only its charge, so its field
#: at the points the lines are traced from is one matrix times that charge
#: (material-response's `field_matrix`): a drag beside the solved plate of
#: `run_with_variants` read the plate there in 64 ms a step, and reads it in
#: under one. Single precision, which a line cannot tell from double: 31 MB
#: for that plate's 996 unknowns at the 2,601 points of a drag, 99 MB at the
#: 8,281 of a scene at rest. Past it, the sheets are read as before: a scene
#: is never slower for it, only not faster.
MATRIX_MEMORY = 150_000_000

#: The matrices kept, by the sheets' fingerprint, the points' and the field:
#: `_Kept`s, the oldest first.
_matrices = collections.OrderedDict()
#: The sheets last read at each set of points, by fingerprint, and how many
#: times running: a matrix is built the second time a mesh is read there --
#: the third for fewer than `FEW_POINTS`, which a build reads no faster than
#: the kernel and a scene at rest reads once. Near contact a solve grades the
#: panels again at every step, and a matrix built for each would be thrown
#: away the next; once they settle, the steps after are fast.
_last_read = collections.OrderedDict()
#: The bytes of matrices that came out larger than `MATRIX_MEMORY` allowed,
#: by key, not built again while it allows less: material-response takes
#: three unknowns a face, not a panel, for a sheet whose charge is not linear
#: across its panels, twice what `_unknowns_at_most` counts.
_too_large = collections.OrderedDict()
_lock = threading.Lock()
FEW_POINTS = 1_500
#: How many sets of points, and matrices, are remembered at most.
_REMEMBERED = 256


class _Kept:
    """A built matrix, and the field matrix that reads a sheet's unknowns
    for it -- without the sheets it was built from, which it would keep, and
    with them the solve they came from: 8 to 35 MB a solve kept for reuse."""

    def __init__(self, reader, matrix):
        reader._sheets = None  # material-response's, read only when none are given
        self.reader, self.matrix = reader, matrix
        # the meshes it compares sheets with are its own copies
        self.nbytes = matrix.nbytes + sum(k[0].nbytes for k in reader._kinds)

    def __call__(self, sheets):
        charges = self.reader.charges(sheets).astype(self.matrix.dtype)
        return (self.matrix @ charges).astype(float).reshape(-1, 3)


def _sheets_by_matrix(sources, points, kind):
    """The field of the solved sheets among `sources` at `points` from a
    kept matrix, and the sources it leaves to compute -- or None and all of
    them, where there is no matrix to use: none built yet, one past
    `MATRIX_MEMORY`, a sheet on a path, a field other than B or H, or a
    material-response without `field_matrix`."""
    with _lock:
        _within(MATRIX_MEMORY)
    if MATRIX_MEMORY <= 0 or kind not in ("B", "H") or not len(points):
        return None, sources
    sheets = [s for s in sources if _charge_sheet(s) and s._get_path_len() == 1]
    if not sheets:
        return None, sources
    try:
        from magpylib_material_response.face_charge import field_matrix
    except ImportError:  # material-response 0.9.3 or earlier
        return None, sources
    meshes = _fingerprint(sheets)
    where = (hashlib.blake2b(points.tobytes(), digest_size=16).digest(), kind)
    key = (meshes, *where)
    with _lock:
        made = _matrices.get(key)
        if made is None:
            seen, times = _last_read.pop(where, (None, 0))
            times = times + 1 if seen == meshes else 1
            _last_read[where] = (meshes, times)
            while len(_last_read) > _REMEMBERED:
                _last_read.popitem(last=False)
            size = 3 * len(points) * _unknowns_at_most(sheets) * 4
            if (
                times < (2 if len(points) >= FEW_POINTS else 3)
                or max(size, _too_large.get(key, 0)) > MATRIX_MEMORY
            ):
                return None, sources
    if made is None:
        made = _built(field_matrix, sheets, points, kind)
        with _lock:
            if made.nbytes > MATRIX_MEMORY:
                _too_large[key] = made.nbytes
                while len(_too_large) > _REMEMBERED:
                    _too_large.popitem(last=False)
                return None, sources
            _matrices[key] = made
            _within(MATRIX_MEMORY)
    with _lock:
        if key in _matrices:
            _matrices.move_to_end(key)
    try:
        values = made(sheets)
    except ValueError:  # a mesh the fingerprint took for another
        with _lock:
            _matrices.pop(key, None)
        return None, sources
    ids = {id(s) for s in sheets}
    return values, [s for s in sources if id(s) not in ids]


def _within(memory):
    """Let the oldest matrices go until those kept take at most `memory`
    bytes, and at most `_REMEMBERED` of them; all of them for none."""
    while _matrices and (
        sum(m.nbytes for m in _matrices.values()) > memory
        or len(_matrices) > _REMEMBERED
    ):
        _matrices.popitem(last=False)
    if memory <= 0:
        _last_read.clear()


def _built(field_matrix, sheets, points, kind):
    """The sheets' matrix at `points`, built a slice of points at a time on
    the `THREADS` threads, as `_in_chunks` reads a field: in one call,
    material-response's own chunks took a gigabyte to build 99 MB."""
    faces = max(1, sum(len(s.faces) for s in sheets))
    rows = max(1, PAIRS_PER_CALL // THREADS // faces)
    slices = [(i, min(len(points), i + rows)) for i in range(0, len(points), rows)]

    def build(piece):
        i, j = piece
        return i, field_matrix(sheets, points[i:j], kind, dtype=np.float32)

    first = build(slices[0])
    matrix = np.empty((3 * len(points), first[1].matrix.shape[1]), dtype=np.float32)
    matrix[: 3 * slices[0][1]] = first[1].matrix
    rest = slices[1:]
    if THREADS == 1 or len(rest) < 2:
        built = map(build, rest)
    else:
        try:
            with ThreadPoolExecutor(min(THREADS, len(rest))) as pool:
                built = list(pool.map(build, rest))
        except RuntimeError:  # no thread to be had: one slice after another
            built = map(build, rest)
    for i, part in built:
        matrix[3 * i : 3 * i + part.matrix.shape[0]] = part.matrix
    return _Kept(first[1], matrix)


def _charge_sheet(source):
    return type(source).__name__ == "ChargeSheet" and _sheet(source)


def _fingerprint(sheets):
    """The sheets' meshes and poses, in one digest: what a matrix is built
    for, whatever their charge."""
    digest = hashlib.blake2b(digest_size=16)
    for sheet in sheets:
        digest.update(np.asarray(sheet.triangles).tobytes())
        digest.update(np.asarray(sheet.position, dtype=float).tobytes())
        digest.update(sheet.orientation.as_quat().tobytes())
    return digest.digest()


def _unknowns_at_most(sheets):
    """The unknowns a matrix of `sheets` takes, three per panel, as solved
    cuboids have them -- three per face for a sheet without panels."""
    return sum(
        3 * (len(np.unique(s.panels)) if s.panels is not None else len(s.faces))
        for s in sheets
    )


@_reading_inside
def inside(sources, points):
    """Which `points` are inside a magnet: where its polarization is not
    zero, as magpylib knows its shape. Currents have no inside.

    Cuboids are tested here, each point against the cuboids round it
    (`_inside_cuboids`): magpylib's `getJ` tests every point against every
    cuboid, which for a body meshed into thousands of cells cost a third as
    much as its field. Every other shape is magpylib's. A source on a path
    stands at its last step, as in `field`."""
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    within = np.zeros(len(points), dtype=bool)
    if not sources:
        return within
    cuboids = [s for s in sources if _cuboid(s)]
    sheets = [s for s in sources if _sheet(s)]
    others = [s for s in sources if not _cuboid(s) and not _sheet(s)]
    if cuboids:
        within |= _inside_cuboids(cuboids, points)
    if sheets:
        within |= _inside_sheets(sheets, points)
    if others:
        within |= np.linalg.norm(_in_chunks(magpy.getJ, others, points), axis=1) > 0
    return within


def _cuboid(source):
    return isinstance(source, magpy.magnet.Cuboid) and source.polarization is not None


def _sheet(source):
    """A solved face-charge sheet (`magpylib_material_response`): a surface
    round a body whose field it gives inside as H alone, B there lacking
    the body's magnetization, and which getJ does not see as a body."""
    return type(source).__module__.startswith("magpylib_material_response.face_charge")


def at_step(obj, step=None):
    """`obj` at `step` of its path, the last where None, every path property
    one entry long -- a shorter path at its own last -- and itself where its
    path is one step. A shallow copy, made as the object's class makes one:
    material-response's bind their field to the copy themselves."""
    if obj._get_path_len() == 1:
        return obj
    out = copy.copy(obj)
    for prop in obj._path_properties:
        value = getattr(obj, f"_{prop}", None)
        if value is not None:
            at = len(value) - 1 if step is None else min(max(step, 0), len(value) - 1)
            setattr(out, f"_{prop}", value[at : at + 1])
    return out


def _inside_sheets(sheets, points):
    """`inside` for solved sheets at their last step: the points their
    triangles enclose, all of them together -- parts solved as one leave
    out the faces they share, so only together are they closed. Tested as
    magpylib tests a TriangularMesh, by the crossings of a ray."""
    from magpylib._src.fields.field_BH_triangularmesh import (
        _mask_inside_trimesh,
    )

    triangles = []
    for sheet in sheets:
        turn = sheet.orientation if sheet.orientation.single else sheet.orientation[-1]
        # a copy: a sheet's arrays are read-only (material-response 0.9.1),
        # which scipy's `apply` refuses before 1.18 (#123)
        corners = np.array(sheet.triangles, dtype=float).reshape(-1, 3)
        moved = turn.apply(corners) + np.atleast_2d(sheet.position)[-1]
        triangles.append(moved.reshape(-1, 3, 3))
    triangles = np.concatenate(triangles)
    if not len(triangles):
        return np.zeros(len(points), dtype=bool)
    return _mask_inside_trimesh(points, triangles)


#: How far, relative to a half-side, a point may stand outside a cuboid and
#: still be in it: magpylib's own ``RTOL_SURFACE``.
_SURFACE = 1e-15


def _inside_cuboids(cuboids, points):
    """`inside` for cuboids at their last step, as magpylib's getJ answers
    it: in the cuboid's own frame, within its half-sides, polarization not
    zero. To rounding: a point on a turned cuboid's face is in or out by the
    last bit of a rotation, and that bit can fall either way here and there.
    Each point is tested only against the cuboids whose centres are within
    the largest half-diagonal of it -- a meshed body's neighbours -- found
    with a k-d tree; a cuboid far larger than the rest is tested against
    every point, so that one does not widen the search for all."""
    centres = np.array([np.atleast_2d(c.position)[-1] for c in cuboids], dtype=float)
    halves = np.abs(np.array([c.dimension for c in cuboids], dtype=float)) / 2
    turns = Rotation.concatenate(
        [c.orientation if c.orientation.single else c.orientation[-1] for c in cuboids]
    )
    live = np.array([np.any(c.polarization) for c in cuboids])
    reach = np.linalg.norm(halves, axis=1)
    large = reach > 4 * np.median(reach)
    pairs = []
    small = np.flatnonzero(~large & live)
    if len(small):
        # a hair wider: a corner is a half-diagonal off, which rounding can
        # put just past it; the test below decides
        wide = reach[small].max() * (1 + 1e-9)
        near = cKDTree(centres[small]).query_ball_point(points, wide)
        counts = np.fromiter((len(n) for n in near), dtype=int, count=len(points))
        pairs.append(
            (
                np.repeat(np.arange(len(points)), counts),
                small[np.fromiter((i for n in near for i in n), dtype=int)],
            )
        )
    for index in np.flatnonzero(large & live):
        pairs.append((np.arange(len(points)), np.full(len(points), index)))
    within = np.zeros(len(points), dtype=bool)
    for at, which in pairs:
        if not len(at):
            continue
        local = turns[which].apply(points[at] - centres[which], inverse=True)
        half = halves[which]
        hit = np.all(np.abs(local) - half < _SURFACE * half, axis=1)
        within[at[hit]] = True
    return within


#: The tolerance of material-response's compiled sheet kernel a saved page
#: computes with (#176): coarse while a sensor is dragged, fine once it is
#: let go. On the solved plate's 664 faces, 2,500 points take 7 ms at 1e-3
#: and 8,000 take 51 ms at 1e-6, against 237 ms exact; the error against
#: |H| is 3e-6 and 3e-9, finer than the 16 bits a live view sends.
PAGE_TOLERANCE = {"drag": 1e-3, "rest": 1e-6}


#: The most magnets a saved page computes the field of itself (#176): the
#: compiled cuboid takes about 215 ns a point in a browser (M4, 2026-11-22),
#: so a hundred of them cost 60 ms on a dragged sensor's new grid of 2,500
#: points and 200 ms on the 8,000 of the grid it is let go on. A body meshed
#: into thousands of cells would freeze the drag: such a page keeps its
#: lines as saved.
PAGE_CUBOIDS = 100
#: How many straight wire segments cost a page what one magnet does: a
#: segment takes about 13 ns a point against the cuboid's 215, so the
#: magnets and a sixteenth of the segments share `PAGE_CUBOIDS`.
SEGMENTS_PER_CUBOID = 16
#: And how many triangles, of a solved sheet or a magnet of triangles: one
#: takes 4.3 ns a point at a drag's tolerance and 9.2 at the release's, on the
#: solved plate's 664 (M4, 2026-11-22). Forty a magnet: a page of triangles
#: alone, 4,000 of them, costs 45 ms on a drag's new grid and 300 at its end.
TRIANGLES_PER_CUBOID = 40


def page_field(sources, sensors):
    """`page_field_why`'s field alone."""
    return page_field_why(sources, sensors)[0]


#: The kernels a page computes some sources with that not every build of
#: material-response's has, all of API 1: a page sends those sources only
#: where the kernels it carries have them (`page_kernels`).
PAGE_KERNELS = frozenset(
    {
        "polyline_field",
        "circle_field",
        "sphere_field",
        "dipole_field",
        "cylinder_field",
    }
)
#: How many wire segments a ring costs a page: about 21 ns a point (MR's
#: `circle_field`, 8,000 points in 0.17 ms) against a segment's 13.
SEGMENTS_PER_RING = 2
#: And a cylinder magnet: about 89 ns a point (MR's `cylinder_field`, 8,000
#: points in 0.71 ms), less than half the cuboid's 215.
SEGMENTS_PER_CYLINDER = 7


def page_field_why(sources, sensors, computes=PAGE_KERNELS):
    """What a saved page needs to draw `sensors`' lines again where they are
    dragged, with no python behind it (#176): the sources at their last
    step, each in its own frame as the compiled kernels take it -- a
    magnet's dimension and polarization, a wire's vertices and current, a
    solved sheet's triangles and the charge density at their corners, as
    `ChargeSheet.from_triangles` takes them -- each sensor's pixels in its
    own frame, and the rules `_field_lines` draws by. `sensors` are
    ``{key: sensor}``; those on a path are left out, whose pose a drag
    writes at every step. Wires, rings, balls and dipoles only where
    `computes` names their kernels (`PAGE_KERNELS`).

    ``(field, None)``, or ``(None, why)`` where a source is of a kind the
    kernels do not compute, more magnets, wire segments and triangles than
    `PAGE_CUBOIDS` allows, or no
    sensor is left: the page's lines then stay as they were drawn, and `why`
    says so in a few words, for the view to say after its export."""
    cuboids, cylinders, sheets, wires, rings, balls, dipoles, meshes, unknown = (
        [] for _ in range(9)
    )
    for source in sources:
        source = at_step(source)
        if (
            isinstance(source, magpy.magnet.TriangularMesh)
            and source.status_open is True
        ):
            # magpylib ray-tests an open mesh's inside all the same, which a
            # page, testing closed ones alone, would not match
            unknown.append("open TriangularMesh")
            continue
        charged = _charged_faces(source)
        if charged is not None:
            meshes.append(charged)
        elif "sphere_field" in computes and isinstance(source, magpy.magnet.Sphere):
            balls.append(
                {
                    "diameter": float(np.ravel(source.diameter)[-1]),
                    "polarization": np.asarray(
                        source.polarization, dtype=float
                    ).tolist(),
                    **_pose(source),
                }
            )
        elif "dipole_field" in computes and isinstance(source, magpy.misc.Dipole):
            dipoles.append(
                {
                    "moment": np.asarray(source.moment, dtype=float).tolist(),
                    **_pose(source),
                }
            )
        elif "polyline_field" in computes and isinstance(
            source, magpy.current.Polyline
        ):
            # a straight segment between each two vertices, in its own frame
            wires.append(
                {
                    "vertices": np.asarray(source.vertices, dtype=float).tolist(),
                    "current": float(np.ravel(source.current)[-1]),
                    **_pose(source),
                }
            )
        elif "circle_field" in computes and isinstance(source, magpy.current.Circle):
            # a loop in its own z = 0 plane, round its own origin
            rings.append(
                {
                    "diameter": float(np.ravel(source.diameter)[-1]),
                    "current": float(np.ravel(source.current)[-1]),
                    **_pose(source),
                }
            )
        elif (
            "cylinder_field" in computes
            and isinstance(source, magpy.magnet.Cylinder)
            and source.polarization is not None
        ):
            # round its own z axis, centred on its own origin
            cylinders.append(
                {
                    "dimension": np.asarray(source.dimension, dtype=float).tolist(),
                    "polarization": np.asarray(
                        source.polarization, dtype=float
                    ).tolist(),
                    **_pose(source),
                }
            )
        elif _cuboid(source):
            cuboids.append(
                {
                    "dimension": np.asarray(source.dimension, dtype=float).tolist(),
                    "polarization": np.asarray(
                        source.polarization, dtype=float
                    ).tolist(),
                    **_pose(source),
                }
            )
        elif _charge_sheet(source) and hasattr(source, "charge_densities"):
            sheets.append(
                {
                    # its arrays held once on a page (`widget._Shared`)
                    "kind": "fieldsheet",
                    "triangles": _float64(source.triangles),
                    "charge_densities": _float64(source.charge_densities),
                    **_pose(source),
                }
            )
        else:
            unknown.append(_kind_named(source))
    if unknown:
        kinds = ", ".join(sorted(set(unknown)))
        return None, f"it does not compute {kinds}"
    segments = sum(len(wire["vertices"]) - 1 for wire in wires)
    triangles = sum(
        len(base64.b64decode(s["triangles"])) // 72 for s in (*sheets, *meshes)
    )
    # a ball or a dipole costs no more than a segment, a ring two, a cylinder seven
    cheap = (
        segments
        + SEGMENTS_PER_RING * len(rings)
        + SEGMENTS_PER_CYLINDER * len(cylinders)
        + len(balls)
        + len(dipoles)
    )
    cost = len(cuboids) + cheap / SEGMENTS_PER_CUBOID + triangles / TRIANGLES_PER_CUBOID
    if cost > PAGE_CUBOIDS:
        counted = [
            f"{n} {name}"
            for n, name in (
                (len(cuboids), "magnets"),
                (len(cylinders), "cylinders"),
                (segments, "wire segments"),
                (len(rings), "rings"),
                (triangles, "triangles"),
            )
            if n
        ]
        return None, (
            f"{', '.join(counted)}: more than it computes at the pace of a drag"
        )
    moved = {
        key: _page_sensor(sensor)
        for key, sensor in sensors.items()
        if sensor._get_path_len() == 1
        and kind_of(sensor) is not None
        and _redrawn_in_page(sensor)
    }
    if not moved:
        return None, (
            "its sensors move on a path, or draw pixels sized by the field, "
            "hide null readings or use a 2D symbol"
        )
    field = {
        "mu0": float(magpy.mu_0),
        "rules": {
            "rest_points": REST_POINTS,
            "drag_points": DRAG_POINTS,
            "probe_points": PROBE_POINTS,
            "held_margin": HELD_MARGIN,
            "rest_margin": REST_MARGIN,
            "across": ACROSS,
            "surface": _SURFACE,
            "max_seeds": MAX_SEEDS,
            "tolerance": PAGE_TOLERANCE,
        },
        "cuboids": cuboids,
        "cylinders": cylinders,
        "sheets": sheets,
        "wires": wires,
        "rings": rings,
        "balls": balls,
        "dipoles": dipoles,
        "meshes": meshes,
        "sensors": moved,
    }
    return field, None


def _charged_faces(source):
    """A magnet made of triangles -- a `TriangularMesh`, a `Tetrahedron`, a
    `Triangle` -- as a page computes it (#176): a sheet of the charge J·n/mu0
    on each face, n its own normal as magpylib orients it, through
    material-response's sheet kernel, whose H it is everywhere, the body's
    inside too; B inside adds J, so its polarization comes along, and
    whether the faces close round a body, which only then has an inside.
    None for anything else, or a magnet with no polarization."""
    if getattr(source, "polarization", None) is None:
        return None
    if isinstance(source, magpy.magnet.TriangularMesh):
        faces, closed = np.asarray(source.mesh, dtype=float), not source.status_open
    elif isinstance(source, magpy.magnet.Tetrahedron):
        from magpylib._src.fields.field_BH_tetrahedron import _check_chirality

        v = _check_chirality(np.array(source.vertices, dtype=float)[None])[0]
        faces = v[[(0, 2, 1), (0, 1, 3), (1, 2, 3), (0, 3, 2)]]
        closed = True
    elif isinstance(source, magpy.misc.Triangle):
        faces, closed = np.asarray(source.vertices, dtype=float)[None], False
    else:
        return None
    normal = np.cross(faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0])
    normal /= np.linalg.norm(normal, axis=1, keepdims=True)
    polarization = np.asarray(source.polarization, dtype=float)
    charge = normal @ polarization / magpy.mu_0
    return {
        # its arrays held once on a page, as a solved sheet's
        "kind": "fieldsheet",
        "triangles": _float64(faces),
        "charge_densities": _float64(np.repeat(charge[:, None], 3, axis=1)),
        "polarization": polarization.tolist(),
        "closed": bool(closed),
        **_pose(source),
    }


def _kind_named(source):
    """`source`'s kind as a reader names it: a current's wire as currents
    are, ``currents (Polyline)``, a magnet by its class."""
    name = type(source).__name__
    if isinstance(source, magpy.current.Polyline | magpy.current.Circle):
        return f"currents ({name})"
    return name


#: The pixel shapes a page draws again where their sensor is dragged: those
#: the view draws itself from data (`threejs._pixels_payload`), turned by
#: the field, or cubes.
_PAGE_SYMBOLS = ("cone", "arrow3d", "none")


def _redrawn_in_page(sensor):
    """Whether a page can draw `sensor`'s pixels again where it drags it
    (#176): none drawn, or drawn as data the view turns and colours itself,
    each the same size whatever it reads, every one shown. Its arrows are
    then the field at the pixels and the colour table the page carries, as
    its lines are; sizes scaled by the field, hidden null readings and 2D
    symbols are magpylib's to draw, and such a sensor stays where it is."""
    from magpylib._src.style import get_style

    style = get_style(sensor, magpy.defaults).pixel
    if not style.size:
        return True
    field = style.field
    return (
        style.symbol == "cube"
        and field.symbol in _PAGE_SYMBOLS
        and field.sizescaling == "uniform"
        and bool(field.shownull)
    )


def _page_sensor(sensor):
    """A sensor as a page drags it: its pixels in its own frame and its
    pose, and what a rigid move leaves as it is -- the normal of the plane
    its pixels lie in, in its own frame (`frame_of`), or None, and their own
    spacing (`_apart`) -- so the page need not find them again."""
    seeds = seeds_of(sensor)
    axes, planar = frame_of(seeds)
    turn = Rotation.from_quat(np.atleast_2d(sensor.orientation.as_quat())[-1])
    source = sensor.style.pixel.field.source
    return {
        "kind": kind_of(sensor),
        # the axes of its own the field is read along, as `readings` reads it
        "components": source[1:] or "xyz",
        "pixels": np.asarray(sensor.pixel, dtype=float).reshape(-1, 3).tolist(),
        "normal": turn.inv().apply(axes[2]).tolist() if planar else None,
        "apart": _apart(seeds),
        **_pose(sensor),
    }


def _pose(obj):
    """`obj`'s position and orientation at its last step, the orientation as
    scipy's quaternion (x, y, z, w)."""
    return {
        "position": np.atleast_2d(np.asarray(obj.position, dtype=float))[-1].tolist(),
        "orientation": np.atleast_2d(obj.orientation.as_quat())[-1].tolist(),
    }


def _float64(values):
    """`values` as little-endian float64, in base64: every bit kept, which the
    page's field must match python's to."""
    raw = np.ascontiguousarray(values, dtype="<f8").tobytes()
    return base64.b64encode(raw).decode("ascii")


#: Where the compiled kernels are, as wasm-pack builds them: a folder with
#: ``mmr_kernels.js`` and ``mmr_kernels_bg.wasm``. Read when a page is written.
KERNELS_VARIABLE = "MAGPYLIB_STUDIO_KERNELS"


def kernel_files():
    """Where material-response's compiled field kernels are for a page
    (#176): its glue module and its WebAssembly, ``(js, wasm)`` paths, or
    None where they are not to be had. From the folder `KERNELS_VARIABLE`
    names, else from material-response's package -- found, not imported:
    a package that fails to import leaves a page without kernels, not
    unsaved."""
    import importlib.util

    folders = []
    named = os.environ.get(KERNELS_VARIABLE)
    if named:
        folders.append(Path(named).expanduser())
    try:
        spec = importlib.util.find_spec("magpylib_material_response")
    except (ImportError, ValueError):
        spec = None
    if spec is not None and spec.origin:
        folders.append(Path(spec.origin).parent / "kernels")
    for folder in folders:
        glue, wasm = folder / "mmr_kernels.js", folder / "mmr_kernels_bg.wasm"
        if glue.is_file() and wasm.is_file():
            return glue, wasm
    return None


def page_kernels():
    """material-response's compiled field kernels for a page (#176): its glue
    module's text and the WebAssembly, ``(js, wasm bytes)``, or None where
    they are not to be had (`kernel_files`). Read once while the files stay
    as they are. A prototype: how they reach studio for good is open
    (magpylib-material-response#215)."""
    files = kernel_files()
    if files is None:
        return None
    return _kernels_read(
        *((str(f), f.stat().st_mtime_ns, f.stat().st_size) for f in files)
    )


@functools.lru_cache(maxsize=2)
def _kernels_read(glue, wasm):
    """`page_kernels`' files read, each ``(path, mtime, size)``."""
    return Path(glue[0]).read_text(encoding="utf-8"), Path(wasm[0]).read_bytes()


def colours(sensor, readings):
    """The table a line of `sensor` is coloured from: colours for |field|
    evenly from the least to the most its pixels read, as its arrows are
    coloured -- by magpylib's own `scaled_norms` over the readings and
    `colors_from_colorscale`, with the sensor's ``colorscaling`` and
    ``colormap`` -- so a line and an arrow where they meet are one colour,
    and a change to either setting is the lines' too. ``(table, [low, high])``;
    past the readings a line takes the end colour.

    `readings` are the sensor's, as `pixel_fields` hands them over:
    ``(path_length, n_pixels, 3)``, or None where it reads nothing yet.
    """
    from magpylib.graphics.backend import colors_from_colorscale, scaled_norms

    from magpylib_studio.threejs import _resolve

    norms = (
        np.zeros(0) if readings is None else np.linalg.norm(readings, axis=-1).ravel()
    )
    read = norms[np.isfinite(norms) & (norms > 0)]
    scaling = _resolve(sensor, "style.pixel.field.colorscaling")
    if scaling == "uniform" or not len(read):
        # one colour, as the arrows then are: the pixels' own
        colour = str(_resolve(sensor, "style.pixel.color") or "black")
        return [colour, colour], [0.0, 1.0]
    low, high = float(read.min()), float(read.max())
    if high <= low:
        high = low * (1 + 1e-9) + 1e-30
    levels = np.linspace(low, high, LUT_STEPS)
    # among the readings, so they are spread over [0, 1] as the arrows' are
    factors = scaled_norms(np.concatenate([norms, levels]), scaling)[-LUT_STEPS:]
    colormap = _resolve(sensor, "style.pixel.field.colormap")
    table = colors_from_colorscale(factors, colormap, cmin=0, cmax=1)
    return list(table), [low, high]


def encoded_field(grid, values, within):
    """The grid, the field along its axes and which of its points are
    inside a magnet, as an item carries them: the part of `item` that costs,
    and that a field standing still through a drag keeps."""
    # 16 bits a component, against the peak: a quarter of the bytes JSON
    # numbers took, and 40 uT steps for a 1.3 T peak, finer than a line shows
    along = values @ grid["axes"].T
    peak = float(np.max(np.abs(along))) or 1.0
    quanta = np.round(along / peak * 32767).astype("<i2")
    return {
        "origin": np.asarray(grid["origin"]).tolist(),
        "axes": np.asarray(grid["axes"]).ravel().tolist(),
        "step": grid["step"],
        "shape": grid["shape"],
        "values": base64.b64encode(quanta.tobytes()).decode("ascii"),
        "scale": peak / 32767,
        "inside": base64.b64encode(np.packbits(within, bitorder="little")).decode(
            "ascii"
        ),
    }


def item(sensor, key, grid, values, within, seeds, readings, encoded=None, region=None):
    """The ``fieldlines`` item for `sensor`, drawn on its node as its lines'
    part (`threejs.PARTS`): the grid and the field on it (`encoded_field`,
    or `encoded` where that is in hand), the pixels to start from, nearest
    the middle first, how far apart to keep the lines, and the colours
    their |field| takes (`colours`).

    And the region the lines run in (`region_payload`): `region`, the box a
    region set on the sensor makes, whose lines stop at it and whose pixels
    outside it start none -- else the grid's own, which the rule laid."""
    from magpylib_studio.threejs import part_id

    lut, levels = colours(sensor, readings)
    box = box_of(grid) if region is None else region
    apart = spacing_of(seeds, grid)  # all the pixels', those left out too
    if region is not None:
        seeds = seeds[within_box(region, seeds, is_flat(grid))]
        if not len(seeds):
            seeds = np.empty((0, 3))
    # nearest first, equals in the pixels' order: a grid of pixels is all
    # ties, which numpy's default sort leaves in any order, and a saved page
    # dragging the sensor orders them again (#176) -- to a picometre, so
    # rounding does not part them
    if len(seeds):
        away = np.rint(np.linalg.norm(seeds - seeds.mean(axis=0), axis=1) * 1e12)
        starts = seeds[np.argsort(away, kind="stable")][:MAX_SEEDS]
    else:
        starts = seeds
    return {
        "kind": "fieldlines",
        "object_id": key,
        # a part of the sensor's drawing, hidden and faded apart from it
        "part": part_id(key, "lines"),
        "name": f"{sensor.style.label or 'Sensor'} field lines",
        **(encoded or encoded_field(grid, values, within)),
        "seeds": np.round(starts, 9).ravel().tolist(),
        "spacing": apart,
        "lut": lut,
        "levels": levels,
        "region": region_payload(box, region is not None),
        **_bar_of(sensor, lut, levels, readings),
    }


def _bar_of(sensor, lut, levels, readings):
    """What the colour bar reads of the lines of a sensor whose pixels are
    not drawn -- at ``style.pixel.size = 0``, the lines alone -- as it reads a
    pixels item's ``scale``: the table, its levels, the field and the scaling,
    and the sensor's name. The lines' table is the pixels' (`colours`), so the
    bar is the one the arrows would have. None for one colour throughout."""
    from magpylib_studio.threejs import _resolve

    scaling = _resolve(sensor, "style.pixel.field.colorscaling")
    if scaling == "uniform" or readings is None:
        return {}
    return {
        "label": sensor.style.label or "Sensor",
        "colour_scale": {
            "lut": lut,
            "levels": levels,
            "source": _resolve(sensor, "style.pixel.field.source"),
            "scaling": scaling,
        },
    }


#: The share of a map's |field| its colours span from each end: past them,
#: the end colour. The field next to a magnet's edge or a wire runs off to
#: what one point of the map shows, and spanned whole it left the rest in
#: the lowest colour.
MAP_SPAN = (1, 99)


def map_levels(item):
    """The |field| a sensor's map shows, from the least to the most bar the
    ends (`MAP_SPAN`): where it is drawn -- outside the magnets, inside a set
    region -- on the plane it is drawn on: the item's grid where that is
    flat, else the one sampled for it (`map_field`). None where it shows
    nothing."""
    plane = item if item["shape"][2] == 1 else item.get("map_field")
    if plane is None:
        return None
    values = np.frombuffer(base64.b64decode(plane["values"]), dtype="<i2")
    size = np.linalg.norm(values.reshape(-1, 3) * plane["scale"], axis=1)
    bits = np.frombuffer(base64.b64decode(plane["inside"]), dtype=np.uint8)
    inside = np.unpackbits(bits, bitorder="little")[: len(size)].astype(bool)
    keep = ~inside & np.isfinite(size) & (size > 0)
    region = item.get("region") or {}
    if region.get("set"):
        grid = {
            "origin": np.asarray(plane["origin"], dtype=float),
            "axes": np.reshape(plane["axes"], (3, 3)),
            "step": plane["step"],
            "shape": plane["shape"],
        }
        box = {
            "centre": np.asarray(region["centre"], dtype=float),
            "axes": np.reshape(region["axes"], (3, 3)),
            "size": np.asarray(region["size"], dtype=float),
        }
        keep &= within_box(box, points_of(grid), flat=True)
    if not keep.any():
        return None
    low, high = np.percentile(size[keep], MAP_SPAN)
    return [float(low), float(max(high, low * (1 + 1e-9) + 1e-30))]


def region_payload(box, chosen):
    """A region as an item carries it: its centre, its axes as nine numbers,
    rows first, and its sides, in the world -- and whether it was `chosen`,
    set on the sensor, or is the rule's."""
    return {
        "centre": np.round(np.asarray(box["centre"], dtype=float), 12).tolist(),
        "axes": np.round(np.asarray(box["axes"], dtype=float), 12).ravel().tolist(),
        "size": np.round(np.asarray(box["size"], dtype=float), 12).tolist(),
        "set": bool(chosen),
    }
