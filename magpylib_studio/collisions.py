"""Which magnets overlap, decided from the scene's geometry.

Magpylib adds the magnetizations of two magnets wherever they overlap, so an
overlap computes a field that looks plausible and is wrong, and nothing says
so. Touching is not overlapping: a Halbach ring or a stack touches on purpose.
A pair counts only when the two interpenetrate by more than `tol`.

The method:

* Every shape is a set of convex pieces, each known by its support function,
  its farthest point along a direction. That is exact for a cuboid, a
  cylinder, a sphere, a tetrahedron and a convex mesh: nothing curved is
  turned into triangles.
* Two convex pieces are compared by MPR (Minkowski portal refinement) after
  each solid one is shrunk by half the tolerance, so faces that touch end up
  apart and only a real interpenetration is found.
* A CylinderSegment with a bore, or one wider than 180 degrees, is not
  convex. It is cut into wedges of at most 90 degrees, and each wedge sits
  between two convex stand-ins: an outer one that covers it and a sliver of
  the bore, and an inner one that lies inside it. Missing the outer clears the
  wedge, hitting the inner proves the overlap, and anything else cuts the
  wedge in half and asks again. A shape within the bore's radius of the axis
  clears every wedge at once. A current loop is cut the same way.
* A mesh that is not convex is its triangles, plus one check that the other
  shape is not wholly inside it. Two such meshes overlap when an edge of one
  passes through a triangle of the other.

It takes magpylib objects and knows nothing of studio, so it can move into
magpylib as it is.
"""

from __future__ import annotations

import math
from collections import OrderedDict

import numpy as np
from scipy.spatial import ConvexHull, QhullError

#: How deep two shapes must interpenetrate to overlap, in metres: far above
#: the rounding of a scene in millimetres, far below anything built.
TOL = 1e-9

# Thirty halvings of a 90 degree wedge leave a sliver between its stand-ins a
# 1e-19th of the bore's radius thick: below the tolerance for any bore.
_MAX_CUTS = 30
# How many tests one pair of pieces may take. A guard a real scene does not
# reach; reached, the pair is called overlapping, since it was not shown clear.
_MAX_TESTS = 20_000
_MAX_ITER = 64

# How many points of a current loop are checked against a mesh that is not
# convex: the loop itself, not a polygon whose chords would cut into a
# faceted surface it only touches.
_LOOP_POINTS = 2048

# Bodies kept built between calls, by what they are made of: a drag moves one
# object, and the others' pieces -- a mesh's thousands of triangles -- stand.
_CACHE_SIZE = 16384
_cache: OrderedDict = OrderedDict()


# ------------------------------------------------------------------ vectors


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _unit(a):
    """`a` made unit length, scaled first so that a tiny vector -- the cross
    product of two nearly parallel ones -- does not underflow on the way."""
    big = max(abs(a[0]), abs(a[1]), abs(a[2]))
    if big == 0:
        return a
    a = (a[0] / big, a[1] / big, a[2] / big)
    return _mul(a, 1.0 / math.sqrt(_dot(a, a)))


def _basis(w):
    """Two unit vectors square to `w` and to each other."""
    t = (1.0, 0.0, 0.0) if abs(w[0]) < 0.9 else (0.0, 1.0, 0.0)
    e1 = _unit(_cross(w, t))
    return e1, _cross(w, e1)


def _off_axis(p, c, w):
    """How far `p` is from the line through `c` along unit `w`."""
    d = _sub(p, c)
    along = _dot(d, w)
    return math.sqrt(max(_dot(d, d) - along * along, 0.0))


# ------------------------------------------------------------------- shapes


class _Shape:
    """A convex shape in the world: a support function in its own frame, and
    where that frame stands. `center` is a point inside it (inside its plane,
    for a flat one), where MPR starts."""

    __slots__ = ("R", "_reach", "c", "center", "hi", "lo", "local", "size")

    def __init__(self, local, R, c, center=(0.0, 0.0, 0.0), reach=None):
        self.local = local
        self.R = R
        self.c = c
        self.center = self.to_world(center)
        self._reach = reach
        lo, hi = [], []
        for k in range(3):
            e = [0.0, 0.0, 0.0]
            e[k] = 1.0
            hi.append(self.support(tuple(e))[k])
            e[k] = -1.0
            lo.append(self.support(tuple(e))[k])
        self.lo, self.hi = lo, hi
        self.size = max(top - bottom for top, bottom in zip(hi, lo, strict=True))

    def to_world(self, p):
        R, c = self.R, self.c
        return (
            c[0] + R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
            c[1] + R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
            c[2] + R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
        )

    def axis(self):
        """Its own z, in the world."""
        return (self.R[2], self.R[5], self.R[8])

    def support(self, d):
        d = _unit(d)
        R = self.R
        p = self.local(
            R[0] * d[0] + R[3] * d[1] + R[6] * d[2],
            R[1] * d[0] + R[4] * d[1] + R[7] * d[2],
            R[2] * d[0] + R[5] * d[1] + R[8] * d[2],
        )
        return self.to_world(p)

    def corners(self):
        return [
            (x, y, z)
            for x in (self.lo[0], self.hi[0])
            for y in (self.lo[1], self.hi[1])
            for z in (self.lo[2], self.hi[2])
        ]

    def reach(self, c, w):
        """How far the shape reaches from the line through `c` along `w`:
        exact where the shape knows it, searched round the axis otherwise."""
        if self._reach is not None:
            found = self._reach(self, c, w)
            if found is not None:
                return found
        e1, e2 = _basis(w)

        def f(t):
            u = (
                e1[0] * math.cos(t) + e2[0] * math.sin(t),
                e1[1] * math.cos(t) + e2[1] * math.sin(t),
                e1[2] * math.cos(t) + e2[2] * math.sin(t),
            )
            return _dot(_sub(self.support(u), c), u)

        n = 96
        best = max(range(n), key=lambda i: f(2 * math.pi * i / n))
        lo, hi = 2 * math.pi * (best - 1) / n, 2 * math.pi * (best + 1) / n
        g = (math.sqrt(5) - 1) / 2
        for _ in range(40):
            x1, x2 = hi - g * (hi - lo), lo + g * (hi - lo)
            if f(x1) > f(x2):
                hi = x2
            else:
                lo = x1
        return max(f((lo + hi) / 2), f(2 * math.pi * best / n))


