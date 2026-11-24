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
| 4     | runs and saved pages honour a set region                                                | todo           |
| 5     | decision record (0059 written), changelog, guide, harness check, bundles                | todo           |

## Known gaps until slice 4

- A saved page whose sensor has a set region draws it with the automatic rule
  once the sensor is dragged on the page.
- A run's frames use the automatic rule.

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

- Open: the pointer cursor over the outline did not show in the headless run.
