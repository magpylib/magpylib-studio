# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "magpylib-studio[widget]>=0.16.0",
#     "marimo",
#     "plotly",
# ]
# ///
"""Magnet balls, let go: `marimo edit docs/notebooks/magnet_balls.py`.

The toy's magnet balls dropped at random on a table and left to themselves,
worked out here as the sliders move: the forces and torques between the
balls, exact for spheres, their weight, and friction where they touch. The
run plays in the view; the plot beside it follows its step.

Needs the widget extra and marimo:

    pip install "magpylib-studio[widget]" marimo
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full", app_title="Magnet balls, let go")


@app.cell
def _():
    import inspect

    import magpylib as magpy
    import marimo as mo
    import numpy as np
    import plotly.graph_objects as go

    from magpylib_studio.examples import magnet_balls as mb
    from magpylib_studio.widget import SceneWidget

    return SceneWidget, go, inspect, magpy, mb, mo, np


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Magnet balls, let go

    Magnet balls are plain magnets: spheres of neodymium iron boron,
    magnetized along a diameter, 5 mm across. Put two together any way you
    like and they snap; they never seem to push each other away, where a
    stack of block magnets pushes wherever two sit north beside north.

    Here a handful of balls is dropped at random on a table, each pointing
    its own way along it, and left to itself. The run is worked out as the
    sliders move, a few seconds: the forces and torques between the balls,
    exact for spheres; their weight on the table; friction where a ball
    slides, and a little where it rolls. Press play at the foot of the
    view.
    """)
    return


@app.cell
def _(inspect, mb, mo):
    mo.accordion(
        {
            "How a run is worked out": mo.md(
                f"```python\n{inspect.getsource(mb.pull)}\n\n"
                f"{inspect.getsource(mb.let_go)}```"
            )
        }
    )
    return


@app.cell(hide_code=True)
def _(mo):
    count = mo.ui.slider(2, 12, value=8, label="balls", debounce=True)
    seed = mo.ui.number(0, 99, value=0, label="where they fall (seed)")
    friction = mo.ui.slider(
        0.05, 0.8, step=0.05, value=0.3, label="friction", debounce=True
    )
    mo.hstack([count, seed, friction], justify="start", gap=2)
    return count, friction, seed


@app.cell
def _(SceneWidget, mo):
    # The view, made once: each run is shown in it by `update`, rather than
    # in a new widget, which a slider would make on every move -- a new
    # element each time, the old one closed under it while the run is
    # worked out, and the camera back where it started.
    view3d = SceneWidget(
        height=460,
        editable="never",
        theme="dark" if mo.app_meta().theme == "dark" else "light",
    )
    step, set_step = mo.state(0)
    view3d.observe(lambda change: set_step(change.new), names="step")
    shown = mo.as_html(mo.ui.anywidget(view3d))
    return shown, step, view3d


@app.cell
def _(count, friction, magpy, mb, seed, view3d):
    # no spinner: it would be this cell's output while it runs, and push the
    # view down; marimo marks the view stale meanwhile
    run = mb.let_go(
        *mb.scattered(count=count.value, seed=seed.value),
        duration=0.3,
        friction=friction.value,
    )
    _balls = magpy.Collection(style_label="balls")
    mb.spheres(run, into=_balls)
    # the balls' paths played as a run, in five seconds, from its start
    view3d.update(_balls, mb.table(run), animation=5)
    return (run,)