def _box(hx, hy, hz):
    def s(x, y, z):
        return (hx if x >= 0 else -hx, hy if y >= 0 else -hy, hz if z >= 0 else -hz)

    return s


def _ball(r):
    def s(x, y, z):
        n = math.sqrt(x * x + y * y + z * z) or 1.0
        return (r * x / n, r * y / n, r * z / n)

    return s


def _cylinder(r, hz):
    def s(x, y, z):
        rho = math.hypot(x, y)
        zz = hz if z >= 0 else -hz
        return (r * x / rho, r * y / rho, zz) if rho > 0 else (0.0, 0.0, zz)

    return s


def _points(pts):
    def s(x, y, z):
        best, bv = pts[0], -math.inf
        for p in pts:
            v = p[0] * x + p[1] * y + p[2] * z
            if v > bv:
                bv, best = v, p
        return best

    return s


def _arc_prism(R, a0, a1, pts, hz):
    """The hull of an arc of radius `R` from `a0` to `a1` (radians, turning
    counter-clockwise) and the flat points `pts`, as a prism of half-height
    `hz`: a wedge's stand-in, or with `hz` 0 the hull of a loop's arc."""
    ends = [(R * math.cos(a0), R * math.sin(a0)), (R * math.cos(a1), R * math.sin(a1))]
    cand = [*pts, *ends]
    span = a1 - a0

    def s(x, y, z):
        best, bv = cand[0], -math.inf
        for p in cand:
            v = p[0] * x + p[1] * y
            if v > bv:
                bv, best = v, p
        if x or y:
            t = math.atan2(y, x)
            if (t - a0) % (2 * math.pi) <= span:
                p = (R * math.cos(t), R * math.sin(t))
                if p[0] * x + p[1] * y > bv:
                    best = p
        return (best[0], best[1], hz if z >= 0 else -hz)

    return s


def _reach_of_points(pts):
    def reach(shape, c, w):
        return max(_off_axis(shape.to_world(p), c, w) for p in pts)

    return reach


def _reach_of_ball(r):
    def reach(shape, c, w):
        return _off_axis(shape.center, c, w) + r

    return reach


def _reach_of_round(r, pts=()):
    """A cylinder, or a wedge's stand-in: exact when its axis is the line's
    (a shaft in a bore, a ring in a ring), searched otherwise."""

    def reach(shape, c, w):
        a = shape.axis()
        if abs(abs(_dot(a, w)) - 1.0) > 1e-12:
            return None
        off = _off_axis(shape.c, c, w)
        if not pts:
            return off + r
        if off > 1e-12 * max(r, 1.0):
            return None
        return max(r, *(math.hypot(p[0], p[1]) for p in pts))

    return reach


# ------------------------------------------------------------------- pieces


class _Part:
    """A piece of a body as it is tested: the shape that covers it (`outer`),
    a shape inside it (`inner`, the same one unless it is a wedge), the bore
    that clears it, and how to halve it."""

    __slots__ = ("bore", "halve", "inner", "outer", "span")

    def __init__(self, outer, inner=None, bore=None, halve=None, span=0.0):
        self.outer = outer
        self.inner = inner or outer
        self.bore = bore
        self.halve = halve
        self.span = span


def _line_at(n, off, t, rho):
    """Where the line `p.n = off` meets the circle of radius `rho`, going out
    along `t`."""
    s = math.sqrt(max(rho * rho - off * off, 0.0))
    return (off * n[0] + s * t[0], off * n[1] + s * t[1])


def _meet(n1, o1, n2, o2):
    """Where the lines `p.n1 = o1` and `p.n2 = o2` cross."""
    det = n1[0] * n2[1] - n1[1] * n2[0]
    return ((o1 * n2[1] - o2 * n1[1]) / det, (n1[0] * o2 - n2[0] * o1) / det)


def _centre2(pts, R, a0, a1):
    mid = (a0 + a1) / 2
    every = [*pts, (R * math.cos(mid), R * math.sin(mid))]
    return (
        sum(p[0] for p in every) / len(every),
        sum(p[1] for p in every) / len(every),
        0.0,
    )


def _wedge(R, c, r1, r2, hz, a, b, face_a, face_b, m):
    """One wedge of a CylinderSegment already shrunk by `m`, between angles
    `a` and `b`. A side that is one of the segment's own faces sits `m`
    inside it; a side the cutting made does not move. Its outer stand-in has
    a chord where the bore is, its inner one a line tangent to the bore."""
    nL, oL, tL = (
        (-math.sin(a), math.cos(a)),
        (m if face_a else 0.0),
        (math.cos(a), math.sin(a)),
    )
    nR, oR, tR = (
        (math.sin(b), -math.cos(b)),
        (m if face_b else 0.0),
        (math.cos(b), math.sin(b)),
    )
    outer_left, outer_right = _line_at(nL, oL, tL, r2), _line_at(nR, oR, tR, r2)
    aL = math.atan2(outer_left[1], outer_left[0])
    aR = aL + ((math.atan2(outer_right[1], outer_right[0]) - aL) % (2 * math.pi))
    corner = _meet(nL, oL, nR, oR)
    walled = r1 > 0 and math.hypot(*corner) < r1  # the bore bounds the wedge
    inner_pts = (
        [_line_at(nL, oL, tL, r1), _line_at(nR, oR, tR, r1)] if walled else [corner]
    )
    outer = _Shape(
        _arc_prism(r2, aL, aR, inner_pts, hz),
        R,
        c,
        _centre2(inner_pts, r2, aL, aR),
        _reach_of_round(r2, inner_pts),
    )
    inner = None
    if walled:
        tL_ang = math.atan2(inner_pts[0][1], inner_pts[0][0])
        tR_ang = tL_ang + (
            (math.atan2(inner_pts[1][1], inner_pts[1][0]) - tL_ang) % (2 * math.pi)
        )
        mu = (tL_ang + tR_ang) / 2
        u = (math.cos(mu), math.sin(mu))
        pts, start, end = [], aL, aR
        half_chord = math.acos(min(r1 / r2, 1.0))
        left = _meet(nL, oL, u, r1)
        if math.hypot(*left) <= r2:
            pts.append(left)
        else:
            start = mu - half_chord
        right = _meet(nR, oR, u, r1)
        if math.hypot(*right) <= r2:
            pts.append(right)
        else:
            end = mu + half_chord
        inner = _Shape(
            _arc_prism(r2, start, end, pts, hz),
            R,
            c,
            _centre2(pts, r2, start, end),
            _reach_of_round(r2, pts),
        )

    def halve():
        mid = (a + b) / 2
        return [
            _wedge(R, c, r1, r2, hz, a, mid, face_a, False, m),
            _wedge(R, c, r1, r2, hz, mid, b, False, face_b, m),
        ]

    bore = (c, (R[2], R[5], R[8]), r1) if r1 > 0 else None
    return _Part(outer, inner, bore, halve, b - a)


