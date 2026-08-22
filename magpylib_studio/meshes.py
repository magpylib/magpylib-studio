"""Where a mesh came from, rather than what it came out as.

`TriangularMesh` is the one magpylib source whose parameters nobody types.
Fifty thousand numbers arrive from a CAD export, and writing them into the
document would make a saved scene a *copy* of the STL rather than a
description of it: megabytes of derived data, a script export no one can
read, and two representations of one mesh free to drift apart. So a create
event records the **call** that produced the mesh — the file it was read
from, the point cloud it is the hull of — exactly as the transform log
records `move` rather than the pose it worked out. `resolve()` performs
that call; the document holds only what it takes to perform it again.

That puts an expensive step somewhere nothing else is expensive. A scene is
re-folded from its log on every slider drag, and magpylib's face
reorientation is roughly quadratic: measured on this machine, a 20k-face
mesh costs 16 s to reorient and 0.1 ms to construct once its faces are
already right. So what a source resolves to is cached — welded, reoriented,
checked — and the object is then built with every check skipped. The
answers are known and the input cannot have changed without the key
changing with it.

Welding is exact, the same `np.unique` magpylib's own `from_mesh` uses. An
STL is a soup of separate triangles and only becomes a closed body when
shared corners land on the same vertex; exporters do write bit-identical
float32 for a shared corner, so this holds in practice. Where it does not,
nothing is silently wrong: the mesh comes back open or disconnected and
says so, which is the whole point of carrying the status around.
"""

from __future__ import annotations

import hashlib
import os
import re
import struct

import magpylib as magpy
import numpy as np

#: One triangle of a binary STL. The normal is read past rather than used:
#: it is redundant with the corner order, exporters get it wrong often
#: enough to be untrustworthy, and magpylib derives its own from the faces.
_BINARY_TRIANGLE = np.dtype(
    [("normal", "<f4", 3), ("corners", "<f4", (3, 3)), ("attr", "<u2")]
)

#: 80 bytes of free-form header, then a uint32 triangle count.
_STL_HEADER = 84

#: `vertex x y z`, in whatever spacing and float spelling the writer chose.
_ASCII_VERTEX = re.compile(
    rb"vertex\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)"
)

#: Read whole, because every mesh reader here wants the bytes twice — once
#: to tell binary from ASCII, once to parse — and because the hash that
#: keys the cache is over the same bytes.
_READ_CHUNK = 1 << 20

#: How much resolved mesh to keep. The cache is keyed by what was read, and
#: for a generated shape that includes its parameters — which are sliders. A
#: superquadric's `plan` moved thirty steps is thirty keys that will never be
#: asked for again (measured: 74 KiB grew to 2.3 MB), and at the top of the
#: `facets` slider one entry alone is ~1.4 MB. So it is bounded, and evicts
#: what was used longest ago: the entry a drag keeps returning to is the one
#: it just made.
MAX_CACHE_BYTES = 64 << 20
MAX_CACHE_ENTRIES = 64


#: The kinds of source a document may name. Kept as data so the refusal can
#: list them rather than restate them.
_SOURCES = ("file", "hull", "superquadric")

#: Sources whose faces arrive with untrustworthy winding, and so have to go
#: through magpylib's general (quadratic) reorientation. A source this module
#: generates does not: see `outward`.
_NEEDS_REORIENT = ("file", "hull")

#: Sources worth testing for self-intersection — which is to say, the ones
#: that could have it. It is by far the most expensive check (seconds, where
#: the other two are tens of milliseconds) and the only one whose answer is
#: already known for a generated shape: a superquadric is a radial
#: parametrisation, so every direction has exactly one point on the surface,
#: and a convex hull cannot cross itself either. A file is the case where
#: running it is the only way to find out.
#:
#: The two cheap checks are run on everything regardless. They are what would
#: catch a bug in the generators above, and claiming a shape is closed
#: because the code that made it meant to be is not the same as knowing.
_CHECKS_SELFINTERSECTION = ("file",)


class MeshError(ValueError):
    """A mesh source that cannot be performed: file missing, unreadable, or
    not describing triangles. Raised so the build's per-event catch reports
    it like any other bad event — a scene with an unreachable STL in it
    still opens, with that one object named as broken."""


