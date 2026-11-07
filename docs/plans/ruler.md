# A ruler in the view — design

**Status: proposed, 2026-11-06.** Issue
[#125](https://github.com/magpylib/magpylib-studio/issues/125). Decided with
Alex that day, on the issue's open questions:

- several measurements at once, each cleared by its own ×, all of them by Esc
  with the ruler on; the ruler off, they stay and follow, so an object is
  selected and dragged by its handles while they show (Alex, the same day);
- with the view split into panes, a measurement is mirrored into every pane, at
  that pane's variant;
- the PNG keeps the measurements; a saved page does not, and has a ruler of its
  own; since, a saved page carries them, and `view.measurements` says them to a
  notebook (Alex, 2026-11-07, §10);
- the legend's gap between two selected objects stays beside the ruler, for now;
- curved surfaces are measured on their drawn facets, said in the label's
  tooltip; exact values from python come later, if at all. Since, a sphere's and
  a cylinder's side are found from their facets and measured exactly (Alex,
  2026-11-07, §3).

Built: all of §7, 2026-11-07; round surfaces and labels kept apart the same day.

---

## 1. What there is

- **The legend's gap** (`get_gap`, `session.py`): two objects selected, the gap
  between them, exact, from python. An editable view's only; a saved page and a
  view of the cell's own have none.
- **Snapping** (`snapTargets`, `scene3d.mjs`): the vertices drawn, and glyph
  anchors, kept in cells of `SNAP_PIXELS` on the page, taken once a drag. It
  keeps world positions only, not whose vertex each is.