def _arc(R, c, r, a, b):
    """One arc of a current loop: its hull covers it, a point on it is inside it."""
    ends = [(r * math.cos(a), r * math.sin(a)), (r * math.cos(b), r * math.sin(b))]
    mid = (a + b) / 2
    outer = _Shape(
        _arc_prism(r, a, b, ends, 0.0),
        R,
        c,
        _centre2(ends, r, a, b),
        _reach_of_round(r, ends),
    )
    point = (r * math.cos(mid), r * math.sin(mid), 0.0)
    inner = _Shape(_points([point]), R, c, point, _reach_of_points([point]))

    def halve():
        m = (a + b) / 2
        return [_arc(R, c, r, a, m), _arc(R, c, r, m, b)]

    return _Part(outer, inner, (c, (R[2], R[5], R[8]), r), halve, b - a)


_IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
_ORIGIN = (0.0, 0.0, 0.0)


def _flat_part(pts):
    """A piece with no volume -- a wire's segment, a sheet's or a mesh's
    triangle -- in the world already."""
    pts = [tuple(float(v) for v in p) for p in pts]
    centre = tuple(sum(p[k] for p in pts) / len(pts) for k in range(3))
    return _Part(
        _Shape(_points(pts), _IDENTITY, _ORIGIN, centre, _reach_of_points(pts))
    )


# ------------------------------------------------------------------- bodies


class _Body:
    """An object as the test sees it: `solid` (convex pieces, wedges among
    them), `mesh` (a closed surface that is not convex), `curve` or `sheet`
    (no thickness).

    A body with triangles -- a mesh, a sheet -- makes a piece of a triangle
    only when something comes near it: an imported part has thousands, and a
    magnet across the scene needs none of them. `probes` are its points for
    asking whether it is inside a mesh: inside it, never on its surface."""

    __slots__ = (
        "_made",
        "hi",
        "key",
        "kind",
        "lo",
        "parts",
        "probes",
        "segs",
        "tri_hi",
        "tri_lo",
        "tris",
    )

    def __init__(self, kind, probes, parts=None, tris=None, segs=None):
        self.kind = kind
        self.parts = parts
        self.tris = tris
        self.segs = segs
        self.probes = np.asarray(probes, dtype=float).reshape(-1, 3)
        self._made = {}
        if tris is not None:
            self.tri_lo, self.tri_hi = tris.min(axis=1), tris.max(axis=1)
            self.lo, self.hi = self.tri_lo.min(axis=0), self.tri_hi.max(axis=0)
        else:
            self.tri_lo = self.tri_hi = None
            self.lo = np.min([p.outer.lo for p in parts], axis=0)
            self.hi = np.max([p.outer.hi for p in parts], axis=0)

    def near(self, lo, hi):
        """Its pieces whose boxes meet the box from `lo` to `hi`."""
        if self.tris is None:
            return [
                p
                for p in self.parts
                if all(
                    p.outer.lo[k] < hi[k] and lo[k] < p.outer.hi[k] for k in range(3)
                )
            ]
        found = np.nonzero(
            np.all(self.tri_lo < hi, axis=1)
            & np.all(np.asarray(lo) < self.tri_hi, axis=1)
        )[0]
        out = []
        for i in found:
            part = self._made.get(i)
            if part is None:
                part = self._made[i] = _flat_part(self.tris[i])
            out.append(part)
        return out


def _pick(rows, step):
    """Row `step` of a value along a path: the last when `step` is None or
    past its end, as magpylib holds a shorter path at its last value."""
    return rows[-1] if step is None or step >= len(rows) else rows[step]


def _pose(obj, step=None):
    """Where an object stands at a step of its path, the last by default."""
    position = _pick(np.asarray(obj.position, dtype=float).reshape(-1, 3), step)
    rotation = _pick(obj.orientation.as_matrix().reshape(-1, 3, 3), step)
    return tuple(float(v) for v in rotation.ravel()), tuple(float(v) for v in position)


def _row(value, width, step=None):
    """A property that may vary along a path, at `step`."""
    return _pick(np.asarray(value, dtype=float).reshape(-1, width), step)


def _points_at(value, step=None):
    """Points that may vary along a path, at `step`."""
    points = np.asarray(value, dtype=float)
    while points.ndim > 2:
        points = _pick(points, step)
    return points.reshape(-1, 3)


def path_length(objects):
    """How many steps the longest path among `objects` has."""
    return max(
        (len(np.asarray(obj.position, dtype=float).reshape(-1, 3)) for obj in objects),
        default=1,
    )


def _world(R, c, pts):
    return np.asarray(pts, dtype=float) @ np.asarray(R).reshape(3, 3).T + np.asarray(c)


def _edges_of(faces):
    pairs = np.sort(
        np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1
    )
    return np.unique(pairs, axis=0)


def _inward_probe(tris, tol):
    """A point just inside a closed mesh: a few tolerances in from the middle
    of its largest face. Inside it, and never on another body's surface it
    merely touches."""
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    outward = (
        np.sign(np.einsum("ij,ij->", tris[:, 0], np.cross(tris[:, 1], tris[:, 2])))
        or 1.0
    )
    k = int(np.argmax(np.linalg.norm(normals, axis=1)))
    n = normals[k] / np.linalg.norm(normals[k]) * outward
    return tris[k].mean(axis=0) - 4 * tol * n


_shapes: OrderedDict = OrderedDict()


def _not_convex(vertices, tris, tol):
    """Whether some face has vertices beyond its own plane on both sides:
    proof a mesh is not convex, from a few faces, without building a hull.
    Faces chosen at random, seeded: a stride lands on the same wall of a
    mesh built round by round."""
    pick = tris[
        np.random.default_rng(0).choice(len(tris), min(len(tris), 256), replace=False)
    ]
    normals = np.cross(pick[:, 1] - pick[:, 0], pick[:, 2] - pick[:, 0])
    size = np.linalg.norm(normals, axis=1)
    normals, pick = normals[size > 0] / size[size > 0, None], pick[size > 0]
    side = (vertices @ normals.T) - np.einsum("ij,ij->i", pick[:, 0], normals)
    return bool(np.any((side.max(axis=0) > tol) & (side.min(axis=0) < -tol)))