def digest(path):
    """SHA-256 of a file, so a document can notice its mesh changed underneath
    it. Recorded when the source is written, never checked on the hot path:
    rebuild-time invalidation keys on mtime and size, which cost a stat."""
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(_READ_CHUNK):
            sha.update(chunk)
    return sha.hexdigest()


def read_stl(path):
    """An STL file -> triangle soup, shape (n, 3, 3), in the file's own units.

    Binary and ASCII both, told apart by arithmetic rather than by the
    leading `solid`: binary STLs in the wild do start with that word, and
    the length a declared triangle count implies is a fact rather than a
    convention.
    """
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        raise MeshError(f"cannot read {os.path.basename(path)}: {e}") from e

    if len(data) >= _STL_HEADER:
        (count,) = struct.unpack("<I", data[80:_STL_HEADER])
        if len(data) == _STL_HEADER + _BINARY_TRIANGLE.itemsize * count:
            triangles = np.frombuffer(
                data, dtype=_BINARY_TRIANGLE, count=count, offset=_STL_HEADER
            )
            return triangles["corners"].astype(float)

    corners = np.array(_ASCII_VERTEX.findall(data), dtype=float)
    if corners.size == 0:
        raise MeshError(
            f"{os.path.basename(path)} is not an STL file: no triangles in it"
        )
    if len(corners) % 3:
        raise MeshError(
            f"{os.path.basename(path)} ends mid-triangle: "
            f"{len(corners)} vertices is not a whole number of faces"
        )
    return corners.reshape(-1, 3, 3)


def read_polydata(path):
    """Any mesh pyvista can open -> triangle soup, shape (n, 3, 3).

    This is the path for OBJ, PLY, VTK and the rest. It is optional on
    purpose: this package's runtime dependencies are magpylib and plotly,
    and pyvista is a large thing to install on behalf of someone who only
    ever opens STLs — which the reader above handles without it.
    """
    try:
        import pyvista
    except ImportError as e:
        raise MeshError(
            f"reading {os.path.basename(path)} needs pyvista "
            f"(pip install pyvista); STL files are read without it"
        ) from e
    try:
        polydata = pyvista.read(path).triangulate()
    except Exception as e:  # whatever pyvista raises is the answer
        raise MeshError(f"pyvista could not read {os.path.basename(path)}: {e}") from e
    vertices = np.asarray(polydata.points, dtype=float)
    faces = np.asarray(polydata.faces).reshape(-1, 4)[:, 1:]
    return vertices[faces]


def read_file(path):
    """A mesh file -> triangle soup, by extension: STL here, the rest via
    pyvista."""
    if path.lower().endswith(".stl"):
        return read_stl(path)
    return read_polydata(path)


def weld(triangles):
    """Triangle soup -> (vertices, faces), shared corners made one vertex.

    magpylib's `from_mesh` does exactly this; it is spelled out here because
    the checked-and-reoriented faces have to come back out, which means
    constructing the object ourselves.
    """
    triangles = np.asarray(triangles, dtype=float)
    if triangles.ndim != 3 or triangles.shape[1:] != (3, 3):
        raise MeshError(f"expected triangles of shape (n, 3, 3), got {triangles.shape}")
    if len(triangles) == 0:
        # An 84-byte binary STL declaring zero triangles satisfies the length
        # arithmetic that tells the two formats apart, so it arrives here as a
        # well-formed empty soup. Refused with a sentence rather than left to
        # fall over on the first `.min(axis=0)` of an empty array.
        raise MeshError("that file declares no triangles, so there is no mesh in it")
    vertices, index = np.unique(triangles.reshape(-1, 3), axis=0, return_inverse=True)
    return vertices, index.reshape(-1, 3)


def hull(points):
    """A point cloud -> the (vertices, faces) of its convex hull.

    scipy comes in with magpylib, so this costs no dependency. The hull is
    closed and its faces are consistently wound by construction, which is
    why it is the one source that never needs repairing.
    """
    from scipy.spatial import ConvexHull

    points = np.asarray(points, dtype=float)
    if points.ndim != 2 or points.shape[1] != 3 or len(points) < 4:
        raise MeshError(
            "a convex hull needs at least four points of shape (n, 3), "
            f"got {points.shape}"
        )
    try:
        computed = ConvexHull(points)
    except Exception as e:  # a degenerate cloud is a user error, not a crash
        raise MeshError(f"no convex hull: {e}") from e
    return np.asarray(computed.points, dtype=float), np.asarray(computed.simplices)


