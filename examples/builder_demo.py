# %% [markdown]
# # A Halbach ring, written in code
#
# Two stacked rings of magnets whose polarization turns twice for every turn
# round the ring, which is what makes the field in the bore nearly uniform,
# and a grid of arrows across the bore that shows it. Written with
# `magpylib_studio.build`: magpylib's spelling, with variables that stay
# variables, so the scene is one parametric document wherever it opens.
#
# Three ways to see it:
#
# - **Open in Magpylib Studio** -- the button in the editor's title bar, or
#   right-click the file. The studio runs this file and opens the scene it
#   built, whole: every variable is a slider in its Variables panel.
# - **As a notebook** -- run its cells. The last one is the 3D view of this
#   scene, with a slider per variable.
# - **`python examples/builder_demo.py`** -- what it built, in words.
#
# Save the scene beside this file from the studio (Save Scene As…,
# `builder_demo.magpy.json`), and the next run starts where you left the
# sliders: the numbers below are defaults, and the saved ones win.

# %%
import pathlib

from magpylib_studio.build import Scene

here = pathlib.Path(globals().get("__file__", "builder_demo.py")).resolve().parent
s = Scene(values=here / "builder_demo.magpy.json")

n = s.variable("n", 12, bounds=(4, 48), slider=(6, 24), integer=True)
radius = s.variable("radius", 0.025, bounds=(0.01, 0.1), slider=(0.018, 0.04))
gap = s.variable("gap", 0.012, bounds=(0.006, 0.05), slider=(0.009, 0.03))
stagger = s.variable("stagger", 180 / n)  # half a magnet step, whatever n is
density = s.variable("density", 7, bounds=(2, 25), slider=(3, 15), integer=True)

# %% [markdown]
# Each ring is one magnet and one step that patterns it round the axis, not
# `n` magnets written out: change `n` and both rings follow. Each copy is
# carried round the ring *and* spun by as much again, so its polarization
# turns twice per revolution -- a Halbach dipole. A loop over fixed things
# (the two rings) is plain Python.

# %%
stack = s.Collection(id="stack", style_label="Halbach stack")
rings = {}
for number, z in ((1, -gap / 2), (2, gap / 2)):
    rings[number] = s.Collection(id=f"ring{number}", style_label=f"Ring {number}")
    stack.add(rings[number])  # the outermost first: see docs/builder.md §3
    magnet = s.magnet.Cuboid(
        id=f"magnet{number}",
        style_label=f"Magnet {number}",
        dimension=(0.008, 0.008, 0.008),
        polarization=(1, 0, 0),
        position=(radius, 0, z),
    )
    rings[number].add(magnet)
    magnet.duplicate_around(count=n, axis="z", spin=360 / n)

# Interleaved: the upper ring sits half a step round from the lower one.
rings[2].rotate_from_angax(stagger, "z", anchor=0)

# %% [markdown]
# The field in the bore, as arrows: a `density` × `density` grid across the
# middle half of the ring. It is a formula of `t`, the sample, so it follows
# `radius` and `density` -- which `np.linspace` over a variable could not,
# since it needs the count now.

# %%
reach = radius / 2  # plain Python holding an expression, not a variable
s.Sensor(
    id="bore",
    pixel=s.sampled(
        lambda t: (
            -reach + 2 * reach * (t % density) / (density - 1),
            -reach + 2 * reach * (t // density) / (density - 1),
            0,
        ),
        count=density**2,
        over=(0, density**2 - 1),
    ),
    style={
        "label": "Field in the bore",
        "size": 0.004,
        "pixel.field.source": "B",
        "pixel.field.symbol": "arrow3d",
        "pixel.field.colormap": "Viridis",
    },
)

# %% [markdown]
# What the document keeps: the variables as written, and each magnet at
# `"=radius"` rather than at the number it is today.

# %%
doc = s.to_dict()
print("variables:", doc["variables"])
for event in doc["events"]:
    if event["op"] == "create" and event["target"] == "magnet1":
        print("magnet1 is at", event["params"]["position"])

# %% [markdown]
# And two ways out. `to_script()` is plain magpylib, for anyone without the
# studio; `to_builder_script()` writes this scene as builder code again,
# which run builds the same document.

# %%
plain = s.to_script().splitlines()
print("\n".join([*plain[:14], "…"]))

# %% [markdown]
# In a notebook: a view of this very scene -- not a copy -- with a control
# per variable. Drag a magnet, or move a slider; undo in the view takes either
# back, and the sliders follow. Outside one, the way in is the studio.

# %%
try:
    from IPython import get_ipython

    kernel = getattr(get_ipython(), "kernel", None)
except ImportError:
    kernel = None

if kernel is not None:
    import ipywidgets as widgets
    from IPython.display import display

    from magpylib_studio.widget import SceneWidget

    view = SceneWidget(s, editable=True, height=480)
    display(widgets.VBox([view.variable_sliders(), view]))
else:
    print(
        "\nTo see it and drag its variables: Open in Magpylib Studio (the "
        "editor's title bar, or right-click this file), or run its cells as "
        "a notebook."
    )
