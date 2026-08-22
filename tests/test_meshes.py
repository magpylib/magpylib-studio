"""Tests for meshes that come from files rather than from typed numbers.

The thing under test is not really the STL reader — it is the decision that a
document records the *source* of a mesh and resolves it on the way in. Most of
what can go wrong lives in that seam: a scene that saves five megabytes of
vertices instead of a filename, a rebuild that re-reads the file on every
slider drag, an invalid mesh that computes a wrong field in silence, a script
export that cannot be read back.
"""

from __future__ import annotations

import io
import json
import os
import struct
import warnings

import magpylib as magpy
import numpy as np
import pytest

from magpylib_studio import meshes
from magpylib_studio.rpc import serve
from magpylib_studio.session import DOC_VERSION, MagpylibStudioSession

# A 10 mm cube, wound consistently outward, as twelve triangles. Millimetres
# on purpose: an STL carries no units and a CAD export is almost always in
# them, so every test here also exercises the scale that fixes that.
_CORNERS = np.array(
    [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
    ],
    dtype=float,
)
_QUADS = [
    (0, 3, 2, 1),
    (4, 5, 6, 7),
    (0, 1, 5, 4),
    (1, 2, 6, 5),
    (2, 3, 7, 6),
    (3, 0, 4, 7),
]


def cube_triangles(size=10.0):
    """The cube as triangle soup, shape (12, 3, 3), in the file's own units."""
    corners = _CORNERS * size
    triangles = []
    for a, b, c, d in _QUADS:
        triangles.append([corners[a], corners[b], corners[c]])
        triangles.append([corners[a], corners[c], corners[d]])
    return np.array(triangles, dtype=float)


def write_binary_stl(path, triangles):
    """The 80-byte header, a count, and 50 bytes a triangle — as exporters do,
    header text included: a binary STL that begins with the word `solid` is
    the reason the reader tells the two formats apart by length instead."""
    with open(path, "wb") as f:
        f.write(b"solid exported by a test".ljust(80, b"\0"))
        f.write(struct.pack("<I", len(triangles)))
        for triangle in triangles:
            normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
            normal = normal / (np.linalg.norm(normal) or 1)
            f.write(struct.pack("<3f", *normal))
            for vertex in triangle:
                f.write(struct.pack("<3f", *vertex))
            f.write(struct.pack("<H", 0))


def write_ascii_stl(path, triangles):
    lines = ["solid cube"]
    for triangle in triangles:
        normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
        normal = normal / (np.linalg.norm(normal) or 1)
        lines.append("  facet normal {:.6e} {:.6e} {:.6e}".format(*normal))
        lines.append("    outer loop")
        for vertex in triangle:
            lines.append("      vertex {:.6e} {:.6e} {:.6e}".format(*vertex))
        lines += ["    endloop", "  endfacet"]
    lines.append("endsolid cube")
    path.write_text("\n".join(lines))


@pytest.fixture
def cube_stl(tmp_path):
    """A closed 10 mm cube as a binary STL."""
    path = tmp_path / "cube.stl"
    write_binary_stl(path, cube_triangles())
    return path


@pytest.fixture
def open_stl(tmp_path):
    """The same cube with its top two triangles missing — the classic bad
    import, and the one that computes a field without complaining."""
    path = tmp_path / "open.stl"
    write_binary_stl(path, cube_triangles()[2:])
    return path


def file_source(path, **extra):
    return {"from": "file", "path": str(path), "scale": 0.001, **extra}


def add_mesh(session, object_id, source, **params):
    return session.add_object(
        object_id,
        "magnet.TriangularMesh",
        params={"polarization": [0, 0, 1.2], "mesh_source": source, **params},
    )


# --------------------------------------------------------------------------
# reading