def _signed_power(values, exponent):
    """`sign(x) · |x|^e`, the operation a superquadric is made of.

    Signed because the exponent has to act on the *shape* of a coordinate
    without folding its negative half onto its positive one: `cos(ω)^0.2` is
    not a number for ω past a quarter turn, and `|cos(ω)|^0.2` would build
    only the front of the solid, twice.
    """
    return np.sign(values) * np.abs(values) ** exponent


def superquadric(size, roundness, around=48, across=24):
    """A superellipsoid surface, as (vertices, faces).

    One formula for most of the solids anyone models a magnet as. With
    half-extents A, B, C and exponents ε₁ (pole to pole) and ε₂ (around):

        x = A · sgn(cos η)|cos η|^ε₁ · sgn(cos ω)|cos ω|^ε₂
        y = B · sgn(cos η)|cos η|^ε₁ · sgn(sin ω)|sin ω|^ε₂
        z = C · sgn(sin η)|sin η|^ε₁

    ε₁ = ε₂ = 1 is an ellipsoid, both → 0 is a box, ε₁ → 0 with ε₂ = 1 is a
    cylinder, and 2, 2 is an octahedron. Between them lie the shapes real
    magnets actually are and magpylib has no class for: the rounded block, the
    pill, the barrel, the chamfered disc — which is the point. Alan Barr,
    *Superquadrics and Angle-Preserving Transformations*, IEEE CG&A 1(1),
    1981; the same family Gielis's superformula generalises.

    Beyond about ε = 2 the solid stops being convex, which is why this is
    sampled and triangulated rather than handed to `from_ConvexHull`: a hull
    would quietly return the envelope instead of the shape, and the field of
    the envelope is a perfectly plausible wrong answer.
    """
    try:
        half = np.asarray(size, dtype=float).reshape(3) / 2
        e1, e2 = (float(e) for e in np.asarray(roundness, dtype=float).reshape(2))
        around, across = int(around), int(across)
    except (TypeError, ValueError) as e:
        raise MeshError(
            f"a superquadric needs size (3 numbers), roundness (2) and two counts: {e}"
        ) from e
    if min(around, across) < 3:
        raise MeshError(
            f"a superquadric needs at least 3 samples each way, got "
            f"{around} around and {across} across"
        )
    if min(e1, e2) <= 0:
        # 0 is the limit the box *approaches*; at 0 exactly every point on a
        # face collapses onto its corner and there is no surface left.
        raise MeshError(f"roundness must be greater than 0, got ({e1}, {e2})")

    # Pole to pole inclusive, but only once around: the seam closes by index
    # rather than by a duplicated column of points.
    latitude = np.linspace(-np.pi / 2, np.pi / 2, across)
    longitude = np.linspace(-np.pi, np.pi, around, endpoint=False)
    lat, lon = np.meshgrid(latitude, longitude, indexing="ij")
    ring = _signed_power(np.cos(lat), e1)
    points = np.stack(
        [
            half[0] * ring * _signed_power(np.cos(lon), e2),
            half[1] * ring * _signed_power(np.sin(lon), e2),
            half[2] * _signed_power(np.sin(lat), e1),
        ],
        axis=-1,
    )
    # The poles, set rather than computed. `cos(±π/2)` is 6.1e-17, not 0, so
    # the top and bottom rows come out as rings of `around` *distinct* points
    # a fifth of an attometre apart — which exact welding keeps apart, leaving
    # a ring of needle triangles around a hole where each cap should be. The
    # mesh then reports itself open at exactly 2 × around edges, which is how
    # this was found and why the cheap checks run on generated shapes too.
    points[0] = (0, 0, -half[2])
    points[-1] = (0, 0, half[2])
    return grid_surface(points)


