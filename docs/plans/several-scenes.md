# Several scenes, and variants — design

**Status: proposed, 2026-10-11.** Roadmap R9, taken up ahead of R7. Decided with
Alex that day: a project is a folder of scene files, with no container format;
variants are named value sets inside a scene, and come in this step; undo stays
the studio's own. Nothing is built.

---

## 1. What one scene costs today

The engine serves one session (`rpc.serve`), and the extension holds one engine,
one panel and one scene file as module-level state: about twenty variables in
`extension.ts` (the panel, the file, the unsaved flag, the crash backup and its
timers, the script tab, the selection), worked on by `activate`, a closure of
about 3,000 lines. A second scene means saving this one and opening the other
over it, its undo history gone.

Around that one scene the extension has built by hand what VS Code gives an
editor:

- the file's name and unsaved dot, in the Scene tree's description: "the only
  title bar the studio has — there is no editor tab to carry the name and the
  dirty dot";
- Save, Save As with mesh paths rebased, Revert, Close and its question;
- a backup written a second after an edit, and on activation the scene the
  workspace last had, from `workspaceState` and that backup;
- a serializer that brings the panel back after a reload.

And whatever reaches the studio replaces the scene: Open Scene, Load Example,
Import Script, Open in Studio on a script's drawing, and a script's other
`show()` calls, switched in place (Switch Imported Scene).

## 2. The shape

As R9 has it:

- **A scene is a file**, `.magpy.json`, and **a project is the folder** that
  holds them. Several projects are several windows or a multi-root workspace,
  and need nothing built.
- **A tab per scene**: the studio as a custom editor for `*.magpy.json`.
- **The sidebar follows the scene in front**: the tree, the Inspector, the
  Variables, the Undo view.
- **One engine, a session per open scene**, each request naming its session.

And a scene can hold **variants** (§6), so that a second setting of the same
design is a name in the scene rather than a copy of it in another file.

## 3. The engine: a session per scene

**A request names its session**, beside the method rather than among its
parameters:

```
-> {"id": 7, "session": "s2", "method": "set_variable", "params": {"name": "gap", "value": 0.002}}
```

`serve()` holds a table of sessions. `open_session` and `close_session` are the
server's, not a session's, and the extension names the session, so the open and
the `load_scene` after it go down the pipe together, with no answer to wait for
in between. A request with no `session` goes to the default one, which exists
from the start, so the "Try it" example in architecture.md and any host that
drives one scene work unchanged. `rpc.handle(session, request)`, which the
widget calls, does not change: routing is `serve`'s.

**The engine says its protocol.** The extension checks nothing about the engine
it starts, and the engine is whatever `magpylib-studio` the chosen interpreter
has. An engine from before this ignores `session` and serves every tab from one
session, without a word. So a `version` method answers the package version and a
protocol number, and the extension refuses an engine without it, offering
Install the Engine.

**Sessions are cheap; processes are not.** Measured: an engine process with the
halbach example drawn is 95 MB and 0.3 s to start; five more sessions in it,
each with the array example drawn, added under 1 MB and 40 ms each. Calls are
serial, so no two sessions' calls interleave, and the magpylib defaults that
`threejs.pinned_scene_units()` sets are put back after each. One thing is shared
and stays so: a script run by `load_script` or the script tab runs in the
engine's process, and one that sets `magpy.defaults` sets it for every open
scene, as today it does for the next scene loaded.

**One queue for every tab.** A long call in one scene (a mesh reorientation is
16 s) holds every tab until it returns. V3's worker fixes that for all of them
at once.

**The table knows each session's file**: `open_session` takes the path, and Save
As tells it. That is the lookup R3 step 2's `magpylib-studio run script.py`
needs, since every run takes a scene, by its file.

## 4. The custom editor

