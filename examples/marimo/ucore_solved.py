# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "magpylib-studio[widget]>=0.15.0",
#     "magpylib-material-response>=0.10.0",
#     "marimo",
# ]
# ///
"""A U-core solved by face charge while you drag:
`marimo edit examples/marimo/ucore_solved.py`.

Needs the widget extra, marimo and magpylib-material-response 0.9.2, and
says so without it:

    uv pip install -e ".[widget]" marimo "magpylib-material-response>=0.9.2"
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="A U-core, solved")


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
    # A U-core, solved while you drag

    Three soft-iron cuboids (χ = 999) wound with a coil of 400
    ampere-turns, solved by face charge: sheets of charge on the core's
    surfaces, no volume mesh. Each sheet keeps the part it was solved from,
    so the view solves the core again at every step of a drag, with nothing
    written here to ask for it. Drag the **coil**, or slide **current**: the
    solve keeps its factorization, so a new load costs milliseconds. Drag a
    **leg** off the yoke and each step factors the matrix again. One undo
    takes back the move and its solve together.
    """)
    return


@app.cell
def _(inspect, mo):
    # The scene, from the package that the gallery and the docs read too,
    # solved as its module is imported. magpylib-material-response is not one
    # of studio's dependencies: without it this part of the page says so.
    try:
        from magpylib_studio.examples import ucore_electromagnet as solved_example
    except ImportError:
        solved_example = None
    mo.stop(
        solved_example is None,
        mo.md(
            "_Needs magpylib-material-response 0.10: "
            '`uv pip install "magpylib-material-response>=0.10.0"`._'
        ),
    )
    ucore_scene = solved_example.ucore_electromagnet
    ucore_scene_solved = solved_example.SOLVED
    mo.accordion(
        {
            "How it is written": mo.md(
                f"```python\n{inspect.getsource(solved_example)}```"
            )
        }
    )
    return ucore_scene, ucore_scene_solved


@app.cell
def _(SceneWidget, mo, ucore_scene):
    ucore_view3d = SceneWidget(
        ucore_scene.build(),
        editable=True,
        field_lines=True,
        open_panel="variables",
        height=620,
    )
    ucore_last = {"solves": []}
    ucore_edited, _set_edited = mo.state(0)

    def _told(change):
        """An edit let go: what it solved, for the line under the view."""
        ucore_last["solves"] = ucore_view3d.last_edit.get(
            "solves", ucore_last["solves"]
        )
        _set_edited(change.new)

    ucore_view3d.observe(_told, names="revision")
    ucore_view = mo.as_html(mo.ui.anywidget(ucore_view3d))
    return ucore_edited, ucore_last, ucore_view


@app.cell
def _(mo, ucore_edited, ucore_last, ucore_scene_solved, ucore_view):
    ucore_edited()  # the numbers follow each edit, when it is let go
    _solves = ucore_last["solves"]
    _info = _solves[-1] if _solves else ucore_scene_solved.face_charge_info
    _said = (
        f"Solved by `{ucore_scene_solved.solved_by}` at level {_info['level']}, "
        f"{_info['unknowns']:,} unknowns, "
        f"in {_info['seconds'] * 1000:.0f} ms"
        f"{', on the factorization it kept' if _info['reused'] else ''}."
    )
    if _solves:
        _mean = sum(each["seconds"] for each in _solves) / len(_solves)
        _said += (
            f" The last edit solved {len(_solves)} times, "
            f"at {_mean * 1000:.0f} ms each."
        )
    mo.vstack([ucore_view, mo.md(_said)])
    return


if __name__ == "__main__":
    app.run()
