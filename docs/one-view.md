# One view — plan

**Status: built, and the checklist in §5 tried by hand in VS Code.** Tracked in
[TASKS.md](../TASKS.md) as W2. The follow-up to
[docs/editable-widget.md](editable-widget.md): the notebook widget edits now,
and the VS Code studio panel should be that same widget rather than a second
interface around the same renderer.

---

## 1. The problem

Three places draw a magpylib scene with the studio's renderer (`scene3d.mjs`):

| where                                       | around the renderer                        |
| ------------------------------------------- | ------------------------------------------ |
| a notebook cell                             | the widget (`widget.mjs`), over the kernel |
| VS Code's script panel (a script's figure)  | the widget, over a model the panel holds   |
| VS Code's studio panel (the scene you edit) | `studio.mjs` and the panel's own HTML      |

The first two are one interface. The studio panel is another: a status bar of
text buttons and dropdowns (Edit/Chart, "Drag to move", "along world axes", XYZ,
Snap, Persp), a ▶ and a slider, a key list, a status line, and a readout of
number boxes. The widget has an icon toolbar, the editing column, a play bar
over the view, a floating legend and notices.

What is shared already: the renderer, the view keys (`VIEW_KEYS`), the drag
gesture (`drag.mjs`), and what an edit becomes in the engine (`apply_edits`,
`apply_calls`). What is not: every control around them, and some logic twice —
the mode keys (`GIZMO_KEYS` / `HANDLE_KEYS`), `DRAG_WRITES`, axis locking and
snapping, playback. A fix or a new control has to be made twice, or the two
drift; they already have.

## 2. The goal

The studio panel draws the widget, as the script panel does. One set of controls
everywhere; `studio.mjs` and the panel's HTML controls are deleted. What the
studio panel can do that the widget cannot yet becomes the widget's, and so the
notebook's too, or stays a small part of the panel around the widget.

## 3. Design

1. **An editor seam in the widget.** The widget talks to _an editor_ —
   `begin(objectIds, mode)`, `preview(edits)`, `commit(edits)`, `scene()`,
   `undo()`, `redo()` — instead of calling the session's methods by name. In a
   notebook the editor is today's calls over the kernel connection. A host that
   has its own supplies it on the model (`model.editor`); the widget uses that
   when it is there. The widget stays unaware of VS Code.

2. **The studio's editor goes through the extension host, not straight to the
   engine.** The host already does what an edit in the studio needs besides the
   edit itself: it refreshes the Scene tree, the Inspector, the field view, the
   history and the script tab, marks the scene unsaved, writes the crash backup,
   and says when a drag takes a value away from a variable. So the studio editor
   sends what `studio.mjs` sends today — `dragStart`, `previewTransform`
   (settled by `previewDone`), `transformObjects`, `rpcRequest` for the scene,
   the undo and redo commands — and the host is unchanged.

3. **A model the studio panel holds** (`media/studioView.mjs`, replacing
   `studio.mjs`), as `scriptView.js` holds one for the script panel:
   - `payload`: `get_scene`, asked again on the host's `refresh`, newest wins,
     as `refreshPaced` does now.
   - `tree`: the engine's `object_tree`, which the notebook's widget uses too.
     The Scene tree is the studio's own legend, so the widget's starts closed
     there, one button away.
   - `selected`: a pick is `selectObject` to the host, and the host's `select`
     sets it — the sidebar and the view agree, as now.
   - `hidden`: in the studio, hiding is an edit (saved, undoable), not a view
     setting. What the eye, H and ⇧H change goes to the host as one `setVisible`
     message (what to hide, what to show), one step to undo; `hidden` is read
     from what the engine says is not visible, so a hidden object stays in the
     legend to be shown again.
   - frames: the widget's frame requests become `get_scene({frame})`.
   - `editable` on; `standalone` on (no kernel to export through).

4. **What the studio panel has and the widget lacks:**
   - _The typed readout_ — the numbers a drag is changing, as boxes that take a
     typed value. Into the widget, for the notebook too; a typed value goes
     through the editor like a release.
   - _The key list_ — a `?` button in the widget with the keys, for everyone.
   - _Chart mode_ (Plotly, read only) — stays the panel's: a small switch beside
     the widget, which hides it and draws the chart in its place, as the script
     panel draws a Plotly figure.
   - _The status line_ — the widget's notices, and VS Code's status bar for what
     the host says (as now).

