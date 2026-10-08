# examples

The 3D view in a notebook — the studio's three.js renderer as an `anywidget` —
on the same scene twice: two rings of magnets stacked round a probe, rebuilt
from sliders, and a sensor sweeping past a magnet.

| File                 | Open with                                                          |
| -------------------- | ------------------------------------------------------------------ |
| `marimo_demo.py`     | `marimo edit examples/marimo_demo.py`                              |
| `jupyter_demo.ipynb` | VS Code, or `jupyter lab examples/jupyter_demo.ipynb`              |
| `scene_demo.py`      | VS Code: **Open in Magpylib Studio** (title bar), or run its cells |

Both need the widget extra, and magpylib's main branch — the display-backend API
they draw through is in no release yet:

```sh
uv pip install -e ".[widget]" marimo wigglystuff
uv pip install "magpylib @ git+https://github.com/magpylib/magpylib@main"
```

In marimo the sliders re-run the cells that read them. Jupyter re-runs nothing
by itself, so the notebook wires its `ipywidgets` sliders to `update()` with
observers. Either way the view is made once and re-pointed, which is what keeps
the camera where you left it.
