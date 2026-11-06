# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "magpylib-studio[widget]>=0.15.0",
#     "marimo",
# ]
# ///
"""Two versions of a unit that differ in structure:
`marimo edit examples/marimo/unit_versions.py`.

`choose(version)` picks what the scene is made of; one document holds both
versions, and the variants mix the choice with the other variables.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="Unit versions")


@app.cell
def _():
    import inspect

    import marimo as mo

    from magpylib_studio.widget import SceneWidget

    return SceneWidget, inspect, mo


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Versions that differ in structure

    A choice can pick what a scene is made of, not only a value:
    `versions = choose(version)`, then `versions.add("v2", ...)`. One
    document holds both versions, a narrow core with two inlay pieces and
    a wide one with three and a notch, and the one **version** names is in
    the scene: drawn, listed, in the field. A piece moved in one version is
    still where you left it when you come back to it.

    The other variables mix in as before. **spacing** spreads v1's two
    pieces, and only v1 reads it: with v2 shown its slider is dimmed.
    **current** is the coil's, both versions'. A variant sets what it
    names: **v2 reversed** sets the version and the current at once, and
    **v1** then sets only the version, so the current stays reversed.
    """)
    return


@app.cell
def _(inspect, mo):
    # The scene, from the package that the gallery and the docs read too:
    # its source a click away, so the page still says how it is written.
    from magpylib_studio.examples.unit_versions import unit_versions as mtu

    mo.accordion(
        {"How it is written": mo.md(f"```python\n{inspect.getsource(mtu)}```")}
    )
    return (mtu,)


@app.cell
def _(SceneWidget, mo, mtu):
    mtu_view3d = SceneWidget(
        mtu.build(), editable=True, height=480, field_lines=True, open_panel="variables"
    )
    mo.ui.anywidget(mtu_view3d)
    return


if __name__ == "__main__":
    app.run()
