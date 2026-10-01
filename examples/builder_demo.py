# %% [markdown]
# # A scene written in code
#
# The studio's halbach example, written with `magpylib_studio.build`:
# magpylib's spelling, with variables that stay variables. Run the file as a
# script to see the document it builds, the magpylib it exports, and where it
# saved the scene. Run its cells in VS Code's interactive window, or a
# notebook, to drag it and to drive its variables from sliders.

# %%
import pathlib
import tempfile

import ipywidgets as widgets
import numpy as np
from IPython.display import display

from magpylib_studio.build import Scene
from magpylib_studio.widget import SceneWidget

s = Scene()
n = s.variable("n", 10, bounds=(2, 60), slider=(4, 20), integer=True)
radius = s.variable("radius", 0.023, bounds=(0.005, 0.08), slider=(0.016, 0.04))
gap = s.variable("gap", 0.015, bounds=(0, 0.06), slider=(0.01, 0.03))
stagger = s.variable("stagger", 360 / (2 * n))  # half a magnet step, always
tilt = s.variable("tilt", 0.0, bounds=(-180, 180), slider=(-90, 90))
tilt_axis = s.variable("tilt_axis", "z", options=("x", "y", "z"))

halbach = s.Collection(id="halbach", style_label="Halbach stack")
rings, magnets = {}, {}
for number, z in ((1, 0.0), (2, gap)):  # a loop over fixed things is plain Python
    rings[number] = s.Collection(id=f"ring{number}", style_label=f"Ring {number}")
    halbach.add(rings[number])
    magnets[number] = s.magnet.Cuboid(
        id=f"r{number}",
        style_label=f"Magnet {number}",
        dimension=(0.01, 0.01, 0.01),
        polarization=(1, 0, 0),
        position=(radius, 0, z),
    )
    rings[number].add(magnets[number])
s.Sensor(
    id="sensor",
    style_label="Sensor",
    style_size=0.005,
    position=np.linspace((0, 0, -0.015), (0, 0, 0.03), 25),
)
for magnet in magnets.values():
    magnet.duplicate_around(count=n, axis="z", spin=360 / n)  # a pattern, not copies
rings[2].rotate_from_angax(stagger, "z", anchor=0)
halbach.rotate_from_angax(tilt, tilt_axis, anchor=0)

# %% [markdown]
# The document keeps what the code said: `"=radius"` where running a script
# would have kept 0.023, and each ring as the one step that patterns it.

# %%
doc = s.to_dict()
print("variables:", doc["variables"])
for event in doc["events"]:
    if event["target"] == "r1":
        print(event["op"], {k: v for k, v in event.items() if k not in ("id", "op")})

# %% [markdown]
# So the scene follows its variables. Here from Python; the sliders below and
# the studio's Variables panel do the same.

# %%
session = s.session
written = session.get_transform("r1")["written_position"]
print("r1 is written at", written, "and is at", session.get_transform("r1")["position"])
session.set_variable("radius", 0.03)
print("with radius 0.03 it is at", session.get_transform("r1")["position"])
session.undo()

# %% [markdown]
# Plain magpylib, for anyone without the studio: the export.

# %%
print(s.to_script())

# %% [markdown]
# Saved as the studio saves a scene. In VS Code, open it with **Magpylib
# Studio: Open Scene…** and drag `radius`, `n` or `tilt` in the Variables panel.

# %%
saved = s.save(pathlib.Path(tempfile.gettempdir()) / "halbach-built.magpy.json")
print("saved to", saved)

# %% [markdown]
# In a notebook: a view of this very scene -- not a copy -- with sliders on
# its variables. Drag a magnet, or move a slider; undo in the view (Cmd/Ctrl+Z)
# takes either back, and the sliders follow.

# %%
view = SceneWidget(s, editable=True, height=460)
sliders = {
    "n": widgets.IntSlider(10, min=4, max=20, description="n"),
    "radius": widgets.FloatSlider(
        0.023,
        min=0.016,
        max=0.04,
        step=0.001,
        readout_format=".3f",
        description="radius",
    ),
    "gap": widgets.FloatSlider(
        0.015, min=0.01, max=0.03, step=0.001, readout_format=".3f", description="gap"
    ),
    "tilt": widgets.FloatSlider(0.0, min=-90, max=90, step=5, description="tilt °"),
}


def values():
    return {v["name"]: v["value"] for v in session.get_variables()["variables"]}


def from_slider(name):
    def moved(change):
        if values()[name] != change["new"]:  # a slider's echo of the view is no edit
            view.set_variable(name, change["new"])

    return moved


def from_view(change):
    now = values()
    for name, slider in sliders.items():
        slider.value = now[name]


for name, slider in sliders.items():
    slider.observe(from_slider(name), "value")
view.observe(from_view, "revision")
display(widgets.VBox([*sliders.values(), view]))