5. **What goes:** `studio.mjs`; the panel's status bar and controls in
   `extension.ts`; `GIZMO_KEYS`, the second `DRAG_WRITES`, the second axis, snap
   and playback code.

## 4. Steps

One pull request, in commits that each leave everything working:

1. **Done.** The editor seam in `widget.mjs`, with the kernel's editor as the
   default. No change in behaviour: the editing browser checks and the real
   JupyterLab and marimo runs pass unchanged.
2. **Done.** The readout and the key list into the widget.
3. **Done.** The studio panel draws the widget: `studioView.mjs`, the panel's
   page, Chart mode in a bar beneath it. `studio.mjs` and the old controls
   deleted. The legend's tree is the engine's now (`object_tree`), for the panel
   and the notebook alike; hiding from the view is one host message
   (`setVisible`) for any number of objects, hidden or shown; the view's undo
   and redo buttons run the extension's commands, and Cmd+Z is left to its
   keybinding.
4. **Done.** Tests: the studio drag check (`studio-drag.html`) runs the widget
   with the studio's model and holds it to the same order of host messages as
   now; a check for selection, hiding and refresh through the host; the message
   check (`check-messages.js`) over the new file; `npm test`; and a checklist
   tried by hand in VS Code (§5).

## 5. Parity checklist, by hand in VS Code

What the studio panel does today, each to be seen working after step 3:

- a pick selects in the Scene tree and the Inspector; ⌘-click adds; the sidebar
  selecting moves the outline;
- a drag keeps the Inspector's numbers and the field view live, is one undo
  step, and says when it takes a value from a variable;
- a patterned source and a polarization aim redraw from the engine mid-drag; a
  dragged sensor shows its reading (#19);
- H hides and ⇧H isolates, as edits, shown again from the Scene tree or the
  legend;
- paths play and scrub; the typed readout takes a value; snap, one-axis drags,
  world/object axes, projection, framing and the view keys;
- Chart mode, with Animate; the theme follows VS Code's;
- the panel survives being hidden and restored, and a window reload.

## 6. Performance

Nothing on the path a drag takes changes: the same renderer, the same drag
gesture and pacing (`drag.mjs`), the same host messages and engine calls, the
same scene sent across. The engine's own time is what a big scene costs, in the
panel as in a notebook (`docs/editable-widget.md` §7).

What the widget adds around the renderer, measured before planning on it — a
redraw of a whole scene, median of five, headless Chrome with WebGL on the CPU
(so the times are slow, and the comparison is what counts):

| scene                                             | without legend | with legend |
| ------------------------------------------------- | -------------- | ----------- |
| the array example, 1000 cuboids as pattern copies | 486 ms         | 489 ms      |
| 1000 separate objects, 1000 legend rows           | 303 ms         | 261 ms      |

The legend is lost in the noise; drawing the meshes is the redraw. The widget
loads its renderer from a blob rather than as files, which the script panel
already does, once per panel.

Step 3 measured the panel before and after, from the host's `refresh` to the
scene drawn, median of five, same machine and conditions:

| scene                           | old panel  | new panel, first try | new panel |
| ------------------------------- | ---------- | -------------------- | --------- |
| the array example, 1000 cuboids | 468–527 ms | 529–593 ms           | 452 ms    |
| 1000 separate objects           | 330–350 ms | 398 ms               | 325 ms    |

The first try was slower, and not in the scene: drawing it took the same 23–27
ms in both. The rest was the browser putting the frame on screen, and the
widget's floating panels were blurred behind (`backdrop-filter`), which is
composited again on every frame the scene draws — cheap on a GPU, 15–20% of a
frame without one. The panels are nearly opaque now and not blurred, in the
notebook too, and the new panel is no slower than the old.

## 7. Risks

- **The studio panel is the extension's main surface.** Everything in §5 is in
  daily use, and most of it has no automated check. The checklist is the guard;
  the browser checks cover the message order and the model.
- **Hiding means two things.** In a notebook it is a view setting; in the studio
  an edit. The widget cannot tell them apart and should not have to: the model
  decides what the eye does.
- **One renderer per view.** The widget makes a renderer per view, from a blob;
  the studio panel has one view, so this costs nothing new there.