def grid_surface(points):
    """A (rows, columns, 3) grid of surface points -> (vertices, faces).

    Columns wrap and rows do not, which is what a surface of revolution is:
    the seam closes by index, and the two ends are caps rather than another
    ring. Both poles collapse to a single vertex under welding, and the
    triangles that fall to a line there are dropped — a face naming the same
    vertex twice has no area, no normal and no side, and magpylib would
    rightly call the mesh that contains one open.
    """
    points = np.asarray(points, dtype=float)
    if points.ndim != 3 or points.shape[2] != 3:
        raise MeshError(f"expected a grid of shape (rows, cols, 3), got {points.shape}")
    rows, columns = points.shape[:2]
    top, bottom = points[:-1], points[1:]
    right = np.roll(np.arange(columns), -1)
    # Two triangles per quad, wound the same way round the whole sheet.
    triangles = np.concatenate(
        [
            np.stack([top, top[:, right], bottom[:, right]], axis=2),
            np.stack([top, bottom[:, right], bottom], axis=2),
        ]
    ).reshape(-1, 3, 3)
    vertices, faces = weld(triangles)
    degenerate = (
        (faces[:, 0] == faces[:, 1])
        | (faces[:, 1] == faces[:, 2])
        | (faces[:, 0] == faces[:, 2])
    )
    if rows < 2 or columns < 3 or len(faces) - int(degenerate.sum()) < 4:
        raise MeshError("that grid does not enclose a solid")
    return vertices, outward(vertices, faces[~degenerate])


def outward(vertices, faces):
    """Faces wound so their normals point out, for a mesh already wound
    *consistently* — which a generated surface is, by construction.

    This is the whole reason a superquadric can be sampled finely. magpylib's
    `reorient_faces` solves the general problem, where every face's winding is
    independently suspect, and it costs roughly quadratic time: 16 s for 20k
    faces. Here the only open question is whether the sheet as a whole came
    out inside-out, which the divergence theorem answers in one pass — the
    signed volume ∑ v₀ · (v₁ × v₂) is positive when the normals face out.

    So a shape this module *generates* skips the repair entirely, while a mesh
    it *reads* still gets it: an STL's winding is whatever the exporter felt,
    and scipy's hull simplices are not consistent with each other at all.
    """
    corners = vertices[faces]
    signed = np.einsum(
        "ij,ij->i", corners[:, 0], np.cross(corners[:, 1], corners[:, 2])
    ).sum()
    return faces[:, ::-1] if signed < 0 else faces


def status_of(obj, original_faces=None):
    """What magpylib knows about a mesh's validity, as plain JSON.

    `None` where a check was skipped rather than passed — the distinction
    matters to a UI, which should not draw a green tick for a question
    nobody asked.

    magpylib's own `status_reoriented` is not among these: it says the
    reorientation *ran*, which is true of every mesh that arrives here and
    so tells a reader nothing. What they want to know is whether the file
    needed fixing, which is how many faces came back wound the other way —
    `flipped`, counted against the faces the file actually held.
    """
    # Read defensively: the engine supports released magpylib as well as its
    # main branch, and a check one of them does not have should cost this
    # dictionary a key rather than the import an AttributeError.
    counts = {
        "open_edges": getattr(obj, "status_open_data", None),
        "parts": getattr(obj, "status_disconnected_data", None),
        "intersecting_faces": getattr(obj, "status_selfintersecting_data", None),
    }
    status = {
        "open": getattr(obj, "status_open", None),
        "disconnected": getattr(obj, "status_disconnected", None),
        "selfintersecting": getattr(obj, "status_selfintersecting", None),
        **{k: len(v) for k, v in counts.items() if v is not None},
    }
    if original_faces is not None:
        differing = np.any(np.asarray(obj.faces) != np.asarray(original_faces), axis=1)
        status["flipped"] = int(np.count_nonzero(differing))
    return status


def is_unreliable(status):
    """Whether a mesh's status means its field should not be believed.

    Open and disconnected both break the inside-outside test the field
    integral rests on. A self-intersection does too, but magpylib computes
    a field regardless and so do we — with this saying not to trust it.
    """
    return bool(
        status.get("open")
        or status.get("disconnected")
        or status.get("selfintersecting")
    )