def test_binary_and_ascii_stl_read_to_the_same_mesh(tmp_path):
    """Two spellings of one file format, and no way to tell from the outside
    which one a CAD tool wrote — so they have to arrive identical."""
    triangles = cube_triangles()
    binary, ascii_ = tmp_path / "b.stl", tmp_path / "a.stl"
    write_binary_stl(binary, triangles)
    write_ascii_stl(ascii_, triangles)

    from_binary = meshes.weld(meshes.read_stl(str(binary)))
    from_ascii = meshes.weld(meshes.read_stl(str(ascii_)))

    assert np.allclose(from_binary[0], from_ascii[0])
    assert np.array_equal(from_binary[1], from_ascii[1])


def test_welding_makes_a_triangle_soup_a_body(cube_stl):
    """An STL has no vertices, only corners: twelve triangles carry thirty-six
    of them, and the cube is only closed once the shared ones are one."""
    triangles = meshes.read_stl(str(cube_stl))
    vertices, faces = meshes.weld(triangles)

    assert len(triangles) == 12
    assert len(vertices) == 8  # not 36
    assert len(faces) == 12


def test_scale_converts_the_file_into_metres(cube_stl):
    """The units trap: a 10 mm cube read as-is is a magnet ten metres wide."""
    unscaled = meshes.resolve({"from": "file", "path": str(cube_stl)}, cache={})
    scaled = meshes.resolve(file_source(cube_stl), cache={})

    assert np.allclose(np.ptp(unscaled["vertices"], axis=0), 10)
    assert np.allclose(np.ptp(scaled["vertices"], axis=0), 0.01)


def test_a_file_that_is_not_a_mesh_says_so(tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("this is not an STL, it is a note about one")

    with pytest.raises(meshes.MeshError, match="not an STL file"):
        meshes.read_stl(str(path))


def test_a_hull_needs_a_cloud_to_be_the_hull_of():
    with pytest.raises(meshes.MeshError, match="at least four points"):
        meshes.hull([[0, 0, 0], [1, 0, 0]])


# --------------------------------------------------------------------------
# validity


def test_an_open_mesh_is_imported_and_flagged_rather_than_refused(open_stl):
    """The decision this whole feature turns on. magpylib computes a field for
    an open mesh — a wrong one, wrong enough to change sign — and warns on a
    stream no GUI user reads. So the import succeeds, because a mesh you
    cannot load is a mesh you cannot fix, and everything that touches it says
    what is wrong with it.
    """
    session = MagpylibStudioSession()
    assert add_mesh(session, "rotor", file_source(open_stl))["ok"] is True

    listed = session.list_objects()[0]
    assert listed["mesh"]["open"] is True
    assert listed["mesh"]["open_edges"] == 4

    with warnings.catch_warnings():
        # magpylib warns too, on the stream this feature exists because
        # nobody reads. Silenced here so the suite's output stays about what
        # the studio says, which is the assertion below.
        warnings.simplefilter("ignore")
        reading = session.get_field(points=[[0, 0, 0.02]])
    assert "open" in reading["warnings"][0]
    assert "unreliable" in reading["warnings"][0]


def test_a_closed_mesh_carries_no_complaint(cube_stl):
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))

    assert session.list_objects()[0]["mesh"]["open"] is False
    assert "warnings" not in session.get_field(points=[[0, 0, 0.02]])


def test_a_checked_mesh_does_not_warn_that_it_is_unchecked(cube_stl):
    """Objects are rebuilt with every check skipped, which leaves magpylib's
    own `status_open` unset and makes it warn before each field computation
    that the mesh might be open. It is not: the answer was worked out once
    and is handed back to the object, so the warning fires only when true."""
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        session.get_field(points=[[0, 0, 0.02]])


