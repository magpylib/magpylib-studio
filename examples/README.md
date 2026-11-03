# examples

The 3D view in a notebook — the studio's three.js renderer as an `anywidget`.
The marimo demo edits five designs written as `@scene` functions, a Halbach
ring, a coil pair, a test unit's operating steps, two versions of a unit that
differ in structure, picked by a choice, and material-response's U-core, with
the view, the field and the files following every edit. It saves the steps as a
page that clicks through them, and solves the U-core by face charge again at
every step of a drag. The Jupyter one rebuilds two rings of magnets from
`ipywidgets` sliders.

| File                 | Open with                                                          |
| -------------------- | ------------------------------------------------------------------ |
| `marimo_demo.py`     | `marimo edit examples/marimo_demo.py`                              |
| `jupyter_demo.ipynb` | VS Code, or `jupyter lab examples/jupyter_demo.ipynb`              |
| `scene_demo.py`      | VS Code: **Open in Magpylib Studio** (title bar), or run its cells |

The notebooks need the widget extra, and the marimo demo's U-core
magpylib-material-response 0.9.2 too; without it, that part says so:

```sh
uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.9.2"
```

In marimo the sliders re-run the cells that read them. Jupyter re-runs nothing
by itself, so the notebook wires its `ipywidgets` sliders to `update()` with
observers. Either way the view is made once and re-pointed, which is what keeps
the camera where you left it.
