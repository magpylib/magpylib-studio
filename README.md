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
  follows. Values are SI unless you type a unit — `15 mm`, `2 cm`, `800 mT` — or
  show the whole scene in mm and mT.
- **Pattern, don't copy.** A ring of twenty magnets is one magnet and one
  "repeat around an axis" step, so changing the magnet changes them all.
- **See the field.** Along a sensor path, as a map over a plane, or swept
  against a variable.
- **Undo anything.** Every scene keeps the steps that built it; step back
  through them, or change an early one.
- **Switch to code and back.** The script tab shows the scene as Python and
  applies your edits when you save. Export plain magpylib for anyone, or the
  scene as code to keep.
- **Let an AI assistant help.** A coding agent can write the scene in code, read
  its field and sweep its variables, and hand it to you to open in the studio
  (see below).

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
[notebook guide](https://github.com/magpylib/magpylib-studio/blob/main/docs/guide/notebook.md).

## Write a scene in code

A scene is a plain magpylib function whose parameters are the variables:

```python
from typing import Annotated

import magpylib as magpy
from magpylib_studio import Count, Length, duplicate_around, scene


@scene
def ring(
    n: Annotated[int, Count(2, 60, slider=(4, 20))] = 10,
    radius: Annotated[float, Length(0.005, 0.08)] = 0.023,
):
    group = magpy.Collection(style_label="Ring")
    magnet = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.01), polarization=(1, 0, 0), position=(radius, 0, 0)
    )
    group.add(magnet)
    duplicate_around(magnet, count=n, axis="z", spin=360 / n)
    return group


ring(n=12).getB((0, 0, 0))  # plain magpylib: real objects, a real field
ring.build().save(
    "ring.magpy.json"
)  # the document: n and radius are sliders in the studio
```

Called, it is magpylib. Built, it is the studio's document, every parameter a
slider. More in
[the guide](https://github.com/magpylib/magpylib-studio/blob/main/magpylib_studio/.agents/skills/magpylib-studio/SKILL.md),
and a complete example in
[examples/scene_demo.py](https://github.com/magpylib/magpylib-studio/blob/main/examples/scene_demo.py).

## Let a coding agent write it

The package carries an [Agent Skill](https://agentskills.io) that teaches coding
agents — Claude Code, Codex, Copilot and others — to write scenes as such
functions, read the field and sweep a variable, and hand you the result to open
in the studio. In a project that depends on `magpylib-studio`:

```sh
uvx library-skills  # pick magpylib-studio; for Claude Code, install into .claude/skills
```

## Install the Python package only

```sh
pip install magpylib-studio
```

Python 3.11 or newer, and magpylib 5.2 or newer.

## Learn more

| If you want to…                | Read                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| use the VS Code extension      | [the extension's guide](https://github.com/magpylib/magpylib-studio/blob/main/vscode-extension/README.md)                  |
| use the 3D view in a notebook  | [docs/guide/notebook.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/guide/notebook.md)                     |
| write scenes in code           | [the guide](https://github.com/magpylib/magpylib-studio/blob/main/magpylib_studio/.agents/skills/magpylib-studio/SKILL.md) |
| know how it works inside       | [docs/architecture.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/architecture.md)                         |
| contribute                     | [CONTRIBUTING.md](https://github.com/magpylib/magpylib-studio/blob/main/CONTRIBUTING.md)                                   |
| see where the project is going | [docs/roadmap.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/roadmap.md)                                   |
| see what was decided, and why  | [docs/decisions.md](https://github.com/magpylib/magpylib-studio/blob/main/docs/decisions.md)                               |

## License

BSD-3-Clause, like the other packages built on magpylib. See
[LICENSE](https://github.com/magpylib/magpylib-studio/blob/main/LICENSE).
