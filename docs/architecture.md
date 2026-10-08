# How it works inside

_For contributors and for anyone driving the engine from another frontend. Using
the studio needs none of this; see the [README](../README.md). This is the one
description of the system as it is: when it and the code disagree, one of them
is wrong and gets fixed. Why it is this way is in [decisions.md](decisions.md);
what is next is in [roadmap.md](roadmap.md)._

## The parts

| Part                   | Where                                             | What it is                                                                                                                                 |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| the engine             | `magpylib_studio/session.py`                      | `MagpylibStudioSession`: the document, the build, and every operation the GUI, the widget, the builder and the RPC call                    |
| the builder            | `magpylib_studio/build.py`                        | `Scene`: a studio document written as code, with variables that stay variables; `to_builder_script` lives beside it                        |
| expressions            | `magpylib_studio/expressions.py`                  | the hermetic expression language of the document                                                                                           |
| units                  | `magpylib_studio/units.py`                        | unit kinds, the shown units, reading `15 mm`                                                                                               |
| meshes                 | `magpylib_studio/meshes.py`                       | STL reader, hulls, superquadrics, validity checks, the resolved-mesh cache                                                                 |
| import                 | `magpylib_studio/importer.py`                     | `load_script` (run a script, intercept `show()`), `document_from_objects`                                                                  |
| transport              | `magpylib_studio/rpc.py`, `__main__.py`           | one JSON object per line on stdio; `rpc.handle` is what the widget's connection calls too                                                  |
| drawing                | `backend.py`, `viewer.py`, `plotly_view.py`       | `magpy.show(backend="studio" \| "widget")`, where a script's figure goes, the plotly figure                                                |
| the 3D view's data     | `magpylib_studio/threejs.py`                      | the scene payload the renderer draws (NaN sent as `null`, restored in the view)                                                            |
| the notebook widget    | `magpylib_studio/widget.py`, `static/`            | `SceneWidget`, an anywidget; `static/widget.js` is the committed bundle of the renderer, `legend.mjs` and `drag.mjs`                       |
| magpylib compatibility | `magpylib_studio/style_compat.py`                 | the style operations on released magpylib ([0016](decisions.md#0016-released-magpylib-through-a-shim-until-the-release))                   |
| the agent skill        | `magpylib_studio/.agents/skills/magpylib-studio/` | `SKILL.md` and a reference generated from the builder's docstrings, shipped in the wheel                                                   |
| the VS Code extension  | `vscode-extension/`                               | `src/extension.ts` the host, `engineClient.ts` the RPC client, one `.ts` per sidebar view, `media/` the webview scripts, `harness/` checks |
| the renderer           | `vscode-extension/media/scene3d.mjs`              | three.js; one node per studio id; handles; the keys table both hosts use                                                                   |
| tools                  | `tools/`                                          | `build-widget.sh`, `check-package-alone.py`, `write-skill-reference.py`, `replay-magpylib-docs.py`                                         |
| the agent evaluation   | `evals/`                                          | tasks with checkable targets, a runner for Claude Code headless, results kept in git                                                       |
| tests                  | `tests/`, `vscode-extension/src/test/`            | the engine suite (against both magpylibs), the extension suite in a real Extension Development Host, browser checks of the widget          |

## The engine and magpylib's versions

`pip install magpylib-studio` is enough: the engine works with **released
magpylib** (≥ 5.2). [magpylib's main][branch], not yet released, adds a
first-class style API, path-valued physics properties
(`current=[100, 200, 300]`), the display-backend API the 3D view draws through,
and `Panel.objects`, which gives a bare `magpy.show()` a legend:

```sh
pip install "magpylib @ git+https://github.com/magpylib/magpylib@main"
```

`style_compat.py` detects which one you have and reproduces the four style
operations the engine needs from `style.update()` / `style.as_dict()`, with a
generated copy of main's JSON Schema (`style_schemas.json`) so the inspector
keeps real widgets. The test suite runs against both. Without the
display-backend API the 3D view is not available and the studio draws the plotly
figure. One difference is silent: on 5.2.3
`show(backend="plotly", plotly_renderer=...)` drops the argument, which is why
`viewer.draw_here()` sets plotly's own default renderer instead.

[branch]: https://github.com/magpylib/magpylib/tree/main

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
  step.
- Variables: hard bounds and `integer` are enforced in the fold, so they hold
  however a value arrived; renaming rewrites expressions through the AST;
  `sweep` re-folds once per value and records nothing.
- Units: every operation that shows a value says how it is `shown`; `quantity`
  and `read_values` read what is typed, `15 mm` or `1.5 cm`, in decimal.

## Writing a scene in code

`magpylib_studio.build.Scene` is magpylib's spelling over the session
([0006](decisions.md#0006-a-scene-written-in-code-records-through-the-session)):
`s.variable(...)` returns a handle, arithmetic on it writes an expression, and
anything that needs the value now raises at its line. Every call goes through
the session operation the panel uses and raises `BuildError` with the session's
message. A create is recorded lazily, when the object first enters the scene.
`s.sampled` writes a formula for a run of points; `Scene(values=path)` takes a
saved scene's slider values as the variables' values. `s.session` is the session
underneath, for `get_field` and `sweep`.

Three ways between code and the document, none of which parses code
([0004](decisions.md#0004-script-generation-is-one-way)):

- `to_script()` writes plain magpylib, for anyone, patterns as loops, folding
  the log in order. An export: it loses `variable_bounds` and `visible`.
- `to_builder_script()` writes the scene as builder code, one call per step,
  which run builds the same document. The script tab shows it, and a deliberate
  save applies it as one undo step
  ([0007](decisions.md#0007-the-script-tab-is-builder-code)).
- `load_script(path)` runs any script with `show()` intercepted. A builder
  script opens as the scene it built, whole; plain magpylib opens as its
  objects, and the import names the variables it turned into numbers.

The builder's spelling is proposed to change to a plain magpylib function
recorded through a hook in magpylib: [plans/recording.md](plans/recording.md).

## The views

**The 3D view** is `scene3d.mjs`, three.js, one node per studio id, drawn from
`threejs.py`'s payload (`get_scene`). It picks, multi-selects, drags with
handles (move, turn, resize, aim a polarization; world or object axes; one-axis
locks; snapping), hides, plays paths, and has one keys table both hosts use. A
drag goes through `static/drag.mjs`: open an undo group, pace previews with one
request in flight, send the final pose through `apply_edits`, close the group.
`apply_edits` turns the view's edits into `set_transform` / `set_param` calls in
the session, batched into one undo step, for every host.

**The notebook widget**, `SceneWidget`
([0010](decisions.md#0010-the-notebook-widget-edits-with-the-package-alone)), is
that renderer as an anywidget with a legend that nests the objects, tools,
export to one HTML file (`write_html`) and PNG. `editable=True` puts a session
in the kernel: the view calls `rpc.handle` over its connection, restricted to a
short allow-list, the objects are copied into the session rather than edited in
place, and a `revision` trait and `last_edit` fire once per settled edit, never
per preview frame. `variable_sliders()` is a control per variable. The bundle
`static/widget.js` is committed so installing needs no node;
`npm run check:widget` fails when it no longer matches its sources, and a CI job
installs the wheel alone and runs an edit through a fake connection.

**The studio panel draws the widget** ([0011](decisions.md#0011-one-view)):
`media/studioView.mjs` holds a model (`payload`, the engine's `object_tree`,
`selected`, `hidden`) and an editor that sends the drag's messages to the
extension host, which refreshes the tree, the Inspector, the field view, the
history and the script tab, and marks the scene unsaved. In the studio hiding is
an edit; in a notebook a view setting; the model decides. Chart mode swaps in
the read-only plotly figure.

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
then `python3`; **Install the Engine** sets one up) and holds one session, one
panel and one scene file. The sidebar: the Scene tree (objects nested as
grouped, with each object's steps under it, drag and drop to reparent, rename,
copy, cut, paste, delete, hide), the Inspector (a webview whose widgets are
built from the style schema; properties and pose take expressions, shown in the
scene's units), the Variables view (a webview, because a tree row cannot hold a
slider), the Undo view, and the Field panel on demand. The script tab is a real
file in extension storage holding `to_builder_script()`, regenerated on every
edit unless it is dirty or holds refused text, and restored across a window
reload against the scene the engine has _now_. Scenes are files: save, Save As
with mesh paths rebased, revert, a crash backup, reopen on activation; only
`broadcastMutation()` marks the scene unsaved, redrawing does not.

Webview JavaScript lives in `media/*.js|mjs` under a nonce CSP, never inside
TypeScript template literals; `harness/` checks that, the message contract, the
declared commands and menus, the scene bounds, and runs a panel's real script
against a real engine (`npm run inspect -- halbach`). All of it runs in
`npm run compile`. `npm test` runs the integration tests in a real Extension
Development Host. The 24 language-model tools for Copilot Chat were removed
([0009](decisions.md#0009-agents-write-builder-code-through-a-skill)); agents
reach the studio through builder code and the skill.

## Agents

An agent writes a builder script, runs it with plain Python, reads the field
through `s.session`, and hands the person the script or the saved `.magpy.json`,
which the studio opens whole. The skill teaches that and what each refusal
means; its reference is generated from the docstrings and tested, and every
example in it is run by the tests. `evals/` measures the same tasks with and
without studio (`evals/README.md`).

## JSON-RPC protocol (stdio)

The host spawns `python -m magpylib_studio` and exchanges one JSON object per
line — no ports, no framework.

```
-> {"id": 1, "method": "get_schema", "params": {"object_id": "cube"}}
<- {"id": 1, "result": { ...JSON Schema... }}
<- {"id": 2, "error": {"type": "KeyError", "message": "..."}}
```

| group     | methods                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| inspect   | `list_objects` · `object_tree` · `get_schema` · `get_values` (style) · `get_params` (physics) · `get_transform` · `get_history` · `inspect_mesh`                                                                                                                                                      |
| structure | `add_object` · `remove_object` · `copy_object` · `move_object` (reparent) · `set_visible`                                                                                                                                                                                                             |
| edit      | `apply_edit` (style) · `set_param` · `reset_style` · `apply_edits` / `apply_calls` (what a view's drag sends) · `begin_interaction` · `end_interaction`                                                                                                                                               |
| transform | `move` · `rotate` · `set_transform` · `clear_path` · `set_pixel_grid`                                                                                                                                                                                                                                 |
| patterns  | `duplicate_around` (circular) · `duplicate_along` (linear; twice = a grid) · `mirror`                                                                                                                                                                                                                 |
| variables | `get_variables` · `set_variable` · `set_variable_bounds` · `set_variable_unit` · `set_model_unit` · `set_field_unit` · `get_units` · `quantity` · `read_values` · `field_units` · `unit_kinds` · `rename_variable` · `remove_variable` · `unknown_variables` · `expression_help` · `check_expression` |
| history   | `get_events` · `edit_event` · `move_event` · `remove_event` · `set_rollback`                                                                                                                                                                                                                          |
| view      | `get_scene` (3D payload) · `get_figure` (plotly) · `get_field_figure` · `get_field_map` · `get_sweep_figure`                                                                                                                                                                                          |
| field     | `get_field` · `sweep`                                                                                                                                                                                                                                                                                 |
| undo      | `undo` · `redo` · `goto_history`                                                                                                                                                                                                                                                                      |
| I/O       | `load_scene` · `set_base_dir` · `load_script` · `load_captured` · `apply_builder_script` · `list_examples` · `load_example` · `clear_scene` · `to_dict` · `to_script` · `to_builder_script`                                                                                                           |
| bulk      | `batch` — many mutating ops in one call, one undo step                                                                                                                                                                                                                                                |

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