def test_a_built_mesh_carries_every_answer_the_checks_found(cube_stl):
    """Not only the field path re-asks these — the *display* path does too,
    and one of them it re-asks unconditionally. `traces_core` runs
    `check_selfintersecting()` on any mesh whose status is unset, which is
    every mesh the studio builds, because the whole point is that the checks
    were done once already. Measured on a 4000-face part: 283 ms per redraw
    against 11 ms, on an object rebuilt every time a slider moves — the cost
    the cache exists to avoid, handed straight back on the way to the screen.

    So all three answers go back onto the object. Pinned by attribute rather
    than by timing: what makes this fast is that nothing is None.
    """
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))
    obj = session._objs["rotor"]

    assert obj.status_open is False
    assert obj.status_disconnected is False
    assert obj.status_selfintersecting is False

    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any "Unchecked ... status" is a failure
        session.get_figure()


def test_inconsistent_winding_is_repaired_and_counted(tmp_path):
    """Half the faces wound the wrong way is what a decimated export looks
    like. magpylib can fix it; what it cannot do is say how much it fixed,
    and "your file needed 6 of 12 faces turned around" is the difference
    between trusting this import and checking the next one."""
    triangles = cube_triangles()
    triangles[:6] = triangles[:6][:, ::-1]  # reverse the winding of half
    path = tmp_path / "scrambled.stl"
    write_binary_stl(path, triangles)

    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(path))
    status = session.list_objects()[0]["mesh"]

    assert status["flipped"] == 6
    assert status["open"] is False  # the body itself was always closed

    # and the repair is real: the field matches the same cube written right
    good = tmp_path / "good.stl"
    write_binary_stl(good, cube_triangles())
    reference = MagpylibStudioSession()
    add_mesh(reference, "rotor", file_source(good))
    assert np.allclose(
        session.get_field(points=[[0, 0, 0.02]])["values"],
        reference.get_field(points=[[0, 0, 0.02]])["values"],
    )


def test_a_mesh_cannot_be_mirrored_and_is_told_why(cube_stl):
    """Mirroring borrows a body's own symmetry, which a mesh does not have —
    the reflection would have to flip its vertices, making a different object
    rather than the same one placed differently. Pinned because the honest
    refusal is the feature."""
    session = MagpylibStudioSession()
    session.add_object("group", "Collection")  # a mirror's copy needs a group
    add_mesh(session, "rotor", file_source(cube_stl))
    session.move_object("rotor", parent="group")

    result = session.mirror("rotor", plane="xy")
    assert result["ok"] is False
    assert "cannot be mirrored" in result["error"]


def built(resolved, polarization=(0, 0, 1.3)):
    """A resolved mesh as the engine builds it: checks skipped, answers handed
    back. Spelled out here so a test measures the object the studio makes and
    not a differently-configured one."""
    obj = magpy.magnet.TriangularMesh(
        polarization=polarization, **meshes.constructor_kwargs(resolved)
    )
    meshes.stamp_status(obj, resolved["status"])
    return obj


# --------------------------------------------------------------------------
# the shape family


@pytest.mark.parametrize(
    ("plan", "profile", "primitive"),
    [
        pytest.param(
            0.05,
            0.05,
            magpy.magnet.Cuboid(dimension=(0.02, 0.02, 0.01), polarization=(0, 0, 1.3)),
            id="block is a Cuboid",
        ),
        pytest.param(
            1,
            0.05,
            magpy.magnet.Cylinder(dimension=(0.02, 0.01), polarization=(0, 0, 1.3)),
            id="cylinder is a Cylinder",
        ),
        pytest.param(
            1,
            1,
            magpy.magnet.Sphere(diameter=0.02, polarization=(0, 0, 1.3)),
            id="sphere is a Sphere",
        ),
    ],
)
def test_one_formula_reproduces_three_magpylib_primitives(plan, profile, primitive):
    """The claim the superquadric source is worth having for, and the strongest
    check the mesh machinery gets.

    Two exponents over a size are enough to be a box, a cylinder or a sphere,
    and magpylib computes all three analytically — so the welding, the pole
    caps, the winding and the skipped checks are all measured here against an
    answer that owes nothing to any of them. The tolerance is a discretisation
    error, not a fudge: it falls as the square of the face count.
    """
    size = (0.02, 0.02, 0.02 if plan == profile == 1 else 0.01)
    resolved = meshes.resolve(
        {
            "from": "superquadric",
            "size": size,
            "roundness": [profile, plan],  # (pole to pole, around)
            "around": 120,
            "across": 60,
        },
        cache={},
    )
    mesh = built(resolved)

    observer = [[0.006, 0.004, 0.012]]
    got = np.atleast_2d(mesh.getB(observer))[0]
    want = np.atleast_2d(primitive.getB(observer))[0]

    assert resolved["status"]["open"] is False
    assert np.linalg.norm(got - want) / np.linalg.norm(want) < 0.005