def _mesh_shape(vertices, faces, m, tol):
    """What a mesh is in its own frame, whatever its pose: convex (its hull
    shrunk by `m`), or not (its edges, and a point just inside it). Kept by
    the mesh's own numbers, so that moving a mesh asks none of it again."""
    key = (m, tol, vertices.tobytes(), faces.tobytes())
    if key in _shapes:
        _shapes.move_to_end(key)
        return _shapes[key]
    tris = vertices[faces]
    shape = None
    if not _not_convex(vertices, tris, tol):
        volume = (
            abs(np.einsum("ij,ij->", tris[:, 0], np.cross(tris[:, 1], tris[:, 2]))) / 6
        )
        try:
            hull = ConvexHull(vertices)
        except (QhullError, ValueError):  # flat or degenerate: no volume to overlap
            hull = None
        if hull is not None and volume >= hull.volume * (1 - 1e-9):
            # shrunk about a point inside, by the nearest face's distance, so
            # that every face moves in by at least `m`
            centre = vertices[hull.vertices].mean(0)
            depth = -(hull.equations[:, :3] @ centre + hull.equations[:, 3]).max()
            corners = (
                centre
                + (vertices[hull.vertices] - centre) * max(depth - m, 0.0) / depth
            )
            shape = ("convex", [tuple(p) for p in corners], tuple(centre))
        elif hull is None:
            return None
    if shape is None:
        shape = ("mesh", _edges_of(faces), _inward_probe(tris, tol))
    _shapes[key] = shape
    if len(_shapes) > _CACHE_SIZE:
        _shapes.popitem(last=False)
    return shape


def _solid(part, probe):
    return _Body("solid", [probe], parts=[part] if isinstance(part, _Part) else part)


def _build(obj, m, tol, step=None):
    kind = type(obj).__name__
    R, c = _pose(obj, step)
    if kind == "Cuboid":
        h = np.maximum(_row(obj.dimension, 3, step) / 2 - m, 0.0)
        corners = [
            (sx * h[0], sy * h[1], sz * h[2])
            for sx in (-1, 1)
            for sy in (-1, 1)
            for sz in (-1, 1)
        ]
        return _solid(_Part(_Shape(_box(*h), R, c, reach=_reach_of_points(corners))), c)
    if kind == "Cylinder":
        d, height = _row(obj.dimension, 2, step)
        r, hz = max(d / 2 - m, 0.0), max(height / 2 - m, 0.0)
        return _solid(
            _Part(_Shape(_cylinder(r, hz), R, c, reach=_reach_of_round(r))), c
        )
    if kind == "Sphere":
        r = max(float(_row(obj.diameter, 1, step)[0]) / 2 - m, 0.0)
        return _solid(_Part(_Shape(_ball(r), R, c, reach=_reach_of_ball(r))), c)
    if kind == "Tetrahedron":
        # shrunk about its incentre, which moves every face in by the same `m`
        v = _points_at(obj.vertices, step)[:4]
        opposite = ((1, 2, 3), (0, 2, 3), (0, 1, 3), (0, 1, 2))
        areas = np.array(
            [
                np.linalg.norm(np.cross(v[j] - v[i], v[k] - v[i])) / 2
                for i, j, k in opposite
            ]
        )
        volume = abs(np.linalg.det(v[1:] - v[0])) / 6
        if volume == 0:
            return None
        centre = (areas[:, None] * v).sum(0) / areas.sum()
        r_in = 3 * volume / areas.sum()
        pts = [tuple(p) for p in centre + (v - centre) * max(r_in - m, 0.0) / r_in]
        shape = _Shape(_points(pts), R, c, tuple(centre), _reach_of_points(pts))
        return _solid(_Part(shape), shape.center)
    if kind == "CylinderSegment":
        r1, r2, height, p1, p2 = _row(obj.dimension, 5, step)
        span = math.radians(p2 - p1)
        full = span >= 2 * math.pi - 1e-12
        hz, r2 = max(height / 2 - m, 0.0), max(r2 - m, 0.0)
        if full and r1 == 0:
            return _solid(
                _Part(_Shape(_cylinder(r2, hz), R, c, reach=_reach_of_round(r2))), c
            )
        # within `m` of where the faces meet is within `m` of a face
        r1 = r1 + m if r1 > 0 else m
        a0, n = math.radians(p1), max(1, math.ceil(span / (math.pi / 2) - 1e-9))
        parts = [
            _wedge(
                R, c, r1, r2, hz,
                a0 + span * i / n, a0 + span * (i + 1) / n,
                not full and i == 0, not full and i == n - 1, m,
            )
            for i in range(n)
        ]  # fmt: skip
        mid, rm = a0 + span / 2, (r1 + r2) / 2
        return _solid(
            parts, _world(R, c, [rm * math.cos(mid), rm * math.sin(mid), 0.0])
        )
    if kind == "TriangularMesh":
        vertices = _points_at(obj.vertices, step)
        faces = np.asarray(obj.faces, dtype=int).reshape(-1, 3)
        shape = _mesh_shape(vertices, faces, m, tol)
        if shape is None:
            return None
        if shape[0] == "convex":
            _, pts, centre = shape
            solid = _Shape(_points(pts), R, c, centre, _reach_of_points(pts))
            return _solid(_Part(solid), solid.center)
        _, edges, probe = shape
        return _Body(
            "mesh",
            [_world(R, c, probe)],
            tris=_world(R, c, vertices[faces]),
            segs=_world(R, c, vertices)[edges],
        )
    if kind == "Polyline":
        pts = _world(R, c, _points_at(obj.vertices, step))
        if len(pts) < 2:
            return None
        segs = np.stack([pts[:-1], pts[1:]], axis=1)
        probes = np.concatenate([pts, segs.mean(axis=1)])
        return _Body("curve", probes, parts=[_flat_part(s) for s in segs], segs=segs)
    if kind == "Circle":
        r = float(_row(obj.diameter, 1, step)[0]) / 2
        if r <= 0:
            return None
        t = np.linspace(0, 2 * math.pi, _LOOP_POINTS, endpoint=False)
        ring = _world(R, c, np.stack([r * np.cos(t), r * np.sin(t), 0 * t], axis=1))
        parts = [
            _arc(R, c, r, i * math.pi / 2, (i + 1) * math.pi / 2) for i in range(4)
        ]
        # no segments: against a mesh the loop is its points, see `_LOOP_POINTS`
        return _Body("curve", ring, parts=parts)
    if kind in ("TriangleSheet", "TriangleStrip", "Triangle"):
        vertices = _points_at(obj.vertices, step)
        if kind == "TriangleSheet":
            faces = np.asarray(obj.faces, dtype=int).reshape(-1, 3)
        elif kind == "TriangleStrip":
            faces = np.array(
                [[i, i + 1, i + 2] for i in range(len(vertices) - 2)], dtype=int
            )
        else:
            faces = np.array([[0, 1, 2]])
        if not len(faces):
            return None
        world = _world(R, c, vertices[faces])
        segs = _world(R, c, vertices)[_edges_of(faces)]
        probes = np.concatenate(
            [world.reshape(-1, 3), world.mean(axis=1), segs.mean(axis=1)]
        )
        return _Body("sheet", probes, tris=world, segs=segs)
    return None


