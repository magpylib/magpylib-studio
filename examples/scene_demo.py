# %% [markdown]
# # A Halbach ring, written as a scene
#
# Two stacked rings of magnets whose polarization turns twice for every turn
# round the ring, which is what makes the field in the bore nearly uniform,
# and a grid of arrows across the bore that shows it. Written as a plain
# magpylib function marked `@scene`: its parameters are the variables, so
# the scene is one parametric document wherever it opens.
#
# Three ways to see it:
#
# - **Open in Magpylib Studio** -- the button in the editor's title bar, or
#   right-click the file. The studio runs this file and opens the scene it
#   built, whole: every parameter is a slider in its Variables panel.
# - **As a notebook** -- run its cells. The last one is the 3D view of this
#   scene, with a slider per variable.
# - **`python examples/scene_demo.py`** -- what it built, in words.
#
# Save the scene beside this file from the studio (Save Scene As…,
# `scene_demo.magpy.json`), and the next run starts where you left the
# sliders: the defaults below are defaults, and the saved values win.

# %%
import pathlib
from typing import Annotated

import magpylib as magpy

from magpylib_studio import (
    Count,
    Length,
    derived,
    duplicate_around,
    name,
    sampled,
    scene,
)

here = pathlib.Path(globals().get("__file__", "scene_demo.py")).resolve().parent


# %% [markdown]
# Each ring is one magnet and one step that patterns it round the axis, not
# `n` magnets written out: change `n` and both rings follow. Each copy is
# carried round the ring *and* spun by as much again, so its polarization
# turns twice per revolution -- a Halbach dipole. A loop over fixed things
# (the two rings) is plain Python. The field in the bore, as arrows, is a
# `density` × `density` grid across the middle half of the ring: a formula
# of `t`, the sample, so it follows `radius` and `density` -- which
# `np.linspace` over a variable could not, since it needs the count now.


# %%
@scene
def halbach(
    n: Annotated[int, Count(4, 48, slider=(6, 24))] = 12,
    radius: Annotated[float, Length(0.01, 0.1, slider=(0.018, 0.04))] = 0.025,
    gap: Annotated[float, Length(0.006, 0.05, slider=(0.009, 0.03))] = 0.012,
    density: Annotated[int, Count(2, 25, slider=(3, 15))] = 7,
):
    stagger = derived("stagger", 180 / n, unit="angle")  # half a step, whatever n is
    stack = name(magpy.Collection(style_label="Halbach stack"), "stack")
    rings = {}
    for number, z in ((1, -gap / 2), (2, gap / 2)):
        rings[number] = name(
            magpy.Collection(style_label=f"Ring {number}"), f"ring{number}"
        )
        stack.add(rings[number])
        magnet = name(
            magpy.magnet.Cuboid(
                dimension=(0.008, 0.008, 0.008),
                polarization=(1, 0, 0),
                position=(radius, 0, z),
                style_label=f"Magnet {number}",
            ),
            f"magnet{number}",
        )
        rings[number].add(magnet)
        duplicate_around(magnet, count=n, axis="z", spin=360 / n)
    # Interleaved: the upper ring sits half a step round from the lower one.
    rings[2].rotate_from_angax(stagger, "z", anchor=0)

    reach = radius / 2  # plain Python holding an expression, not a variable
    bore = name(
        magpy.Sensor(
            pixel=sampled(
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
                "pixel": {
                    "field": {"source": "B", "symbol": "arrow3d", "colormap": "Viridis"}
                },
            },
        ),
        "bore",
    )
    return stack, bore


# %% [markdown]
# Called plainly, the function is magpylib: real objects at the values you
# pass, and a real field. Built, it is the document: what it keeps are the
# variables as written, and each magnet at `"=radius"` rather than at the
# number it is today.

# %%
stack, bore = halbach(n=16)
print("called plainly:", len(stack.sources_all), "magnets")

s = halbach.build(values=here / "scene_demo.magpy.json")
doc = s.to_dict()
print("variables:", doc["variables"])
for event in doc["events"]:
    if event["op"] == "create" and event["target"] == "magnet1":
        print("magnet1 is at", event["params"]["position"])

# %% [markdown]
# And two ways out. `to_script()` is plain magpylib, for anyone without the
# studio; `to_builder_script()` writes this scene as a function again, which
# run builds the same document.

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
    from IPython.display import display

    from magpylib_studio.widget import SceneWidget

    # Editable from the start: the handles, and at the foot of the edit
    # column the sliders toggle, which opens a slider per variable in the view.
    view = SceneWidget(s, editable=True, height=480)
    display(view)
else:
    print(
        "\nTo see it and drag its variables: Open in Magpylib Studio (the "
        "editor's title bar, or right-click this file), or run its cells as "
        "a notebook."
    )
