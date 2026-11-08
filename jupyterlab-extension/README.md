# The JupyterLab scene tab

A `.magpy.json` opens in JupyterLab as the package's editable widget, in a tab
of its own. Why and how:
[decision 0058](../docs/decisions.md#0058-a-scene-file-opens-in-jupyterlab-as-a-tab);
for users, the notebook guide's "A scene file in JupyterLab".

`src/index.ts` is the extension. `labextension/` is its build, committed: the
wheel installs it under `share/jupyter/labextensions/` (see `pyproject.toml`),
so installing magpylib-studio needs no node.

## After changing it

```bash
npm install
PATH=<venv with jupyterlab>/bin:$PATH npm run build  # tsc, the lab build, the stamp
JLAB_PYTHON=<venv>/bin/python npm run check            # a private JupyterLab, end to end
```

The build writes `labextension/sources.sha256`; `tests/test_labextension.py`
fails when the sources no longer match it. `npm run check` needs a python with
`jupyterlab` and `magpylib-studio[widget]`, and Chrome (or `CHROME`). It touches
nothing installed: the lab runs in a folder of its own with this build as its
only extra extension.
