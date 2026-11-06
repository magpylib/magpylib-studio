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
  own;
- the legend's gap between two selected objects stays beside the ruler, for now;
- curved surfaces are measured on their drawn facets, said in the label's
  tooltip; exact values from python come later, if at all.

Nothing is built.

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

The pairs the other way round are the same. An edge with a corner or a face is
the distance from the corner to the edge's line, or the edge's nearest point to
the face's plane.

- **Hovering shows the pick first**: a dot on a corner, the edge drawn bright,
  or the face tinted, within `SNAP_PIXELS`. A corner beats an edge, an edge a
  face.
- **One dimension line, one label**, said by `sayLength`, or in degrees. Its
  tooltip gives Δx, Δy and Δz, and says when an end is on a curved surface's
  facets.
- **M or the button** says only whether a click picks a corner: off, the
  measurements stay, follow what they measure, and a label's × still takes one
  away, while a click selects again and the handles drag.
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
- **It is the view's**, not the document's: no undo step, nothing in the script,
  the saved scene or a saved page.

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
with nothing more to do. A label faces the camera, stays its size on screen, and
stands aside from the lines' ends.

## 6. Cost

- Snap targets for vertices, as a drag takes them: when the ruler comes on and
  each time the camera stops, in the pane under the pointer.
- One ray a frame on the pointer's move, as hover already casts, for the face
  and the part under it.
- A part's faces and edges once, the first time the pointer is over it.
- Checked on a sealed collection of thousands of cells (#86–#88): orbit and
  hover with the ruler on no slower than with it off, on the slow-machine run.

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

- `view.measurements`, read only, a value a variant, as `panes` and
  `selected_variants` are, for a notebook to plot a gap per variant. Later; the
  features of §3 make it possible.
- Folding the legend's gap into the ruler, once the ruler measures object to
  object as well.
