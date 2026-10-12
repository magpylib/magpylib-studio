# Changelog

What changed in Magpylib Studio: the VS Code extension and the
`magpylib-studio` Python package it runs on. Open an entry for its details.

## [Unreleased]

### Added

<details>
<summary>Several scenes at once, each in a tab of its own</summary>

A `.magpy.json` opens in its own tab, with its own undo, unsaved dot and script
tab. New Scene, Load Example and Import Script open a new tab instead of
replacing the scene that is open. In the side bar, **Open Scenes** lists the
open scenes (Cmd-click picks several) and **Objects** shows the objects of the
ones picked. The Variables, Inspector and Undo views follow the scene in front.

</details>

<details>
<summary>A scene's file is watched</summary>

A change made elsewhere — git, another editor, an agent — comes into the tab as
one undo step. Renaming or moving the file in the Explorer keeps its unsaved
changes and its undo.

</details>

<details>
<summary>Unsaved work survives a crash</summary>

Unsaved changes VS Code did not bring back after a crash are offered back. If
the engine stops, every scene comes back as it was a second after its last edit.

</details>

<details>
<summary>The 3D view in a notebook</summary>

`SceneWidget(objects)` from `magpylib_studio.widget`, or
`magpy.show(..., backend="widget")`, draws the studio's view in a Jupyter,
marimo, VS Code or Colab cell, with its legend, keys, animation and export to
HTML or PNG. Install with `pip install "magpylib-studio[widget]"`; it needs
magpylib's main branch.

</details>

<details>
<summary>Editing in a notebook</summary>

`SceneWidget(..., editable=True)` gives the view its editing handles, undo,
`save()` and `to_script()`, without the extension. The pencil among the view's
tools turns editing on; `editable="never"` is a view for looking only. A scene
with variables gets a sliders panel, and its `variables` trait can be read, set
or linked from a cell. `reset()` takes every edit back in one undoable step.
`SceneWidget(ring)` takes a scene function directly.

</details>

<details>
<summary>Writing a scene in code</summary>

A scene is a plain magpylib function marked `@scene`: its parameters are the
variables (bounds and kinds in `Annotated[...]`: `Length`, `Angle`, `Count`)
and its body is magpylib. Called, it is plain magpylib; `.build()` makes it a
studio scene. The studio's own steps — `derived`, `duplicate_around`,
`duplicate_along`, `mirror`, `place`, `sampled`, `grid`, `hide`, `unhide`,
`remove`, `name`, `TriangularMesh.from_file` and the like — are one step each,
and an object's `style_label` is its id. A call the scene cannot take fails at
its line and says why. **Open in Magpylib Studio** on such a script opens its
scene, and `to_builder_script()` writes any scene back as a function.

</details>

<details>
<summary>Variants: named sets of values</summary>

A scene keeps named sets of values for its variables: `@scene(variants={...})`
in code, `view.save_variant(name)` in a notebook, or the Variables view's menu
(Save as Variant, Save Over, Rename, Delete). The variables panel shows a toggle
per variant, and one press sets them all as one undo step. Variants are saved in
the `.magpy.json`.

</details>

<details>
<summary>Units: lengths in mm, fields in mT</summary>

A variable can say what it measures — length, angle, field, current — and every
box reads a unit when one is typed: `20 mm`, `2 cm`, `5°`. **Units…** (the ruler
on the Variables view) shows lengths in mm, cm or µm and fields in mT or µT in
the Inspector, the steps, the field maps and the plots, and a bare number then
means that unit. The file stays in metres and tesla, so nothing saved changes.

</details>

<details>
<summary>The Variables and Object panels beside the view</summary>

Both panels dock in a column beside the view (`V`, `O`), or below it when the
view is narrow. The Object panel shows the selection's parameters, pose and
style in the scene's units; a value can be `12`, `1.5 cm` or a variable's name.
↺ puts back variables a drag took over, or resets a style. In a notebook,
`view.panel("variables")` and `view.panel("object")` place them anywhere. The
studio's Variables view and Inspector are these same panels.

</details>

<details>
<summary>A script's figures use the new view</summary>

`magpy.show(..., backend="studio")`, or any `magpy.show()` with **Draw scripts
here** on, draws the notebook widget: legend, tools and keys. `animation=True`
plays in the panel. A re-run keeps what you hid, the theme and the camera.
Needs magpylib's main branch.

</details>

- Typing a name the scene lacks into the Inspector or the drag readout makes
  that variable, at the value it replaced, in one undo step.
- A collection can be dragged as one: select it in the tree or the legend, or
  press C on something inside it.
- With a pattern's source selected, the source is outlined in full, its copies
  faintly, with a dashed line through them. A style set on the source reaches
  the copies at once.
- The view's tools are grouped, and `W`, `E`, `R` or `P` put the handles out in
  that mode.