- **Hover** (`pick`, `lookSoon`): one ray a frame while the pointer moves, over
  every drawn trace, for the faint mark of what a click would select. A batched
  trace (#86–#88) still hangs on its object's node, where the ray finds it.
- **Edges** (`regionEdges`): `THREE.EdgesGeometry` at `EDGE_ANGLE`, for a
  region's outline.
- **Lengths said** (`sayLength`): a length in the scene's unit, in the unit that
  reads best.
- **Pictures** (`snapshot`): the canvas, which the scale bar is drawn on as a
  texture; what a host lays over the canvas as HTML is not in it. Split, the
  picture is every pane's (#149).

## 2. The tool

A ruler button among the view tools, and the key **M**: a view setting, not an
edit, so it is in a view to look at, a saved page and the VS Code panel alike,
all of it in the renderer, nothing asked of python.

What the two picks are decides what is measured, with no mode to choose:

| 1st pick | 2nd pick | Shows                                             |
| -------- | -------- | ------------------------------------------------- |
| corner   | corner   | the distance                                      |
| corner   | face     | the distance to the face's plane, at right angles |
| face     | face     | the gap, if they are parallel; else the angle     |
| edge     | edge     | the shortest distance between them                |
| any      | round    | the shortest distance, to the true shape          |

Two features with a direction -- edges and faces -- that touch or cross are
measured by their angle, the distance between them being none; parallel, by
their distance; neither, by their distance, the angle in the label's tooltip.
What has no size is a point: a dipole -- drawn at any size, `sizemode` absolute
or a model of its own too, marked in Python with its position (`_mark_dipoles`)
-- a sensor at its position and each of its pixels at its middle, not the boxes
they are drawn as (Alex, 2026-11-07). The pairs the other way round are the
same. A corner and an edge are the distance from the corner to the edge; an edge
or a face and a face that are neither parallel nor touching, the shortest
distance between them, as drawn, and parallel, the distance between their
planes. Where such a distance ends in a face's plane but off the face -- a
corner's foot past its edge, a parallel face's middle beside it -- a dashed line
runs on from that end to the face's nearest point, as a drawing's extension line
does, so the end is seen to be that face's (Alex, 2026-11-07). A pair measured
already, either way round, or another whose line is the same, is not measured
again.

- **Hovering shows the pick first**: a dot on a corner, the edge drawn bright,
  or the face tinted, within `SNAP_PIXELS`. A corner beats an edge, an edge a
  face. Only what is in sight: a corner or an edge counts where the first
  surface a ray from the camera meets on the way to it is not nearer than itself
  -- an edge a few pixels off the surface under the pointer is still on it, one
  behind the shape a shape's depth further.
- **A straight edge** runs from a corner to a corner without bending; **a flat
  face** is a plane's triangles where every one round them meets them at an
  edge, not smoothly as a sphere's or a cylinder's side's facets do.
- **A round surface** is the rest of a shape's triangles, joined where they go
  on smoothly: a sphere's, a cylinder's side, a segment's two. Under the pointer
  when no corner, edge or flat face is, it is tinted whole.
- **One dimension line, one label**, said by `sayLength`, or in degrees. Its
  tooltip gives Δx, Δy and Δz, and says when an end is on a curved surface's
  facets.
- **M or the button** says only whether a click picks a corner: off, the
  measurements stay, follow what they measure, and a label's × still takes one
  away, while a click selects again and the handles drag.
- **Esc**, the ruler off and nothing selected, clears the measurements.
- **Esc** clears the pick half made, then the measurements, then -- the ruler
  off -- what it always did: a pane carried takes it first, as it does today.

## 3. What a measurement holds

A corner is where a shape's sharp edges meet -- faces at more than `EDGE_ANGLE`,
as its outline is found -- or a wire's end or bend: not a facet's vertex on a
round surface, so a sphere, a cylinder's side and rims, and a loop have none,
and a wire's corners come from the line its flow runs along, not from its
arrows.

Each end is a **feature**, not a point: the object's id, which drawn part of it
(the mesh's place among the node's children), and which corner, edge or face of
that part's geometry. A face is the triangles round the one hit that share its
plane, found on that part alone; an edge is one of its `EdgesGeometry` pairs.
Both are worked out once a part, when the pointer first comes over it.

- **It follows the objects**: each frame, the ends are where their features are
  now, so a drag moves the number with the magnet, and a run's step shown is the
  one measured.
- **It is mirrored** (§4): the same feature names the same corner of the same
  object in a pane drawn at another variant, where a point in the object's frame
  would not -- a variant that changes a magnet's size moves its corner.
- **A round surface is its shape**, where it is one: a cylinder's side if every
  facet's normal is at right angles to one axis, else a sphere if its vertices
  are, to 1e-4 of the radius; part of the way round where a rim runs along the
  axis. The vertices are on the true surface, so the fit is exact to rounding.
  The nearest points of it and the other end are each the other's nearest in
  turn till they stand still, from three starts, the shortest kept: each one's
  nearest to the other's middle, and the nearest pair of points sampled on the
  two. One start alone stood still on the far side of a bore, a sphere across
  its axis read 4 mm for 2. What is neither is measured on its facets, the
  tooltip says so.
- **A wire's curve** is a run of it that bends, corner to corner, or a loop with
  none: a Circle's, an arc a Polyline draws finely. A circle where its points
  are on one, to 1e-4 of the radius -- a cylinder's side of no height, part of
  the way round where it is open, measured the same way -- else its segments,
  which are the wire. Picked as an edge is, by its segment nearest the pointer
  on the page, and drawn bright whole (Alex, 2026-11-07).
- **It is the view's**, not the document's: no undo step, nothing in the script
  or the saved scene. The view's `measurements` trait holds them, and a page
  saved from the view carries that.

Snapping keeps whose corner each target is, to anchor a corner pick: an owner
and an index beside each world position, in the same cells.

## 4. In the grid

A measurement made in any pane is told to the grid, which hands every pane the
list; each pane finds the features in its own scene and draws what it finds, its
own value on its own label. A pane where an object or a feature is not -- a
variant with fewer magnets -- draws no line for it.

- **In the scene's pane the value follows a drag live**; the others follow when
  they redraw, once the edit settles (`GRID_SETTLE`).
- **Hovering looks only in the pane under the pointer**; the others work out the
  measured features alone, a handful of points.
- **The × on a label clears it in every pane.**

## 5. Drawn on the canvas

The lines and the labels are drawn by the renderer, the labels as textures as
the scale bar is, so the PNG has them, and the split one each pane's (#149),
with nothing more to do. A label faces the camera, stays its size on screen,
stands aside from the lines' ends, and above a label it would overlap.

## 6. Cost

- What a pick looks at, made again once the camera or the scene has stood still
  a moment: the shapes' parts, each with a bounding sphere, and what a ray
  cannot hit -- points and wires.
- A hover casts a ray at the pointer and four a few pixels round it; each is
  tested on the spheres first, a loop of sums, and on the triangles of the few
  it passes. The corners, edges and face come from the parts those rays meet,
  and from the points and wires near the pointer; at most six candidates of a
  kind are tested for sight, the nearest first.
- A part's corners, edges and faces once, when a ray first meets it.
- Measured on a sealed body of 4,096 cells, headless Chrome on an M4: a hover's
  look takes 0.8 ms at the median and 3 ms at worst, against 2.7 ms for the
  selection's own hover with the ruler off. What the ruler adds is a redraw when
  the feature under the pointer changes, to show it.

## 7. The order

1. **The ruler in one view**: corner to corner, the button and M, Esc, the ×,
   following a drag. The keys table and the tooltips list M.
2. **The other pairs**: faces and edges, the angle.
3. **The grid**: the list told to every pane.
4. **The PNG**: checked, though §5 should make it free.

Each with its checks in the browser harness (§8).

## 8. Checks

- Each pair of picks, on a saved page, by real pointer events.
- A measurement following a drag, in an editable page.
- Split, a measurement in each variant pane at that pane's value, and in none
  where its feature is missing.
- The PNG, alone and split, with a label in it.
- Screenshots in real JupyterLab and marimo, light and dark: the hover cue and a
  label.

## 9. Rejected

- **A point in the object's frame as the anchor**: it follows a drag, but not a
  variant that resizes the object, so a mirrored measurement would land off the
  corner.
- **Labels as HTML over the view**: crisp text, but out of the PNG, and placed
  by hand every frame.
- **Exact values from python** in v1: a saved page has no python, and a view to
  look at no session; facets, said so, are the same everywhere.

## 10. Open

- `view.measurements` is built: each pair's ends and what it reads in the
  scene's view, a length in metres or an angle, told when one is made or taken
  away and once the scene settles; assignable, and carried by a saved page. Ends
  a script names are built too: `view.measure`, each end an object and a point
  in metres at the feature, which the view names as a click would -- nearest, a
  corner before an edge before a face -- the first time the object is drawn, and
  tells back (Alex, 2026-11-07). Open: a value a variant, for a notebook to plot
  a gap per variant.
- Folding the legend's gap into the ruler, once the ruler measures object to
  object as well.
