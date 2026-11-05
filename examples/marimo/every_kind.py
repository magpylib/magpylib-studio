# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "magpylib-studio[widget]>=0.15.0",
#     "marimo",
# ]
# ///
"""Every kind of magpylib object in one view, and the view's keys and tools:
`marimo edit examples/marimo/every_kind.py`.

Needs the widget extra and marimo:

    uv pip install -e ".[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="Every kind")


@app.cell
def _():
    import inspect

    import marimo as mo

    from magpylib_studio.widget import SceneWidget

    return SceneWidget, inspect, mo


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Every kind of object, and the view's keys

    Click a view to give it the keys: **F** frames the selection, **Home**
    everything, **1** **3** **7** look from the front, the right and the
    top, **H** hides, **space** plays a run. The tools in its top-right
    corner export a PNG, or one HTML file that works without this notebook.
    """)
    return


@app.cell(hide_code=True)
def _(SceneWidget, inspect, mo):
    # The scene, from the package that the gallery and the docs read too.
    from magpylib_studio.examples.every_kind import every_kind

    mo.vstack(
        [
            mo.md(
                "Every kind of object, round a Möbius band whose current runs "
                "over both its faces. Each takes the handles: **R** on a "
                "magnet's faces resizes it, ⌥ moving the opposite one too; a "
                "sphere and a loop resize by the rim; a shape made of points "
                "has a dot on each, ⌘/ctrl-click to take several. Hold ⇧ to "
                "land on another object's corner; Esc takes a drag back."
            ),
            SceneWidget(every_kind, editable=True, height=540),
            mo.accordion(
                {
                    "How it is written": mo.md(
                        f"```python\n{inspect.getsource(every_kind)}```"
                    )
                }
            ),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
