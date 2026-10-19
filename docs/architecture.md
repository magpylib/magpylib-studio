# How it works inside

_For contributors and for anyone driving the engine from another frontend. Using
the studio needs none of this; see the [README](../README.md). This is the one
description of the system as it is: when it and the code disagree, one of them
is wrong and gets fixed. Why it is this way is in [decisions.md](decisions.md);
what is next is in [roadmap.md](roadmap.md)._

## The parts

| Part                  | Where                                             | What it is                                                                                                                                             |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the engine            | `magpylib_studio/session.py`                      | `MagpylibStudioSession`: the document, the build, and every operation the GUI, the widget, the builder and the RPC call                                |
| the scene function    | `magpylib_studio/recording.py`, `hook.py`         | `@scene` and studio's words: a plain magpylib function recorded into a document through magpylib's hook, or a copy of it from outside                  |
| the document builder  | `magpylib_studio/build.py`                        | `Scene`: a document written one operation at a time, underneath the recorder; the writer that turns a document back into a function                    |
| expressions           | `magpylib_studio/expressions.py`                  | the hermetic expression language of the document                                                                                                       |
| units                 | `magpylib_studio/units.py`                        | unit kinds, the shown units, reading `15 mm`                                                                                                           |
| meshes                | `magpylib_studio/meshes.py`                       | STL reader, hulls, superquadrics, validity checks, the resolved-mesh cache                                                                             |
| import                | `magpylib_studio/importer.py`                     | `load_script` (run a script, intercept `show()`), `document_from_objects`                                                                              |
| scripts outside       | `magpylib_studio/runner.py`                       | a script run in a process of its own -- the script tab's save, Open in Studio -- handing back documents, the meshes carried                            |
| transport             | `magpylib_studio/rpc.py`, `__main__.py`           | one JSON object per line on stdio; `rpc.handle` is what the widget's connection calls too                                                              |
| drawing               | `backend.py`, `viewer.py`, `plotly_view.py`       | `magpy.show(backend="studio" \| "widget")`, where a script's figure goes, the plotly figure                                                            |
| the 3D view's data    | `magpylib_studio/threejs.py`                      | the scene payload the renderer draws (NaN sent as `null`, restored in the view)                                                                        |
| the notebook widget   | `magpylib_studio/widget.py`, `static/`            | `SceneWidget`, an anywidget; `static/widget.js` is the committed bundle of the renderer, `legend.mjs`, `drag.mjs`, `variables.mjs` and `inspector.mjs` |
| the agent skill       | `magpylib_studio/.agents/skills/magpylib-studio/` | `SKILL.md` and a reference generated from the builder's docstrings, shipped in the wheel                                                               |
| the VS Code extension | `vscode-extension/`                               | `src/extension.ts` the host, `engineClient.ts` the RPC client, one `.ts` per sidebar view, `media/` the webview scripts, `harness/` checks             |
| the renderer          | `vscode-extension/media/scene3d.mjs`              | three.js; one node per studio id; handles; the keys table both hosts use                                                                               |
| tools                 | `tools/`                                          | `build-widget.sh`, `check-package-alone.py`, `write-skill-reference.py`, `replay-magpylib-docs.py`                                                     |
| the agent evaluation  | `evals/`                                          | tasks with checkable targets, a runner for Claude Code headless, results kept in git                                                                   |
| tests                 | `tests/`, `vscode-extension/src/test/`            | the engine suite, the extension suite in a real Extension Development Host, browser checks of the widget                                               |

## The engine and magpylib's versions

The engine needs magpylib 6 (`magpylib>=6.0`), the first release with what it is
built on: the style property tree it reads and writes styles through
(`schema()`, `set`, `set_values()`), path-valued physics properties
(`current=[100, 200, 300]`), the display-backend API the 3D view draws through,
with its pixel helpers, and `Panel.objects`, which gives a bare `magpy.show()` a
legend.

## The document