def _fingerprint(obj, step=None):
    """What an object's body is made of at `step`: its class, its pose and
    its geometry, as bytes -- equal for a rebuilt object that has not
    changed, and for every step at which it has not moved."""
    parts = [type(obj).__name__, *_pose(obj, step)]
    for name in ("dimension", "diameter", "vertices", "faces"):
        value = getattr(obj, name, None)
        if value is None:
            continue
        if name == "vertices":
            value = _points_at(value, step)
        elif name == "faces":
            value = np.asarray(value, dtype=float)
        else:
            value = np.asarray(value, dtype=float)
            value = _pick(value.reshape(-1, value.shape[-1] if value.ndim else 1), step)
        parts.append((name, value.shape, value.tobytes()))
    return tuple(parts)


def _body(obj, tol, step=None):
    """The body of a magpylib object at a step of its path, its solid pieces
    shrunk by half of `tol`; None for what has no shape to overlap with -- a
    sensor, a dipole, a custom source, a collection -- or no geometry yet."""
    try:
        key = (tol, _fingerprint(obj, step))
    except (AttributeError, TypeError, ValueError):
        return None
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    try:
        body = _build(obj, tol / 2, tol, step)
    except (AttributeError, IndexError, TypeError, ValueError, ZeroDivisionError):
        body = None  # a shape whose geometry is missing or degenerate
    if body is not None:
        body.key = key
    _cache[key] = body
    if len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return body


# ------------------------------------------------------------------- tests


def _mpr(A, B, eps):
    """Whether two convex shapes meet: Minkowski portal refinement (Snethen,
    XenoCollide). A ray from inside A - B towards the origin; a portal on
    A - B's surface where the ray leaves it, refined until the origin is
    behind it (they meet), beyond a support plane (they do not), or the
    portal is within `eps` of the surface (they do not, within `eps`).
    Quicker than GJK on round shapes, where GJK has to enclose the origin
    with points on a curved surface."""

    def S(n):
        return _sub(A.support(n), B.support(_mul(n, -1.0)))

    v0 = _sub(A.center, B.center)
    if max(abs(v0[0]), abs(v0[1]), abs(v0[2])) <= 1e-12 * max(A.size, B.size, 1e-300):
        return True  # a point inside each, in the same place
    n = _mul(v0, -1.0)
    v1 = S(n)
    if _dot(v1, _unit(n)) <= 0:
        return False
    n = _cross(v1, v0)
    if n == (0.0, 0.0, 0.0):
        return True  # the origin is on the segment from v0 to v1
    v2 = S(n)
    if _dot(v2, _unit(n)) <= 0:
        return False
    n = _cross(_sub(v1, v0), _sub(v2, v0))
    if _dot(n, v0) > 0:
        v1, v2 = v2, v1
        n = _mul(n, -1.0)
    for _ in range(_MAX_ITER):  # a portal the ray passes through
        v3 = S(n)
        if _dot(v3, _unit(n)) <= 0:
            return False
        if _dot(_cross(v1, v3), v0) < 0:
            v2, n = v3, _cross(_sub(v1, v0), _sub(v3, v0))
            continue
        if _dot(_cross(v3, v2), v0) < 0:
            v1, n = v3, _cross(_sub(v3, v0), _sub(v2, v0))
            continue
        break
    else:
        return False
    for _ in range(_MAX_ITER):  # refined towards the surface
        n = _cross(_sub(v2, v1), _sub(v3, v1))
        if n == (0.0, 0.0, 0.0):
            return True
        n = _unit(n)
        if _dot(n, v1) >= 0:
            return True
        v4 = S(n)
        if _dot(v4, n) <= 0 or _dot(_sub(v4, v3), n) <= eps:
            return False
        d1, d2, d3 = (
            _dot(_cross(v4, v1), v0),
            _dot(_cross(v4, v2), v0),
            _dot(_cross(v4, v3), v0),
        )
        if d1 < 0:
            if d2 < 0:
                v1 = v4
            else:
                v3 = v4
        elif d3 < 0:
            v2 = v4
        else:
            v1 = v4
    return False


def _in_bore(shape, bore, memo):
    """Whether `shape` stays within the bore's radius of its axis."""
    c, w, r = bore
    if _off_axis(shape.center, c, w) > r:
        return False  # a point of it is already outside
    if max(_off_axis(p, c, w) for p in shape.corners()) <= r:
        return True  # its whole box is inside
    key = (id(shape), bore)
    if key not in memo:
        memo[key] = shape.reach(c, w) <= r
    return memo[key]


def _decide(P, Q, depth, budget, eps, memo):
    """Whether pieces P and Q overlap, cutting a wedge in half while its two
    stand-ins disagree: the pair of pieces that shows it, or None."""
    budget[0] -= 1
    if budget[0] < 0:
        return (P, Q)  # not shown clear: say so rather than nothing
    for X, Y in ((P, Q), (Q, P)):
        if X.bore is not None and _in_bore(Y.outer, X.bore, memo):
            return None  # Y stays inside X's bore
    if not _mpr(P.outer, Q.outer, eps):
        return None
    if P.inner is P.outer and Q.inner is Q.outer:
        return (P, Q)
    if _mpr(P.inner, Q.inner, eps):
        return (P, Q)
    X = max(
        (p for p in (P, Q) if p.halve is not None), key=lambda p: p.span, default=None
    )
    if X is None or depth >= _MAX_CUTS:
        return None  # the sliver between the stand-ins is below the tolerance
    for half in X.halve():
        found = _decide(
            half if X is P else P, half if X is Q else Q, depth + 1, budget, eps, memo
        )
        if found:
            return found
    return None