def test_a_finer_superquadric_is_a_better_sphere():
    """Discretisation error, shown to be discretisation error.

    A tolerance nobody can move is indistinguishable from a bug that happens
    to be small. This one halves and halves again — measured 2.8% at 480
    faces down to 0.058% at 24960 — which is what says the mesh is
    approaching the sphere rather than sitting near it by luck.
    """
    observer = [[0.006, 0.004, 0.012]]
    want = np.atleast_2d(
        magpy.magnet.Sphere(diameter=0.02, polarization=(0, 0, 1.3)).getB(observer)
    )[0]

    errors = []
    for around, across in ((24, 12), (48, 24), (96, 48)):
        resolved = meshes.resolve(
            {
                "from": "superquadric",
                "size": (0.02, 0.02, 0.02),
                "roundness": [1, 1],
                "around": around,
                "across": across,
            },
            cache={},
        )
        mesh = built(resolved)
        got = np.atleast_2d(mesh.getB(observer))[0]
        errors.append(np.linalg.norm(got - want) / np.linalg.norm(want))

    assert errors[0] > errors[1] > errors[2]
    assert errors[2] < errors[0] / 8  # quadratic: two doublings, sixteen-fold


def test_a_generated_surface_closes_at_its_poles(caps_grid=(32, 16)):
    """The bug the cheap checks caught, and why they run on generated shapes.

    `cos(±π/2)` is 6.1e-17 rather than 0, so the top and bottom rows of the
    grid come out as rings of distinct points a fifth of an attometre apart.
    Exact welding keeps them apart, and each cap becomes a ring of needles
    around a hole — a mesh that is open at exactly 2 × around edges and
    computes a wrong field without saying so.
    """
    around, across = caps_grid
    resolved = meshes.resolve(
        {
            "from": "superquadric",
            "size": (0.02, 0.02, 0.01),
            "roundness": [0.4, 1],
            "around": around,
            "across": across,
        },
        cache={},
    )

    assert resolved["status"]["open"] is False
    assert resolved["status"]["open_edges"] == 0
    # the poles are one vertex each, not a ring of `around` of them
    assert len(resolved["vertices"]) == around * (across - 2) + 2


def test_a_generated_surface_skips_the_repair_it_cannot_need():
    """Winding is consistent by construction here, so the only question is
    whether the sheet came out inside-out — one signed volume, not magpylib's
    quadratic reorientation. Self-intersection is likewise impossible for a
    radial parametrisation, and is recorded as answered rather than left open:
    None would send magpylib off to re-answer it on every redraw.
    """
    resolved = meshes.resolve(
        {
            "from": "superquadric",
            "size": (0.02, 0.02, 0.01),
            "roundness": [0.4, 1],
            "around": 48,
            "across": 24,
        },
        cache={},
    )

    assert resolved["status"]["flipped"] == 0  # nothing to reorient
    assert resolved["status"]["selfintersecting"] is False  # answered, not skipped


def test_a_superquadric_needs_a_shape_to_be():
    session = MagpylibStudioSession()
    bad = session.add_object(
        "blob",
        "magnet.TriangularMesh",
        params={
            "polarization": [0, 0, 1],
            "mesh_source": {
                "from": "superquadric",
                "size": (0.01, 0.01, 0.01),
                "roundness": [0, 1],
            },
        },
    )

    assert bad["ok"] is False
    assert "roundness" in bad["error"]


