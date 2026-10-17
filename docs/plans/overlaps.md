# Overlaps: what is left

**Status:** built on #47, 2026-10-18; what it decided is
[0029](../decisions.md#0029-overlapping-magnets-are-found-and-said-as-you-edit),
and how it works is in [architecture.md](../architecture.md). This plan keeps
only what is not built. The method is explained, shape by shape, in the
[Magnet Overlap Explorer](https://claude.ai/artifact/XVjV65rAadneCavh5BKB22).

## Open decisions

1. **A meshed magnet is one body.** material-response returns a Collection of
   touching cells. Proposed: it marks the Collection it returns, and a marked
   one is checked as one body: its cells never against each other, the grid
   handing over the cells near anything else. Unmarked, the cells are checked
   pair by pair: right, but about 13 ms for a turned 10 × 10 × 10 mesh.
2. **Into magpylib.** When, and under what name (`magpy.check_overlaps`?). The
   module imports nothing from studio.

## Not built

- A loop meets a mesh that is not convex as 2048 points on it, so a dip into the
  mesh shorter than their spacing is missed.
- A mesh against a mesh compares every edge's box with every triangle's, and a
  gap between two large meshes is measured triangle pair by triangle pair.
- A pair of pieces that takes more than 20,000 tests is called overlapping,
  since it was not shown clear: a guard no scene tried has reached.
- A script run in VS Code draws a saved page, made without the objects, so its
  figure shows no overlaps; a notebook's `show()` does.

## Done when

The decisions are taken and built, and this plan is deleted.