A scene is one JSON object, saved verbatim as `.magpy.json`
([0013](decisions.md#0013-the-saved-file-is-the-document)):

```json
{
  "version": 3,
  "variables": { "n": 10, "radius": 0.023, "stagger": "=360/(2*n)" },
  "variable_bounds": {
    "n": {
      "integer": true,
      "min": 2,
      "max": 60,
      "soft_min": 4,
      "soft_max": 20
    },
    "radius": { "min": 0.005, "max": 0.08, "unit": "length" }
  },
  "variants": { "compact": { "n": 8, "radius": 0.018 }, "wide": { "n": 16 } },
  "model_unit": "mm",
  "field_unit": "mT",
  "events": [
    {
      "id": "e1",
      "op": "create",
      "target": "ring1",
      "type": "Collection",
      "style": { "label": "Ring 1" }
    },
    {
      "id": "e2",
      "op": "create",
      "target": "r1",
      "type": "magnet.Cuboid",
      "parent": "ring1",
      "params": {
        "dimension": [0.01, 0.01, 0.01],
        "polarization": [1, 0, 0],
        "position": ["=radius", 0, 0]
      }
    },
    {
      "id": "e3",
      "op": "duplicate_around",
      "target": "r1",
      "count": "=n",
      "axis": "z",
      "spin": "=360/n"
    },
    {
      "id": "e4",
      "op": "rotate_from_angax",
      "target": "ring1",
      "angle": "=stagger",
      "axis": "z",
      "anchor": 0
    }
  ],
  "objects": ["…a projection, never written to…"]
}
```

- **`events` is the whole scene**
  ([0001](decisions.md#0001-the-document-is-the-log)). Ops: `create`, `remove`,
  `reparent`; the transforms `move`, `rotate_from_angax`, `rotate_from_rotvec`,
  `position`, `orientation`; the patterns `duplicate_around`, `duplicate_along`,
  `mirror`. A `create` carries the object's type, constructor `params`, `style`
  (dotted paths nested), its `parent`, and for a `TriangularMesh` a
  `mesh_source` instead of vertices
  ([0002](decisions.md#0002-record-the-call-not-the-result)). What an object
  _is_ is edited on its create event; what happened _to_ it is appended.
- **Any numeric value may be an expression**: a string starting with `=`, over
  `variables` ([0003](decisions.md#0003-expressions-are-hermetic)). A run of
  points may be a `sampled` node, a formula of `t` with a `count` and a range,
  so a pixel grid or a path can follow a variable, count included.
- **`variable_bounds`** holds hard limits (`min`, `max`, enforced in the build),
  the slider range (`soft_min`, `soft_max`), `integer`, `options` for a choice,
  and `unit`, the kind a variable measures
  ([0008](decisions.md#0008-units-are-metadata)). `model_unit` and `field_unit`
  say what the scene is _shown_ in; the numbers stay SI.
- **`variants`** names sets of values for the variables, a variant each:
  `{name: {variable: value}}`, a finite number or a choice's name, never an
  expression, stored as numbers in the variables' order. A variant may leave
  variables out. `use_variant` sets the ones it names as one step; which one the
  scene is in is read off the variables, never stored: of those whose values
  hold, the one naming the most. Saving, renaming or removing one rebuilds
  nothing. A variant is checked as the combination it makes: values the limits
  refuse, its own or a formula's following them, are refused when it is saved; a
  change of limits that would strand one is refused, naming it; one a later
  formula makes unusable is listed in `get_variables` as `unusable`, with why,
  and not used. Renames and removals of variables reach every variant; a
  variable made a formula leaves them. An older studio carries the key untouched
  ([0013](decisions.md#0013-the-saved-file-is-the-document)), so the version
  stays 3.
- **One id names one object** in the whole log. An id a removed object had,
  given to a new one, retires the removed object's steps to an id of their own
  (`magnet~1`), and a file written before is read the same way when opened;
  copies take ids no step has named.
- **Hidden objects** stay in the scene and in the field: hiding sets magpylib's
  own `model3d.showdefault` and `path.show` on the leaf specs, keeping the prior
  values in `hidden_style` for an exact restore, so nothing else is recoloured.
- **Versioning**: `DOC_VERSION` is stamped on every document that passes through
  a session; an older one is migrated, a newer one refused; unknown keys
  survive. A JSON Schema at `vscode-extension/schemas/magpy-scene.schema.json`
  is validated against every example.

## The build

`_build` folds the whole log from the start on every change: construct and
attach each `create`, detach a `remove`'s subtree, move a `reparent`'s, then
replay the transforms and patterns in order. 1.7 ms for the 24-object example,
which is what makes sliders live and `sweep` affordable.

- A pattern's copies are built at fold time, registered as real sources, and
  reported by `list_objects` with `derived` naming their source: selectable, not
  editable.
- A per-event failure goes into `_broken` and the fold carries on, so a document
  with one bad step still shows a scene. Ordinary mutations roll back and report
  (`_mutate_doc`); edits to the log itself apply and report what fell over.
- `set_rollback(index)` folds only the events before a step: a view, with edits
  made meanwhile inserted at that step.
- Undo is a stack of document snapshots, capped at 100
  ([0005](decisions.md#0005-undo-is-snapshots)); a drag or a `batch` is one
  step. A Save As that rebases mesh paths rebases every snapshot too, so a step
  taken back still finds its meshes.
- A copy stands where its source stands. Beside its source (`copy_object`
  without a parent), its steps go into the log beside the source's, each after
  the one it copies, so it is in the same groups when they turn and follows the
  same variables; put elsewhere, its steps go at the end in their own order, and
  it is pinned to its source's world pose where the source's groups had moved
  it, in the same undo step.
- Across scenes a copy is a scene of its own: `export_object` writes the
  object's subtree with the variables its formulas name and what its groups did
  to it as one rigid step on its top (a pattern's source inside a Collection
  named after it); `import_fragment` merges that under a parent as one step,
  keeping ids this log never used and renaming the rest, renaming a variable
  whose name is taken (`radius` to `radius_2`, every formula following) unless
  an earlier import from the same origin made that same variable, and rebasing
  mesh paths to its own folder. Variants stay with their scene.
- Variables: hard bounds and `integer` are enforced in the fold, so they hold
  however a value arrived; renaming rewrites expressions through the AST;
  `sweep` re-folds once per value and records nothing.
- Units: every operation that shows a value says how it is `shown`; `quantity`
  and `read_values` read what is typed, `15 mm` or `1.5 cm`, in decimal.

## Writing a scene in code

A scene is a plain magpylib function under `@scene`
([0017](decisions.md#0017-the-scene-is-a-function-in-plain-magpylib-recorded)).
Its parameters are the variables, each with a default and, in `Annotated`, its
bounds and kind (`Length`, `Angle`, `Count`, `Bounds`; a `Literal` for a
choice). Called, it is the plain function: magpylib objects at those values.
`fn.build()` calls it with the parameters as handles inside a `record` block
(`hook.py`: magpylib's hook where it has one, the same wrapping put on
magpylib's classes from outside where it does not) and maps each event onto the
document builder underneath (`build.py`): a construction is a create step at the
root, `group.add(obj)` moves a fresh create inside the group,
`obj.parent = group` is a reparent, a transformation is its step, a property
assignment a parameter edit or a pose pin, `copy()` the document's copy, and the
style each object was given is read between calls and written as edits.
Arithmetic on a handle writes an expression; what needs the value now raises at
its line; a property read is today's number, with a warning. Studio's own words
(`derived`, the patterns, `sampled` and `grid`, `hide` and `unhide`, `remove`,
`TriangularMesh.from_file`, `.from_hull` and `.from_superquadric`, `place`,
`name`) are one step each when recording and plain magpylib when called.
`fn.build(values=path)` takes a saved scene's slider values. The mark names
variants, `@scene(variants={...})`, each value checked against its parameter's
annotation where the mark is written; `ring.variants` is that mapping, so
`ring(**ring.variants["wide"])` is plain magpylib at those values. The build
keeps them, and a saved scene's over them by name when the document is first
read (`Scene`, so a builder script keeps them too): one the built scene cannot
take whole -- a parameter gone or a formula now, values past new limits -- is
left out with a warning, and the mark's of that name stays. A plain function
handed to the notebook's view is a scene function without the mark, built the
same way; the mark is for a file, where it says which function is the scene, and
for `build()` without a view.

Three ways between code and the document, none of which parses code
([0004](decisions.md#0004-script-generation-is-one-way)):

- `to_script()` writes plain magpylib, for anyone, patterns as loops, folding
  the log in order. An export: it loses `variable_bounds` and `visible`.
- `to_builder_script()` writes the scene as such a function, one call per step,
  which run builds the same document. The script tab shows it, and a deliberate
  save applies it as one undo step
  ([0007](decisions.md#0007-the-script-tab-is-builder-code)). Variants are
  written in the mark, each value in the signature's order; an entry naming no
  parameter, and a variant the scene cannot use, are named at the top instead,
  since written they would fail the script at its mark.
- `load_script(path)` runs any script with `show()` intercepted. A script that
  defined a scene function opens as the scene it builds, whole; plain magpylib
  opens as its objects, and the import names the variables it turned into
  numbers.

## The views

**The 3D view** is `scene3d.mjs`, three.js, one node per studio id, drawn from
`threejs.py`'s payload (`get_scene`), under `threejs.pinned_scene_units()`:
lengths in metres, sensors and dipoles at their stated size and a bare one at
`SENSOR_SIZE`, with magpylib's defaults put back after, so a notebook's own
`show()` is untouched
([0020](decisions.md#0020-a-bare-sensor-is-drawn-at-the-studios-size-and-magpylibs-defaults-are-left-alone)).
A sensor whose pixels read the field comes as a `pixels` item, a position, a
direction, a size and a colour per pixel, that the renderer draws as instances
of one shape, sized and coloured as magpylib sizes and colours them
([0021](decisions.md#0021-a-frame-is-one-message-and-a-readings-pixels-are-instances));
the sensor keeps its axes as a mesh, and a run's frames keep magpylib's whole
drawing. It picks, multi-selects, drags with handles (move, turn, resize, aim a
polarization; world or object axes; one-axis locks; snapping), hides, fades by
id (`setFades`: a share of each object's own opacity, looked through by a click;
[0031](decisions.md#0031-the-legends-eye-fades-as-a-view-setting)), plays paths,
and has one keys table both hosts use. It says the scene's scale one of three
ways (`setAxes`, the widget's `axes`): by default a view cube and a scale bar,
drawn into the canvas's corner after the scene in the same frame, the cube a
click away from twenty-six views and the bar a round length at the orbit centre,
said in the unit that reads best, kept by the PNG where the cube is not; the
graduated box round the scene; or neither
([0027](decisions.md#0027-the-scale-is-said-round-the-scene-or-in-its-corner),
[0030](decisions.md#0030-the-view-cube-is-the-default-scale)). A drag goes
through `static/drag.mjs`: open an undo group, pace previews with one request in
flight, send the final pose through `apply_edits`, close the group.
`apply_edits` turns the view's edits into `set_transform` / `set_param` calls in
the session, batched into one undo step, for every host; with `define`, a bare
variable's name typed where a number was, that the document lacks, is made at
the value it replaces, in that kind of unit, in the same step. The payload says
the scene's `units` and the `expressions` written behind the pose fields, so the
view's readout shows `gap` in the scene's millimetres and reads `15 mm`, `5°` or
a name back through `quantity`.

Every scene also says which objects overlap
([0029](decisions.md#0029-overlapping-magnets-are-found-and-said-as-you-edit)):
`overlaps`, pairs of ids, with `overlap_depths`; `intended_overlaps`, the pairs
marked as meant; and `overlaps_by_step` where something moves along a path. Two
objects overlap when they interpenetrate by more than a nanometre, touching
never, each where its path ends; a magnet inside a pattern's copied group is
named by the copy that holds it. `collisions.py` decides it from the magpylib
objects alone, keeping each shape built while it is unchanged, so a drag
rebuilds only what moved. `get_overlaps` lists the pairs, `get_gap` measures two
objects, `set_overlap_intended` marks a pair, kept in the document's
`intended_overlaps` and carried through the script tab, and `list_objects` names
each object's partners, which the Objects tree marks as it marks a broken mesh.
The view outlines each overlapping object in amber, its own traces only, and in
a run the pairs of the step shown; a selected one keeps its green. The legend
marks each overlapping row, passed up to a folded collection, faint for a pair
marked as meant; above the list it counts the pairs, a click stepping through
them with a way to mark the one shown, and with two objects selected says how
far apart they are. A read-only view works the overlaps out from the objects it
was given, keyed as its payload. A check that fails leaves `overlaps` empty and
says why in `overlaps_error`.

**The notebook widget**, `SceneWidget`
([0010](decisions.md#0010-the-notebook-widget-edits-with-the-package-alone)), is
that renderer as an anywidget with a legend that nests the objects, tools,
export to one HTML file (`write_html`) and PNG. A scene written in code, or a
path, is shown as its own session with the handles away; `editable=True`, or the
pencil among the view's tools later
([0018](decisions.md#0018-a-view-is-read-only-until-its-pencil-is-pressed)),
puts them out, and for the cell's own objects first copies them into a session
in the kernel, named from the cell's variables as read when they were given. The
view calls `rpc.handle` over its connection, restricted to a short allow-list,
and a `revision` trait and `last_edit` fire once per settled edit, never per
preview frame. With the handles, the sliders toggle at the foot of the edit
column opens **the variables panel** in a column beside the view, which refits
to what is left, or in a sheet below a view narrower than 720px, the widget
growing by it (`static/variables.mjs`,
[0019](decisions.md#0019-the-editors-panels-are-the-widgets-and-a-host-mounts-them),
[0024](decisions.md#0024-the-panels-dock-beside-the-view-and-below-a-narrow-one)):
a slider per variable with a range, a dropdown for a choice, a box that reads
`15 mm` through `quantity`; a value under the pointer is a `set_variable` marked
`preview`, applied without a word to the notebook, and answered with the scene
when the message asks (`scene`), so a frame of a slider's or a handle's drag is
one message where it was two; the release settles as one edit. With variants,
one row above the sliders: a toggle per variant, the one the values are in
pressed, one press a `use_variant` settled as one edit, an unusable one shown
and not offered -- or a dropdown, past four or names too long for a row.
`view.save_variant(name)` keeps the values as they are and hands back, for the
mark, those of the scene function's parameters. A `variables` trait,
`{name: value}` as resolved, follows the session, so a cell reads the knobs;
assigned, it sets what differs as one change (`set_variables`: one rebuild,
checked as the combination it makes, no step for values the scene already has),
so another control's trait links to it both ways (`traitlets.link`), the view's
model owning the numbers. Beside the sliders, an object toggle opens **the
object panel** (`static/inspector.mjs`, the studio's Inspector, compact): the
selection's parameters and pose, in the scene's units, expressions as written,
and its style tree folded under one heading, read when opened; it follows the
selection. A value typed is read through `read_values`, and set with `define`,
so a bare name the scene lacks is made at the value it replaces; a style
property set is `apply_edit`, settled and told as a `set` of `style.<path>`. One
of the two panels is open at a time. The bundle `static/widget.js` is committed
so installing needs no node; `npm run check:widget` fails when it no longer
matches its sources, and a CI job installs the wheel alone and runs an edit
through a fake connection.

**The studio panel draws the widget** ([0011](decisions.md#0011-one-view)):
`media/studioView.mjs` holds a model (`payload`, the engine's `object_tree`,
`selected`, `hidden`) and an editor that sends the drag's messages to the
extension host, which refreshes the tree, the Inspector, the field view, the
history and the script tab, and marks the scene unsaved. In the studio hiding is
an edit; in a notebook a view setting; the model decides. Fading is a view
setting in both. Chart mode swaps in the read-only plotly figure.

**Field views**: `get_field` (summed B, H, J or M at points or along a sensor,
with `skipped` and `warnings` inline), `get_field_figure` (magpylib's own 2D
rendering along the sensors), `get_field_map` (a heatmap on a plane or off a
sensor's pixel grid, sized from the scene's extent), `get_sweep_figure` (the
field against a variable).

**Scripts draw in the window they were run from**
([0014](decisions.md#0014-the-window-stamp-says-where-never-whether)): the
extension stamps `MAGPYLIB_STUDIO_DROP` on its terminals, and the
`drawScriptsHere` setting, on by default, makes a plain `magpy.show()` draw in a
panel; a test run is excepted. Elsewhere a script's figure opens as a saved page
in the browser, saying where.

## The extension

`src/extension.ts` spawns `python -m magpylib_studio` (resolution: the
`magpylib-studio.pythonPath` setting, then `.venv` in the workspace or the repo,
then `python3`; **Install the Engine** sets one up) and holds one engine with a
session per open scene.

**A scene is a tab.** `.magpy.json` opens in a custom editor
(`magpylibStudio.scene`, `src/scenes.ts`): its document is the scene's object in
the extension -- the file, the engine session (a random name, a new one when an
engine restarts), the panels showing it, the selection, the script tab's state,
and the last document it settled on, taken a second after each edit. VS Code's
Save, Save As, Revert, hot exit and unsaved dot are the scene's; undo stays the
studio's, so the dot is told once per edit (`CustomDocumentContentChangeEvent`)
and cleared only by a save or a revert. Save As and a rename or a move in the
Explorer hand the session to the new file's document -- its undo, its unsaved
changes, its mesh paths rebased -- since VS Code reopens the new name from the
file. Each scene's file is watched: a change made elsewhere comes in as one undo
step named "changed on disk", a file that does not read is not loaded and its
row says so, and a save checks the file first. Each scene keeps a recovery copy
in extension storage, because VS Code brings unsaved work back after a crash
only from the editor state it saves about once a minute; on the next start a
copy newer than what its tab loaded is offered back. An engine that dies is
given every scene back, one at a time, the one going back named on disk so that
a scene whose restore stops it too is kept out the next time, marked lost and
never saved. Scene tabs an extension-host restart leaves without a document are
reopened.

**The scene in front** is the one the side bar shows and the commands act on:
the scene tab last used or the row last clicked, which stays in front while the
focus is in the side bar or another editor. A command acts on the scene it
started in through every question it asks (an `AsyncLocalStorage` holds it); a
side view names the scene it was drawn for in every request.

The sidebar, as Source Control's Repositories and Changes: Open Scenes, hidden
until a second scene opens and then the person's to show or hide from the views
menu (a line per open scene, its file's commands on it -- Save, Close, Save As,
Revert, Export, Reveal; picking one, or several with Cmd-click, picks what
Objects shows; while it is hidden those commands are in Objects' title bar
instead), Objects (the scenes picked, each under its own heading, or one's
objects at the top, nested as grouped with each object's steps under them; drag
and drop to reparent within a scene and to copy into another, rename, copy, cut,
paste -- across scenes a copy, a Cut moving it, one undo where it landed putting
it back in both -- delete, hide), the Inspector (a webview whose widgets are
built from the style schema; properties and pose take expressions, shown in the
scene's units), the Variables view (a webview, because a tree row cannot hold a
slider: the package's `variables.mjs`, the widget's own panel, with its calls
routed through the extension host, and the variants kept, renamed and deleted
from its title bar; the Inspector is `inspector.mjs` the same way, in full), the
Undo view, and the Field panel on demand, which belongs to the scene it was
opened for. Each scene has its script tab: a real file in extension storage,
named after the scene in a folder keyed by where the scene is, holding
`to_builder_script()`, regenerated on every edit unless it is dirty or holds
refused text, applied to its own scene on a deliberate save. Only
`broadcastMutation()` marks a scene unsaved, redrawing does not. Cmd/Ctrl+Z in a
box of a webview undoes the typing: the webviews say when a box has the focus
(`magpylib-studio.textFocus`), and in a scene's tab, which VS Code's own undo
never reaches, the host asks the page to undo it.

Webview JavaScript lives in `media/*.js|mjs` under a nonce CSP, never inside
TypeScript template literals; `harness/` checks that, the message contract, the
declared commands and menus, the scene bounds, and runs a panel's real script
against a real engine (`npm run inspect -- halbach`). All of it runs in
`npm run compile`. `npm test` runs the integration tests in a real Extension
Development Host. The 24 language-model tools for Copilot Chat were removed
([0009](decisions.md#0009-agents-write-builder-code-through-a-skill)); agents
reach the studio through scene functions and the skill.

## Agents

An agent writes a scene function, runs it with plain Python, reads the field
through `fn.build().session`, and hands the person the script or the saved
`.magpy.json`, which the studio opens whole. The skill teaches that and what
each refusal means; its reference is generated from the docstrings and tested,
and every example in it is run by the tests. `evals/` measures the same tasks
with and without studio (`evals/README.md`).

## JSON-RPC protocol (stdio)

The host spawns `python -m magpylib_studio` and exchanges one JSON object per
line — no ports, no framework.

```
-> {"id": 1, "method": "get_schema", "params": {"object_id": "cube"}}
<- {"id": 1, "result": { ...JSON Schema... }}
<- {"id": 2, "error": {"type": "KeyError", "message": "..."}}
```

**One engine, a session per scene.** `open_session(session, scene?, path?)`
opens a session under a name the host chooses and loads it in the same call;
from then on a request names its session beside the method, and the answer names
it back. `close_session` drops one. A name is used once, closed ones included,
so a stale one can only miss. A request that names no session goes to a session
of its own only on a connection that has never opened one by name -- the
one-scene host, the "Try it" below; after an `open_session` it is refused
(`SessionError`), so a call that forgot its scene fails rather than reading an
empty one. `version` says the package's version, the protocol number
(`rpc.PROTOCOL`, 2 since sessions) and the newest document version read. Every
session resolves meshes through one cache per process, keyed by what the source
read, so a part in two scenes is reoriented once.

```
-> {"id": 3, "method": "open_session", "params": {"session": "4f2a9c", "path": "ring.magpy.json"}}
-> {"id": 4, "session": "4f2a9c", "method": "undo"}
<- {"id": 4, "session": "4f2a9c", "result": {...}}
```

| group     | methods                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| engine    | `open_session` · `close_session` · `version`                                                                                                                                                                                                                                                                                                                                                   |
| inspect   | `list_objects` · `object_tree` · `get_schema` · `get_values` (style) · `get_params` (physics) · `get_transform` · `get_history` · `inspect_mesh`                                                                                                                                                                                                                                               |
| structure | `add_object` · `remove_object` · `copy_object` · `move_object` (reparent) · `set_visible` · `export_object` · `import_fragment` (across scenes)                                                                                                                                                                                                                                                |
| edit      | `apply_edit` (style) · `set_param` · `reset_style` · `apply_edits` / `apply_calls` (what a view's drag sends) · `begin_interaction` · `end_interaction`                                                                                                                                                                                                                                        |
| transform | `move` · `rotate` · `set_transform` · `clear_path` · `set_pixel_grid`                                                                                                                                                                                                                                                                                                                          |
| patterns  | `duplicate_around` (circular) · `duplicate_along` (linear; twice = a grid) · `mirror`                                                                                                                                                                                                                                                                                                          |
| variables | `get_variables` · `set_variable` · `set_variable_bounds` · `set_variable_unit` · `set_model_unit` · `set_field_unit` · `get_units` · `quantity` · `read_values` · `field_units` · `unit_kinds` · `rename_variable` · `remove_variable` · `unknown_variables` · `expression_help` · `check_expression` · `set_variables` · `use_variant` · `save_variant` · `rename_variant` · `remove_variant` |
| history   | `get_events` · `edit_event` · `move_event` · `remove_event` · `set_rollback`                                                                                                                                                                                                                                                                                                                   |
| view      | `get_scene` (3D payload) · `get_overlaps` · `get_figure` (plotly) · `get_field_figure` · `get_field_map` · `get_sweep_figure`                                                                                                                                                                                                                                                                  |
| field     | `get_field` · `sweep`                                                                                                                                                                                                                                                                                                                                                                          |
| undo      | `undo` · `redo` · `goto_history`                                                                                                                                                                                                                                                                                                                                                               |
| I/O       | `load_scene` · `set_base_dir` · `load_script` · `load_captured` · `apply_builder_script` · `list_examples` · `load_example` · `clear_scene` · `to_dict` · `to_script` · `to_builder_script`                                                                                                                                                                                                    |
| bulk      | `batch` — many mutating ops in one call, one undo step                                                                                                                                                                                                                                                                                                                                         |

Mutating methods return `{"ok": bool, "error"?: str}`
([0012](decisions.md#0012-validation-is-shared-and-reported)). Everything is
JSON-serializable in both directions; `get_figure` is
`json.loads(fig.to_json())` so plotly's encoder handles numpy. `serve()` is a
strictly serial blocking loop with no threads: a long operation freezes every
view, which is why FEM jobs need a worker (roadmap).

Try it:

```sh
printf '%s\n' \
  '{"id":1,"method":"load_example"}' \
  '{"id":2,"method":"list_objects"}' \
  '{"id":3,"method":"get_field","params":{"points":[[0,0,0]]}}' \
  '{"id":4,"method":"to_script"}' \
| python -m magpylib_studio
```