# --------------------------------------------------------------------------
# what the document holds


def test_the_document_records_the_source_not_the_mesh(cube_stl):
    """The whole point of the design. A thousand-face part would be hundreds
    of kilobytes of vertices; what is saved is the sentence that produces
    them."""
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))
    document = json.dumps(session.to_dict())

    assert len(document) < 1500
    assert "cube.stl" in document
    assert '"vertices"' not in document
    assert session.to_dict()["version"] == DOC_VERSION


def test_the_file_is_read_once_however_often_the_scene_rebuilds(cube_stl, monkeypatch):
    """A scene is re-folded from its log on every slider drag, and reorienting
    a large mesh takes seconds. Without the cache a scene with one CAD part in
    it cannot be edited at all, so this counts the reads rather than trusting
    that it is fast."""
    reads = []
    original = meshes.read_file
    monkeypatch.setattr(
        meshes, "read_file", lambda path: (reads.append(path), original(path))[1]
    )

    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))
    for _ in range(20):
        session._build()

    assert len(reads) == 1


def test_a_file_that_changed_on_disk_is_noticed(cube_stl):
    """A newer CAD export is usually the point, but a scene that quietly means
    something else than it did when it was saved should say so."""
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))
    saved = session.to_dict()
    assert "sha256" in saved["events"][0]["params"]["mesh_source"]

    write_binary_stl(cube_stl, cube_triangles(size=20.0))  # same name, new part
    reopened = MagpylibStudioSession()
    reopened.load_scene(saved)

    assert reopened.list_objects()[0]["mesh"]["changed"] is True


def test_a_missing_file_breaks_its_object_and_not_the_scene(cube_stl):
    """A document is something you open on a machine that may not have the
    CAD next to it. The fold reports the event it could not apply and carries
    on, so the rest of the scene is there to look at while it is fixed."""
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))
    session.add_object("cube", "magnet.Cuboid", params={"dimension": [0.01] * 3})
    document = session.to_dict()
    document["events"][0]["params"]["mesh_source"]["path"] = "/nowhere/gone.stl"

    reopened = MagpylibStudioSession()
    assert reopened.load_scene(document)["ok"] is True
    assert [o["id"] for o in reopened.list_objects()] == ["cube"]
    assert "gone.stl" in reopened._broken[0]["error"]


def test_a_relative_path_is_relative_to_the_document(cube_stl):
    """Not to this process's working directory, which is wherever the editor
    happened to be launched from. A scene and the part it was built from
    travel together; an absolute path is right on exactly one machine."""
    session = MagpylibStudioSession()
    session.set_base_dir(str(cube_stl.parent))
    result = add_mesh(
        session, "rotor", {"from": "file", "path": "cube.stl", "scale": 0.001}
    )

    assert result["ok"] is True
    assert session.list_objects()[0]["mesh"]["faces"] == 12


def test_moving_the_document_re_resolves_its_meshes(cube_stl, tmp_path):
    """Save As into another folder is a base-dir change, and the mesh has to
    follow it — including by failing, when the part did not come along."""
    session = MagpylibStudioSession()
    session.set_base_dir(str(cube_stl.parent))
    add_mesh(session, "rotor", {"from": "file", "path": "cube.stl", "scale": 0.001})

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    session.set_base_dir(str(elsewhere))

    assert session.list_objects() == []
    assert "cube.stl" in session._broken[0]["error"]


def test_a_refused_load_leaves_the_open_scene_where_it_was(cube_stl):
    """`load_scene` refuses a document from a newer version rather than read
    it half-way — and that refusal has to be total. Setting the base directory
    before the guards meant a rejected file repointed the *open* scene's
    relative mesh paths, which then resolved somewhere else on the next
    rebuild: a file you declined to open, breaking the one you had.
    """
    session = MagpylibStudioSession()
    session.set_base_dir(str(cube_stl.parent))
    add_mesh(session, "rotor", {"from": "file", "path": "cube.stl", "scale": 0.001})

    refused = session.load_scene({"version": 999, "objects": []}, base_dir="/nowhere")

    assert refused["ok"] is False
    assert session._base_dir == str(cube_stl.parent)
    assert session.list_objects()[0]["mesh"]["faces"] == 12  # still built


