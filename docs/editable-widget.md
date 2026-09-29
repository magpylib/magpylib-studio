# Editable widget — plan

**Status: plan, nothing built.** Tracked in [TASKS.md](../TASKS.md) as W1.
Written after the panel's widget (#16), to be edited in place as decisions land.
Where a decision is made, the rejected alternative is recorded with it (§8).

---

## 1. The goal

Edit a scene in a notebook the way the studio edits one in VS Code, with nothing
installed but the Python package:

```python
import magpylib_studio

studio = magpylib_studio.edit(magnet, sensor)  # or a script path, or a .magpy.json
studio  # the widget, with move and rotate handles

studio.objects  # live magpylib objects, by id, as edited
studio.to_script()  # what was done, as code
studio.undo()
studio.save("scene.magpy.json")  # opens in the VS Code studio too
```

**The first slice:** move and rotate with the handles, undo and redo,
`to_script`, in Jupyter (Lab, Notebook, VS Code notebooks) and marimo. Other
anywidget hosts should work but are not a target.

Without a kernel (a saved page, a docs page, the page a script opens), the
widget stays read-only, as it is today.

## 2. The constraint: the package alone

It has to work with `pip install "magpylib-studio[widget]"` and no VS Code
extension, and it must not depend on the extension. Nothing in the plan needs
the extension at run time:

- **The engine is plain Python.** `session.py`, `importer.py` and `rpc.py`
  depend on magpylib, plotly, numpy and scipy. The extension only starts it as
  `python -m magpylib_studio` and talks to it over stdio. In a notebook, the
  kernel holds it instead.
- **The view ships in the package.** `magpylib_studio/static/widget.js` is
  committed and goes into the wheel, with the renderer (`scene3d.mjs`) bundled
  in by `tools/build-widget.sh`. Installing needs no node.
- **The read-only widget already works this way** in JupyterLab and marimo.

"Shared" in this plan means shared source files in this repository, bundled at
build time. To keep the dependency one way (the extension uses the package,
never the reverse):

- New JavaScript both sides use lives in `magpylib_studio/static/`, and the
  extension copies it, as `harness/copy-widget.js` already copies `widget.js`.
  (`scene3d.mjs` still lives in `vscode-extension/media/`. Moving it to the
  package too would finish the job, but is a separate cleanup.)
- A CI job installs the built wheel alone, in a fresh environment with no node
  and no `vscode-extension/`, and runs an edit through a fake kernel connection.
  That catches a hidden dependency the day it appears.

## 3. What already exists

- **The session owns a scene** (`MagpylibStudioSession`): it builds the objects
  from a document, records edits as events, groups a drag into one undo step
  (`begin_interaction` / `end_interaction`), undoes and redoes, and writes the
  scene back as code (`to_script`).
- **Imports:** `importer.document_from_objects(objects, namespace)` turns live
  objects into a document; `load_script` and `load_scene` take a script or a
  `.magpy.json`.
- **Transport:** `rpc.handle(session, request)` dispatches one request dict to
  the session, restricted to `rpc._PUBLIC`. Nothing in it is stdio-specific.
- **The renderer has the handles.** `scene3d.mjs` dispatches `objectpick`,
  `dragstart` and `objecttransform` (with `preview` and `edits`) on its host
  element. Plain DOM events, nothing VS Code-specific. The widget turns the
  handles off (`api.setGizmoMode("none")` in `widget.mjs`).
- **The drag glue is split across two places today:**
  - `vscode-extension/media/studio.js` (webview): the `dragstart` and
    `objecttransform` listeners, preview pacing (`sendPose`: one pose in flight,
    the newest waiting wins), `redrawAroundDrag` with its 8 ms budget
    (`REDRAW_BUDGET_MS`), the pose readout (`showPose`), handle modes
    (`applyGizmo`).
  - `vscode-extension/src/extension.ts` (host): `beginDragFromPanel` (opens the
    undo group), `transformFromPanel` and `callsFor` (edits to `set_transform` /
    `set_param` calls, batched when several objects move), `finishDrag` (closes
    the group).

