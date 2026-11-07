# The notebook view

`SceneWidget`, from `magpylib_studio.widget`
(`pip install "magpylib-studio[widget]"`), is the studio's 3D view as a notebook
widget: Jupyter, marimo, VS Code notebooks. It also writes the view as one HTML
file that opens anywhere, from a notebook or from a plain script.

## Which view to make

```python
import magpylib as magpy

from magpylib_studio.widget import SceneWidget

magnet = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01))
probe = magpy.Sensor(position=(0, 0, 0.02))

look = SceneWidget(magnet, probe)  # to look at; its pencil gives it handles
edit = SceneWidget(magnet, probe, editable=True)  # handles and undo
shown = SceneWidget(magnet, probe, editable="never")  # re-pointed by the notebook
shown.update(magnet.copy(position=(0.005, 0, 0)), probe)
```

- **A view with a session of its own** copies the objects into a studio session,
  and the cell's objects stay as they were. That is a view made from a `@scene`
  or a path, one made with `editable=True` or `field_lines=True`, and one whose
  pencil was pressed.
- **`update(...)`** re-points a view of the cell's own objects, keeping the
  camera. A view with a session of its own refuses it with a `TypeError`.
- **Field lines need a session**, so a view made with `editable="never"` draws
  none and says nothing: it is for re-pointing, not for lines.
- **Make the view once and keep it.** A view made again in the cell a slider
  re-runs is a new element every time, and the camera goes back to its first
  framing. Call `update(...)` from another cell; it returns `None`.

## Reading the edits back

- `view.objects` is `{name: object}`, the session's objects by the cell's names,
  made again at every edit: read it again rather than keep an object from it.
- `view.variables` holds a `@scene`'s values, and `view.set_variable(name, v)`
  sets one.
- `view.revision` counts the edits, and `view.last_edit` says what the last one
  was. In marimo, wrap the view as `mo.ui.anywidget(view)` and read it in
  another cell, which re-runs after each edit. In Jupyter, use
  `view.observe(callback, "revision")`.
- `view.panes` lists the variants with a pane beside the scene's. Assigned,
  `view.panes = ["wide"]` opens those and closes the rest; the variant the scene
  is at, and a name past the twelfth pane, open none, and the trait reads what
  opened.
- `view.selected_variants` lists the variants selected: a click on a chip or a
  pane's tag selects one alone, Ctrl-click or Cmd-click adds or removes one. A
  chip's click also sets the scene to that variant; a Ctrl-click and a tag's
  click do not. Assignable, names checked. `session.variant_session(name)` is
  the copy of the scene at that variant, the one its pane is drawn from: its
  `get_field` gives a curve per selected variant.
- `view.measurements` lists the ruler's measurements (M, or the ruler button):
  each a dict of its two ends, `"a"` and `"b"`, and what it reads in the scene's
  view, `"length"` in metres or `"angle"` in degrees, the other None. It updates
  when one is made or taken away, and once the scene settles after an edit. `[]`
  takes them away; a list read from the view puts it back. A page from
  `view.write_html` carries them. An end names a feature by the view's object id
  and a number; a script names one with
  `view.measure((obj, point), (obj, point))`, each point in metres at the
  feature meant -- the view takes that object's feature nearest it, a corner
  before an edge before a face, a round surface or a curve -- and a page saved
  after opens measured.
- `view.step` is the step of the run on screen, the row of a field read along
  the path (`sensor.getB(...)`): said when the run pauses, ends or is scrubbed,
  not at each frame played. `view.step = 12` stops the run there. A plot follows
  it with `view.observe(callback, "step")`, in marimo into a `mo.state` the plot
  cell reads.

## A scene, its variants and a run

A `@scene` function shown in the view has its variants as a row along the view's
foot. A chip lifted out of the row and dropped on a side of the view is a pane
of its own there, the scene at that variant's values beside the scene, as VS
Code splits its editors: up to 12 panes with the scene's, moved by their tags,
resized by the line between them, turned together. A variant with a pane has no
chip in the row until the pane closes; the one the scene is at opens no pane,
the scene's own shows it, its tag named for it (`✎ Helmholtz` in an editable
view: the pencil marks the live scene, the other panes are copies), and its chip
leaves the row too while the view is split. The button at the end of the row
opens every other variant at once in a grid, up to 11, and closes them all
again. The scene's own ×, at a variant, moves the scene to the next pane's
variant (one step to undo) and closes that pane into it. With the handles out
(`editable=True`, or the pencil), the sliders toggle opens a slider per
variable, and `open_panel="variables"` opens it at the start. An object on a
path is a run, which the view plays.