@app.cell(hide_code=True)
def _(go, mb, mo, np, run, shown, step):
    _ms = run.times * 1e3
    _at = _ms[min(step(), len(_ms) - 1)]
    _lost = run.magnetic[0] + run.kinetic[0] - run.magnetic - run.kinetic
    _figure = go.Figure()
    for _name, _values in (
        ("magnetic", run.magnetic),
        ("moving", run.kinetic),
        ("lost to friction", _lost),
    ):
        _figure.add_scatter(x=_ms, y=_values * 1e3, name=_name, mode="lines")
    _figure.add_vline(x=_at, line_dash="dot")
    _figure.update_layout(
        template="plotly_dark" if mo.app_meta().theme == "dark" else "plotly_white",
        height=460,
        margin={"l": 60, "r": 10, "t": 60, "b": 40},
        hovermode="x unified",
        legend={"orientation": "h", "y": -0.2},
        title="Where the energy goes<br><sup>the view plays it "
        f"{5 / run.times[-1]:.0f} times slower</sup>",
        xaxis_title="time (ms)",
        yaxis_title="energy (mJ)",
    )
    _plot = mo.ui.plotly(_figure, config={"displayModeBar": False})

    # what they made: groups of balls that touch, and how many each touches
    _x = run.positions[-1]
    _near = np.linalg.norm(_x[:, None] - _x[None], axis=-1) < mb.DIAMETER * 1.01
    _touches = _near.sum(1) - 1
    _groups, _seen = [], set()
    for _i in range(len(_x)):
        if _i in _seen:
            continue
        _group, _todo = set(), [_i]
        while _todo:
            _k = _todo.pop()
            if _k not in _group:
                _group.add(_k)
                _todo.extend(np.nonzero(_near[_k])[0].tolist())
        _seen |= _group
        _groups.append(sorted(_group))

    def _shape(group):
        if len(group) == 1:
            return "a ball alone"
        if all(_touches[k] <= 2 for k in group):
            ends = sum(_touches[k] == 1 for k in group)
            return (
                f"a chain of {len(group)}" if ends == 2 else f"a ring of {len(group)}"
            )
        return f"a clump of {len(group)}"

    made = ", ".join(_shape(g) for g in sorted(_groups, key=len, reverse=True))
    mo.vstack(
        [
            mo.Html(
                '<div style="display: grid; gap: 1rem; align-items: start; '
                'grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)">'
                f"{shown.text}<div>{_plot.text}</div></div>"
            ),
            mo.md(f"They made **{made}**."),
        ]
    )
    return


@app.cell(hide_code=True)
def _(friction, mb, mo, np):
    # where the push between two balls north to north is as strong as the
    # table's grip on one: closer, it slides it; farther, it only turns it
    _moment = mb.POLARIZATION * np.pi / 6 * mb.DIAMETER**3 / mb.MU0
    _mass = mb.DENSITY * np.pi / 6 * mb.DIAMETER**3
    _grip = friction.value * _mass * 9.81
    _reach = (6 * mb.MU0 / (4 * np.pi) * _moment**2 / _grip) ** 0.25 * 1e3
    mo.md(f"""
    ## Why none is pushed away

    Two balls close together, north facing north, do push apart: let go a
    millimetre apart, they fly off before either has turned round. That
    never happens here, because the balls meet from afar. The push between
    two balls falls with the fourth power of how far apart they are, the
    torque that turns one only with the third. Far off, the push is weaker
    than the table's grip on a ball, **{_grip * 1e3:.1f} mN** at this friction,
    and moves nothing -- that is the case beyond **{_reach:.0f} mm** --
    while the torque meets almost nothing: a ball spins where it lies, or
    rolls over. So each ball has turned toward its neighbours long before
    it can be pushed, and every pair that meets meets south to north, and
    snaps.

    Head to tail is the strongest way two balls hold, so they make chains.
    A chain is not the lowest energy there is -- a long one folds into a
    ring, which holds tighter -- but folding takes a push the table's
    friction does not give. Try other seeds: groups that meet side on make
    a clump, and now and then a ball snapping on knocks another loose,
    which rolls off: knocked, not pushed.

    Turn the friction down and the reach grows: the push beats the grip
    from farther off, before a ball has turned, and the balls slide into
    each other harder -- at 0.05 some seeds end in pieces. Turn it up and
    they still all meet, but roll rather than slide, which costs little,
    so they take longer to come to rest.
    """)
    return


if __name__ == "__main__":
    app.run()