## 4. Design

1. **The session in the kernel owns the objects.** `edit(...)` builds a
   `MagpylibStudioSession`: from objects through `document_from_objects`, with
   the caller's globals as the namespace (for variable names); from a path
   through `load_script` or `load_scene`. `StudioWidget` is a `SceneWidget` that
   holds it. Its payload is `session.get_scene()` and its legend is
   `session.list_objects()`, nested by the `parent` links. Ids are the session's
   (`"cube"`), so selection and hiding use them too.
2. **Transport: `rpc.handle` over the widget's kernel connection.** The view
   sends `{kind: "rpc", id, method, params}`; Python answers
   `{kind: "rpc", id, result}` or `{..., error}`. The widget allows a short list
   of its own: `begin_interaction`, `end_interaction`, `apply_edits`, `undo`,
   `redo`, `get_scene`. Nothing that runs a file (`load_script`,
   `apply_script`): the view does not need them.
3. **Edits become calls in Python, once.** `callsFor` and `transformFromPanel`
   move into the session as `apply_edits(edits)`, with the same batching (one
   undo step for several objects). The VS Code host calls it too, so there is
   one copy instead of two.
4. **The drag glue is one module:** `magpylib_studio/static/drag.mjs`, taken out
   of `studio.js`. It opens the undo group on `dragstart`, paces previews, sends
   the final pose through `apply_edits` and closes the group, redraws around the
   drag within the budget, and shows the pose readout. It is handed an
   `rpc(method, params)` function and a `render(payload)`: the panel passes its
   webview messages, the widget its kernel connection. `studio.js` is loaded as
   a plain script, so either it becomes a module or the glue hangs on `window`
   as `scene3d` does.
5. **The widget, when editable** (a trait; false for saved pages and for the
   read-only backend): handles on, move and rotate modes with the panel's keys,
   undo and redo buttons and Cmd/Ctrl+Z. If Python does not answer an edit
   within 4 s, the view goes back to the last scene Python sent and says so,
   reusing the "No answer from Python" notice playback has.
6. **Notebook updates.** When a gesture ends, Python sets `payload` and `tree`
   and increments a `revision` trait, so in marimo the cells that read the
   widget re-run. Previews during a drag go as messages, never as traits, so
   nothing re-runs per frame. In Jupyter, `studio.objects` read in a later cell
   is simply current.
7. **Python API.** `studio.objects` by id, rebuilt after every edit: keep
   `studio`, not the objects. `studio.to_script()`, `undo()`, `redo()`,
   `save(path)` (a `.magpy.json`, from `to_dict`). `write_html` saves a
   read-only page.

**Not in the first slice:** resizing, aiming polarization, variables (later as
notebook sliders calling `set_variable`, the parameter binding of
`docs/direction.md` §5.3), and anything like the Scene tree, Inspector or
Variables panel. Those are VS Code views; a widget equivalent would be built in
the widget, in the package, not ported from the extension.

## 5. Steps

Two pull requests: a refactor with no change in behaviour, then the feature.

**PR A — shared pieces, no behaviour change**

1. **Latency spike — done: go.** One drag over the kernel connection, measured
   in JupyterLab and marimo against the panel's stdio; the numbers are in §7.
   The spike's code is throwaway and was not committed.
2. `session.apply_edits`; the VS Code host switches to it. Existing tests pass
   unchanged.
3. `drag.mjs` out of `studio.js`, in `magpylib_studio/static/`, copied into the
   extension; the panel uses it. `npm test` and the harness pass unchanged.

**PR B — the editable widget**

4. `StudioWidget` and `edit()`: the RPC over the connection, the allowed list,
   handles, undo and redo, the no-answer fallback.
5. The `revision` trait, and example cells for Jupyter and marimo.
6. Tests (§6), and the wheel-only CI job (§2).

## 6. Tests

