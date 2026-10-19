# Changelog

What changed in Magpylib Studio: the VS Code extension and the `magpylib-studio`
Python package it runs on. Open an entry for its details.

## [Unreleased]

### Added

<details>
<summary>Field lines through a sensor's pixels, following a drag (prototype)</summary>

A sensor whose pixels read B or H can draw the field's lines through them: the
lines button among the view's tools, `SceneWidget(..., field_lines=True)` or
`set_field_lines` on the session. In a plane of the field's symmetry the lines
keep to it, elsewhere they run in 3D, and they stop at magnets: they show the
field in the air, coloured as the sensor's arrows are. They follow a drag, are
saved with the scene and undone like an edit, and a saved page carries them. In
the notebook widget and the VS Code panel alike (#46).

</details>

<details>
<summary>Spread a sensor's pixels with the handles</summary>

R now resizes a Sensor with pixels: it spreads the pixel array about its centre,
the pixels and the sensor's axes keeping their size. A grid written over a
variable, such as its density, is stretched as that formula, so the variable
still decides it. The engine draws it as the drag goes. A sensor with one pixel,
or more than 256, keeps the Inspector (#59).

</details>

### Changed

<details>
<summary>A drag sends only what it moves</summary>

Past its first step, a drag draws and sends only the objects it moves and the
sensors whose arrows read the field; the rest of the scene stays as the view
drew it, and is drawn whole again when the drag ends. Whether two magnets
overlap is decided once per pair while neither moves. A drag of 96 magnets in
marimo went from 18 to 24 scenes a second, and the demo with field lines from 53
to 59, its frame rate (#58).

</details>

### Fixed

<details>
<summary>An aim let go after a pause is its own undo step</summary>

Aiming a polarization, or resizing a patterned source, then pausing before
letting go sent nothing at the release: the drag stayed open, and the edits
after it joined its undo step (#59).

</details>

## [0.6.0]

### Added

<details>
<summary>Magnets that overlap are found and marked as you edit</summary>

magpylib adds the magnetizations of two magnets where they overlap, so a magnet
pushed into its neighbour gives a field that looks right and is wrong. The view
now finds such pairs, while a magnet is still being dragged, and says so: an
amber outline in the 3D view, a warning on the object's row in the legend and in
the Objects tree, and above the legend the number of pairs, a click looking at
each in turn. Touching is not overlapping, so Halbach rings, stacks and a shaft
in its bore are left alone. An overlap meant as a cut-out is marked once and no
longer warned about; it stays in the scene's file. The legend says how deep an
overlap goes and, with two objects selected, how far apart they are; a run
outlines what overlaps at each of its steps. From code: `get_overlaps`,
`get_gap` and `set_overlap_intended` on the session (#47).

</details>

<details>
<summary>Fade an object from the legend, to see what is inside it</summary>

Press an object's eye in the view's legend and slide sideways: left fades it,
right brings it back, and a click still hides it. A thin bar under the row shows
how far while you slide. A click in the view goes through what is faded, so the
sensor inside a faded Halbach ring can be picked. It changes the view, not the
scene: nothing is saved or undone, and the scene's opacity stays the
Inspector's. In a notebook it is the widget's `faded`, beside `hidden` (#52).

</details>

### Changed

<details>
<summary>The view cube is the default scale</summary>

A view now says its scale with the view cube and a scale bar in its corner, in a
notebook and in the VS Code panel alike, rather than with the graduated box
round the scene. The axes button goes round the cube, the box and none, in that
order. `axes="box"` still asks for the box, and a page saved with a choice keeps
it (#49).

</details>

<details>
<summary>The engine needs magpylib 6</summary>

`pip install magpylib-studio` now brings magpylib 6, and nothing needs
installing from magpylib's git any more. What kept the engine working on 5.2 is
gone: the style shim and its copy of the style schema, the check that turned the
3D view off without the display-backend API, and the panel falling back to the
chart when it did. Nothing a scene file or a script holds changes (#49).

</details>

<details>
<summary>Dragging redraws faster</summary>

Every step of a drag rebuilds the scene, and the view used to throw away each
mesh's material with it, which had the browser compile its shaders anew on the
next step: about seven programs, 14 ms of a frame on an M4 Pro. The materials
now stay, so drawing a step costs about 2 ms instead of 15, in the notebook
widget and the VS Code view alike. The picture is unchanged (#44).

The engine also builds the next step's scene while the view draws the last one,
where it used to wait: a step a little longer than a frame cost two. The marimo
demo now gets 58 scenes a second during a drag where it got 52 (#55).

</details>

## [0.5.1]

### Changed

<details>
<summary>Dragging keeps up better where a sensor draws the field</summary>

While you drag, the arrows a sensor draws are worked out again at every step,
and a step now costs less: it makes one trip through VS Code's extension host
instead of two, and magpylib reads the arrows' field once instead of three
times. In the turning-magnet example, the engine's part of a step went from
about 12 ms to about 5 ms on an M4. Reading the field once needs magpylib's main
branch (#43).

</details>

### Fixed

<details>
<summary>Magnets coloured by name, and sensor pixels that read nothing</summary>

A magnet whose colours were given by name, such as
`style_magnetization_color_north="red"`, stopped the 3D view from drawing.
Sensor pixels that read no field are drawn grey, as magpylib draws them: they
were black when no pixel read anything, and top-of-scale yellow beside one that
did, which also lost its size under log scaling (#40).

</details>

## [0.5.0]

### Added

<details>
<summary>A view cube and a scale bar, in place of the box</summary>

The axes button in the view's tools goes round three ways to show the scale: the
graduated box, as before; a view cube in the corner with a scale bar beside it;
and none. Click a face, an edge or a corner of the cube to look from there, and
drag it to orbit. The bar is a round length in the unit that reads best — 1 mm,
not 0.001 m — exact in a parallel view and at the orbit centre in perspective,
and the picture a view saves keeps it. The box's numbers read the same way: a
scene two centimetres across is ticked in millimetres. From code, `axes="box"`,
`"cube"` or `"none"`; `True` and `False` still mean the box and none.

</details>

<details>
<summary>Several scenes at once, each in a tab of its own</summary>

A `.magpy.json` opens in its own tab, with its own undo, unsaved dot and script
tab. New Scene, Load Example and Import Script open a new tab instead of
replacing the scene that is open. In the side bar, **Objects** shows the objects
of the scene in front. When a second opens, **Open Scenes** lists them above it,
as Source Control's Repositories do, and Objects shows the ones picked there
(Cmd-click picks several); the side bar's views menu shows or hides it. The
Variables, Inspector and Undo views follow the scene in front.

</details>

<details>
<summary>Copy, cut and drag objects between scenes</summary>

Paste an object into another scene, or drag it onto that scene in the side bar,
and it arrives as a copy where it stood, with the variables it uses: a name the
scene already has comes in renamed (`radius` as `radius_2`), so the copy never
moves with the other scene's slider. Cut and Paste moves it, and one undo where
it landed puts it back. A copy taken before its scene closed still pastes.

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
A script -- the script tab's save, Open in Magpylib Studio -- runs in a process
of its own, so one that never returns or ends its process takes only that with
it; it is stopped after five minutes (`magpylib-studio.scriptTimeout`). When the
engine has not answered for 30 s, the studio says so and offers **Restart
Engine**, which is also in the Command Palette.

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
variables (bounds and kinds in `Annotated[...]`: `Length`, `Angle`, `Count`) and
its body is magpylib. Called, it is plain magpylib; `.build()` makes it a studio
scene. The studio's own steps — `derived`, `duplicate_around`,
`duplicate_along`, `mirror`, `place`, `sampled`, `grid`, `hide`, `unhide`,
`remove`, `TriangularMesh.from_file` and the like — are one step each, and an
object's id is the variable it is assigned to (`r1 = magpy.magnet.Cuboid(...)`),
else its `style_label`. A call the scene cannot take fails at its line and says
why. **Open in Magpylib Studio** on such a script opens its scene, and
`to_builder_script()` writes any scene back as a function.

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
plays in the panel. A re-run keeps what you hid, the theme and the camera. Needs
magpylib's main branch.

</details>

<details>
<summary>Typing a new name makes a variable</summary>

Type a name the scene does not have into the Inspector or the drag readout, and
it becomes a variable at the value it replaced, in one undo step. The status bar
says what was made.

</details>

<details>
<summary>Drag a whole collection</summary>

Select a collection in the tree or the legend, or press C on something inside
it, and a drag moves and turns the whole collection as one edit.

</details>

<details>
<summary>A pattern's copies shown as a family</summary>

With a pattern's source selected, the source is outlined in full and its copies
faintly, with a dashed line through them. A style set on the source reaches the
copies at once.

</details>

<details>
<summary>The view's tools in groups, and W E R P</summary>

The tools are grouped: the camera, what is shown, the pencil, export, the
window. On a view that offers the pencil, `W`, `E`, `R` or `P` put the handles
out in that mode.

</details>

<details>
<summary>Several values in one step</summary>

`view.variables = {...}` sets everything it changes together: one rebuild
instead of one per value, checked as the combination it makes.

</details>

<details>
<summary>Imports name the variables they flattened</summary>

Importing plain magpylib now names the variables it turned into numbers, where
it used to say nothing.

</details>

<details>
<summary>Faster dragging in notebooks</summary>

A slider's or a handle's frame asks for the scene in one message instead of two:
half the wait per frame on a notebook host where every message costs, marimo
most of all.

</details>

<details>
<summary>An Agent Skill for coding agents</summary>

The package carries a skill that teaches coding agents to write scenes as
functions, read the field and sweep a variable. `uvx library-skills` links it
into a project.

</details>

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
and patterns. A script that fails, or that would change more than you edited, is
refused with the line why. If the scene changed since the tab was written, the
save asks first. Auto-save does not apply the tab. **Export as Scene Script…**
writes the function to a file.

</details>

<details>
<summary>One 3D view, the same everywhere</summary>

The studio's 3D view is the notebook widget, with the same controls and keys:
tools at the top right, editing handles with undo and redo down the right edge,
the numbers a drag changes at the bottom left (typeable), a key list, and a play
bar for paths. Chart mode and Animate sit beneath the view. Hiding objects (H,
⇧H, the legend's eye) is one undo step.

</details>

<details>
<summary>The legend says what each row is</summary>

Each row shows its kind's icon in the object's colour. A collection counts what
is drawn under it, pattern copies included, and a pattern's source shows how
many it stands for (`×10`).

</details>

<details>
<summary>A clearer selection outline</summary>

A selection is outlined in bright green along the object's own edges, its path
apart, instead of a thin blue box round everything. A selected collection
includes its pattern copies, for the outline and for `F`.

</details>

<details>
<summary>Undo starts where the scene opened</summary>

Opening a scene, a script or an example is where its history begins: the first
undo takes back the first edit, never the whole scene.

</details>

<details>
<summary>Needs VS Code 1.109 or later</summary>

Earlier versions left the old tab marked unsaved after Save As, and after an
untitled scene's first save.

</details>

<details>
<summary>Update the engine with the extension</summary>

An engine from before several scenes, or newer than the extension understands,
is refused with a message. **Install the Engine** now upgrades one already
installed.

</details>

<details>
<summary>Sensors in scenes written in code are drawn at 5 mm</summary>

A sensor or dipole with no size set used to be drawn a metre across in a scene
written in code. It is 5 mm now, and a size its style gives is kept.

</details>

<details>
<summary>An idle 3D view leaves the GPU alone</summary>

The view draws only when something in it changes, instead of every frame.

</details>

### Removed

<details>
<summary>The Copilot Chat tools</summary>

`#magpyAdd` and the rest are gone. A coding agent writes the scene as a function
instead, taught by the Agent Skill, and **Open in Magpylib Studio** opens what
it wrote.

</details>

<details>
<summary>Parsing scripts back into the scene</summary>

Saving the script tab no longer parses arbitrary code into the scene; it applies
a scene function. Plain magpylib comes in through **Open in Magpylib Studio**.

</details>

### Fixed

<details>
<summary>A scene file can only name the classes a scene holds</summary>

Opening a scene turned each object's `type` into a callable by walking
magpylib's attributes, so a crafted `.magpy.json` could name, and have the
studio call, any function reachable from magpylib. Types now come from a fixed
list of the classes a scene supports; any other is refused before anything is
called, and the rest of the scene opens (#34).

</details>

<details>
<summary>Cmd/Ctrl+Z in a text box undoes the typing</summary>

It undid the scene instead, and Shift+Cmd/Ctrl+Z redid it, in the studio's
panels and in VS Code's own boxes.

</details>

<details>
<summary>Install the Engine says when there is no Python</summary>

On a machine without Python it failed with "spawn python3 ENOENT". It now says
to install Python 3.11 or newer, or uv, which the button then uses.

</details>

<details>
<summary>A box's values are split at commas</summary>

`0, 0, gap * 2` and `radius * cos(tau * turns * t)` are read as written; they
used to be split at their spaces and refused.

</details>

<details>
<summary>A copy in a turned group stands where the object stands</summary>

A copy of any magnet of the Halbach's second ring stood where it would be had
the ring never turned.

</details>

<details>
<summary>Objects that shared an id are kept apart</summary>

Removing an object and adding another under its id left both under that id: a
copy could copy the removed one, and an edit could land on it.

</details>

<details>
<summary>Undo after Save As keeps mesh paths</summary>

After Save As into another folder, an undo brought back mesh paths meaning the
old folder, and the mesh broke.

</details>

<details>
<summary>A path stays put when its object turns or resizes</summary>

Turning or resizing an object on a path with the handles dragged the path along,
and it jumped back on release.

</details>

<details>
<summary>A sensor's reading follows a drag</summary>

A sensor that colours its pixels or draws arrows showed the field from where a
drag began until the drag ended.

</details>

<details>
<summary>A click on a handle leaves undo alone</summary>

A handle clicked and let go without moving left an undo group open, and the next
edit anywhere was folded into it.

</details>

<details>
<summary>Dragging several objects is all or nothing</summary>

When the engine refused part of a drag of several objects, the others moved
anyway, and the message said only "undefined".

</details>

<details>
<summary>↺ puts a variable's expression back</summary>

A resize, an aim or a number typed over a value written with a variable left no
way back but undo. The expression is kept now, and ↺ in the Variables panel
restores it.

</details>

<details>
<summary>The 2D arrow symbol draws</summary>

A sensor switched to the 2D `arrow` symbol failed to draw.

</details>

<details>
<summary>No white halo round the logo on dark themes</summary>

The logo on a scene's tab had a white outline on dark themes; they now get a
version drawn light.

</details>

## [0.4.1]

A maintenance release, with no changes you would notice.

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
`X`/`Y`/`Z` hold a drag to an axis, `L` uses the object's own axes, `S` snaps. A
drag is one undo step.

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
where it has one. "Field on a plane" is now a probe under a magnet, showing what
a placement tolerance costs in field variation.

</details>

<details>
<summary>Paths play</summary>

A play button, a scrubber and `space` run the paths. Each frame is the scene
computed at that step, and a run lasts magpylib's animation time, five seconds
by default.

</details>

<details>
<summary>A box that shows the scale</summary>

A graduated box at the scene's extent, with magpylib's axis names and units,
says what scale the scene is at.

</details>

<details>
<summary>Navigation keys</summary>

`F` frames the selection and `Home` everything; `1`, `3` and `7` look down the
axes; `5` switches to a parallel projection; `Tab` walks the objects; `H` hides
one and `⇧H` shows it alone.

</details>

<details>
<summary>Sliders move the scene while you drag</summary>

Variable sliders redraw the scene during the drag, not only on release, and the
whole drag is still one undo step.

</details>

<details>
<summary>Close Scene</summary>

On the Scene view's title bar, beside undo, redo and save. Closing also shuts
the 3D and field views.

</details>

### Changed

<details>
<summary>The 3D view is a scene graph</summary>

It draws with three.js, so objects can be clicked and dragged. The Plotly chart
is one button away, read only, and Animate belongs to it.

</details>

<details>
<summary>Examples sized like real magnets</summary>

The example scenes are in millimetres, not metres, so their fields read in tens
to hundreds of millitesla, and their sensors are the size of a Hall probe.

</details>

<details>
<summary>The magnet array stacks</summary>

A third count, `nz`, stacks the array. It starts at 1, so the scene opens as
before.

</details>

<details>
<summary>Field maps fit the scene</summary>

A field map's plane and a new pixel grid are sized from the objects, instead of
a fixed 2.4 m square.

</details>

### Fixed

<details>
<summary>Inspector edits count as edits</summary>

Typing into the Inspector updated the 3D view and the tree only: the field, the
script and `scene.json` lagged behind, and the unsaved mark and the crash backup
were skipped.

</details>

<details>
<summary>A drag that ends where it began leaves no step</summary>

It left a step that undid to the same scene, and cleared redo.

</details>

<details>
<summary>Sliders redraw during the drag on any scene</summary>

On a fast scene the redraw kept being pushed back until the drag ended. A drag
now redraws once per frame, as fast as the scene allows.

</details>

<details>
<summary>The helical winding example draws</summary>

Its 3D view was empty: the gaps in its trace broke the message carrying it.

</details>

## [0.3.1]

### Fixed

<details>
<summary>Numbers sent as text are numbers</summary>

A `"10"` from a caller became a string variable, so `n * 2` gave `"1010"`. Bare
numerals are read as numbers now.

</details>

<details>
<summary>A name used in arithmetic says so</summary>

A variable holding `"z"` in a sum now says so, instead of giving `"zz"`.

</details>

<details>
<summary>Running an edited script keeps the variables</summary>

Adding a `for` loop to the generated script dropped every variable; they are
carried across now.

</details>

<details>
<summary>Chat batches take every step</summary>

`remove_variable`, `duplicate_along` and `mirror` could not be batched from
chat.

</details>

<details>
<summary>Clearing the scene says it clears the variables</summary>

It always did; now it says so.

</details>

## [0.3.0]

### Added

<details>
<summary>Rename a variable</summary>

Under `⋯` in the Variables panel. Every formula that uses it is rewritten, so
the scene is unchanged and the limits follow the name.

</details>

<details>
<summary>Scripts keep the variables' limits</summary>

Each variable's line carries its limits as a comment
(`n = 10  # 2 to 60, slider 4 to 20, whole`), read back when the script is
imported.

</details>

### Changed

<details>
<summary>A menu for a variable's settings</summary>

`⋯` on a variable opens a menu of its name, range, kind and limits, each showing
what it holds, instead of a three-step wizard.

</details>

### Fixed

<details>
<summary>Every object shows its steps</summary>

Only collections showed the steps that built them; a magnet's own history was
there but unreachable.

</details>

<details>
<summary>A deleted object's history stays</summary>

It shows under a dimmed row saying why the object is missing: deleted, rolled
back past, or no longer built.

</details>

<details>
<summary>Move Step Later stops at "created"</summary>

Moving a create step later is refused, instead of leaving the object gone and
its history broken.

</details>

<details>
<summary>Pattern and mirror steps have icons</summary>

They showed the generic dot.

</details>

## [0.2.0]

### Added

<details>
<summary>Paths and curves as formulas</summary>

Move By… and Rotate… offer an even spread (`np.linspace`), a step repeated
(`np.arange`), custom points, or a formula in `t`. A run of points — a path, a
polyline's vertices — can be a formula whose count is a variable, so a helix's
resolution is a slider. The script writes the matching numpy call.

</details>

<details>
<summary>A helical winding example</summary>

One wire as a formula: the case no pattern can make.

</details>

<details>
<summary>Polyline vertices in an editor</summary>

Add Object… takes a polyline's vertices one point per line, and catches a wrong
count before the editor closes.

</details>

### Changed

<details>
<summary>Document format version 2</summary>

Older releases refuse scenes saved by this one with a message, instead of
opening them half-empty. Older scenes open as before.

</details>

<details>
<summary>Add Object… shows the shapes</summary>

Each entry shows the icon the tree will use, says what the shape is for, and
names its magpylib class, which the filter matches.

</details>

<details>
<summary>Chat reads cost fewer tokens</summary>

A pattern's copies are counted instead of listed, and field results are rounded
to six significant figures without echoing the points sent.

</details>

### Fixed

<details>
<summary>Paths export as the call that made them</summary>

A moved path came back as hundreds of numbers; it is written as
`move(np.linspace(...))` again, and so is a run of points in a parameter.

</details>

<details>
<summary>Paths start where the object is</summary>

A path from Move By… or Rotate… left out its starting pose, and could begin on a
repeated frame. The prompt now asks **Start over** or **Continue**.

</details>

<details>
<summary>Exported scripts import their maths</summary>

An expression using `sqrt`, `cos`, `pi` or `tau` exported a script that failed
with `NameError`.

</details>

<details>
<summary>Imports say what they flattened</summary>

A script's loop of eight current loops became eight objects without a word; the
import now says so.

</details>

## [0.1.3]

### Fixed

<details>
<summary>The Inspector shows full numbers</summary>

It dropped digits (2.5 read "2."), and an edit could save the rounded values
back.

</details>

<details>
<summary>No more "currently NaN"</summary>

A pattern step's expression no longer reads as NaN; the real value shows where
the engine has one.

</details>

<details>
<summary>A restarted engine keeps the scene</summary>

It started empty, and could write the empty scene over the backup.

</details>

<details>
<summary>Installing the engine doesn't freeze VS Code</summary>

The install ran on the extension host's one thread and stopped every extension
while it ran.

</details>

<details>
<summary>Panels come back after a reload</summary>

The 3D and Field panels now return like the scene and the script tab.

</details>

<details>
<summary>The Field view is ready when it opens</summary>

It lists a sensor's grid at once, and **Sweep a Variable…** no longer races the
panel it opens.

</details>

<details>
<summary>Changing the Python path restarts the engine</summary>

Changing `magpylib-studio.pythonPath` restarts the engine on the new
interpreter, keeping the scene, instead of waiting for a reload.

</details>

### Changed

<details>
<summary>Install the Engine names the interpreter</summary>

It says which interpreter it would change, and offers a `.venv` instead.

</details>

## [0.1.2]

### Added

<details>
<summary>A variable can be a choice</summary>

`options` give a dropdown, as bounds give a slider. The Halbach example's
`tilt_axis` shows it.

</details>

### Fixed

<details>
<summary>Large patterns rebuild faster</summary>

A pattern's copies join their group in one call: a Halbach at n=500 rebuilds in
95 ms instead of 147.

</details>

<details>
<summary>Reopening restores unsaved changes quietly</summary>

Unsaved changes come back marked, as VS Code's hot exit does, instead of a
question asked on every start.

</details>

<details>
<summary>A name-valued variable shows its name</summary>

It showed an empty box.

</details>

## [0.1.1]

### Added

<details>
<summary>A getting-started walkthrough</summary>

It opens once after install, each step linking the real command.

</details>

<details>
<summary>Install the Engine</summary>

"No Python interpreter found" offers it: it uses the Python extension's
interpreter, or uv, or a `python3` found as a terminal would.

</details>

<details>
<summary>The engine is on PyPI</summary>

`pip install magpylib-studio`.

</details>

## [0.1.0]

### Added

<details>
<summary>Scenes are files</summary>

Save and open `.magpy.json` scenes, with an unsaved mark and a prompt before
anything discards work. **Export as Python Script…** writes a script.

</details>

<details>
<summary>A versioned format with a schema</summary>

A newer scene is refused, an older one migrated, and a JSON Schema helps editing
by hand.

</details>

<details>
<summary>Backups</summary>

The scene is backed up after every edit and reopened after a reload.

</details>

<details>
<summary>A history of steps</summary>

Edit a past step and the rest re-apply, or build up to any step and add from
there.

</details>

<details>
<summary>Variables and expressions</summary>

Any number can be a formula (`=gap * 2`) over variables with bounds, sliders and
sweeps.

</details>

<details>
<summary>Patterns</summary>

Circular, linear (twice makes a grid) and mirror, each one step standing for
many copies.

</details>

<details>
<summary>A script tab</summary>

The scene as runnable magpylib, read back when the tab is saved.

</details>

<details>
<summary>A field view</summary>

B, H, J or M on a sensor's pixel grid.

</details>

<details>
<summary>Six example scenes</summary>

Each leans on a different feature.

</details>

### Fixed

<details>
<summary>The Inspector rendered blank</summary>

A line break in its script stopped it from loading.

</details>

<details>
<summary>Expression help opened empty</summary>

"What can go in a value" showed an empty box.

</details>

<details>
<summary>A rotate step's axis showed NaN</summary>

`"z"` was read as a number.

</details>

<details>
<summary>Deleted pattern copies left the field</summary>

Deleting a patterned magnet left its copies, invisible but still adding to every
field.

</details>

<details>
<summary>Exported scripts after a removal</summary>

They failed to run, and copying a patterned object failed outright.

</details>

<details>
<summary>The script tab after a reload</summary>

It showed the previous window's scene.

</details>
