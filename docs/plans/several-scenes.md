# Several scenes — design

**Status: proposed, revised 2026-10-11 after an adversarial review.** Roadmap
R9, taken up ahead of R7. Decided with Alex that day:

- a project is a folder of scene files, with no container format;
- undo stays the studio's own;
- the side bar's tree holds every open scene;
- objects copy and drag across scenes in this step: a drag copies, Cut and Paste
  moves, and a pasted copy keeps its own variables, never sharing one;
- VS Code 1.109 is the floor;
- a file changed on disk comes into a tab as one undo step, unsaved edits or
  not;
- the order of §7: a prototype first, the tabs and the tree as one release;
- variants come in this step: built (#32), recorded in
  [0026](../decisions.md#0026-variants-are-named-value-sets-inside-a-scene);
- the studio keeps a recovery copy of each open scene, since VS Code's own
  restore after a crash misses recent edits (§4).

The prototype of §7 step 0 ran the same day on VS Code 1.109, 1.131 and 1.141;
§8 is what it found. The rest is not built.

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

- **A scene is a file**, `.magpy.json`, and **a project is the folder** that
  holds them. Several projects are several windows or a multi-root workspace.
- **A tab per scene**: the studio as a custom editor for `*.magpy.json`.
- **The side bar holds every open scene**: the tree lists them, each with its
  objects; the Variables, the Inspector and the Undo view show the scene in
  front.
- **One engine, a session per open scene**, every request naming its session;
  scripts run outside it.
- **Objects copy across scenes**, their variables with them.
- **Variants** name sets of values inside a scene (built, 0026).

## 3. The engine: a session per scene

**Every request names its session**, beside the method:

```
-> {"id": 7, "session": "4f2a9c", "method": "set_variable", "params": {"name": "gap", "value": 0.002}}
```

- `open_session(session, scene?, path?)` opens a session and loads it in the
  same call, from a document or a path, and refuses a name already open;
  `close_session(session)` drops it. Names are random and never reused, across
  engine restarts too, so a stale reference can only miss.
- **No default once a session is open.** A request without `session` goes to a
  default session only on a connection that never opened one -- the "Try it"
  example in architecture.md, a host that drives one scene. After an
  `open_session` it is refused, so a call the refactor misses fails loudly
  instead of reading or writing an empty scene.
- **The engine says its protocol.** `version` answers the package version, a
  protocol number and `DOC_VERSION`; the extension checks a range and refuses an
  engine outside it, offering Install the Engine. An engine from before this
  ignores `session`, and would serve every tab from one session without a word.
- **Every message the engine sends names its session**: R3 step 2's "the scene
  changed", V3's jobs.

**Sessions are cheap; what they hold is not.** Measured: an engine process is 95
MB resident (72 MB footprint) and 0.25 s to start, nearly all of it
`import magpylib`; another session adds well under 1 MB and a few milliseconds.
What grows is per session: up to 100 undo snapshots of its document, and its
meshes. The mesh cache becomes one per process -- its keys are content hashes
already -- so a part used in two scenes, or copied across, resolves once.

**Code runs outside it.** A script -- `load_script`, the script tab's save, R3's
runs -- runs in a short-lived child process (0.25 s to start), in the scene's
folder, with that root's interpreter, and hands back a document. One that calls
`os._exit`, loops for ever or sets `magpy.defaults` then takes nothing down with
it; today it takes every open scene. This is V3's worker, built for scripts
first. A watchdog and a Restart Engine command bring every scene back (§4) when
a call hangs.

**One queue still.** A long call in one scene (a 16 s mesh reorientation) holds
every tab until it returns. Moving such calls off the queue is V3's.

**Across sessions**, `export_object` and `import_fragment` (§5.1) are session
calls, and the extension carries what one returns to the other.

**R3 step 2 names its scene.** A run names a file or a session; with neither it
goes to the scene in front, which the extension tells the engine (`set_front`);
with no scene in front it is refused.

## 4. The custom editor

**A `CustomEditorProvider`, the engine owning the document**, registered for
`*.magpy.json` as the default editor, with `retainContextWhenHidden` given at
registration (a custom editor takes it nowhere else). The document is the saved
file, `to_dict()` verbatim
([0013](../decisions.md#0013-the-saved-file-is-the-document)), and undo is the
session's ([0005](../decisions.md#0005-undo-is-snapshots)); a
`CustomTextEditorProvider` would make VS Code's text model a second owner, each
settled drag a whole-file text edit and two undo stacks to keep in step.

**VS Code 1.109 is the floor** (decided). Before it, Save As and an untitled
scene's first save leave the old tab dirty, and closing it asks to save what was
just saved (microsoft/vscode#286325). The typings are pinned to the floor, and
`npm test` runs on it as well as on stable.

**Each scene is live, restoring or lost.**

- **Live**: the engine holds its session, and the extension holds its last
  settled document, fetched where `broadcastMutation` runs now (0.7 ms for a
  400-object scene).
- **Restoring**: after an engine restart, until its session is back.
- **Lost**: its restore failed. Save, Save As and backup throw, so VS Code keeps
  the tab dirty and its last backup; the tab offers Try Again and Open as JSON.
  Nothing writes an empty scene over a file.

**Edits and replacements.** An edit fires `CustomDocumentContentChangeEvent` and
moves the scene's revision. A replacement -- opening, a revert, a file changed
on disk, a crash restore -- fires nothing. A save notes the revision before it
writes; if an edit moved it meanwhile, the event fires again once the save has
returned, since VS Code clears the dot when the save resolves. A scene loaded
into an untitled tab -- an import, a script's drawing -- starts dirty, so it is
backed up and asked about; an empty New Scene starts clean, and so does an
example: the session opens on it (`open_session(example=...)`), so there is
nothing to undo, and its preview tab is the next example's to take. VS Code
keeps no backup of a clean tab, so the example each untouched tab holds is kept
in workspace state by the tab's untitled name and loaded again when the tab
comes back; the first edit pins the tab, which VS Code does for a dirty one,
and forgets the name.

| VS Code calls                                                 | the provider                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openCustomDocument(uri, { backupId, untitledDocumentData })` | never throws: a document that cannot load holds why, and its tab says so with Retry, Install the Engine and Reopen as Text. A `git:` or other non-file URI is read with `workspace.fs`, shown read-only, and kept out of the tree |
| `resolveCustomEditor(document, panel)`                        | what `adoptStudioPanel` does now. A document holds a set of panels: a Source Control diff opens a second one on the open document                                                                                                 |
| `saveCustomDocument`                                          | checks the file first. Unchanged since this tab read or wrote it, it writes the last settled document; changed, it asks: Overwrite, Load the File's Version, Compare                                                              |
| `saveCustomDocumentAs(destination)`                           | writes a rebased copy to the destination, the live session untouched, and records destination → session                                                                                                                           |
| `revertCustomDocument`                                        | replaces the scene with the file's, as one undo step                                                                                                                                                                              |
| `backupCustomDocument(destination)`                           | writes the last settled document                                                                                                                                                                                                  |

**Save As hands the session over.** VS Code disposes the old document, then
opens one for the new file with a new panel, its tab clean (§8).
`openCustomDocument(destination)` adopts the session recorded for it instead of
loading -- its undo, its selection, its camera -- and rebases its mesh paths, in
the undo snapshots too. The old document's dispose does not close a session it
handed on; one that no document adopts within ten seconds, saved under a name
the studio does not open, closes. A rename or a move in the Explorer is the
same, through `onWillRenameFiles`, with one step more: VS Code drops the old
tab's unsaved edits and opens the new one clean, so a session that arrives with
unsaved edits fires its change event again for the dot. An untitled scene's
first save is a Save As. New Scene opens an `untitled:` URI with a path in the
workspace folder, where the save dialog then starts; without a path it starts at
the root of the disk. Save As onto a scene open in another tab is refused.

**A file changed on disk** comes in as one undo step labelled "changed on disk",
whether the tab has unsaved edits or not (decided): what it had is one undo
away, and a notice says so. The watcher ignores a write whose bytes are the ones
this tab last wrote or read, lets a burst of events settle (git deletes then
creates), and marks a deleted file without loading anything. A file that does
not load -- conflict markers, a newer format -- marks the tab "changed on disk,
not loaded", and refuses its saves until Load or Overwrite. A document identical
to the scene records nothing.

**Revert** is VS Code's, which asks nothing and does not wait for the provider:
it replaces the scene as one undo step, so it can be undone. The studio's own
Revert buttons keep their question.

**Auto-save** (`files.autoSave`) saves through `saveCustomDocument` and never
backs up; with `onFocusChange`, a click into the side bar writes the file. The
guide says so, and the check before a save keeps another writer's file safe.

**Upgrading from one scene**: for one release a stub `magpylibStudio` serializer
disposes the old panel and opens the remembered scene as a tab, and the old
`SCENE_STATE_KEY` and `backup.magpy.json` open once as a dirty tab on the
remembered file.

**What goes**: `sceneFile` and `showSceneFile`; `SCENE_STATE_KEY` and
`restoreScene`, after the upgrade release; the reload half of the backup; the
panel's serializer. The module-level `sceneDirty` becomes each scene's.

**What stays the extension's: the engine's crash.** VS Code's backups are for
the window; the engine is our subprocess, and holds every open scene. A
restarted engine is given each scene's last settled document back, one at a
time, with a marker on disk naming the one restoring, so a scene whose restore
kills the engine is skipped next time and marked lost. A crash loses every tab's
undo history; the notice says so.

**A recovery copy of each scene** (decided 2026-10-11). After a crash of VS Code
itself, VS Code brings a scene's unsaved edits back only from the editor state
it saves about once a minute: edits made since come back as a clean tab, and a
scene opened since not at all, though its backup is on disk (§8). So each open
scene keeps its last settled document in extension storage, written a second
after an edit as `backup.magpy.json` is now, and removed on save, revert and
close. A document that opens without a backup while a newer copy of it waits
offers it back -- "Unsaved changes to ring.magpy.json from 14:02: Restore,
Discard" -- and the copies no tab claims are listed once the window has restored
its tabs.

**An extension-host restart** -- Restart Extension Host, or an extension's
update -- meets VS Code's own veto while any scene tab is open: the first asks
"Please confirm restart of extensions", the second is refused. After Restart
Anyway, VS Code hands no scene tab to the new extension host, and the engine has
gone with the old one (§8). On activation the studio closes and reopens each
scene tab VS Code has not handed over within a few seconds, from its recovery
copy when that is newer; whether a dead tab marked unsaved closes without asking
is step 3's to try.

## 5. The extension: every open scene in the tree

**One object per open scene**, the custom document, holds what is module-level
now: the uri, the session, its panels, the selection, the script tab, the
imported candidates, its state and revision, its last settled document. The
engine and the side bar's providers stay the window's.

**The tree holds every open scene** (decided), each a top-level node with its
objects under it, as Unity's Hierarchy shows the scenes it has loaded. Its
scenes come from the tabs (`window.tabGroups`, inputs of this view type), not
from the documents: after a reload VS Code loads a tab's document only when it
is shown, so a scene behind another tab is listed as unloaded and loads in its
own group when it is expanded or dropped on. A diff's tab is not a scene: on
1.109 a scene's diff is a tab whose input the API cannot read, and from 1.131 a
text diff. A scene opened from a file is pinned, so a single click on a second
scene in the Explorer does not close the first; Load Example opens as a preview,
replaced by the next until something is done in it. Rows are keyed by scene --
objects, steps and removed objects; a step row is `op-e1` today, which two
scenes would share. Scenes are listed in the order they opened; two of the same
name show their folder. An edit refreshes its scene's node and nothing else.

**The scene in front is the extension's own state**, set by any act on a scene:
focusing its tab, selecting its node, a menu command on its row, a drop or a
paste into it, focusing its script tab. It is not VS Code's active editor, which
may be a Python file, or the other scene when the two sit side by side --
revealing a tab without focus does not activate its group. It is published as a
context key, and its node is marked. The tree's selection is its selection: when
a scene comes in front, or its view picks something, the tree reveals and
selects it.

- **The Variables, the Inspector and the Undo view show it**, their titles
  naming it. Each is drawn for one session, and every call it makes carries that
  session, so a value committed by the click that switches scenes lands in the
  scene it was typed for.
- **Keys act on it.** Undo and Redo bind on the scene in front, with
  `!inputFocus` so a search box keeps its own. Save and Save As keep studio
  bindings while the focus is in the side bar, acting on the scene in front
  through `workspace.save(uri)` and `workspace.saveAs(uri)`; in an editor, VS
  Code's act on that editor, which the click put in front. VS Code cannot see a
  text box inside the view (§8): each of the studio's webviews says when one of
  its boxes has the focus, and the undo keys stand aside on
  `magpylib-studio.textFocus`, as they have since the fix that left the panel
  undoing the scene from a value field (media/textFocus.mjs). In a custom editor
  that is not enough: VS Code's undo then goes to the custom editor's, never to
  the box (§8), so while a box has the focus the studio's key asks the view to
  undo the box itself.
- **A scene's node carries its commands**: Add Object, New Collection, Save,
  Close, View Script and Field View, on hover and in its menu. The title bar
  keeps New Scene, Open Scene, Load Example, Collapse All, Undo and Redo. Revert
  on a node brings its tab forward first.
- **The field panel belongs to one scene**, its title naming it; Field View on
  another scene's node moves it there and drops a sweep made for the first.
- **Each scene has its script tab**: a file in extension storage named after the
  scene, in a folder keyed by a random id the document keeps through its backup
  and its Save As, so two `ring.magpy.json` from different folders never share
  one. Its save applies to its own scene. The live JSON
  (`magpylib-studio:/scene.json`) becomes one per scene the same way.
- **What arrives opens a tab.** Import Script, and Open in Studio on a script or
  on a script's drawing, open a new untitled scene, dirty, instead of replacing
  the one in front. A script with several `show()` calls opens its first; Switch
  Imported Scene switches that tab's, as one undo step.
- **With no scene open**, the tree's welcome offers New Scene, Open Scene, Load
  Example and Import Script; an empty scene's node holds one row, "Add an
  object…"; the walkthrough's first step opens or makes a scene.

### 5.1 Copying across scenes

Decided 2026-10-11, in this step.

**A copy is an ordinary scene document**, the part of `to_dict` that is the
object's: the live life of its subtree -- each object's last create and the
steps after it, in the log's order, with the parents they had then -- the
variables it uses through every formula, with their limits and units, and the
folder its mesh paths are relative to. It loads alone through `load_scene`, the
JSON Schema validates it, and on the system clipboard it pastes across windows.
`export_object(object_id)` writes one; `import_fragment(fragment, parent)`
merges one under a parent as one step to undo. A copy within a scene goes
through the same exporter.

- **The copy is the object it was.** Its world pose comes with it, as a copy
  within a scene keeps it since the review: what its groups did to it is one
  rigid step on the copy's root. (Before, halbach's `r2`, turned 18° by its
  ring, copied to (23, 0, 15) mm at 0° where it sits at (21.9, 7.1, 15) mm.)
- **Ids** are new in the target, none its log has used, live or removed, and
  `target`, `parent` and `children` are renamed together, as within a scene: one
  id names one object in a log, a removed object's id retired when reused.
- **Variables are never shared** (decided): the copy brings its own, renamed on
  any clash -- `radius` → `radius_2` -- in one pass, in dependency order, every
  formula rewritten. A later paste of the same reuses the twin it made
  (`radius_2` with the same definition and limits) rather than making
  `radius_3`. Only the variables the copy uses come; an expression set aside
  under a pinned value is dropped. The paste says what it did: "n → n_2, radius
  → radius_2". Unifying two on purpose is a Merge, later.
- **Steps that would point outside the copy** -- a reparent onto a group not
  copied -- are left out; a broken step is left out and named; a name the source
  does not define never binds to the target's.
- **A pattern's source** pasted at a scene's root is wrapped in a new Collection
  named after it, in the same step: a pattern needs a group, and every example's
  magnet is a pattern's source. A pattern's copy cannot be copied, as within a
  scene.
- **Mesh paths** are rebased from the source's folder to the target's.
- **Variants stay with their scene**: the copy's variables come in at their
  current values.
- **The clipboard holds a reference** -- the session, the object, its revision
  -- while the source is open, and the copy is exported at paste time, as within
  a scene today; when the source closes, the clipboard takes the copy then. A
  copy carries its `DOC_VERSION`.
- **A drag across scenes copies** (decided). The target comes in front, its tab
  forward and the copy selected, and the status bar says "Copied magnet to
  stator.magpy.json". A drop on empty space does nothing.
- **Cut and Paste moves**: the copy goes in, then the source's object is
  removed. Undoing the paste also undoes the removal while that is still the
  source's latest step; otherwise the status bar says to undo there. A cut whose
  scene has closed pastes as a copy, and says so.
- **In a notebook** copying across scenes is a function call
  (`import_fragment`), not a gesture: the widget is the view of one scene
  ([0022](../decisions.md#0022-what-the-widget-is-and-is-not)).

## 6. Variants

Built (#32): architecture.md says how they work,
[0026](../decisions.md#0026-variants-are-named-value-sets-inside-a-scene) why.
Left for this plan: in the VS Code side bar, save as a new variant, save over
the one in force, rename and delete, as the host's actions in the variables
panel, built in §7 step 3. Where variants go next -- R7's parametric table, R8's
values back as a variant, the field per variant, two variants side by side -- is
the roadmap's.

## 7. The order

Decided 2026-10-11. Each step lands with its changelog and architecture.md.

0. **A prototype, thrown away** -- done 2026-10-11, on VS Code 1.109, 1.131 and
   1.141; §8 is what it found. Scripted: Save As and an untitled first save, a
   dirty rename, reload, quit and crashes with unsaved scenes, auto-save against
   an outside write, Source Control diffs and merges, a split, twenty WebGL
   tabs. By hand: keys in the view and in a text box, and an extension-host
   restart with an unsaved scene.
1. **The engine's sessions** -- done 2026-10-11 (about ½ day): `serve`'s table,
   `open_session` that loads, `close_session`, `version`, random names, refusal
   without a session after an open, one mesh cache per process. Three engine
   fixes it rests on are made already, with this plan's revision: a copy's pose,
   an id reused after a removal, Save As then undo breaking mesh paths.
2. **Every view and request carries its scene** (1–2 days): a handle
   `{engine, session}` through the extension's forty-odd call sites and the side
   bar's views, each drawn for one session. Still one scene, the suite green,
   and nothing moved that step 3 deletes.
3. **Tabs, the tree of every open scene, and crash safety, as one release** --
   built 2026-10-12, its by-hand checks to do (5–7 days): the custom editor, its
   document as the per-scene object, the scene in front, the watcher, Save As's
   hand-over, the recovery copy, a box's own undo in the view, the upgrade, the
   variants' side bar actions. The first slice anyone sees, and the riskiest,
   which step 0 de-risks.
4. **Copying across scenes** (about 2 days), engine and interface together: the
   exporter, the import, paste and drag, the clipboard; a copy within a scene
   through the same exporter.
5. **Scripts outside the engine** (about 1 day), before any R3 step 2 work: the
   child process, the watchdog, Restart Engine.

**Done when**, each clause a check:

- the engine's tests (`tests/test_session.py`, and a new `tests/test_rpc.py`
  driving `serve`): two sessions, each with its own undo; a request without a
  session refused once one is open; a copy across sessions keeping its pose and
  bringing its variables renamed; Save As then undo keeping its mesh paths;
- `npm test`: two scene tabs in the tree; a drag from one node onto the other;
  the engine killed with two dirty scenes, both back; a script tab each; Save As
  keeping the undo history;
- by hand, in CONTRIBUTING's list: a reload with two unsaved scenes; VS Code
  killed a few seconds after an edit, the copy offered back; Cmd+Z in a value
  field; eight tabs' memory.

Then this plan goes: its decisions become records, and what it built is in
architecture.md.

## 8. What VS Code does, as the prototype found it

A throwaway custom editor, left in `sandbox/` and not kept, logged every call VS
Code made on 1.109 and 1.141, under the test runner and in windows it launched,
reloaded, quit and killed; 1.131 for diffs and merges. The versions behave alike
except where a point says.

- **Save As and an untitled scene's first save**: `saveCustomDocumentAs`, then
  the old panel and document disposed, then the destination opened from the file
  with a new panel, its tab clean. An untitled document without a path makes the
  save dialog start at the root of the disk.
- **A rename in the Explorer** (a `WorkspaceEdit`, as the Explorer makes it)
  discards the old tab's backup and unsaved edits, and opens the new name from
  the file, clean.
- **The dot**: a content-change event sets it; it clears when a save resolves,
  whatever arrived meanwhile, and at once on Revert, whose promise resolved
  within 4 ms while the provider took 300.
- **Auto-save** calls `saveCustomDocument` and never backs up. **A file written
  outside** reaches the provider not at all: no reload, and a save then writes
  over it unchecked.
- **Reload and quit** bring every tab back with its dot. A document opens only
  when its tab is shown, a dirty one from its backup, an untitled one too.
- **A crash of VS Code** (kill -9, an ordinary window): tabs come back as VS
  Code last saved its editor state, about once a minute. Edits made since come
  back as a clean tab opened from the file; a scene opened since does not come
  back, though its backup is on disk; on 1.109 a tab came back marked unsaved,
  opened empty. A window for extension development keeps no backups at all.
- **Diffs**: 1.109 opens the studio on both sides. A Source Control diff's left
  side is a `git:` URI that `workspace.fs` reads; a scene already open is
  reused, with a second panel; the diff's tab has no input the API can read. By
  1.131 a diff is text: `priority` takes `{ textEditor, diffEditor }`, and a
  diff stays text unless `diffEditor` opts in (microsoft/vscode#292379; the
  versions between were not tried).
- **Merges**: on 1.109 a conflicted scene opens nothing from Source Control's
  merge command, and says nothing; by 1.131 the text merge editor opens.
- **One editor per document** (`supportsMultipleEditorsPerDocument: false`):
  opening the scene into another group moves its tab there, the same panel, not
  resolved again; Split Editor opens an empty group beside it; revealing a tab
  without focus does not activate its group.
- **A rejected `openCustomDocument`** leaves its tab on VS Code's failure page.
- **An extension-host restart** is vetoed by every open scene, saved or not.
  Restart Extension Host asks "Please confirm restart of extensions"; an
  automatic restart, after an extension install, is refused (VS Code's source).
  After Restart Anyway the tabs stay, the unsaved one still marked, but VS Code
  hands none of them to the new extension host: no open, no backup, nothing when
  the window closes.
- **Keys in the view** reach the extension's bindings with the focus on the
  canvas, and with the focus in a text box inside the view too: `inputFocus`
  stays false there. Backspace then ran the binding and deleted a character as
  well; Cmd+Z, Cmd+C and Cmd+V ran the binding, and the box did nothing, VS
  Code's webview host having stopped its own handling. With no binding of the
  studio's, VS Code's own undo would not reach the box either: for a custom
  editor it goes to the custom editor's undo, ahead of the webview's (VS Code's
  source: priority 105 against 100), whenever one is the active editor.
- **Twenty tabs**, each holding a WebGL2 context, a 4 MB texture and a 4 MB
  buffer, with `retainContextWhenHidden` (given at registration, the only place
  a custom editor takes it): no context lost, all in the window's two or three
  renderer processes, 6 to 8 MB more per tab. The real view's cost is step 3's
  to measure.

## 9. Rejected

- **A container format**, a file of scenes (decided 2026-10-11): a folder is
  what Godot, notebooks and VS Code use, `plans/instancing.md` puts a definition
  in its own file, and one scene per file is one diff per scene.
- **A `CustomTextEditorProvider`**: §4.
- **A process per scene**: 95 MB and 0.25 s each, for an isolation that scripts
  need and documents do not; scripts run in a child process instead (§3).
- **VS Code's undo stack** (decided 2026-10-11): the Undo view's jumps, the
  rollback bar and the cap of 100 snapshots would each have to be mirrored into
  a stack VS Code keeps.
- **The side bar showing the tab in front only**, or a list of scenes above one
  tree (decided 2026-10-11): one scene at a time, where the person wants several
  side by side.
- **Every scene file in the workspace in the tree**: the Explorer lists files;
  the tree is for what is open, each node a live session.
- **A pasted copy following the target's variables**, or sharing one whose
  definition matches (decided 2026-10-11): it would move with the target's
  slider because the values happened to agree.
- **A drag across scenes moving**: an accidental drag would take an object out
  of its scene, undone only by two undos in two scenes.
- **Asking before taking a file changed on disk** (decided 2026-10-11): an
  agent's session would be a dialog per write, where one undo keeps the person's
  edits.
- **A floor of 1.95, or of 1.131** (decided 2026-10-11): below 1.109 Save As
  leaves the old tab dirty; 1.131, which keeps diffs as text, is too recent for
  the editors built on VS Code.
- **Moving the closure's state into a per-scene object first**, the old step 3:
  it moved code the custom editor then deletes.
- **`copy_across` in the engine**: the extension carries the copy for the
  clipboard anyway, and it would tie sessions to one process.
- **The field panel following the scene in front**: it carried one scene's sweep
  into another, and recomputed on every switch.

## 10. Open

- A Merge of two variables -- a rename onto an existing one, its uses repointed
  -- when someone asks for it.
- Whether a preview tab joins the tree (proposed: yes, marked as a preview).