def test_a_document_that_moves_takes_its_meshes_with_it(cube_stl, tmp_path):
    """Save As into another folder. The relative path in the document still
    means the folder the scene came from, so leaving it alone breaks it —
    every mesh reference lost, or silently resolved to a different file that
    happens to share a name. Rebasing rewrites the path to mean the same file
    from where the scene now lives.
    """
    session = MagpylibStudioSession()
    session.set_base_dir(str(cube_stl.parent))
    add_mesh(session, "rotor", {"from": "file", "path": "cube.stl", "scale": 0.001})

    moved_to = tmp_path / "scenes"
    moved_to.mkdir()
    result = session.set_base_dir(str(moved_to), rebase=True)

    assert result["rebased"] == 1
    written = session.to_dict()["events"][0]["params"]["mesh_source"]["path"]
    assert written == os.path.join("..", "cube.stl")
    assert session.list_objects()[0]["mesh"]["faces"] == 12  # and it still reads


def test_opening_from_a_directory_does_not_rewrite_what_it_finds(cube_stl, tmp_path):
    """The other half of the same distinction: a document *opened* from a
    folder already says what it means, and rebasing it there would break the
    paths that were right."""
    session = MagpylibStudioSession()
    session.set_base_dir(str(cube_stl.parent))
    add_mesh(session, "rotor", {"from": "file", "path": "cube.stl", "scale": 0.001})
    document = session.to_dict()

    reopened = MagpylibStudioSession()
    reopened.load_scene(document, base_dir=str(cube_stl.parent))

    assert (
        reopened.to_dict()["events"][0]["params"]["mesh_source"]["path"] == "cube.stl"
    )
    assert reopened.list_objects()[0]["mesh"]["faces"] == 12


def test_an_absolute_path_is_left_alone_when_the_document_moves(cube_stl, tmp_path):
    """An absolute path names the same file wherever the scene goes, which is
    the whole reason someone writes one."""
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))

    session.set_base_dir(str(tmp_path / "anywhere"), rebase=True)

    assert session.to_dict()["events"][0]["params"]["mesh_source"]["path"] == str(
        cube_stl
    )


def test_the_cache_stops_growing_while_a_slider_moves(cube_stl):
    """The cache is keyed by what was read, and for a generated shape that
    includes parameters that are *sliders* — so a drag makes a key per frame
    that will never be asked for again. Measured before the bound: 74 KiB
    became 2.3 MB over thirty steps, and one entry at the top of the `facets`
    slider is ~1.4 MB on its own.
    """
    session = MagpylibStudioSession()
    session.set_variable("plan", 0.5)  # before the object that is written in it
    assert session.add_object(
        "blob",
        "magnet.TriangularMesh",
        params={
            "polarization": [0, 0, 1],
            "mesh_source": {
                "from": "superquadric",
                "size": [0.01, 0.01, 0.01],
                "roundness": ["=plan", 1],
                "around": 32,
                "across": 16,
            },
        },
    )["ok"]

    for step in range(200):
        session.set_variable("plan", 0.2 + step * 0.005)

    assert len(session._mesh_cache) <= meshes.MAX_CACHE_ENTRIES
    assert session.list_objects()[0]["mesh"]["faces"] > 0  # and still resolves


def test_a_file_that_declares_no_triangles_is_reported_not_raised(tmp_path):
    """An 84-byte binary STL with a zero count satisfies the length arithmetic
    that tells binary from ASCII, so it arrives as a well-formed empty mesh.
    It used to escape `inspect_mesh` as a raw ValueError, which is the one
    shape the import dialog cannot show: it checks `ok`, and never got one.
    """
    path = tmp_path / "empty.stl"
    path.write_bytes(b"solid empty".ljust(80, b"\0") + struct.pack("<I", 0))

    session = MagpylibStudioSession()
    report = session.inspect_mesh({"from": "file", "path": str(path)})

    assert report["ok"] is False
    assert "no triangles" in report["error"]
    assert add_mesh(session, "rotor", file_source(path))["ok"] is False


