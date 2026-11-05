# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "magpylib-studio[widget]>=0.15.0",
#     "magpylib-material-response>=0.10.0",
#     "marimo",
# ]
# ///
"""A run beside variants, solved and drawn with field lines, every combination
exportable: `marimo edit examples/marimo/run_with_variants.py`.

Needs the widget extra, marimo and magpylib-material-response 0.9.2, and says
so without it:

    uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.9.2"
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="A run beside variants")


@app.cell
def _():
    import inspect
    import json

    import marimo as mo

    from magpylib_studio.widget import SceneWidget

    return SceneWidget, inspect, json, mo


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # A run beside variants, solved, with field lines

    A magnet slides across a soft-iron plate in thirteen steps: the scene's
    path is the run, played by the transport at the foot of the view. The
    plate is solved by face charge, sheets of charge on its surfaces, and
    keeps the part it was solved from, so the view solves it again when the
    magnet's height or strength changes. The **low**, **high** and
    **reversed** variants are a click each, beside the transport.

    Every step of every variant has its own solve and its own field lines:
    material-response solves one configuration, so the view hands it each
    step. The view's download button, in its top-right corner, writes a page
    that carries them all and plays any variant's run with no notebook
    behind it: fifty-one frames, each solved and drawn, a few seconds, which
    the foot of the view counts and its Cancel stops. Dragging, or a variable the
    variants do not name, needs the notebook: a new solve, a new field.
    """)
    return


@app.cell
def _(inspect, mo):
    # The scene, from the package that the gallery and the docs read too,
    # solved as its module is imported. magpylib-material-response is not one
    # of studio's dependencies: without it this part of the page says so.
    try:
        from magpylib_studio.examples import solved_plate_run as solved_example
    except ImportError:
        solved_example = None
    mo.stop(
        solved_example is None,
        mo.md(
            "_Needs magpylib-material-response 0.10: "
            '`uv pip install "magpylib-material-response>=0.10.0"`._'
        ),
    )
    slide = solved_example.solved_plate_run
    slide_solved = solved_example.SOLVED
    mo.accordion(
        {
            "How it is written": mo.md(
                f"```python\n{inspect.getsource(solved_example)}```"
            )
        }
    )
    return slide, slide_solved


@app.cell
def _(SceneWidget, json, mo, slide):
    built = slide.build()
    view3d = SceneWidget(
        built, editable=True, height=560, field_lines=True, open_panel="variables"
    )
    # Written when clicked, so it holds the scene as it is then. The page is
    # the view's own download button: written a piece at a time, so it can be
    # stopped, where a `mo.download` keeps the kernel busy until it is done.
    mo.vstack(
        [
            mo.ui.anywidget(view3d),
            mo.download(
                data=lambda: json.dumps(built.to_dict(), indent=2),
                filename="slide.magpy.json",
                mimetype="application/json",
                label="slide.magpy.json",
            ),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