def complaint(label, status):
    """One sentence naming what is wrong with a mesh, or None if nothing is.

    Written for a place where it will be read next to a number the mesh
    produced, so it says what it means for the number.
    """
    faults = []
    if status.get("open"):
        edges = status.get("open_edges")
        faults.append(f"open{f' at {edges} edges' if edges else ''}")
    if status.get("disconnected"):
        parts = status.get("parts")
        faults.append(f"in {parts} separate parts" if parts else "disconnected")
    if status.get("selfintersecting"):
        faces = status.get("intersecting_faces")
        faults.append(f"self-intersecting{f' across {faces} faces' if faces else ''}")
    if not faults:
        return None
    return f"{label} is {' and '.join(faults)}; its field is unreliable"


def source_path(spec, base_dir=None):
    """The spec's file, resolved against the document's own directory.

    Relative is the form worth writing: a scene and the CAD it was built
    from usually travel together, and an absolute path is wrong on every
    machine but the one that wrote it. Relative to *the document*, not to
    the process's working directory, because the engine's cwd is wherever
    the editor happened to launch it.
    """
    path = spec.get("path")
    if not path:
        raise MeshError("mesh source has no 'path'")
    if os.path.isabs(path):
        return path
    return os.path.normpath(os.path.join(base_dir or os.getcwd(), path))


def _cache_key(spec, path):
    """What makes two resolutions of a source the same resolution.

    For a file: its identity on disk plus how big and how recently written
    — a stat, not a hash, because this runs on every rebuild. The recorded
    sha256 is for telling a person their STL changed, which is a different
    question asked at a different time.
    """
    scale = float(spec.get("scale", 1.0))
    reorient = bool(spec.get("reorient", True))
    if spec.get("from") == "hull":
        points = np.asarray(spec.get("points") or [], dtype=float)
        return ("hull", points.tobytes(), points.shape, scale, reorient)
    if spec.get("from") == "superquadric":
        return (
            "superquadric",
            tuple(np.ravel(spec.get("size") or ()).tolist()),
            tuple(np.ravel(spec.get("roundness") or ()).tolist()),
            spec.get("around", 48),
            spec.get("across", 24),
            scale,
            reorient,
        )
    try:
        stat = os.stat(path)
    except OSError as e:
        raise MeshError(f"cannot find {spec.get('path')}: {e}") from e
    return (
        "file",
        os.path.realpath(path),
        stat.st_mtime_ns,
        stat.st_size,
        scale,
        reorient,
    )


def resolve(spec, base_dir=None, cache=None):
    """Perform a mesh source: {vertices, faces, status} ready to construct with.

    The faces come back reoriented and the status filled in, so the caller
    builds the real object with every check set to `skip` — see the module
    docstring for why that matters. `cache` is a dict the caller keeps for
    the life of the session.
    """
    if not isinstance(spec, dict):
        raise MeshError(f"mesh source must be an object, got {type(spec).__name__}")
    source = spec.get("from")
    if source not in _SOURCES:
        raise MeshError(
            f"unknown mesh source {source!r}; expected one of "
            f"{', '.join(sorted(_SOURCES))}"
        )

    path = source_path(spec, base_dir) if source == "file" else None
    key = _cache_key(spec, path)
    if cache is not None and key in cache:
        cache[key] = cache.pop(key)  # freshly used, so last to be evicted
        return cache[key]

    if source == "hull":
        vertices, faces = hull(spec.get("points"))
    elif source == "superquadric":
        vertices, faces = superquadric(
            spec.get("size"),
            spec.get("roundness"),
            around=spec.get("around", 48),
            across=spec.get("across", 24),
        )
    else:
        vertices, faces = weld(read_file(path))

    scale = float(spec.get("scale", 1.0))
    if scale != 1.0:
        vertices = vertices * scale

    # Built once, here, with the checks answered rather than warned about:
    # a warning on stderr is invisible to a GUI, and the point of importing
    # a mesh through the studio instead of a script is to be told.
    reorient = spec.get("reorient", source in _NEEDS_REORIENT)
    probe = magpy.magnet.TriangularMesh(
        vertices=vertices,
        faces=faces,
        check_open="ignore",
        check_disconnected="ignore",
        check_selfintersecting=(
            "ignore" if source in _CHECKS_SELFINTERSECTION else "skip"
        ),
        reorient_faces="skip" if reorient is False else "ignore",
    )
    status = status_of(probe, original_faces=faces)
    if source not in _CHECKS_SELFINTERSECTION:
        # Not "unknown" but "impossible", and the difference matters twice.
        # A radial parametrisation gives every direction exactly one point
        # and a convex hull cannot cross itself, so this is a fact about the
        # construction rather than a test that was skipped to save time —
        # a UI that showed it as unanswered would be reporting doubt nobody
        # has. And left as None, magpylib reads the question as open and
        # re-asks it on the display path, at seconds a redraw.
        status["selfintersecting"] = False
    resolved = {
        "vertices": probe.vertices,
        "faces": probe.faces,
        "status": status,
        # Hashed here and only here: a cache miss is exactly when the file
        # has been read, which is exactly when its contents are a new fact.
        # Hashing on the rebuild path instead would re-read the whole STL on
        # every slider drag to answer a question nobody asked.
        **({"sha256": digest(path)} if source == "file" else {}),
    }
    if cache is not None:
        _remember(cache, key, resolved)
    return resolved