def test_a_copy_of_a_mesh_is_offered_its_source_not_its_vertices(cube_stl):
    """A pattern's copy has no spec of its own, so the suppression that keeps
    a mesh's vertex table out of the Inspector missed it — and a copy arrived
    as the table its source exists to avoid. Measured at 48 × 24 facets: 947
    bytes for the original against 111 kB for each copy.
    """
    session = MagpylibStudioSession()
    session.add_object("group", "Collection")
    add_mesh(session, "rotor", file_source(cube_stl))
    session.move_object("rotor", parent="group")
    session.duplicate_around("rotor", count=3)

    copies = [o["id"] for o in session.list_objects() if o.get("derived")]
    assert copies, "the pattern should have made copies"
    for copy_id in copies:
        params = {p["name"]: p for p in session.get_params(copy_id)}
        assert "vertices" not in params
        assert params["mesh_source"]["value"]["path"].endswith("cube.stl")


def test_a_superquadric_script_imports_nothing_it_does_not_use():
    """The helper's exponent parameter was called `e`, and `e` is one of the
    names an expression may use — so the scan that decides which maths names a
    finished script needs found it and wrote `from math import e` at the top
    of every script with a superquadric in it."""
    session = MagpylibStudioSession()
    session.load_example("solid")

    script = session.to_script()

    assert "from math import" not in script
    assert "_superquadric" in script  # the helper is still there


# --------------------------------------------------------------------------
# the round trip


@pytest.mark.parametrize(
    "source",
    [
        pytest.param("file", id="from a file"),
        pytest.param("hull", id="from a point cloud"),
    ],
)
def test_a_mesh_survives_the_script_round_trip_as_a_source(source, cube_stl, tmp_path):
    """The document is canonical and the script is generated, and the two have
    to agree down to the byte or the script tab churns on its first save. The
    stake here is higher than usual: parsed, the mesh stays a reference;
    *executed*, `pv.read(...)` would come back as the numbers that were in
    the file that day, and the next save would write them into the document.
    """
    session = MagpylibStudioSession()
    if source == "file":
        add_mesh(session, "rotor", file_source(cube_stl))
    else:
        add_mesh(
            session,
            "rotor",
            {"from": "hull", "points": (_CORNERS * 0.01).tolist()},
        )
    session.move("rotor", [0, 0, 0.05])
    document = session.to_dict()

    script = tmp_path / "scene.py"
    script.write_text(session.to_script())
    reopened = MagpylibStudioSession()
    reopened.set_base_dir(str(cube_stl.parent))
    result = reopened.apply_script(str(script))

    assert result["ok"] is True
    assert result["mode"] == "parsed"  # not executed: the reference survives
    assert json.dumps(reopened.to_dict()) == json.dumps(document)


def test_the_script_says_what_a_magpylib_user_would_have_written(cube_stl):
    """`from_pyvista(pv.read(...))` is the idiom in magpylib's own CAD example.
    The export therefore needs pyvista where the studio itself did not — the
    price of a script that still says *cube.stl* rather than the mesh that
    was in it."""
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))
    script = session.to_script()

    assert "import pyvista as pv" in script
    assert "TriangularMesh.from_pyvista(polydata=pv.read(" in script
    assert ".scale(0.001)" in script

    hull_session = MagpylibStudioSession()
    add_mesh(
        hull_session, "blob", {"from": "hull", "points": (_CORNERS * 0.01).tolist()}
    )
    assert "TriangularMesh.from_ConvexHull(points=" in hull_session.to_script()
    assert "pyvista" not in hull_session.to_script()  # scipy's hull needs none