def _pieces_overlap(A, B, eps):
    """Whether a piece of A and a piece of B overlap, among those whose boxes
    meet: the pair that shows it, or None. A is a body with pieces of its own
    (a solid, a curve)."""
    memo = {}
    for P in A.parts:
        for Q in B.near(P.outer.lo, P.outer.hi):
            found = _decide(P, Q, 0, [_MAX_TESTS], eps, memo)
            if found:
                return found
    return None


def _pierces(segs, tris, tol):
    """Whether a segment passes through a triangle, its two ends at least
    `tol` either side of the triangle's plane: a crossing, not a contact."""
    if segs is None or tris is None or not len(segs) or not len(tris):
        return False
    v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
    normal = np.cross(v1 - v0, v2 - v0)
    size = np.linalg.norm(normal, axis=1)
    keep = size > 0
    v0, v1, v2, normal = v0[keep], v1[keep], v2[keep], normal[keep] / size[keep, None]
    tri_lo = np.minimum(np.minimum(v0, v1), v2)
    tri_hi = np.maximum(np.maximum(v0, v1), v2)
    for start in range(0, len(segs), 256):
        p0, p1 = segs[start : start + 256, 0], segs[start : start + 256, 1]
        seg_lo, seg_hi = np.minimum(p0, p1), np.maximum(p0, p1)
        i, j = np.nonzero(
            np.all(seg_lo[:, None] <= tri_hi[None], -1)
            & np.all(tri_lo[None] <= seg_hi[:, None], -1)
        )
        if not len(i):
            continue
        d0 = np.einsum("ij,ij->i", p0[i] - v0[j], normal[j])
        d1 = np.einsum("ij,ij->i", p1[i] - v0[j], normal[j])
        across = ((d0 > tol) & (d1 < -tol)) | ((d0 < -tol) & (d1 > tol))
        i, j, d0, d1 = i[across], j[across], d0[across], d1[across]
        if not len(i):
            continue
        x = p0[i] + (d0 / (d0 - d1))[:, None] * (p1[i] - p0[i])
        e1, e2, q = v1[j] - v0[j], v2[j] - v0[j], x - v0[j]
        d11, d12, d22 = (e1 * e1).sum(1), (e1 * e2).sum(1), (e2 * e2).sum(1)
        q1, q2 = (q * e1).sum(1), (q * e2).sum(1)
        den = d11 * d22 - d12 * d12
        u, v = (d22 * q1 - d12 * q2) / den, (d11 * q2 - d12 * q1) / den
        if np.any((u >= 0) & (v >= 0) & (u + v <= 1)):
            return True
    return False


def _parity(tris, points):
    """For each point, whether an odd number of triangles cut a ray from it."""
    d = np.array([0.4472135955, 0.5773502691, 0.6831300511])
    e1, e2 = tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
    p = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, p)
    ok = np.abs(det) > 1e-300
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    out = np.zeros(len(points), dtype=bool)
    for start in range(0, len(points), 64):
        s = points[start : start + 64, None, :] - tris[None, :, 0]
        u = np.einsum("ptj,tj->pt", s, p) * inv
        q = np.cross(s, e1[None])
        v = (q @ d) * inv
        t = np.einsum("tj,ptj->pt", e2, q) * inv
        hits = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
        out[start : start + 64] = hits.sum(axis=1) % 2 == 1
    return out


def _distance(tris, point):
    """How far `point` is from the nearest of `tris`."""
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    ab, ac, ap = b - a, c - a, point - a
    n = np.cross(ab, ac)
    nn = np.einsum("ij,ij->i", n, n)
    flat = nn > 0
    along = np.einsum("ij,ij->i", ap, n) / np.where(flat, nn, 1)
    foot = ap - along[:, None] * n
    d00, d01, d11 = (ab * ab).sum(1), (ab * ac).sum(1), (ac * ac).sum(1)
    f0, f1 = (foot * ab).sum(1), (foot * ac).sum(1)
    den = np.where(flat, d00 * d11 - d01 * d01, 1)
    v, w = (d11 * f0 - d01 * f1) / den, (d00 * f1 - d01 * f0) / den
    inside = flat & (v >= 0) & (w >= 0) & (v + w <= 1)
    best = np.where(inside, np.abs(along) * np.sqrt(nn), np.inf)
    for s0, e in ((a, ab), (a, ac), (b, c - b)):
        ee = np.einsum("ij,ij->i", e, e)
        t = np.clip(
            np.einsum("ij,ij->i", point - s0, e) / np.where(ee > 0, ee, 1), 0, 1
        )
        best = np.minimum(best, np.linalg.norm(point - s0 - t[:, None] * e, axis=1))
    return float(best.min())


def _inside(mesh, points, tol):
    """Whether any of `points` is inside a closed mesh by more than `tol`:
    on its surface is touching it, not being inside it."""
    pts = np.asarray(points, dtype=float).reshape(-1, 3)
    pts = pts[np.all((pts > mesh.lo + tol) & (pts < mesh.hi - tol), axis=1)]
    if not len(pts):
        return False
    return any(_distance(mesh.tris, p) > tol for p in pts[_parity(mesh.tris, pts)])


def _overlap(A, B, tol):
    eps = tol / 8
    flat = ("curve", "sheet")
    if A.kind in flat and B.kind in flat:
        return False  # no thickness on either side
    if A.kind == "mesh" or B.kind == "mesh":
        mesh, other = (A, B) if A.kind == "mesh" else (B, A)
        if other.kind == "solid":
            return _pieces_overlap(other, mesh, eps) or _inside(mesh, other.probes, tol)
        # a mesh against a mesh, a wire or a sheet: an edge through a triangle,
        # or one inside the other
        if _pierces(other.segs, mesh.tris, tol) or _pierces(mesh.segs, other.tris, tol):
            return True
        return _inside(mesh, other.probes, tol) or (
            other.kind == "mesh" and _inside(other, mesh.probes, tol)
        )
    solid, other = (A, B) if A.kind == "solid" else (B, A)
    return _pieces_overlap(solid, other, eps)