**A `CustomEditorProvider`, the engine owning the document.** The saved file is
`to_dict()` verbatim
([0013](../decisions.md#0013-the-saved-file-is-the-document)) and undo is the
session's snapshots ([0005](../decisions.md#0005-undo-is-snapshots)). A
`CustomTextEditorProvider` would make VS Code's text model a second owner: every
settled drag a whole-file text edit, and two undo stacks to keep in step.

**Registered for `*.magpy.json`, as the default.** A scene file opened anywhere
(the Explorer, Quick Open, `code ring.magpy.json`, a link in an agent's answer)
opens in the studio. The JSON is one Reopen Editor With… → Text Editor away,
where the schema still validates it.

| VS Code calls                                                 | the provider                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openCustomDocument(uri, { backupId, untitledDocumentData })` | `open_session`, then `load_scene` from the backup if there is one, else from the file, else from the untitled data or nothing; the base directory is the file's folder, or the workspace's for an untitled scene |
| `resolveCustomEditor(document, panel)`                        | what `adoptStudioPanel` does now, for that document                                                                                                                                                              |
| `saveCustomDocument`                                          | writes `to_dict` to the file                                                                                                                                                                                     |
| `saveCustomDocumentAs(destination)`                           | `set_base_dir(rebase=True)`, then writes                                                                                                                                                                         |
| `revertCustomDocument`                                        | `load_scene` from the file                                                                                                                                                                                       |
| `backupCustomDocument(destination)`                           | writes `to_dict` there, for hot exit                                                                                                                                                                             |

**An edit marks the tab.** Each mutation fires a
`CustomDocumentContentChangeEvent` where `broadcastMutation` sets `sceneDirty`
now: the dot is on the tab, closing asks, and VS Code keeps the backup. **Undo
stays the studio's** (decided): Ctrl+Z is `magpylib-studio.undo` on the scene in
front, and the dot clears on a save or a revert, not on undoing back to the
saved state, as the tree's • behaves today.

**New Scene is an untitled tab**, opened with `vscode.openWith` on an
`untitled:` URI; its first save asks where. Load Example opens one too.

**A file changed on disk** is loaded again by a tab with no unsaved changes, as
one undo step, as a text editor does; a tab with changes says so and offers
Revert. Nothing watches the scene file today. With a tab per file, this is how
an agent's `ring.build().save("ring.magpy.json")` reaches the tab the person has
open. `load_scene` starts the history afresh, so this needs the replace that the
script tab's save does (`_replace`), as a call of its own.

**One tab per scene** (`supportsMultipleEditorsPerDocument: false`): splitting
reveals the one there is. Two views of one session, with two cameras say, when
someone asks.

**When the engine cannot start**, the tab says so in place, with Install the
Engine and Reopen as Text.

**What goes**: `sceneFile`, `sceneDirty` and `showSceneFile`; `SCENE_STATE_KEY`
and `restoreScene`; the reload half of the backup; the `magpylibStudio` panel
serializer. Save, Save As, Revert and Close become VS Code's, on the tab, Ctrl+S
included; the Scene view's buttons call them for the scene in front.

**What stays the extension's: the engine's crash.** VS Code's backups are for
the window. The engine is our subprocess, and it holds every open scene, so the
crash copy stays, one per scene, and a restarted engine is given each one back;
a scene whose copy will not load says so on its tab.

## 5. The extension: the scene in front

**One object per open scene**, the custom document, holds what is module-level
now: the uri, the session, the panel, the selection, the script tab, the
imported candidates, the crash copy and its timer. The engine, the sidebar's
providers and the clipboard stay the window's.

**The scene in front** is the one whose tab was focused last. It stays in front
while the focus is on a Python file or the terminal, so the sidebar does not
empty while someone writes a script beside the scene; when its tab closes, the
scene tab focused before it takes its place.

- **The sidebar reads it.** Each provider is handed a `request` bound to the
  scene in front, and a change of scene refreshes all four. The tree's
  description is the scene's name; the dot is on the tab.
- **The field panel follows it**, as the sidebar does. Comparing two scenes'
  fields is another feature.
- **Commands and keys act on it.** In the keybindings,
  `activeWebviewPanelId == 'magpylibStudio'` becomes
  `activeCustomEditorId == 'magpylib-studio.scene'`.
- **Each scene has its script tab**: a file in extension storage named after the
  scene (`ring.py`), in a folder keyed by the scene's URI, so that two
  `ring.magpy.json` from different folders do not share one and a reload finds
  which scene a restored tab belongs to. It is regenerated as now, and its save
  applies to its own scene wherever the focus is. The live JSON
  (`magpylib-studio:/scene.json`) becomes one per scene the same way.
- **What arrives opens a tab.** Import Script, and Open in Studio on a script or
  on a script's drawing, open a new untitled scene instead of replacing the one
  in front. A script with several `show()` calls opens its first; Switch
  Imported Scene switches that tab's, as now.
- **Paste stays within a scene.** Copying in one tab and pasting in another is
  new engine work (an object's create, its steps and the variables they name,
  moved between sessions); for now it refuses and says why.

## 6. Variants

### 6.1 What a variant is

A named set of values for the scene's **knobs**: its variables that hold a
number or a choice, not a formula.

```json
"variables": { "n": 10, "radius": 0.023, "stagger": "=360/(2*n)" },
"variants": {
  "compact": { "n": 8, "radius": 0.018 },
  "wide": { "n": 12, "radius": 0.035 }
}
```

- **Using a variant sets the knobs it names**, as one undo step, the way a
  slider sets one: the fold holds the hard bounds and `integer` as it does for
  any value. `variables` stays the one answer to what the scene is now; a
  variant is not a mode.
- **Which variant the scene is in is worked out, never stored**: of those whose
  values all hold, the one naming the most of them, so a variant that holds
  another's values and more is the one in force once used. Move a slider and the
  scene is in none; move it back and it is in the variant again. Nothing to keep
  in step, and nothing for undo to get wrong. The panel remembers which one it
  used last, so that "save over" knows what to save over; the document does not.
- **Saving a variant from the panel writes every knob**, so using it puts the
  scene back exactly. One written in code or by a tool may name fewer (R8's
  values from an Optimetrics run name what the optimiser moved), and using it
  leaves the rest where they are.
- **Variants follow the variables.** Renaming a variable renames it in every
  variant, and removing one removes it. A knob made a formula leaves every
  variant, since a formula is a definition and a variant holds values. A knob
  added later is in no variant until one is saved again; using an older one
  leaves it as it is, and the answer names it. An entry naming no variable (an
  older studio renamed it) is left out when the variant is used, and reported; a
  rename onto its name drops it rather than collide with it.
- **A variant is checked as the combination it makes** (2026-10-11, after a
  review): values the limits refuse -- those it sets, or a formula following
  them -- are refused when it is saved; a change of limits that would strand one
  is refused, naming it; one a later formula makes unusable is listed as
  `unusable`, with why, shown and not offered, and not used. Its values are
  numbers (a numeral as text is read as one) or a choice's name, finite, never a
  formula; a variant with none is no variant.

**In the document**, `variants` is a new top-level key. An older studio carries
it untouched ([0013](../decisions.md#0013-the-saved-file-is-the-document)) and
offers nothing for it, so `DOC_VERSION` stays 3; the JSON Schema gains it.

### 6.2 In the session

`get_variables()` adds `variants`, `variant`, the one the scene is in, or none,
and `unusable`. `use_variant(name)`, `save_variant(name, values=None)` (none
means every knob as it is now), `rename_variant(old, new)` and
`remove_variant(name)` are each one undo step, reported like any edit.
`save_variant` refuses a name that is not a knob. Saving, renaming and removing
rebuild nothing: no object follows a variant until it is used, and a rebuild
would also throw away a captured run. `set_variables(values)` sets several
variables in one rebuild and one step, as the `variables` trait does.

### 6.3 In code

The scene function names its variants in its mark, beside its units:

```python
@scene(
    variants={"compact": {"n": 8, "radius": 0.018}, "wide": {"n": 12, "radius": 0.035}}
)
def ring(n: ... = 10, radius: ... = 0.023): ...
```

- `ring(**ring.variants["wide"])` is plain magpylib at those values, and
  `ring.build(values=ring.variants["wide"])` the document at them: `values`
  takes a mapping already, so using a variant in code is nothing new to learn.
  In a notebook, `view.variables = ring.variants["wide"]` uses one, through the
  trait that is already there, as one change: `set_variables` sets them all in
  one rebuild and one undo step, checked as the combination they make (the trait
  set them one at a time before, a rebuild each).
- `to_builder_script()` writes them in the mark, so the script tab says the
  whole scene and its save keeps them. A key no builder call writes does not
  survive a save that changes something (`apply_builder_script`), which is why
  they have to be code. Each is written in the signature's order, however the
  document stored it, so the tab builds its scene back; an entry naming no
  parameter, and a variant the scene cannot use, are named at the top instead,
  since written they would fail the script at its mark.
- The mark's values are checked against each parameter's annotation where the
  mark is written: a count's whole number, a choice's options, the bounds.
- `build(values=path)` takes a saved scene's variants along with its values. A
  variant saved in the panel survives the next run, as a slider's position does,
  and wins over one of the same name in the mark. One deleted in the panel but
  still in the mark comes back with the next run, as a variable removed in the
  panel comes back from the signature: the mark is the code's. A variant, the
  mark's or the file's, that the built scene cannot take whole -- a parameter
  gone or a formula now, values past new limits -- is left out with a warning,
  never trimmed and never failing the build; the mark's of that name stays.
- `Scene.variant(name, values)` underneath, for the builder;
  `Scene(values=path)` lays the saved variants over the script's when the scene
  is first read, so a builder script keeps them as a scene function does.

### 6.4 In the panel

The variables panel is one module in both hosts (`static/variables.mjs`). With
variants in the scene, it gets one row above the sliders: a toggle per variant,
the one the values are in pressed, and none once a slider moves off them; one
press uses one, as one change (decided 2026-10-11: a dropdown was two clicks,
and plain). Past four variants, or names too long to sit in a row, a dropdown
holds them instead. An unusable variant is shown and not offered, its tooltip
saying why.

- **In the sidebar**, beside it, the host's actions, as `edit` and `remove` are
  for a variable now: save as a new variant, save over this one, rename, delete.
- **In the widget, the toggles alone.** Using a variant edits values, which the
  widget does; making one changes what the scene says, which in a notebook is
  the scene function's job, as adding a variable is. The widget's allow-list
  gains `use_variant` and nothing else.
- **From a cell, `view.save_variant(name)`** (decided 2026-10-11): a method, not
  a button. It keeps the knobs as they are under that name in the view's scene,
  so the panel has it at once, and returns them, ready to paste into the mark.
  Two things it saves a person from: `view.variables` holds every variable,
  formulas included, which a variant must not; and a variant saved on the
  session directly leaves the view stale, since the view follows only the edits
  made through its own calls. Until it is in the mark it lives as a dragged
  slider does: gone when the cell runs again, kept by `view.save` and a build
  from that file.
- With no variants there is no row, and the panel stays as it is.

### 6.5 Next, not here

- **R8**: values back from Optimetrics arrive as a variant named after the run,
  instead of over the knobs; the person compares, and uses it.
- **R7**: the emitter can write the variants as a parametric table, so one
  Maxwell run solves each.
- **The field per variant**: `sweep` over variants, recording nothing, when a
  cell or the evals ask for it.
- **Two variants side by side**: a view of one scene at another variant's
  values. Until then, a second tab is a Save As.

## 7. The order

Each step lands on its own, writing the changelog and architecture.md as it
does.

1. **The engine's sessions**: `serve`'s table, `open_session`, `close_session`,
   the default session, `version`. Tested: two sessions, each with its own undo;
   an unknown session refused; a request without one served as today.
2. **Variants**, engine and panel: the document key, the session's calls, the
   rules of §6.1, the mark, the writer, `build(values=path)`, the panel's row
   and the sidebar's actions, the widget's allow-list, the skill and its
   generated reference. Independent of the tabs, and in notebooks the day it
   lands.
3. **The extension, unchanged to look at**: what is one scene's moves into one
   object. Still one scene, and the extension suite green.
4. **The custom editor**: scenes open in tabs; New, Open, Save, Save As, Revert
   and reload are VS Code's, and the hand-built ones go; a crash copy per scene;
   the file watcher.
5. **Several tabs**: the sidebar, the Undo view, the field panel and the keys
   follow the scene in front; a script tab per scene; what arrives opens a tab.

**Done when** two scenes are open side by side, each with its own undo, tree,
variables and script tab; a reload brings both back, unsaved changes included;
an engine crash brings both back; and a variant saved in the sidebar is used
from a notebook's dropdown and survives a save and a run of its script. Then
this plan goes: its decisions become records, and its as-built facts are in
architecture.md.

## 8. To check before building

- **Untitled custom documents**: New Scene's `untitled:` tab, and its first save
  through `saveCustomDocumentAs`, on VS Code 1.95, the floor.
- **A diff in Source Control**: with the studio the default for `.magpy.json`,
  does a diff open two studio views (two sessions, one of them on a `git:` URI)
  or the text diff? The text diff is the one wanted.
- **WebGL contexts**: each tab keeps its context while hidden
  (`retainContextWhenHidden`, for the camera). The browser drops the oldest
  somewhere past sixteen, and the widget's pool of eight is per page, so it does
  not span tabs. How many tabs before a hidden one comes back blank?
- **Hot exit**: two scenes with unsaved changes, a reload; both come back
  unsaved, from VS Code's backups.

## 9. Rejected

- **A container format**, a file of scenes (decided 2026-10-11): a folder is
  what Godot, notebooks and VS Code use, `plans/instancing.md` puts a definition
  in its own file, and one scene per file is one diff per scene.
- **A `CustomTextEditorProvider`**: §4.
- **A process per scene**: 95 MB and 0.3 s each, for an isolation the serial
  loop already gives between calls. A long job's isolation is V3's worker.
- **VS Code's undo stack** (decided 2026-10-11): the Undo view's jumps, the
  rollback bar and the cap of 100 snapshots would each have to be mirrored into
  a stack VS Code keeps.
- **Variants as files**: a value set saved as a file copies the whole scene with
  it, and the two drift apart with the first edit.
- **A stored active variant that slider edits are written into**, as CAD
  configurations do: sliders with a mode, and where an edit lands a matter of
  state. `variables` stays the one answer to what the scene is now.
- **Formulas in a variant**: a variant that put a number in `stagger`'s place
  would undo a definition every time it was used.

## 10. Open

Nothing yet. The widget's question (a save button, or the dropdown alone) is
answered in §6.4: the toggles alone, and `view.save_variant` from a cell.
