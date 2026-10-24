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
  unstable to trace.

During a gesture the grid is coarser and kept for its length, unless the
sensor itself moves: the field of what does not move is computed once and
only the moving sources' field added each frame, which is the whole field to
float precision. A sensor dragged past sources that all stand still keeps a
grid too, fixed in the world, and the field on it, until its pixels leave
it (`holds`) -- see `MagpylibStudioSession._field_lines`.
"""

import base64
import os
from concurrent.futures import ThreadPoolExecutor

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
    plane: its lines have no plane to keep to."""
    if len(seeds) >= 3:
        _, spread, axes = np.linalg.svd(seeds - seeds.mean(axis=0))
        if spread[1] > 1e-3 * spread[0] and spread[2] <= 1e-6 * spread[0]:
            if np.linalg.det(axes) < 0:
                axes[2] = -axes[2]
            return axes, True
    return np.eye(3), False


def spacing_of(seeds, grid):
    """How far apart the lines are drawn: the seeds' own spacing -- the median
    distance to the nearest one -- or a thirtieth of a flat grid's larger
    side if that is finer, as matplotlib's streamplot spaces its lines by
    default; a few grid steps for a single pixel."""
    step = grid["step"]
    plane = grid["shape"][2] == 1
    finest = max(grid["shape"][:2]) * step / 30 if plane else np.inf
    if len(seeds) < 2:
        return float(min(4 * step, finest))
    distance, _ = cKDTree(seeds).query(seeds, k=2)
    apart = distance[:, 1][distance[:, 1] > 0]
    own = float(np.median(apart)) if len(apart) else 4 * step
    return float(min(own, finest))


def grid_around(sources, seeds, points, flat=None):
    """The grid for `seeds`: in their plane, if they lie in one and `flat` is
    not False, else a box;
    round them and the sources near them, padded by a quarter of its largest
    side, about `points` evenly spaced points.

    Near is within three times the seeds' own reach of their centre: the lines
    are about what the sensor sits in, and a grid stretched to a magnet
    dragged a metre off spreads its points so thin that the bore has none.
    """
    axes, planar = frame_of(seeds)
    if flat is False:
        axes, planar = np.eye(3), False
    centre = seeds.mean(axis=0)
    reach = 3 * max(float(np.max(np.linalg.norm(seeds - centre, axis=1))), 0.005)
    centres = [np.atleast_2d(np.asarray(s.position, dtype=float))[-1] for s in sources]
    near = [c for c in centres if np.linalg.norm(c - centre) <= reach]
    local = (np.vstack([*near, seeds]) - centre) @ axes.T
    low, high = local.min(axis=0), local.max(axis=0)
    pad = 0.25 * float(np.max(high - low)) or 0.01
    low, high = low - pad, high + pad
    if planar:
        low[2] = high[2] = 0.0  # the plane through the seeds
        span = (high - low)[:2]
        step = float(np.sqrt(np.prod(span) / points))
        shape = [*np.maximum(np.ceil(span / step).astype(int) + 1, 2), 1]
    else:
        span = high - low
        step = float((np.prod(span) / points) ** (1 / 3))
        shape = list(np.maximum(np.ceil(span / step).astype(int) + 1, 2))
    return {
        "origin": centre + low @ axes,
        "axes": axes,
        "step": step,
        "shape": [int(n) for n in shape],
    }


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
    view draws and a sensor's seeds stand at (`seeds_of`). One call is made
    where it is, and so are all where no thread can be started (Pyodide)."""
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


def field(sources, points, kind="B"):
    """B, or H, at `points` from `sources`, summed; zero for no sources."""
    if not sources:
        return np.zeros((len(points), 3))
    return _in_chunks(magpy.getH if kind == "H" else magpy.getB, sources, points)


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
    others = [s for s in sources if not _cuboid(s)]
    if cuboids:
        within |= _inside_cuboids(cuboids, points)
    if others:
        within |= np.linalg.norm(_in_chunks(magpy.getJ, others, points), axis=1) > 0
    return within


def _cuboid(source):
    return isinstance(source, magpy.magnet.Cuboid) and source.polarization is not None


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


def item(sensor, key, grid, values, within, seeds, readings, encoded=None):
    """The ``fieldlines`` item for `sensor`, drawn on its node as its lines'
    part (`threejs.PARTS`): the grid and the field on it (`encoded_field`,
    or `encoded` where that is in hand), the pixels to start from, nearest
    the middle first, how far apart to keep the lines, and the colours
    their |field| takes (`colours`)."""
    from magpylib_studio.threejs import part_id

    lut, levels = colours(sensor, readings)
    order = np.argsort(np.linalg.norm(seeds - seeds.mean(axis=0), axis=1))
    starts = seeds[order][:MAX_SEEDS]
    return {
        "kind": "fieldlines",
        "object_id": key,
        # a part of the sensor's drawing, hidden and faded apart from it
        "part": part_id(key, "lines"),
        "name": f"{sensor.style.label or 'Sensor'} field lines",
        **(encoded or encoded_field(grid, values, within)),
        "seeds": np.round(starts, 9).ravel().tolist(),
        "spacing": spacing_of(seeds, grid),
        "lut": lut,
        "levels": levels,
    }
