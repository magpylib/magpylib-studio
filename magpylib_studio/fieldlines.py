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
- **Where they end.** Leaving the grid, closing on itself, or where the field
  fades out; a line in a plane also at a magnet the plane cuts -- the grid
  points inside one, from magpylib's own polarization (`getJ`), so every
  shape it knows. A line in 3D goes through a magnet, as the field does.

During a gesture the grid is coarser and kept for its length, unless the
sensor itself moves: the field of what does not move is computed once and
only the moving sources' field added each frame, which is the whole field to
float precision -- see `MagpylibStudioSession._field_lines`.
"""

import base64

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
#: be drawn in it: a plane of symmetry has none, and the Halbach demo's bore,
#: whose rings are turned half a step apart, has 40 % -- its lines leave it.
ACROSS = 0.02
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


def field(sources, points, kind="B"):
    """B, or H, at `points` from `sources`, summed; zero for no sources."""
    if not sources:
        return np.zeros((len(points), 3))
    get = magpy.getH if kind == "H" else magpy.getB
    return np.asarray(get(sources, points, sumup=True)).reshape(-1, 3)


def inside(sources, points):
    """Which `points` are inside a magnet: where its polarization is not
    zero, as magpylib knows its shape. Currents have no inside."""
    if not sources:
        return np.zeros(len(points), dtype=bool)
    polarization = np.asarray(magpy.getJ(sources, points, sumup=True)).reshape(-1, 3)
    return np.linalg.norm(polarization, axis=1) > 0


def colours(sensor, readings):
    """The table a line of `sensor` is coloured from: colours for |field|
    evenly from the least to the most its pixels read, as its arrows are
    coloured -- by magpylib's own `scale_pixel_norms` over the readings and
    `colors_from_colorscale`, with the sensor's ``colorscaling`` and
    ``colormap`` -- so a line and an arrow where they meet are one colour,
    and a change to either setting is the lines' too. ``(table, [low, high])``;
    past the readings a line takes the end colour.

    `readings` are the sensor's, as `sensor_pixel_fields` hands them over:
    ``(path_length, n_pixels, 3)``, or None where it reads nothing yet.
    """
    from magpylib.graphics.backend import colors_from_colorscale, scale_pixel_norms

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
    factors = scale_pixel_norms(np.concatenate([norms, levels]), scaling)[-LUT_STEPS:]
    colormap = _resolve(sensor, "style.pixel.field.colormap")
    table = colors_from_colorscale(factors, colormap, cmin=0, cmax=1)
    return list(table), [low, high]


def item(sensor, key, grid, values, within, seeds, readings):
    """The ``fieldlines`` item for `sensor`, drawn on its node: the grid, the
    field along its axes, which points are inside a magnet, the pixels to
    start from, nearest the middle first, how far apart to keep the lines,
    and the colours their |field| takes (`colours`)."""
    lut, levels = colours(sensor, readings)
    # 16 bits a component, against the peak: a quarter of the bytes JSON
    # numbers took, and 40 uT steps for a 1.3 T peak, finer than a line shows
    along = values @ grid["axes"].T
    peak = float(np.max(np.abs(along))) or 1.0
    quanta = np.round(along / peak * 32767).astype("<i2")
    order = np.argsort(np.linalg.norm(seeds - seeds.mean(axis=0), axis=1))
    starts = seeds[order][:MAX_SEEDS]
    return {
        "kind": "fieldlines",
        "object_id": key,
        "name": f"{sensor.style.label or 'Sensor'} field lines",
        "origin": np.asarray(grid["origin"]).tolist(),
        "axes": np.asarray(grid["axes"]).ravel().tolist(),
        "step": grid["step"],
        "shape": grid["shape"],
        "values": base64.b64encode(quanta.tobytes()).decode("ascii"),
        "scale": peak / 32767,
        "inside": base64.b64encode(np.packbits(within, bitorder="little")).decode(
            "ascii"
        ),
        "seeds": np.round(starts, 9).ravel().tolist(),
        "spacing": spacing_of(seeds, grid),
        "lut": lut,
        "levels": levels,
    }