```python
from typing import Annotated

import magpylib as magpy
import numpy as np

from magpylib_studio import Length, grid, scene
from magpylib_studio.widget import SceneWidget


@scene(variants={"near": {"gap": 0.004}, "far": {"gap": 0.012}})
def pair(gap: Annotated[float, Length(0.002, 0.02)] = 0.008):
    """Two magnets `gap` apart, one sliding past a probe."""
    fixed = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01,) * 3)
    moving = magpy.magnet.Cuboid(
        polarization=(0, 0, 1), dimension=(0.01,) * 3, position=(-0.01, 0, 0.01 + gap)
    )
    moving.move(np.linspace((0, 0, 0), (0.02, 0, 0), 9), start=0)
    probe = magpy.Sensor(
        position=(0, 0, 0.012 + gap / 2),
        pixel=grid(0.02, 9, plane="xz"),
        style={"pixel": {"size": 0, "field": {"source": "B"}}},
    )
    return fixed, moving, probe


view = SceneWidget(
    pair.build(), editable=True, field_lines=True, open_panel="variables"
)
view.set_variable("gap", 0.006)
print(view.variables)
```

`field_lines=True` draws lines through the pixels of each sensor that has a
`pixel` array and reads B or H there (`style.pixel.field.source`). A sensor
without either draws none, and nothing says so. At `pixel.size` 0 the pixels are
hidden and still give the lines their colours.

## One HTML file, from a script

```python
import pathlib

page = view.to_html()  # the run, every variant, the field lines
pathlib.Path("pair.html").write_text(page, encoding="utf-8")
view.write_html("pair_now.html", variants=False)  # the run, no variants
view.write_html("pair_still.html", run=False)  # the step drawn, still
view.write_html("pair_part.html", steps=(2, 6))  # steps 2 to 6 alone
```

No notebook or browser is needed: this runs in a plain Python script.
`write_html(path)` is `to_html()` written to a file; each call computes the page
again. The page is the view itself, not a picture: orbit, legend, keys, the run
and the variants, with no Python behind it. It has no handles and no sliders: a
value outside its variants needs the notebook. A view never drawn on screen has
no camera to keep, so the page opens framed on the whole scene. A run carries
every step, and each variant its own run, so a page with a long run and many
variants takes a while to write. In a notebook, the view's own export button
asks first, in the view's foot, which steps of the run and which variants to
carry, and writes it a piece at a time, with a count and a Cancel.

## What takes the time

- **Solved parts.** A face-charge sheet that keeps its part (material-response
  0.9.1 on, or `ChargeSheet(..., part=)`) is solved again at every step of a
  drag or a run, in a view with a session. A drag whose steps take over a
  quarter of a second, or a model of over 5,000 unknowns, is solved once, when
  the drag ends.
- **Field lines.** They are traced through a grid of points around each sensor:
  about 2,500 while dragging, about 8,000 at rest. Beside a solved part, its
  field there is most of a step without a matrix. From
  magpylib-material-response 0.10.0 it is kept as one, built the second time
  running a mesh is read at the same points, the pixels' included; every step
  after reads it in under a millisecond.
- **Where it stays as slow as without a matrix, never slower.** A part moved
  along a solved part within about a tenth of its own size (1 mm for a 10 mm
  magnet) grades the sheet's panels anew at every step, so no two steps share a
  mesh. And the matrices take at most `magpylib_studio.fieldlines.MATRIX_MEMORY`
  bytes in all, 150 MB, the oldest let go first. Set it before the view draws:
  higher for a fine mesh, with room for the drag and the rest grids together
  (about 550 MB for a plate at level 3), or 0 for none.
- **Precision.** A matrix is single precision, which a field line cannot tell
  from double. Two pages of the same scene may differ in the last digits of
  their lines, depending on whether a matrix had been built before.
