# The 3D view in a notebook

_The full guide. The short version is in the
[README](../README.md#use-it-in-a-notebook)._

```sh
pip install "magpylib-studio[widget]"
pip install "magpylib @ git+https://github.com/magpylib/magpylib@main"
```

The second line is not optional yet. The widget draws through magpylib's
display-backend API, which is on main and in no release: on 5.2.3,
`backend="widget"` does not exist.

```python
import magpylib as magpy
from magpylib_studio.widget import SceneWidget

SceneWidget(magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1)))
```

`magpy.show(objects, backend="widget")` is the same thing said magpylib's way,
and `magpy.defaults.display.backend = "widget"` makes every `show()` in the
notebook draw one. A script has no cell to draw in: run from a terminal of a
studio window, it draws in the Magpylib Studio panel, and anywhere else it opens
the view in your browser as a saved page, saying where. The tools sit in the
view's top-right corner and show when the pointer is on it, as Plotly's modebar
does: the legend, the axes, framing, the projection, the theme, a picture,
export and full screen. `animation=True` captures the paths, and a transport
along the foot of the view plays and scrubs them: in the browser, from the
motion, when every step is the first one moved — and a frame at a time from
python when the run changes shape as it goes.

A `SceneWidget` is read only, like the panel — what a view can offer to edit is
what its host can put back, and a cell has already run (for a view you can edit,
see [Editing a scene in the notebook](#editing-a-scene-in-the-notebook)).
Selecting and hiding are the exceptions, because they are values rather than
edits:

```python
scene = mo.ui.anywidget(SceneWidget(height=460))  # one cell: the view
...
scene.widget.update(ring, probe)  # another: what it draws
scene.widget.picked  # a third: what was clicked
```

**Make the view once and re-point it.** A slider re-runs every cell that reads
it, so a `SceneWidget(...)` in one of them is a _new widget per drag_: a new
element, controls rebuilt from nothing, and the camera back at its opening
framing — you lose the zoom you were working in. `update()` replaces the drawn
objects and leaves the view alone, which is what makes a slider smooth.

**The legend** floats over the view: the objects as they are nested, with a
caret to fold a collection, an eye to hide it and everything in it — shown on
the row under the pointer, and always on one that is hidden — a swatch in the
colour it is drawn, and the row itself to click: ⌘/ctrl adds, shift takes a
range in tree order, a double click frames it. It writes `selected` and
`hidden`, the traitlets a click in the view and a notebook cell write too. It
needs the objects, because the payload cannot say how they nest: it comes with
`SceneWidget(...)` and `update()`, and with a bare `magpy.show()` only where
magpylib hands its backends the objects (`Panel.objects`).

What is selected, hidden or folded survives `update()`: an object passed again
keeps it, and a rebuilt one inherits it from whatever sat in its place in the
tree — "the lower ring" is still the one below after a slider has remade both.

**Keys**, once the view has focus, are the panel's: **F** frames the selection
and **Home** everything, **1**/**3**/**7** look from the front, right and top,
**5** switches the projection, **H** hides the selection and **shift-H** shows
only it, **Esc** lets go, **space** plays. They come from one table in
`scene3d.mjs` that both hosts use. Tab is the one the widget does not take: in a
notebook it moves between cells.

**Full screen** gives the view the screen, legend and controls with it. The
**camera** saves the view as a PNG, as it is on screen and without the legend.
**Export** saves it as one HTML file that opens anywhere with no notebook behind
it — the widget itself, not a picture: orbit, legend, keys, and a captured run
that still plays, because its motion — or, for a run that changes shape, its
frames — travels in the file. `write_html(path)` does the same from a cell.
Either way the page opens where the view was looking.

Which is [direction.md](direction.md) §5.3 — _a viewer with parameter binding_ —
with the notebook's own reactivity in place of a protocol: a slider rebuilds the
objects, the view redraws them, and a click is an input to the next cell.
`examples/marimo_demo.py` is that loop, and `examples/jupyter_demo.ipynb` the
same scene in Jupyter, with `ipywidgets` sliders in place of marimo's
reactivity.

## Editing a scene in the notebook

`editable=True` puts out the studio's handles, over a studio session in the
kernel — the engine the VS Code extension drives, with nothing of the extension
needed:

```python
studio = SceneWidget(ring, probe, editable=True)
studio  # W moves, E turns, R resizes, P aims; L for the object's own axes
```

`SceneWidget("scene.py", editable=True)` is the same view of a script's objects,
or of a `.magpy.json` the studio saved.

```python
studio.objects["probe"]  # the objects as edited, to compute with
print(studio.to_script())  # what was built, and every edit, as magpylib code
studio.undo()  # a whole drag at a time; ⌘Z / ctrl-Z in the view
studio.save("ring.magpy.json")  # opens in the VS Code studio
studio.set("probe", position=(0, 0, 0.02))  # an edit from code, as a drag makes
```

`set` and `observe(..., "revision")` keep a notebook control and the view in
step both ways — `examples/jupyter_demo.ipynb` does it with a slider. A value
the object already has is no edit, so neither side echoes the other. `revision`
counts each settled edit — a drag's end, an undo, a redo, a `set` — once, and
`last_edit` says what it was
(`{"by": "drag", "objects": ["probe"], "changed": {...}}`, or the step an undo
took back); the same example logs them under the view, with what was selected
and hidden. A drag of several objects, or a `set` of several values, is one
edit: refused in part, none of it is made.

The objects are copied into the session rather than edited in place: the cell
that made them stays as it was, and running it again does not take the edits
away. A drag is recorded as it goes and is one step to undo; the notebook hears
of it once, when it ends — in marimo, the cells that read
`mo.ui.anywidget(studio)` re-run then, not on every frame. It needs a live
kernel: without one the view says so and puts the object back, and a page saved
with `write_html` is read only. The handles and their keys are the panel's —
**W** moves, **E** turns, **R** resizes, **P** aims a polarization, **Q** puts
them away; **X**/**Y**/**Z** hold a drag to one axis and **A** frees it, **L**
swaps the world's axes for the object's own, **S** snaps — and a column down the
view's right-hand side has the same. The corner reads out the numbers a drag is
changing, and takes a typed value in their place; the keys button lists every
key. A collection has handles of its own: select it — its row in the legend, or
**C** from something in it, and **C** again for the one round that — and a drag
moves and turns it whole, as one edit to the collection. The variables come
later — [editable-widget.md](editable-widget.md).

The view is `vscode-extension/media/scene3d.mjs` — the panel's own renderer —
and the legend `magpylib_studio/static/legend.mjs`. `tools/build-widget.sh`
bundles them with three.js into `magpylib_studio/static/widget.js`, which is
committed so that installing the package needs no node; `npm run check:widget`
fails the build when it no longer matches its sources.

[aw]: https://anywidget.dev