def _remember(cache, key, resolved):
    """Keep a resolved mesh, and drop the least recently used until the cache
    is back inside its bounds.

    Insertion order is the eviction order — dicts keep it, and every hit
    reinserts — so this is a plain LRU. The newest entry is never evicted,
    however big it is: it is the one the scene being rebuilt right now needs,
    and a cache that throws it away is a cache that reads the file again on
    every drag, which is the thing this exists to stop.
    """
    cache[key] = resolved
    while len(cache) > 1 and (
        len(cache) > MAX_CACHE_ENTRIES or _cache_bytes(cache) > MAX_CACHE_BYTES
    ):
        del cache[next(iter(cache))]


def _cache_bytes(cache):
    return sum(
        entry["vertices"].nbytes + entry["faces"].nbytes for entry in cache.values()
    )


def constructor_kwargs(resolved):
    """The resolved mesh as magpylib constructor arguments.

    Every check is skipped: `resolve()` already answered all four, and the
    faces it returned are the ones reorientation produced. Asking again on
    every rebuild is what makes a big mesh unusable.
    """
    return {
        "vertices": resolved["vertices"],
        "faces": resolved["faces"],
        "check_open": "skip",
        "check_disconnected": "skip",
        "check_selfintersecting": "skip",
        "reorient_faces": "skip",
    }


#: Where magpylib keeps each answer, so a rebuilt object can be given the one
#: `resolve()` already worked out. Private attributes because there is no
#: public way to tell an object something it is allowed to compute for itself.
_STATUS_ATTRS = {
    "open": "_status_open",
    "disconnected": "_status_disconnected",
    "selfintersecting": "_status_selfintersecting",
}


def stamp_status(obj, status):
    """Hand a freshly built mesh the answers `resolve()` already worked out.

    `constructor_kwargs` skips every check, which leaves all three of these
    at None — and magpylib then re-answers them itself, in two places that
    both matter. Before every B computation it warns that the mesh is
    unchecked, on a mesh that has been checked more carefully than the
    warning asks for. Worse, *drawing* one runs `check_selfintersecting()`
    outright: 950 ms at 20k faces, on an object rebuilt from the log every
    time a slider moves, which would have handed back on the display path
    exactly what the cache exists to avoid paying on the build path.

    Only the booleans. The data behind them — open edges, disconnected
    subsets — magpylib computes lazily when something asks, which only a
    broken mesh does.

    Guarded per attribute, so a magpylib that renames one costs a redundant
    check rather than a crash.
    """
    for key, attr in _STATUS_ATTRS.items():
        if status.get(key) is not None and hasattr(obj, attr):
            setattr(obj, attr, status[key])


def describe(spec, resolved=None):
    """A short human phrase for a mesh source, for a tree row or a log line."""
    if spec.get("from") == "hull":
        return f"hull of {len(spec.get('points') or [])} points"
    if spec.get("from") == "superquadric":
        e1, e2 = (spec.get("roundness") or [1, 1])[:2]
        return f"superquadric · roundness {e1:g}, {e2:g}"
    name = os.path.basename(spec.get("path") or "?")
    if resolved is None:
        return name
    return f"{name} · {len(resolved['faces'])} faces"