def _candidates(lo, hi):
    """Pairs of boxes that overlap: sorted along x and swept, then y and z."""
    n = len(lo)
    order = np.argsort(lo[:, 0], kind="stable")
    lo_x = lo[order, 0]
    end = np.searchsorted(lo_x, hi[order, 0], side="left")
    counts = np.maximum(end - np.arange(n) - 1, 0)
    first = np.repeat(np.arange(n), counts)
    offset = np.arange(counts.sum()) - np.repeat(np.cumsum(counts) - counts, counts)
    a, b = order[first], order[first + 1 + offset]
    keep = np.all(lo[a] < hi[b], axis=1) & np.all(lo[b] < hi[a], axis=1)
    return a[keep], b[keep]


# ------------------------------------------------------- how much, how far


def _fibonacci(n):
    """`n` directions spread evenly over the sphere."""
    golden = math.pi * (3 - math.sqrt(5))
    out = []
    for i in range(n):
        z = 1 - (2 * i + 1) / n
        r = math.sqrt(1 - z * z)
        out.append((r * math.cos(golden * i), r * math.sin(golden * i), z))
    return out


_DIRECTIONS = _fibonacci(128)


def _penetration(A, B):
    """How deep two convex shapes interpenetrate: the shortest push that
    parts them, the smallest support of A - B over all directions. Searched
    from the best of a spread of directions, to a millionth of a radian:
    a number to show, not to decide by."""

    def f(n):
        return _dot(A.support(n), n) - _dot(B.support(_mul(n, -1.0)), n)

    starts = sorted((f(n), n) for n in _DIRECTIONS)[:2]
    best = starts[0][0]
    for value, n in starts:
        step, turn = 0.2, 0.0
        for _ in range(400):
            if step < 1e-6:
                break
            t1, t2 = _basis(n)
            moved = False
            for k in range(8):
                a = turn + k * math.pi / 4
                m = _unit(
                    tuple(
                        n[i] + step * (math.cos(a) * t1[i] + math.sin(a) * t2[i])
                        for i in range(3)
                    )
                )
                fm = f(m)
                if fm < value - 1e-15:
                    value, n, moved = fm, m, True
                    break
            if not moved:
                step, turn = step / 2, turn + 0.7
        best = min(best, value)
    return max(best, 0.0)


def _closest(simplex):
    """The point of a simplex (one to four points) nearest the origin, and
    the points it needs: Johnson's sub-algorithm, by Voronoi regions."""
    if len(simplex) == 1:
        return simplex[0], simplex
    if len(simplex) == 2:
        a, b = simplex
        ab = _sub(b, a)
        den = _dot(ab, ab)
        t = -_dot(a, ab) / den if den > 0 else 0.0
        if t <= 0:
            return a, [a]
        if t >= 1:
            return b, [b]
        return tuple(a[i] + t * ab[i] for i in range(3)), [a, b]
    if len(simplex) == 3:
        a, b, c = simplex
        ab, ac = _sub(b, a), _sub(c, a)
        d1, d2 = -_dot(ab, a), -_dot(ac, a)
        if d1 <= 0 and d2 <= 0:
            return a, [a]
        d3, d4 = -_dot(ab, b), -_dot(ac, b)
        if d3 >= 0 and d4 <= d3:
            return b, [b]
        vc = d1 * d4 - d3 * d2
        if vc <= 0 and d1 >= 0 and d3 <= 0:
            return _closest([a, b])
        d5, d6 = -_dot(ab, c), -_dot(ac, c)
        if d6 >= 0 and d5 <= d6:
            return c, [c]
        vb = d5 * d2 - d1 * d6
        if vb <= 0 and d2 >= 0 and d6 <= 0:
            return _closest([a, c])
        va = d3 * d6 - d5 * d4
        if va <= 0 and d4 - d3 >= 0 and d5 - d6 >= 0:
            return _closest([b, c])
        total = va + vb + vc
        if total == 0:
            return min(
                (_closest(e) for e in ([a, b], [a, c], [b, c])),
                key=lambda r: _dot(r[0], r[0]),
            )
        v, w = vb / total, vc / total
        return tuple(a[i] + v * ab[i] + w * ac[i] for i in range(3)), [a, b, c]
    best = None
    a, b, c, d = simplex
    for p, q, r, o in ((a, b, c, d), (a, c, d, b), (a, d, b, c), (b, d, c, a)):
        n = _cross(_sub(q, p), _sub(r, p))
        if -_dot(p, n) * _dot(_sub(o, p), n) < 0 or _dot(_sub(o, p), n) == 0:
            found = _closest([p, q, r])
            if best is None or _dot(found[0], found[0]) < _dot(best[0], best[0]):
                best = found
    return best or ((0.0, 0.0, 0.0), simplex)


def _apart(A, B, eps):
    """How far apart two convex shapes are, to `eps`: GJK in its distance
    form, stopped when the bound the last support point gives from below
    meets the distance to the simplex from above. 0 when they meet."""

    def S(n):
        return _sub(A.support(n), B.support(_mul(n, -1.0)))

    v = S(_sub(B.center, A.center))
    simplex, lower = [], 0.0
    for _ in range(_MAX_ITER):
        vv = _dot(v, v)
        if vv <= eps * eps:
            return 0.0
        nv = math.sqrt(vv)
        w = S(_mul(v, -1.0))
        lower = max(lower, _dot(v, w) / nv)
        if nv - lower <= eps or any(w == p for p in simplex):
            return nv
        simplex.append(w)
        v, simplex = _closest(simplex)
        if len(simplex) == 4:
            return 0.0
    return math.sqrt(_dot(v, v))


def _pieces(body):
    """Every piece of a body, made: a mesh's triangles too."""
    if body.tris is None:
        return body.parts
    return body.near(np.full(3, -np.inf), np.full(3, np.inf))