# --------------------------------------------------------------------------
# what a frontend is given


def test_inspect_mesh_reports_what_an_import_dialog_has_to_ask(cube_stl):
    """Reading a file before committing to it: an STL carries no units, so
    `24.5 x 12 x 8` is what turns the scale from a guess into a choice."""
    session = MagpylibStudioSession()
    report = session.inspect_mesh({"from": "file", "path": str(cube_stl)})

    assert report["ok"] is True
    assert report["faces"] == 12
    assert report["vertices"] == 8
    assert report["extent"] == [10, 10, 10]  # the file's own units
    assert report["status"]["open"] is False
    assert len(report["sha256"]) == 64
    assert session.list_objects() == []  # inspected, not added


def test_inspect_mesh_reports_a_bad_file_rather_than_raising(tmp_path):
    session = MagpylibStudioSession()
    report = session.inspect_mesh({"from": "file", "path": str(tmp_path / "nope.stl")})

    assert report["ok"] is False
    assert "nope.stl" in report["error"]


def test_the_inspector_is_offered_the_source_and_not_the_vertices(cube_stl):
    """Nobody edits fifty thousand welded vertices; what is editable is which
    file they came from. Same reason a sampled path is not offered as the
    points it draws."""
    session = MagpylibStudioSession()
    add_mesh(session, "rotor", file_source(cube_stl))
    params = {p["name"]: p for p in session.get_params("rotor")}

    assert "vertices" not in params
    assert "faces" not in params
    assert params["mesh_source"]["kind"] == "mesh"
    assert params["mesh_source"]["value"]["path"].endswith("cube.stl")
    assert params["mesh_source"]["status"]["faces"] == 12


def test_a_mesh_typed_out_in_full_still_works(cube_stl):
    """The source is an addition, not a replacement: a document may still
    carry vertices and faces directly, which is what importing a script that
    built one produces."""
    vertices, faces = meshes.weld(meshes.read_stl(str(cube_stl)) * 0.001)
    session = MagpylibStudioSession()
    result = session.add_object(
        "rotor",
        "magnet.TriangularMesh",
        params={
            "polarization": [0, 0, 1.2],
            "vertices": vertices.tolist(),
            "faces": faces.tolist(),
        },
    )

    assert result["ok"] is True
    assert "mesh" not in session.list_objects()[0]  # no source, no status
    assert {p["name"] for p in session.get_params("rotor")} >= {"vertices", "faces"}


def test_the_mesh_methods_are_reachable_over_the_wire(cube_stl):
    """A method the session has and `_PUBLIC` does not is a method the
    frontend calls and the wire refuses — which is how this feature first
    reached the extension: the import dialog asking a question the engine
    would not answer.
    """
    requests = [
        {
            "id": 1,
            "method": "inspect_mesh",
            "params": {"source": {"from": "file", "path": str(cube_stl)}},
        },
        {"id": 2, "method": "set_base_dir", "params": {"path": str(cube_stl.parent)}},
    ]
    out = io.StringIO()
    serve(
        session=MagpylibStudioSession(),
        inp=io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n"),
        out=out,
    )
    responses = [json.loads(line) for line in out.getvalue().splitlines()]

    assert responses[0]["result"]["faces"] == 12
    assert responses[1]["result"] == {"ok": True}


def test_pyvista_is_optional_and_says_so_when_it_is_missing(tmp_path):
    """OBJ, PLY and the rest go through pyvista, which this package does not
    depend on — its runtime is magpylib and plotly. Whichever way the machine
    running the tests is set up, the answer has to be a sentence a person can
    act on rather than an ImportError from three frames down."""
    path = tmp_path / "part.obj"
    path.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")

    try:
        import pyvista  # noqa: F401
    except ImportError:
        with pytest.raises(meshes.MeshError, match="needs pyvista"):
            meshes.read_file(str(path))
    else:
        assert len(meshes.read_file(str(path))) == 1
