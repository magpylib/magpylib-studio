# examples

The 3D view in a notebook — the studio's three.js renderer as an `anywidget`.
The marimo demo edits two designs written as `@scene` functions, a Halbach ring
and a coil pair, with the view, the field and the files following every edit;
the Jupyter one rebuilds two rings of magnets from `ipywidgets` sliders. The
U-core demo is a scene of thousands of objects: material-response's U-core,
meshed into cells and solved, with its field lines.

| File                 | Open with                                                          |
| -------------------- | ------------------------------------------------------------------ |
| `marimo_demo.py`     | `marimo edit examples/marimo_demo.py`                              |
| `jupyter_demo.ipynb` | VS Code, or `jupyter lab examples/jupyter_demo.ipynb`              |
| `scene_demo.py`      | VS Code: **Open in Magpylib Studio** (title bar), or run its cells |
| `ucore_demo.py`      | `marimo edit examples/ucore_demo.py`                               |

The notebooks need the widget extra, and the U-core demo
magpylib-material-response too:

```sh
uv pip install -e ".[widget]" marimo magpylib-material-response
```

In marimo the sliders re-run the cells that read them. Jupyter re-runs nothing
by itself, so the notebook wires its `ipywidgets` sliders to `update()` with
observers. Either way the view is made once and re-pointed, which is what keeps
the camera where you left it.
