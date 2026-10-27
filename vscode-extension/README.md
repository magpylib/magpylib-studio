# Magpylib Studio

Build and explore [magpylib](https://github.com/magpylib/magpylib) magnet
designs in VS Code. Place magnets, currents and sensors in a 3D view, name the
numbers that matter, and drag a slider: the whole design follows, with the field
computed exactly in milliseconds.

<!-- Absolute, not relative. vsce rewrites relative image paths against the
     *repository* root it reads from package.json, and this extension lives in
     a subfolder of that repo — so `../docs/halbach.gif` becomes a 404 on the
     Marketplace listing while looking right on GitHub. -->

![The Halbach rings of the marimo example in VS Code, half in the light theme and half in the dark: the objects and the steps that built them, the variables with their sliders, the 3D view with the field lines flowing through the bore, and the scene as code in the script tab.](https://raw.githubusercontent.com/magpylib/magpylib-studio/main/docs/halbach.gif)

_The Halbach rings from `examples/marimo_demo.py`: two rings of twelve magnets,
each ring one magnet and one pattern, and the field's lines flowing through the
bore. Drag `n` and both rings rebuild._

## Get started

1. Install the extension: search for **Magpylib Studio** in the Extensions view,
   or run `code --install-extension magpylib.magpylib-studio-vscode`.
2. Open a folder, click the magpylib icon in the Activity Bar, choose **Load
   Example Scene…** and pick the Halbach rings from the gallery.
3. The first time, it offers to **Install the Engine**, the Python side of the
   studio. Accept: it uses the Python interpreter you have selected, if it is
   3.11 or newer and you agree, or creates a `.venv` in the folder.

Then try a few things:

- In **Variables**, drag `n`: twenty-four magnets rebuild from one number.
- In **Objects**, expand a ring to see the steps that built it, and choose
  **Edit Step…** on one to change it after the fact.
- Run **Sweep a Variable…** on `gap` to plot the field against it.
- Run **Edit Python Script** to see the scene as code, change a line and save.

## What you can do

- **Work in scenes.** A scene is a `.magpy.json` file that opens in its own tab.
  Several can be open side by side, each with its own undo, and **Save** writes
  them like any other file.
- **Build in 3D.** Add magnets, currents, sensors, or a triangular mesh from a
  file, from points or from a formula. Click an object to select it and drag its
  handles to move, turn or resize it, or to aim its polarization.
- **Make it parametric.** Name the numbers the scene is written in, such as
  `radius`, `gap` or `n`. Each gets a slider, a value can be an expression like
  `360 / n`, and a typed unit is understood (`15 mm`, `800 mT`). Save a set of
  values as a variant to come back to it.
- **Pattern, don't copy.** **Pattern…** repeats an object around an axis, along
  a direction, or as a mirror image. It is one step, so changing the original
  changes every copy.
- **Change any step.** The Objects view lists the steps that built each object.
  Edit one, move it earlier or later, or remove it, and everything after it is
  applied again. **Build Up To Here** shows the scene as it was at that step.
- **See the field.** The Field view shows it along a sensor's path, as a map
  over a plane, or swept against a variable.
- **Switch to code and back.** **Edit Python Script** shows the scene as a
  magpylib function whose parameters are the variables, and saving the tab
  applies your edits. **Export as Python Script…** writes plain magpylib that
  anyone can run, and **Open in Magpylib Studio** opens the scene a script
  builds.
- **Keep your work.** The studio keeps a backup after every edit, so open scenes
  come back after a reload, unsaved changes included.
- **Work with a coding agent.** The Python package teaches coding agents to
  write scenes, and the result opens here.
  [How to set it up](https://github.com/magpylib/magpylib-studio#let-a-coding-agent-write-it).

## The views

| View            | Shows                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Open Scenes** | The scenes open in this window, once there are two or more.                                    |
| **Objects**     | The objects of the scene in front, grouped as in the scene, and the steps that built them.     |
| **Inspector**   | The selected object's position, properties and style.                                          |
| **Variables**   | The scene's variables, their sliders and units, and saved variants.                            |
| **Undo**        | Every edit in this session. Click one to go back or forward to it.                             |
| **Field**       | The field along a path, over a plane, or against a variable. Open it with **Open Field View**. |

## Keys

In the 3D view:

| Key                          | Does                                                   |
| ---------------------------- | ------------------------------------------------------ |
| W, E, R, P                   | Handles to move, turn, resize, or aim the polarization |
| Q                            | Put the handles away                                   |
| X, Y, Z / A                  | Hold a drag to one axis / free it again                |
| L                            | Switch between world axes and the object's own         |
| S                            | Snap to round steps                                    |
| Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z | Undo, redo                                             |

In the Objects view: Cmd/Ctrl+S saves, Cmd/Ctrl+C, X and V copy, cut and paste,
F2 (Enter on macOS) renames, and Delete (Cmd+Backspace on macOS) removes.

## Settings

| Setting                           | Default         | What it does                                                                                              |
| --------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `magpylib-studio.pythonPath`      | empty: find one | The Python interpreter that runs the engine.                                                              |
| `magpylib-studio.scriptTimeout`   | 300 s           | How long a script may run when the studio runs it, before it is stopped.                                  |
| `magpylib-studio.drawScriptsHere` | on              | `magpy.show()` in scripts run from this window's terminals draws in a studio panel instead of Matplotlib. |

## If something goes wrong

- The engine's messages are in the **Magpylib Studio Engine** output channel
  (**View → Output**).
- **Restart Engine** in the Command Palette starts the Python side again.
- The engine is looked for in this order: the `magpylib-studio.pythonPath`
  setting, a `.venv` in the workspace, then `python3` on the PATH. An
  interpreter counts only if it can import `magpylib_studio`, which needs Python
  3.11 or newer. To set it up yourself, run `pip install magpylib-studio` and
  point the setting at that interpreter.

## More

- [Magpylib Studio](https://github.com/magpylib/magpylib-studio): the 3D view in
  notebooks, writing scenes in code, and the coding-agent skill.
- [Changelog](https://github.com/magpylib/magpylib-studio/blob/main/vscode-extension/CHANGELOG.md)
- [Contributing](https://github.com/magpylib/magpylib-studio/blob/main/CONTRIBUTING.md):
  building and debugging the extension.
- [Issues](https://github.com/magpylib/magpylib-studio/issues)

BSD-3-Clause, like the other packages built on magpylib.
