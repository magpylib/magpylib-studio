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

| slice | what                                                                                    | state                         |
| ----- | --------------------------------------------------------------------------------------- | ----------------------------- |
| 1     | flat set region: outline, pick, 4 grips, edit, lines clipped, caches keyed, undo, saved | built, waiting for Alex's try |
| 2     | map: `field_map` switch, host glue, texture from the flat grid                          | todo                          |
| 3     | box: 6 grips, a plane sample for the map                                                | todo                          |
| 4     | runs and saved pages honour a set region                                                | todo                          |
| 5     | decision record, changelog, guide, harness check, bundles                               | todo                          |

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
- Open: the pointer cursor over the outline did not show in the headless run.
