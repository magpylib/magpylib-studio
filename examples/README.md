# examples

The 3D view in a notebook — the studio's three.js renderer as an `anywidget`.
Each marimo notebook in `marimo/` is one design written as a `@scene` function,
with the view, the field and the files following every edit. The Halbach ring
and the coil pair are the gallery's own, imported from
`magpylib_studio.examples` and shown there, so they are written once. The
Jupyter one rebuilds two rings of magnets from `ipywidgets` sliders.

| File                          | What it shows                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `marimo/halbach_ring.py`      | A Halbach ring to tune: field map, axis, sweep, a search for the flattest bore    |
| `marimo/coil_pair.py`         | A coil pair to flip: Helmholtz and anti-Helmholtz variants                        |
| `marimo/unit_versions.py`     | Two versions of a unit that differ in structure, picked by `choose`               |
| `marimo/ucore_solved.py`      | A U-core electromagnet solved by face charge again at every step of a drag        |
| `marimo/run_with_variants.py` | A run beside variants, solved, with field lines, every combination exportable     |
| `marimo/every_kind.py`        | Every kind of magpylib object in one view, and the view's keys                    |
| `jupyter_demo.ipynb`          | Two rings of magnets rebuilt from `ipywidgets` sliders                            |
| `scene_demo.py`               | A scene script: **Open in Magpylib Studio** (VS Code title bar), or run its cells |

Open a marimo one with `marimo edit examples/marimo/<file>`, the Jupyter one in
VS Code or with `jupyter lab examples/jupyter_demo.ipynb`. The notebooks need
the widget extra; the two solved ones need magpylib-material-response 0.9.2 too,
and say so without it:

```sh
uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.9.2"
```

In marimo the sliders re-run the cells that read them. Jupyter re-runs nothing
by itself, so the notebook wires its `ipywidgets` sliders to `update()` with
observers. Either way the view is made once and re-pointed, which is what keeps
the camera where you left it.
