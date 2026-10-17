# Overlaps: say which magnets interpenetrate

**Status:** prototype on the `overlap-detection` branch, 2026-10-17. The method
is explained, shape by shape, in the
[Magnet Overlap Explorer](https://claude.ai/artifact/XVjV65rAadneCavh5BKB22).

## Why

Magpylib adds the magnetizations of two magnets wherever they overlap. A magnet
pushed into its neighbour therefore computes a field that looks plausible and is
wrong, and nothing says so: it is the most common silent modelling error. Studio
already says what is wrong with a mesh where it is listed (an open mesh is data,
not a warning); an overlap is the same kind of fact about the scene.

## What counts

- A pair overlaps when the two interpenetrate by more than 1 nm
  (`collisions.TOL`). Touching never counts: a Halbach ring, a stack, a shaft in
  its bore and a coil on its core all touch on purpose.
- Every leaf is checked against every other, copies made by a pattern included;
  collections are not shapes.
- Sensors, dipoles and custom sources never overlap: a sensor inside a magnet is
  a valid reading. Two wires, or two sheets, have no thickness and are not
  checked against each other. A wire or a sheet through a magnet is.
- Each object is taken where its path ends, which is the pose it is drawn in.

## How, as prototyped

`magpylib_studio/collisions.py` takes magpylib objects and returns index pairs.
It imports nothing from studio, so it can move into magpylib as it is.

- **Convex pieces.** Each shape is a set of convex pieces known by their support
  functions: exact for Cuboid, Cylinder, Sphere, Tetrahedron and a convex
  TriangularMesh. Nothing curved is turned into triangles.
- **Touching is not overlapping.** Every solid piece is shrunk by half the
  tolerance before it is tested: exactly for the analytic shapes, about the
  incentre for a tetrahedron, about the centre for a convex mesh. Faces that
  touch end up apart.
- **The test.** MPR (Minkowski portal refinement) decides whether two convex
  pieces meet. Measured on 72,000 near-contact cases (box, sphere, cylinder; 0.1
  mm gap to 0.1 mm overlap): all right, where GJK misread up to 12% of touching
  curved pairs.
- **Rings.** A CylinderSegment with a bore, or wider than 180°, is cut into
  wedges of at most 90°. Each wedge sits between an outer stand-in (a chord
  where the bore is) and an inner one (a line tangent to the bore). Missing the
  outer clears the wedge, hitting the inner proves the overlap, and anything
  else halves the wedge. A shape within the bore's radius of the axis clears
  every wedge at once. A current loop is cut the same way. Reaching the outer
  stand-in alone proves nothing: a tilted shaft clearing its bore by 0.47 mm
  needs eight cuts, and was called touching until that was fixed.
- **Meshes that are not convex.** Their triangles are the pieces, and one more
  check finds a shape wholly inside. Two such meshes, or a mesh and a wire or a
  sheet, overlap when an edge of one passes through a triangle of the other, its
  two ends at least the tolerance either side.
- **Pairs worth testing** come from a sweep over the objects' boxes, then the
  pieces' boxes. Shrunk boxes of shapes that only touch are already apart.

The session lists the pairs as `get_overlaps` (also over RPC) and in every scene
it sends (`overlaps`), a drag's preview frames included, so an overlap shows
while the magnet is still under the pointer. The 3D view outlines each
overlapping object in magenta, with the selection's outline: lines only, so a
magnet's colours still say its magnetization. Not red: magpylib paints a
magnet's north pole red, and a red outline vanished on the magnets it marked
(checked on a screenshot). A selected object keeps its green.

## Numbers

`get_overlaps` on the eight examples: 0.03 to 3.8 ms, nothing found. From the
earlier prototype: a pair with a clear gap costs 1.6 µs, a curved pair in
contact 50 to 60 µs; the box sweep takes 0.05 ms for 100 objects and 1.4 ms for
1,000.

## Open decisions

1. **Overlaps on purpose.** Magpylib's own superposition example cuts a hole
   with an overlapping magnet of opposite polarization. Recommendation: list
   every overlap, and let a pair be marked as intended in the document, shown
   dimmed rather than hidden. Guessing from the polarizations would be wrong too
   often.
2. **A meshed magnet is one body.** material-response returns a Collection of
   touching cells. Recommendation: it marks the Collection it returns, and a
   marked one is checked as one body: its cells never against each other, the
   grid handing over the cells near anything else. Unmarked, the cells are
   checked pair by pair: right, but a turned 10×10×10 mesh costs about 13 ms.
3. **Paths.** Only where each path ends, or every step: a rotor turning past its
   stator overlaps mid-path.
4. **Into magpylib.** When, and under what name (`magpy.check_overlaps`?).

## Not in the prototype

- How deep an overlap is, and how wide a gap: "r3 overlaps r4 by 0.8 mm", a gap
  readout between two selected objects, sliding to contact.
- The Objects tree and the Inspector saying it; the agent skill teaching it.
- A read-only view: a notebook's `show()` or a script's figure is drawn from
  magpylib's display scene, not a session, so it shows no overlaps yet.
- Pieces kept between builds: every scene builds them again.
- A loop meets a mesh that is not convex as a 256-sided polygon; large meshes
  compare every edge's box with every triangle's.

## Done when

The decisions are taken, the gaps above that they need are closed, the
architecture says how it works, and this plan is deleted.
