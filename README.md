# Magpylib Studio

Build and explore [magpylib](https://github.com/magpylib/magpylib) magnet
designs visually — in VS Code, in a notebook, or in code. Name the numbers that
matter, drag a slider, and the whole design follows, with the field computed
exactly in milliseconds.

![The Halbach example in VS Code: the scene tree, the variables with their sliders, the 3D view and the script tab.](https://raw.githubusercontent.com/magpylib/magpylib-studio/main/docs/halbach.png)

_The Halbach example: two rings of ten magnets, each ring one magnet and one
pattern. Drag `n` and both rings rebuild._

## What you can do

- **Build a scene by hand.** Add magnets, currents and sensors, group them, and
  move, turn and resize them in the 3D view.
- **Make it parametric.** Name the numbers that matter — `radius`, `gap`, `n` —
  and write positions and sizes in terms of them. Drag a slider and everything
  follows. Values are SI unless you type a unit: `15 mm`, `2 cm`, `800 mT`.
- **Pattern, don't copy.** A ring of twenty magnets is one magnet and one
  "repeat around an axis" step, so changing the magnet changes them all.
- **See the field.** Along a sensor path, as a map over a plane, or swept
  against a variable.
- **Undo anything.** Every scene keeps the steps that built it; step back
  through them, or change an early one.
- **Switch to code and back.** The script tab shows the scene as Python and
  applies your edits when you save. Export plain magpylib for anyone, or the
  scene as code to keep.
- **Let an AI assistant help.** Copilot Chat can build and edit the scene with
  you.

## Get started in VS Code

1. Install the extension: search for **Magpylib Studio** in the Extensions view,
   or run `code --install-extension magpylib.magpylib-studio-vscode`.
2. Open a folder, click the magpylib icon in the Activity Bar, and choose **Load
   Example Scene**.
3. The first time, it offers to **Install the Engine** (the Python side) for
   you. Nothing to set up beforehand.

More in the
[extension's guide](https://github.com/magpylib/magpylib-studio/blob/main/vscode-extension/README.md).

## Use it in a notebook

The same 3D view, in Jupyter, marimo, VS Code notebooks or Colab:

```sh
pip install "magpylib-studio[widget]"
pip install "magpylib @ git+https://github.com/magpylib/magpylib@main"  # until magpylib's next release
```

```python
import magpylib as magpy
from magpylib_studio.widget import SceneWidget

cube = magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(0.01, 0.01, 0.01))
SceneWidget(cube)  # look around it
SceneWidget(cube, editable=True)  # or move, turn and resize it, with undo
```

More in the
[notebook guide](https://github.com/magpylib/magpylib-studio/blob/main/docs/notebook.md).

## Write a scene in code

It reads like magpylib, but the variables stay variables:

```python
from magpylib_studio.build import Scene

s = Scene()
n = s.variable("n", 10, bounds=(2, 60), slider=(4, 20), integer=True)
radius = s.variable("radius", 0.023, bounds=(0.005, 0.08), unit="length")

ring = s.Collection(id="ring")
magnet = s.magnet.Cuboid(
    dimension=(0.01, 0.01, 0.01), polarization=(1, 0, 0), position=(radius, 0, 0)
)
ring.add(magnet)
magnet.duplicate_around(count=n, axis="z", spin=360 / n)

s.save("ring.magpy.json")  # open it in the studio: n and radius are sliders there
```

More in
[docs/builder.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/builder.md),
and a complete example in
[examples/builder_demo.py](https://github.com/magpylib/magpylib-studio/blob/main/examples/builder_demo.py).

## Install the Python package only

```sh
pip install magpylib-studio
```

Python 3.11 or newer, and magpylib 5.2 or newer.

## Learn more

| If you want to…                | Read                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| use the VS Code extension      | [the extension's guide](https://github.com/magpylib/magpylib-studio/blob/main/vscode-extension/README.md) |
| use the 3D view in a notebook  | [docs/notebook.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/notebook.md)                |
| write scenes in code           | [docs/builder.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/builder.md)                  |
| know how it works inside       | [docs/architecture.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/architecture.md)        |
| contribute                     | [CONTRIBUTING.md](https://github.com/magpylib/magpylib-studio/blob/main/CONTRIBUTING.md)                  |
| see where the project is going | [docs/roadmap.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/roadmap.md)                  |

## License

BSD-3-Clause, like the other packages built on magpylib. See
[LICENSE](https://github.com/magpylib/magpylib-studio/blob/main/LICENSE).