- `view.variables = {...}` sets several values in one step and one rebuild.
- An import of plain magpylib names the variables it turned into numbers.
- Dragging in a notebook waits half as long per frame, marimo most of all.
- An Agent Skill in the package teaches coding agents to write scenes as
  functions, read the field and sweep a variable; `uvx library-skills` links it
  into a project.

### Changed

<details>
<summary>A scene is a VS Code document</summary>

Save, Save As, Revert and the question on closing a tab with unsaved changes are
VS Code's own. An example opens in a preview tab named after it, with nothing
unsaved: the next example takes its place, and the first edit keeps it. The one
scene an older version remembered opens once as a tab.

</details>

<details>
<summary>The script tab is the scene as a function, and saving applies it</summary>

**Edit Python Script** shows the scene as a `@scene` function; saving replaces
the scene with what it builds, as one undo step that keeps variables, formulas
and patterns. A script that fails, or that would change more than you edited,
is refused with the line why. If the scene changed since the tab was written,
the save asks first. Auto-save does not apply the tab. **Export as Scene
Script…** writes the function to a file.

</details>

<details>
<summary>One 3D view, the same everywhere</summary>

The studio's 3D view is the notebook widget, with the same controls and keys:
tools at the top right, editing handles with undo and redo down the right edge,
the numbers a drag changes at the bottom left (typeable), a key list, and a play
bar for paths. Chart mode and Animate sit beneath the view. Hiding objects (H,
⇧H, the legend's eye) is one undo step.

</details>

- The legend shows each object's kind as an icon in its colour, and counts
  pattern copies (`×10`).
- A selection is outlined in bright green along the object's own edges, instead
  of a blue box round everything; a selected collection includes its pattern
  copies.
- Undo never goes back past opening a scene, a script or an example.
- Needs VS Code 1.109 or later.
- Update the engine with the extension: an older engine is refused, and
  **Install the Engine** now upgrades one already installed.
- In a scene written in code, a sensor or dipole with no size set is drawn 5 mm
  across instead of a metre.
- The 3D view draws only when something changes, so an idle panel leaves the GPU
  alone.

### Removed

- The Copilot Chat tools (`#magpyAdd` and the rest). A coding agent writes the
  scene as a function instead, taught by the Agent Skill.
- Saving the script tab no longer parses arbitrary code back into the scene.
  Plain magpylib comes in through **Open in Magpylib Studio**.

### Fixed

- Cmd/Ctrl+Z in a text box undoes the typing, not the scene.
- Install the Engine on a machine with no Python says to install one, instead
  of "spawn python3 ENOENT".
- A box's values are split at commas, so `0, 0, gap * 2` is accepted.
- A copy of an object in a turned group stands where the object stands.
- Removing an object and adding another with the same id no longer mixes them
  up.
- Undo after Save As into another folder no longer breaks mesh paths.
- Turning or resizing an object on a path no longer drags its path along.
- A sensor's own reading is redrawn during a drag, not only after it.
- A handle clicked without moving no longer swallows the next edit into its
  undo step.
- A drag of several objects is all or nothing, and a refusal says why.
- A value typed over a variable's expression can be put back with ↺.
- A sensor switched to the 2D `arrow` symbol draws.
- No white halo round the logo on dark themes.

## [0.4.1]

- Maintenance release, no changes you would notice.

## [0.4.0]

### Added

<details>
<summary>Triangular meshes: magnets shaped like the part</summary>

**Add Object… → Triangular mesh** reads an STL (built in; OBJ, PLY and others
with pyvista) or takes the convex hull of a point cloud. The import asks the
file's units and shows the size each answer gives. The scene records the file,
not its vertices, and says when the file has moved or changed. A mesh that is
open, disconnected or self-intersecting is flagged in the tree, the Inspector
and the field view; inside-out faces are turned round and counted.

</details>

<details>
<summary>The 3D view can be worked in</summary>

Click an object to select it, Cmd-click to add to the selection, and drag the
handles to move (`W`), turn (`E`), resize (`R`) or aim a polarization (`P`).
`X`/`Y`/`Z` hold a drag to an axis, `L` uses the object's own axes, `S` snaps.
A drag is one undo step.

</details>

<details>
<summary>A script's own show() draws in VS Code</summary>

`magpy.show(..., backend="studio")` opens a panel beside the editor, and with
**Draw scripts here** on (the default; it can be turned off) so does a plain
`magpy.show()`. A re-run updates the panels; a badge says when the script was
saved since it drew. **Open in Magpylib Studio** opens the script's scene for
editing.

</details>

<details>
<summary>New examples: one formula, many solids; placement tolerance</summary>

A superellipsoid magnet whose two roundness sliders make a block, cylinder,
sphere, rounded disc or octahedron, matching magpylib's exact field within 0.2%
where it has one. "Field on a plane" is now a probe under a magnet, showing
what a placement tolerance costs in field variation.

</details>

- Paths play, with a play button, a scrubber and `space`.
- A graduated box shows the scene's scale.
- Navigation keys: `F` frames the selection, `Home` everything, `1` `3` `7`
  look down the axes, `5` toggles a parallel projection, `Tab` walks the
  objects, `H` hides (`⇧H` shows one alone).
- Variable sliders move the scene while you drag them.
- **Close Scene** on the Scene view's title bar.

### Changed

- The 3D view is a three.js scene graph; the Plotly chart is one button away,
  read only, with Animate.
- The example scenes are sized like real magnets, in millimetres, with
  Hall-probe-sized sensors.
- The magnet array example stacks, with a third count `nz`.
- Field maps and pixel grids are sized from the scene.

### Fixed

- An Inspector edit marks the scene unsaved, writes the backup and updates the
  field, script and `scene.json`.
- A drag that ends where it began leaves no undo step.
- Variable sliders redraw during the drag on any scene.
- The helical winding example draws.

## [0.3.1]

### Fixed

- A number sent as text (`"10"`) is read as a number.
- A variable holding a name used in arithmetic says so.
- Running an edited script keeps the scene's variables.
- `remove_variable`, `duplicate_along` and `mirror` can be batched from chat.
- Clearing the scene says it clears the variables.

## [0.3.0]

### Added

- Rename a variable from `⋯` in the Variables panel; everything using it
  follows.
- A script keeps each variable's limits in a comment
  (`n = 10  # 2 to 60, slider 4 to 20, whole`) and reads them back.

### Changed

- `⋯` on a variable opens a menu instead of a three-step wizard.

### Fixed

- Every object shows the steps that built it, not only collections.
- A deleted object's history is still shown, under a dimmed row saying why.
- Move Step Later on a "created" step is refused.
- Pattern-along and mirror steps have their own icon.

## [0.2.0]

### Added

<details>
<summary>Paths and curves as formulas</summary>

Move By… and Rotate… offer an even spread (`np.linspace`), a step repeated
(`np.arange`), custom points, or a formula in `t`. A run of points — a path, a
polyline's vertices — can be a formula whose count is a variable, so a helix's
resolution is a slider. The script writes the matching numpy call.

</details>

- A "Helical winding" example.
- A polyline's vertices are typed one point per line, in an editor that catches
  a wrong count.

### Changed

- The document format is version 2. Older releases refuse these scenes with a
  message; older scenes open as before.
- Add Object… shows each shape's icon, says what it is for and can be filtered
  by magpylib class.
- Reading the scene and the field from chat costs far fewer tokens.

### Fixed

- A moved path exports as the `move(np.linspace(...))` call that made it.
- A path from Move By… or Rotate… starts where the object is, without a repeated
  first frame; the prompt asks Start over or Continue.
- An exported script imports the maths (`sqrt`, `cos`, `pi`, `tau`) its
  expressions use.
- Importing a script says what running it flattened.

## [0.1.3]

### Fixed

- The Inspector showed rounded numbers (2.5 as "2.") and could save them back.
- A pattern step's expressions no longer read "currently NaN".
- A restarted engine brings the scene back instead of starting empty.
- Installing the engine no longer freezes VS Code.
- The 3D and Field panels come back after a window reload.
- The Field view lists a sensor's grid as soon as it opens.
- Changing `magpylib-studio.pythonPath` restarts the engine on the new
  interpreter.

### Changed

- Install the Engine names the interpreter it will change, and offers a `.venv`
  instead.

## [0.1.2]

### Added

- A variable can be a choice: `options` give a dropdown, as bounds give a
  slider.

### Fixed

- Large patterns rebuild faster while you drag.
- Reopening a scene restores unsaved changes without asking every time.
- A variable holding a name shows it instead of an empty box.

## [0.1.1]

### Added

- A getting-started walkthrough opens on first install.
- "No Python interpreter found" offers **Install the Engine**, which finds or
  fetches a suitable Python.
- The engine is on PyPI: `pip install magpylib-studio`.

## [0.1.0]

### Added

- Scenes are `.magpy.json` files: save, open, an unsaved mark, and a prompt
  before anything discards work. **Export as Python Script…** writes a script.
- The format has a version and a JSON Schema for editing by hand.
- The scene is backed up after every edit and reopened after a reload.
- The scene is a list of steps: edit a past step, or build up to any step and
  add from there.
- Variables and expressions (`=gap * 2`), with bounds, sliders and sweeps.
- Patterns: circular, linear (twice makes a grid) and mirror.
- A script tab that exports the scene and reads it back.
- A field view over B, H, J or M on a sensor's pixel grid.
- Six example scenes.

### Fixed

- The Inspector rendered blank.
- "What can go in a value" opened onto an empty box.
- A rotate step's axis showed `NaN`.
- Deleting a patterned magnet left its copies in the field.
- The exported script failed after a removal.
- The script tab showed the previous window's scene after a reload.
