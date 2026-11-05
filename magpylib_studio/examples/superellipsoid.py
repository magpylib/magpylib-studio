"""One formula, and most of the shapes a magnet is modelled as.

A superellipsoid is a size and two roundness exponents. `plan` rounds the shape
seen from above, from square through circular to a diamond; `profile` rounds it
seen from the side, from flat-topped to domed. Between them they make a block, a
cylinder, a sphere, and the rounded blocks and chamfered discs that real magnets
are but no magpylib class describes.

| plan | profile | shape |
| --- | --- | --- |
| 0.05 | 0.05 | a block, as magpylib's `Cuboid` |
| 1 | 0.05 | a cylinder, as `Cylinder` |
| 1 | 1 | a sphere, as `Sphere` |
| 1 | 0.3 | a rounded-edge disc |
| 2 | 2 | an octahedron |

At the first three rows the mesh can be checked against the class magpylib
computes exactly: at `facets = 120` they agree to within 0.2 %, and the error
falls with the square of the number of faces, which is why `facets` is a
slider.
"""

from typing import Annotated

import magpylib as magpy

from magpylib_studio import Bounds, Count, Length, TriangularMesh, sampled, scene

TITLE = "One formula, many solids"
SUMMARY = (
    "A superellipsoid mesh: two roundness sliders turn a block into a cylinder "
    "into a sphere — matching Cuboid, Cylinder and Sphere as they pass"
)


@scene
def superellipsoid(
    width: Annotated[float, Length(0.0005, 0.2, slider=(0.005, 0.05))] = 0.02,
    depth: Annotated[float, Length(0.0005, 0.2, slider=(0.005, 0.05))] = 0.02,
    height: Annotated[float, Length(0.0005, 0.2, slider=(0.003, 0.04))] = 0.01,
    plan: Annotated[float, Bounds(0.05, 2, slider=(0.05, 1))] = 0.35,
    profile: Annotated[float, Bounds(0.05, 2, slider=(0.05, 1))] = 0.35,
    facets: Annotated[int, Count(6, 200, slider=(12, 96))] = 48,
    lift: Annotated[float, Length(0.001, 0.1, slider=(0.005, 0.04))] = 0.01,
):
    """A superellipsoid magnet `width` by `depth` by `height`, meshed with
    `facets` faces round, and a sensor rising above it."""
    magnet = TriangularMesh.from_superquadric(
        size=(width, depth, height),
        roundness=(profile, plan),
        around=facets,
        across=round(facets / 2),
        polarization=(0, 0, 1.3),
        style_label="Superquadric magnet",
    )
    sensor = magpy.Sensor(
        position=sampled(lambda t: (0, 0, height / 2 + lift * (1 + 5 * t)), count=25),
        style_label="Above the magnet",
    )
    return magnet, sensor
