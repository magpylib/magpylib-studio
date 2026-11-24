# A sensor's field region: lines and a map, resized by grips

**Status:** in progress on branch `field-region`, started 2026-11-23. Mockup:
<https://claude.ai/artifact/4zsFvPwPS2xhtcEEyb3HQv>.

## What

Each sensor whose pixels read B or H has one **region**: a rectangle in its
plane when its lines keep to it, else a box. Its field lines run in it, and a
**map** of |field| can be drawn on its plane, from the same grid. The region is
resized with **face grips**, as a Cuboid is (`GRIPS.free`): 4 grips flat, 6 in a
box, the opposite face staying put, ⌥ both.

## Decisions taken (proposed to Alex 2026-11-23, "go")

1. **Auto by default, unchanged**: a sensor with no region set keeps today's
   rule (`grid_around`, `frame_of`) byte for byte, so scenes, runs and saved
   pages draw as they did.
2. **A set region is the sensor's**: its centre, axes and size are stored in the
   sensor's own frame, so it turns and moves with the sensor. The first grip
   drag takes them from the automatic grid then in use, with its depth, so a
   region whose field leaves the plane has a box ready.
3. **Picked by its outline**: with the sensor picked and lines or map on, the
   region shows dashed; a click on it shows its grips. R on the sensor still
   spreads its pixels. Pixels spread past a set region start no lines.
4. **Saved in the document** (`field_regions`, per sensor), as 0032 keeps the
   lines' switch. A drag is one step to undo, through `apply_edits`, so every
   host relays it as it relays any drag. "Back to auto" is the same edit with no
   region.
5. **Points stay fixed** (`REST_POINTS`, `DRAG_POINTS`): a bigger region is
   coarser, and a frame costs what it did.
6. **The grid keeps one step**: it covers the region, and the item carries the
   region's box beside it; lines stop at the box, and the outline and grips are
   drawn from it.
7. **Map switch scene-wide**, beside the lines' (`field_map`): lines, map, both
   or none. Coloured by the sensor's own table, so the colour bar holds; it
   saturates near a magnet. Lines over a map are drawn in a neutral ink.

## Slices

| slice | what                                                                                    | state          |
| ----- | --------------------------------------------------------------------------------------- | -------------- |
| 1     | flat set region: outline, pick, 4 grips, edit, lines clipped, caches keyed, undo, saved | done (cc1c40e) |
| 2     | map: `field_map` switch, host glue, texture from the flat grid                          | built          |
| 3     | box: 6 grips, a plane sample for the map                                                | built          |
| 4     | runs and saved pages honour a set region                                                | built          |
| 5     | decision record (0059 written), changelog, guide, harness check, bundles                | built          |

## Log

- 2026-11-23: plan written from the mockup's review; reordered into slices.
- 2026-11-23: slice 1 built, flat and box alike (6 grips came for free). Alex's
  first try (Helmholtz, a box): lines kept to the pixels' reach. A set region
  now fills: starts laid evenly through it, middle first, and lines run to a
  thousandth of the field at the pixels rather than a twenty-fifth. Checked in a
  headless JupyterLab: outline click picks, grips drag, Esc lets go.
- 2026-11-23: Alex: no colour bar with the lines alone. At `pixel.size = 0`
  magpylib draws no pixels, and the bar read only pixels items; the lines item
  now carries the same table (`colour_scale`) and the bar falls back to it.
- 2026-11-24: slices 2 and 3 built. The map is a row of its own beneath each
  sensor ("field map (|B|)"), its eye the document's `field_map` switch as the
  lines' eye is `field_lines`'; drawn from the lines' grid where it is flat, and
  where the lines run in a box from a plane the engine samples for it (a set
  region's own plane, else the rule's flat grid). Lines over a map are white.
  Checked in a headless JupyterLab on the two cubes, the tilted probe and the
  coil pair.
- 2026-11-24: the colour bar spans what the pixels read; on the coil pair the
  map saturated everywhere but the middle. Alex: the bar spans what the map
  shows. With the map on, the sensor's levels widen to the map's 1st–99th
  percentile of |B| (`map_levels`), and pixels, lines and map restretch with it:
  coil pair 2.42–3.12 → 1.79–5.26 mT.
- 2026-11-24: branch review. Fixed:
  - a saved page dragged kept the old region and map plane;
  - a run's last frame kept lines from before a map switch or region edit;
  - a run export missed map and region changes made while it ran;
  - a region beside a pose in one `apply_edits` went half through;
  - a grid's kind was not redone when the pixels left the region's plane;
  - white ink on box lines;
  - the map's name.

- 2026-11-24: Alex: "fix all".
  - A set region keeps its field as the rule's grid does: in a gesture a grid
    1.5 times the region, fixed in the world while it covers it; at rest a
    step's room round it, slid on release.
  - The map's plane does the same, and with the lines off it is all that is
    computed.
  - Code cites decision 0059 rather than this plan.

  A sensor dragged past 1,000 still cuboids (`dragperf/drag.py` in the session
  scratchpad): 390–700 → 50 ms a frame, 1–1.9 s → 0.2–0.45 s to let go. The
  rule's grid alone: 45 ms.

- 2026-11-24: Alex: with the map alone, the dashed outline lagged behind a
  sensor dragged by its gizmo. Two causes: the outline was drawn in the world
  from the engine's last item, and the rule's grid stays in the world during a
  drag, so a map drawn from it stayed behind. Now the outline hangs on the
  sensor's node, and under a map the rule's grid slides with the sensor by whole
  steps (88 ms a frame past 1,000 cuboids, against 316 before the branch and 50
  for a grid that stays). Checked in a headless JupyterLab: the outline follows
  the gizmo to a pixel.
- 2026-11-24: Alex, on an exported page: the map could not be seen, and the
  grips resized nothing.
  - The page dragged with code of its own that knew no region: a grip's edit
    moved the sensor to where it stood, and a sensor dragged lost its region
    and, on a grid in a box, its map. The page now lays a set region's grid, the
    map's plane, and the map alone where the lines are off, as the session does;
    the region travels with the page's sensor. Held to python by a parity test;
    resized and dragged in headless Chrome.
  - The map one colour: on the U-core, a sensor on the yoke has pixels in the
    iron reading up to 277 mT, the map 0.25–13 mT, and the bar spanned both.
    With the map on, the sensor's colours are now the map's span alone.
- 2026-11-24: Alex: "finish what is open". A run's frames lay a set region's
  grid and the map's plane (`_frame_field`), the map alone from its plane. The
  pointer cursor over the outline works: the headless run sent its moves with
  the left button held, which the view reads as an orbit. Changelog, guide and
  architecture written. The plan is built; it goes once Alex says so.