def _gap(A, B, precision):
    """How far apart two bodies are: the least distance between their
    pieces, found pair by pair in order of how near their boxes are, a wedge
    halved while the distances to its two stand-ins differ by more than
    `precision`, and anything that cannot be nearer than the best so far
    left alone."""
    pa, pb = _pieces(A), _pieces(B)
    lo_a = np.array([p.outer.lo for p in pa])
    hi_a = np.array([p.outer.hi for p in pa])
    lo_b = np.array([p.outer.lo for p in pb])
    hi_b = np.array([p.outer.hi for p in pb])
    apart = np.maximum(
        0.0, np.maximum(lo_b[None] - hi_a[:, None], lo_a[:, None] - hi_b[None])
    )
    boxes = np.linalg.norm(apart, axis=-1)
    best = [math.inf]
    memo = {}

    def between(P, Q, depth):
        lower = _apart(P.outer, Q.outer, precision / 4)
        for X, Y in ((P, Q), (Q, P)):
            if X.bore is not None:
                c, w, r = X.bore
                lower = max(lower, r - Y.outer.reach(c, w))  # Y in the bore
        if lower >= best[0] - precision:
            return
        whole = P.inner is P.outer and Q.inner is Q.outer
        upper = lower if whole else _apart(P.inner, Q.inner, precision / 4)
        best[0] = min(best[0], upper)
        if upper - lower <= precision or depth >= _MAX_CUTS:
            return
        X = max((p for p in (P, Q) if p.halve), key=lambda p: p.span, default=None)
        if X is None:
            return
        for half in X.halve():
            between(half if X is P else P, half if X is Q else Q, depth + 1)

    for flat in np.argsort(boxes, axis=None):
        i, j = np.unravel_index(flat, boxes.shape)
        if boxes[i, j] >= best[0] - precision:
            break
        between(pa[i], pb[j], 0)
    del memo
    return best[0]


def _depth(proof, tol):
    """How deep the overlap a proof shows goes, or None when it was shown
    some other way -- through a mesh's surface, or one wholly inside."""
    if not isinstance(proof, tuple):
        return None
    P, Q = proof
    # the inner stand-ins lie inside their pieces: at least this deep
    return _penetration(P.inner, Q.inner) + tol


def separation(a, b, tol=TOL, step=None):
    """How two objects stand to each other: ``("gap", d)`` d metres apart,
    ``("touch", 0.0)``, ``("overlap", depth)`` -- depth None where it is not
    known -- or None when either has no shape to measure."""
    A, B = _body(a, tol, step), _body(b, tol, step)
    if A is None or B is None:
        return None
    proof = _overlap(A, B, tol)
    if proof:
        return ("overlap", _depth(proof, tol))
    size = float(max(np.max(A.hi - A.lo), np.max(B.hi - B.lo)))
    # the shrinking parts every pair by the tolerance it takes away
    d = _gap(A, B, max(10 * tol, 1e-6 * size)) - tol
    return ("touch", 0.0) if d <= tol else ("gap", d)


def find_overlaps(objects, tol=TOL, step=None, depths=False):
    """The pairs of `objects` that overlap, as index pairs `(i, j)`, `i < j`;
    with `depths`, as ``(i, j, depth)``, depth in metres or None where it is
    not known.

    Two objects overlap when they interpenetrate by more than `tol` metres;
    touching does not count. Collections are not looked into: pass their
    leaves. What has no shape to overlap with -- a sensor, a dipole, a custom
    source, a shape not yet given its geometry -- is never in a pair, and
    neither are two wires or two sheets, which have no thickness. Each object
    is taken where it is at `step` of its path, the last by default.
    """
    bodies = [_body(obj, tol, step) for obj in objects]
    index = [k for k, body in enumerate(bodies) if body is not None]
    if len(index) < 2:
        return []
    lo = np.array([bodies[k].lo for k in index])
    hi = np.array([bodies[k].hi for k in index])
    found = {}
    for a, b in zip(*_candidates(lo, hi), strict=True):
        i, j = sorted((index[a], index[b]))
        proof = _decided(bodies[i], bodies[j], tol)
        if proof:
            found[(i, j)] = (
                _measured(bodies[i], bodies[j], proof, tol) if depths else None
            )
    if depths:
        return [(i, j, found[i, j]) for i, j in sorted(found)]
    return sorted(found)


# Whether each pair of bodies near enough to ask overlaps, by what the two are
# made of, as `_depths` keeps how deep: a drag moves one magnet, and every
# pair it is not in stands. Asked again each step, the touching pairs of a
# ring of 96 were a fifth of the step.
_verdicts: OrderedDict = OrderedDict()


def _decided(A, B, tol):
    key = (A.key, B.key, tol)
    if key not in _verdicts:
        _verdicts[key] = _overlap(A, B, tol)
        if len(_verdicts) > _CACHE_SIZE:
            _verdicts.popitem(last=False)
    _verdicts.move_to_end(key)
    return _verdicts[key]


# How deep each overlapping pair goes, by what its two bodies are made of: a
# drag moves one magnet, and the others' depths stand.
_depths: OrderedDict = OrderedDict()


def _measured(A, B, proof, tol):
    key = (A.key, B.key)
    if key not in _depths:
        _depths[key] = _depth(proof, tol)
        if len(_depths) > _CACHE_SIZE:
            _depths.popitem(last=False)
    _depths.move_to_end(key)
    return _depths[key]


def overlaps_along(objects, tol=TOL):
    """The pairs that overlap at each step of the longest path among
    `objects`: a list with an entry per step, each as `find_overlaps` gives
    it. Pairs of objects that stand still are decided once; only pairs with
    something moving are asked again at each step."""
    steps = path_length(objects)
    moving = {
        k
        for k, obj in enumerate(objects)
        if len(np.asarray(obj.position).reshape(-1, 3)) > 1
        or len(obj.orientation.as_quat().reshape(-1, 4)) > 1
    }
    still = [k for k in range(len(objects)) if k not in moving]
    fixed = [
        (still[i], still[j]) for i, j in find_overlaps([objects[k] for k in still], tol)
    ]
    along = []
    for step in range(steps):
        bodies = [_body(obj, tol, step) for obj in objects]
        index = [k for k, body in enumerate(bodies) if body is not None]
        found = set(fixed)
        if moving and len(index) > 1:
            lo = np.array([bodies[k].lo for k in index])
            hi = np.array([bodies[k].hi for k in index])
            for a, b in zip(*_candidates(lo, hi), strict=True):
                i, j = sorted((index[a], index[b]))
                if (i in moving or j in moving) and _overlap(bodies[i], bodies[j], tol):
                    found.add((i, j))
        along.append(sorted(found))
    return along
