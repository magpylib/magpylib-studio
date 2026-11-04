"""Every kind of magpylib object in one view, and the view's keys and tools:
`marimo edit examples/marimo/every_kind.py`.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="Every kind")


@app.cell
def _():
    import magpylib as magpy
    import marimo as mo
    import numpy as np

    from magpylib_studio.widget import SceneWidget

    return (
        magpy,
        mo,
        np,
        SceneWidget,
    )


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Every kind of object, and the view's keys

    Click a view to give it the keys: **F** frames the selection, **Home**
    everything, **1** **3** **7** look from the front, the right and the
    top, **H** hides, **space** plays a run. The tools in its top-right
    corner export a PNG, or one HTML file that works without this notebook.
    """)
    return


@app.cell(hide_code=True)
def _(SceneWidget, magpy, mo, np):
    mm = 1e-3

    def _every_kind():
        # The centrepiece: a Möbius band, as the docs build one -- vertices
        # from its middle line out to its edge, twice round, which covers
        # both halves of it -- its current running over both its faces.
        # Turned to the view's first look, which comes from 51 degrees below
        # x, so that its twist shows.
        round_twice = np.linspace(0, 4 * np.pi, 160)

        def band(w):
            reach = 1 + w * np.cos(round_twice / 2)
            return np.column_stack(
                [
                    reach * np.cos(round_twice),
                    reach * np.sin(round_twice),
                    w * np.sin(round_twice / 2),
                ]
            )

        strip = np.empty((320, 3))
        strip[0::2], strip[1::2] = band(0), band(0.36)
        moebius = magpy.current.TriangleStrip(
            current=20, vertices=strip * 16 * mm, style_label="Möbius band"
        )
        moebius.rotate_from_angax(-51, "z", anchor=0)

        # a square sheet, as the docs build one: its current circulating, the
        # stronger the further out
        side = np.linspace(-5, 5, 11) * mm
        sheet = np.array([(x, y, 0) for x in side for y in side])
        sheet_faces = [
            face
            for i in range(10)
            for j in range(10)
            for face in (
                (j + 11 * i, j + 11 * i + 11, j + 11 * i + 12),
                (j + 11 * i, j + 11 * i + 12, j + 11 * i + 1),
            )
        ]
        centres = sheet[np.array(sheet_faces)].mean(axis=1)
        sheet_current = np.column_stack(
            [centres[:, 1], -centres[:, 0], np.zeros(len(centres))]
        ) / (5 * mm)

        # one of every other kind, each made with its magnetization along `p`
        kinds = {
            "mesh": lambda p: magpy.magnet.TriangularMesh.from_ConvexHull(
                polarization=p, points=np.vstack([np.eye(3), -np.eye(3)]) * 7.5 * mm
            ),
            "sphere": lambda p: magpy.magnet.Sphere(polarization=p, diameter=11 * mm),
            "cuboid": lambda p: magpy.magnet.Cuboid(
                polarization=p, dimension=(11 * mm,) * 3
            ),
            "cylinder": lambda p: magpy.magnet.Cylinder(
                polarization=p, dimension=(11 * mm, 13 * mm)
            ),
            "segment": lambda p: magpy.magnet.CylinderSegment(
                polarization=p, dimension=(5 * mm, 11 * mm, 10 * mm, -42, 42)
            ),
            "tetrahedron": lambda p: magpy.magnet.Tetrahedron(
                polarization=p,
                vertices=(
                    np.array([(0, 0, 0), (10, 0, 0), (0, 10, 0), (0, 0, 10)]) - 2.5
                )
                * 1.3
                * mm,
            ),
            "triangle": lambda p: magpy.misc.Triangle(
                polarization=(0, 0, 1),
                vertices=np.array([(-5, -4, 0), (5, -4, 0), (0, 5, 0)]) * 1.3 * mm,
            ),
            "loop": lambda p: magpy.current.Circle(current=10, diameter=13 * mm),
            "sheet": lambda p: magpy.current.TriangleSheet(
                current_densities=sheet_current, vertices=sheet, faces=sheet_faces
            ),
            "wire": lambda p: magpy.current.Polyline(
                current=10,
                vertices=np.array([(-6, -4, 0), (-2, 4, 0), (2, -4, 0), (6, 4, 0)])
                * 1.3
                * mm,
            ),
            "dipole": lambda p: magpy.misc.Dipole(
                moment=0.4 * np.array(p), style_size=12 * mm, style_sizemode="absolute"
            ),
        }
        # Round the band, in this order from 47 degrees: the magnets behind it,
        # as the view first looks, polarized round the ring; the flat ones in
        # front, stood up to face it.
        ring = []
        for k, name in enumerate(kinds):
            angle = np.deg2rad(47 + k * 360 / len(kinds))
            outward = np.array([np.cos(angle), np.sin(angle), 0])
            around = np.array([-np.sin(angle), np.cos(angle), 0])
            made = kinds[name](around)
            made.style.label = name
            reach = 37 * mm
            if name == "segment":
                # its arc bulging outward, and its own y round the ring
                made.rotate_from_angax(np.rad2deg(angle), "z", anchor=0)
                made.polarization = (0, 1, 0)
                reach -= 8 * mm
            elif name in ("triangle", "loop", "sheet", "wire"):
                # facing that first look: 51 degrees below x, 29 above the floor
                made.rotate_from_angax(61, "x", anchor=0)
                made.rotate_from_angax(39, "z", anchor=0)
            made.move(reach * outward)
            ring.append(made)
        objects = [moebius, *ring]
        return mo.vstack(
            [
                mo.md(
                    "Every kind of object, round a Möbius band whose current runs "
                    "over both its faces. Each takes the handles: **R** on a "
                    "magnet's faces resizes it, ⌥ moving the opposite one too; a "
                    "sphere and a loop resize by the rim; a shape made of points "
                    "has a dot on each, ⌘/ctrl-click to take several. Hold ⇧ to "
                    "land on another object's corner; Esc takes a drag back. These "
                    "are copies of the cell's objects, which stay as made."
                ),
                SceneWidget(*objects, editable=True, height=540),
            ]
        )

    _every_kind()
    return


if __name__ == "__main__":
    app.run()