- **Python:** RPC over the connection (a fake comm); one drag is one undo step;
  `to_script` after a move; the allowed list refuses `load_script`; `write_html`
  of an editable widget is read-only; `edit()` from objects, a script and a
  `.magpy.json`.
- **Browser harness:** a page whose fake kernel answers from a canned session. A
  drag sends `begin_interaction`, previews, `apply_edits`, `end_interaction`, in
  that order; with no answer, the view goes back and says so.
- **Wheel only:** §2.

## 7. Risks and open questions

- **Round trip — measured (step 1), and not the transport.** One drag frame is a
  pose sent (`set_transform`), then the scene asked for again (`get_scene`), as
  the panel's `redrawAroundDrag` does. Median per frame, 20 frames, a grid of
  cuboid magnets, on an Apple M4 Pro (JupyterLab 4.6.4, marimo 0.24.0, anywidget
  0.11.0), from a throwaway widget answering through `rpc.handle`:

  | magnets | stdio (the panel) | JupyterLab | marimo | scene sent |
  | ------- | ----------------- | ---------- | ------ | ---------- |
  | 2       | 0.9 ms            | 4.1 ms     | 3.4 ms | 5 KB       |
  | 100     | 21 ms             | 27 ms      | 102 ms | 53 KB      |
  | 1000    | 309 ms            | 341 ms     | 475 ms | 513 KB     |

  JupyterLab's connection adds 1–3 ms a call, up to about 9 ms for a 513 KB
  scene: the engine's own time dominates, as it does in the panel. At 1000
  magnets that is three frames a second either way, so the fallback below is
  worth having in both, and so is cutting what a pose costs the engine
  (`set_transform` alone is 114 ms there: a rebuild of the scene).

  Fallback: move only the dragged objects in the view (the renderer already
  does, on its rig) and redraw the rest when the gesture ends. Also one call per
  frame instead of two, for a small saving.

- **marimo adds 60–85 ms to a slow call.** A call that takes Python more than
  about 20 ms came back 60–85 ms later than Python finished (100 magnets:
  `get_scene` 95 ms against 24 ms in Python); fast calls add about 1 ms.
  Measured once; the cause is not known. Small scenes are unaffected; a
  100-magnet drag is about 10 frames a second in marimo against 38 in
  JupyterLab. Look into it when the marimo step comes.
- **marimo re-runs.** The cell that calls `edit()` must not read the widget's
  value, or every edit rebuilds the session. The examples show the pattern.
- **Flattened imports.** Live objects built in loops or helpers are flattened,
  with warnings (the "built without a variable of their own" message). Show them
  once, in the cell's output.
- **Keyboard.** Cmd/Ctrl+Z reaches the widget only when it has focus; otherwise
  it is the notebook's own undo.
- **Hiding.** The widget's eye is view-only today; the session has
  `set_visible`. Keep it view-only in the slice, and decide later whether hiding
  is an edit.
- **Scripts.** A script's page has no Python behind it once the script exits, so
  it stays read-only. A small local server in the package that keeps a session
  alive would change that; not planned.

## 8. Decided against

- **Let the widget move the live objects in place.** Quick, but a notebook's
  objects belong to the cell's code: the edit is lost the next time the cell
  runs (in marimo, on every slider drag), and the code stops describing what is
  on screen. Edits need an owner that keeps them, which is the session.
- **Port the host's drag logic to JavaScript for the widget.** A second copy of
  `callsFor` and its batching, to drift from the first. Moving it into the
  session gives both sides one copy in the place both can reach.
- **Start the engine as a subprocess from the widget**, as the extension does.
  The kernel is already Python; a second process adds a transport and a
  lifecycle for nothing.
- **Expose all of `rpc._PUBLIC` to the view.** The kernel's user can run
  anything already, but the view has no need for methods that execute files, and
  a short list is easier to reason about.
- **Previews as traits.** Every preview frame would re-run marimo's dependent
  cells and sync state per frame in Jupyter.
