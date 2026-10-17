"""Which magnets overlap, decided from the scene's geometry.

Magpylib adds the magnetizations of two magnets wherever they overlap, so an
overlap computes a field that looks plausible and is wrong, and nothing says
so. Touching is not overlapping: a Halbach ring or a stack touches on purpose.
A pair counts only when the two interpenetrate by more than `tol`.

The method (docs/plans/overlaps.md):

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

import numpy as np
from scipy.spatial import ConvexHull, QhullError

#: How deep two shapes must interpenetrate to overlap, in metres: far above
#: the rounding of a scene in millimetres, far below anything built.
TOL = 1e-9

# Guards a real scene does not reach. Twelve halvings of a 90 degree wedge
# leave a sliver a hundred-millionth of the bore's radius thick.
_MAX_CUTS = 12
_MAX_TESTS = 5000
_MAX_ITER = 64

# A current loop meets a mesh's triangles as this many straight segments.
_LOOP_SEGMENTS = 256


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
    n = math.sqrt(_dot(a, a))
    return _mul(a, 1.0 / n) if n else a


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

    __slots__ = ("R", "_reach", "c", "center", "hi", "lo", "local")

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
        R = self.R
        p = self.local(
            R[0] * d[0] + R[3] * d[1] + R[6] * d[2],
            R[1] * d[0] + R[4] * d[1] + R[7] * d[2],
            R[2] * d[0] + R[5] * d[1] + R[8] * d[2],
        )
        return self.to_world(p)

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
    outer_d = (r2, aL, aR, inner_pts, hz)
    outer = _Shape(
        _arc_prism(*outer_d),
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


def _segment_parts(R, c, pts):
    """Convex pieces with no volume -- a wire's segments, a sheet's triangles --
    in the world already, so posed at the identity."""
    return [
        _Part(_Shape(_points(p), R, c, tuple(np.mean(p, axis=0)), _reach_of_points(p)))
        for p in pts
    ]


# ------------------------------------------------------------------- bodies


class _Body:
    """An object as the test sees it: `solid` (convex pieces, wedges among
    them), `mesh` (a closed surface that is not convex: its triangles),
    `curve` or `sheet` (no thickness)."""

    __slots__ = ("hi", "kind", "lo", "parts", "sample", "segs", "tris")

    def __init__(self, kind, parts, sample, tris=None, segs=None):
        self.kind = kind
        self.parts = parts
        self.sample = np.asarray(sample, dtype=float)
        self.tris = tris
        self.segs = segs
        self.lo = np.min([p.outer.lo for p in parts], axis=0)
        self.hi = np.max([p.outer.hi for p in parts], axis=0)


_IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)


def _pose(obj):
    """Where an object stands at the last step of its path."""
    position = np.asarray(obj.position, dtype=float).reshape(-1, 3)[-1]
    rotation = obj.orientation.as_matrix().reshape(-1, 3, 3)[-1]
    return tuple(float(v) for v in rotation.ravel()), tuple(float(v) for v in position)


def _last(value, width):
    return np.asarray(value, dtype=float).reshape(-1, width)[-1]


def _world(R, c, pts):
    return np.asarray(pts, dtype=float) @ np.asarray(R).reshape(3, 3).T + np.asarray(c)


def _edges_of(faces):
    pairs = np.sort(
        np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1
    )
    return np.unique(pairs, axis=0)


def _body(obj, m):
    """The body of a magpylib object, its solid pieces shrunk by `m`; None
    for what has no shape to overlap with: a sensor, a dipole, a custom
    source, a collection."""
    kind = type(obj).__name__
    try:
        R, c = _pose(obj)
    except AttributeError:
        return None
    if kind == "Cuboid":
        h = np.maximum(_last(obj.dimension, 3) / 2 - m, 0.0)
        corners = [
            (sx * h[0], sy * h[1], sz * h[2])
            for sx in (-1, 1)
            for sy in (-1, 1)
            for sz in (-1, 1)
        ]
        return _Body(
            "solid", [_Part(_Shape(_box(*h), R, c, reach=_reach_of_points(corners)))], c
        )
    if kind == "Cylinder":
        d, height = _last(obj.dimension, 2)
        r, hz = max(d / 2 - m, 0.0), max(height / 2 - m, 0.0)
        return _Body(
            "solid",
            [_Part(_Shape(_cylinder(r, hz), R, c, reach=_reach_of_round(r)))],
            c,
        )
    if kind == "Sphere":
        r = max(float(_last(obj.diameter, 1)[0]) / 2 - m, 0.0)
        return _Body(
            "solid", [_Part(_Shape(_ball(r), R, c, reach=_reach_of_ball(r)))], c
        )
    if kind == "Tetrahedron":
        # shrunk about its incentre, which moves every face in by the same `m`
        v = _last(obj.vertices, 12).reshape(4, 3)
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
        return _Body(
            "solid",
            [_Part(_Shape(_points(pts), R, c, tuple(centre), _reach_of_points(pts)))],
            c,
        )
    if kind == "CylinderSegment":
        r1, r2, height, p1, p2 = _last(obj.dimension, 5)
        span = math.radians(p2 - p1)
        full = span >= 2 * math.pi - 1e-12
        hz, r2 = max(height / 2 - m, 0.0), max(r2 - m, 0.0)
        if full and r1 == 0:
            return _Body(
                "solid",
                [_Part(_Shape(_cylinder(r2, hz), R, c, reach=_reach_of_round(r2)))],
                c,
            )
        # within `m` of where the faces meet is within `m` of a face
        r1 = r1 + m if r1 > 0 else m
        a0, n = math.radians(p1), max(1, math.ceil(span / (math.pi / 2) - 1e-9))
        parts = [
            _wedge(
                R,
                c,
                r1,
                r2,
                hz,
                a0 + span * i / n,
                a0 + span * (i + 1) / n,
                not full and i == 0,
                not full and i == n - 1,
                m,
            )
            for i in range(n)
        ]
        mid, rm = a0 + span / 2, (r1 + r2) / 2
        return _Body(
            "solid", parts, _world(R, c, [rm * math.cos(mid), rm * math.sin(mid), 0.0])
        )
    if kind == "TriangularMesh":
        vertices = np.asarray(obj.vertices, dtype=float)
        faces = np.asarray(obj.faces, dtype=int)
        tris = vertices[faces]
        volume = (
            abs(
                np.einsum(
                    "ij,ij->i", tris[:, 0], np.cross(tris[:, 1], tris[:, 2])
                ).sum()
            )
            / 6
        )
        try:
            hull = ConvexHull(vertices)
        except (QhullError, ValueError):  # flat or degenerate: no volume to overlap
            return None
        convex = volume >= hull.volume * (1 - 1e-9)
        if convex:
            centre = vertices[hull.vertices].mean(0)
            depth = -(hull.equations[:, :3] @ centre + hull.equations[:, 3]).min()
            pts = [
                tuple(p)
                for p in centre
                + (vertices[hull.vertices] - centre) * max(depth - m, 0.0) / depth
            ]
            return _Body(
                "solid",
                [
                    _Part(
                        _Shape(_points(pts), R, c, tuple(centre), _reach_of_points(pts))
                    )
                ],
                c,
            )
        world = _world(R, c, tris)
        edges = _edges_of(faces)
        segs = _world(R, c, vertices)[edges]
        return _Body(
            "mesh",
            _segment_parts(
                _IDENTITY, (0.0, 0.0, 0.0), [list(map(tuple, t)) for t in world]
            ),
            world[0, 0],
            tris=world,
            segs=segs,
        )
    if kind == "Polyline":
        pts = _world(R, c, np.asarray(obj.vertices, dtype=float).reshape(-1, 3))
        if len(pts) < 2:
            return None
        segs = np.stack([pts[:-1], pts[1:]], axis=1)
        return _Body(
            "curve",
            _segment_parts(
                _IDENTITY, (0.0, 0.0, 0.0), [list(map(tuple, s)) for s in segs]
            ),
            pts[0],
            segs=segs,
        )
    if kind == "Circle":
        r = float(_last(obj.diameter, 1)[0]) / 2
        if r <= 0:
            return None
        parts = [
            _arc(R, c, r, i * math.pi / 2, (i + 1) * math.pi / 2) for i in range(4)
        ]
        t = np.linspace(0, 2 * math.pi, _LOOP_SEGMENTS + 1)
        ring = _world(R, c, np.stack([r * np.cos(t), r * np.sin(t), 0 * t], axis=1))
        return _Body(
            "curve", parts, ring[0], segs=np.stack([ring[:-1], ring[1:]], axis=1)
        )
    if kind in ("TriangleSheet", "TriangleStrip", "Triangle"):
        vertices = np.asarray(obj.vertices, dtype=float).reshape(-1, 3)
        if kind == "TriangleSheet":
            faces = np.asarray(obj.faces, dtype=int).reshape(-1, 3)
        elif kind == "TriangleStrip":
            faces = np.array(
                [[i, i + 1, i + 2] for i in range(len(vertices) - 2)], dtype=int
            )
        else:
            faces = np.array([[0, 1, 2]])
        world = _world(R, c, vertices[faces])
        segs = _world(R, c, vertices)[_edges_of(faces)]
        return _Body(
            "sheet",
            _segment_parts(
                _IDENTITY, (0.0, 0.0, 0.0), [list(map(tuple, t)) for t in world]
            ),
            world[0, 0],
            tris=world,
            segs=segs,
        )
    return None


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
    if v0 == (0.0, 0.0, 0.0):
        v0 = (1e-300, 0.0, 0.0)
    n = _mul(v0, -1.0)
    v1 = S(n)
    if _dot(v1, n) <= 0:
        return False
    n = _cross(v1, v0)
    if n == (0.0, 0.0, 0.0):
        return True  # the origin is on the segment from v0 to v1
    v2 = S(n)
    if _dot(v2, n) <= 0:
        return False
    n = _cross(_sub(v1, v0), _sub(v2, v0))
    if _dot(n, v0) > 0:
        v1, v2 = v2, v1
        n = _mul(n, -1.0)
    for _ in range(_MAX_ITER):  # a portal the ray passes through
        v3 = S(n)
        if _dot(v3, n) <= 0:
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
        nn = math.sqrt(_dot(n, n))
        if nn == 0:
            return True
        n = _mul(n, 1.0 / nn)
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


def _decide(P, Q, depth, budget, eps):
    """Whether pieces P and Q overlap, cutting a wedge in half while its two
    stand-ins disagree."""
    budget[0] -= 1
    if budget[0] < 0:
        return False
    for X, Y in ((P, Q), (Q, P)):
        if X.bore is not None and Y.outer.reach(X.bore[0], X.bore[1]) <= X.bore[2]:
            return False  # Y stays inside X's bore
    if not _mpr(P.outer, Q.outer, eps):
        return False
    if P.inner is P.outer and Q.inner is Q.outer:
        return True
    if _mpr(P.inner, Q.inner, eps):
        return True
    X = max(
        (p for p in (P, Q) if p.halve is not None), key=lambda p: p.span, default=None
    )
    if X is None or depth >= _MAX_CUTS:
        return False  # the sliver between the stand-ins is below the tolerance
    for half in X.halve():
        if _decide(
            half if X is P else P, half if X is Q else Q, depth + 1, budget, eps
        ):
            return True
    return False


def _boxes_meet(a_lo, a_hi, b_lo, b_hi):
    return np.all(a_lo[:, None, :] < b_hi[None, :, :], axis=-1) & np.all(
        b_lo[None, :, :] < a_hi[:, None, :], axis=-1
    )


def _pieces_overlap(A, B, eps):
    a_lo = np.array([p.outer.lo for p in A.parts])
    a_hi = np.array([p.outer.hi for p in A.parts])
    b_lo = np.array([p.outer.lo for p in B.parts])
    b_hi = np.array([p.outer.hi for p in B.parts])
    budget = [_MAX_TESTS]
    for i, j in zip(*np.nonzero(_boxes_meet(a_lo, a_hi, b_lo, b_hi)), strict=True):
        if _decide(A.parts[i], B.parts[j], 0, budget, eps):
            return True
    return False


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


def _inside(mesh, point):
    """Whether `point` is inside a closed mesh: an odd number of its
    triangles cut a ray from it."""
    tris = mesh.tris
    d = np.array([0.4472135955, 0.5773502691, 0.6831300511])
    e1, e2 = tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
    p = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, p)
    ok = np.abs(det) > 1e-300
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    s = point - tris[:, 0]
    u = np.einsum("ij,ij->i", s, p) * inv
    q = np.cross(s, e1)
    v = (q @ d) * inv
    t = np.einsum("ij,ij->i", e2, q) * inv
    hits = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
    return bool(hits.sum() % 2)


def _overlap(A, B, tol):
    eps = tol / 8
    flat = ("curve", "sheet")
    if A.kind in flat and B.kind in flat:
        return False  # no thickness on either side
    if A.kind == "mesh" or B.kind == "mesh":
        mesh, other = (A, B) if A.kind == "mesh" else (B, A)
        if other.kind != "solid":
            # a mesh against a mesh, a wire or a sheet: an edge through a triangle
            if _pierces(other.segs, mesh.tris, tol) or _pierces(
                mesh.segs, other.tris, tol
            ):
                return True
            return _inside(mesh, other.sample) or (
                other.kind == "mesh" and _inside(other, mesh.sample)
            )
    if _pieces_overlap(A, B, eps):
        return True
    return any(X.kind == "mesh" and _inside(X, Y.sample) for X, Y in ((A, B), (B, A)))


def find_overlaps(objects, tol=TOL):
    """The pairs of `objects` that overlap, as index pairs `(i, j)`, `i < j`.

    Two objects overlap when they interpenetrate by more than `tol` metres;
    touching does not count. Collections are not looked into: pass their
    leaves. What has no shape to overlap with -- a sensor, a dipole, a custom
    source -- is never in a pair, and neither are two wires or two sheets,
    which have no thickness. Each object is taken at the last step of its
    path.
    """
    m = tol / 2
    bodies = [_body(obj, m) for obj in objects]
    index = [k for k, body in enumerate(bodies) if body is not None]
    if len(index) < 2:
        return []
    lo = np.array([bodies[k].lo for k in index])
    hi = np.array([bodies[k].hi for k in index])
    # sort and sweep along x, then the boxes' y and z
    order = np.argsort(lo[:, 0])
    found = []
    for n, a in enumerate(order):
        for b in order[n + 1 :]:
            if lo[b, 0] >= hi[a, 0]:
                break
            if np.all(lo[a, 1:] < hi[b, 1:]) and np.all(lo[b, 1:] < hi[a, 1:]):
                i, j = sorted((index[a], index[b]))
                if _overlap(bodies[i], bodies[j], tol):
                    found.append((i, j))
    return sorted(found)
