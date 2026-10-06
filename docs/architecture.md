# How it works inside

_For contributors and for anyone driving the engine from another frontend. Using
the studio needs none of this; see the [README](../README.md)._

## The engine and magpylib's versions

`pip install magpylib-studio` is enough: the engine works with **released
magpylib** (≥ 5.2). [magpylib's main][branch], not yet released, adds a
first-class style API, path-valued physics properties
(`current=[100, 200, 300]`) and the display-backend API the editable 3D view is
built on:

```sh
pip install "magpylib @ git+https://github.com/magpylib/magpylib@main"
```

`magpylib_studio/style_compat.py` detects which one you have. On released
magpylib it reproduces the four style operations the engine needs from
`style.update()` / `style.as_dict()`, and falls back to a generated copy of the
main's JSON Schema (`style_schemas.json`) — the two style trees are the same
shape, so the inspector keeps real widgets (enum dropdowns, ranges, colour
pickers) either way. The test suite runs against both.

[branch]: https://github.com/magpylib/magpylib/tree/main

## Design decisions

- **The document is a log, and the object tree is a projection of it.**
  `doc["events"]` holds everything that built the scene — `create`, `remove`,
  `reparent`, the transforms and the patterns — and every build folds it from
  the start, so `doc["objects"]` is regenerated rather than stored. Strip it
  from a document and the log reconstructs the same scene, ids and field
  included. Editing an early event therefore re-applies everything after it for
  free; what it breaks is reported rather than blocking the edit.
- **What a thing _is_ is edited; what happened _to_ it is appended.** An
  object's type, parameters and style live on its `create` event and are changed
  in place — dragging a slider must not write history — while moves, rotations,
  removals and reparents go on the end. That one distinction is what keeps the
  log finite _and_ meaningful.
- **Transforms are recorded magpylib calls, not derived poses.** The log holds
  `move`, `rotate_from_angax`, … as they were made, so magpylib owns every
  semantic: paths, anchors, `start`, and group transforms carrying a subtree.
- **Scenes are parametric.** Any numeric value may be an expression over the
  document's variables (`"=360/n"`), evaluated from its AST against an
  allow-list — never `eval`, because a document is something you open from
  someone else. A variable is not always a quantity: one bounded by `options`
  holds a name (`"z"` for an axis), which gets a dropdown for the same reason
  min/max gets a slider, and is enforced the same way. `sweep()` re-folds the
  scene once per value of a variable, which is affordable because a rebuild is
  milliseconds.
- **A mesh is recorded as where it came from.** `TriangularMesh` is the one
  class whose parameters nobody types — fifty thousand numbers arrive from a CAD
  export — so a create event holds `mesh_source` (the file, its scale, a hash of
  what was in it; the point cloud to take the hull of; or the superellipsoid to
  sample) and the build performs it. The same rule as transforms: record the
  call, not the result. A document stays a description of a scene rather than a
  copy of the STL, the script export still says `pv.read("rotor.stl")`, and both
  round-trip byte for byte. Resolving is the one expensive step in a system
  where a rebuild happens on every slider drag — reorienting a 20k-face mesh
  takes 16 s — so what a source resolves to is cached, and each rebuild is
  handed the answers rather than asked to find them again. **What the checks
  found travels with the object**: an open or disconnected mesh still computes a
  field, and that field is wrong, so the tree row, the Inspector and the reading
  itself say so rather than leaving it to a warning on a stream nobody reads.
  What each source is _trusted_ for differs: a file gets every check, a hull
  skips the one a convex body cannot fail, and a generated superellipsoid skips
  both the quadratic face repair (its winding is consistent by construction, so
  pointing it outward is one signed volume) and the self-intersection test (a
  radial parametrisation cannot cross itself). Skipped answers are recorded as
  answers, not as silence — magpylib re-asks an open question on every redraw.
- **One schema contract.** The same JSON Schema drives the inspector widgets
  _and_ the LLM tool inputs.
- **Validation is shared.** Every edit goes through magpylib, and a bad edit is
  _reported_ (`{"ok": false, "error": …}`), not raised — so a GUI shows an error
  and an LLM self-corrects. There is no second validation layer.
- **The saved file is the document, and it is versioned.** A scene saves as
  `.magpy.json` — exactly what `to_dict()` returns, so the format the engine
  works in is the format on disk, with no serializer in between to disagree with
  it. It carries a `version`, because a file outlives the program that wrote it:
  an older one is migrated, and a _newer_ one is refused rather than read
  half-way and saved back with the parts we did not understand missing. Fields
  the engine does not recognise are carried through, which is the only form of
  forward compatibility a document can actually have. A script is an export, not
  a save: it loses slider bounds and hidden flags, and nothing else — measured,
  not assumed.
- **Document canonical, script generated — one way.** `to_script()` emits
  runnable magpylib code, patterns included (as the loops they mean), **folding
  the log in order** rather than declaring everything up front: where an object
  is created relative to the steps around it is part of the scene, and an object
  added to an already-patterned group must not end up inside every copy. Nothing
  reads it back: the script is an export and the document stays the artifact
  (`docs/direction.md` §5.1). `load_script()` imports any script, this one
  included, by _executing_ it with `show()` intercepted, and reports what that
  flattens. `to_builder_script()` writes the scene as `magpylib_studio.build`
  code instead, which run builds the same document: variables, formulas and
  patterns included (`docs/builder.md`). A script written with the builder opens
  in the studio as the scene it built, whole, and the script tab is that code:
  `apply_builder_script()` runs it on a save and replaces the document with what
  it built, as one undo step, refusing plain magpylib rather than flattening it.

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
| inspect   | `list_objects` · `get_schema` · `get_values` (style) · `get_params` (physics) · `get_transform` · `get_history` · `inspect_mesh`                                                                                                                                                                      |
| structure | `add_object` · `remove_object` · `copy_object` · `move_object` (reparent) · `set_visible`                                                                                                                                                                                                             |
| edit      | `apply_edit` (style) · `set_param` · `reset_style`                                                                                                                                                                                                                                                    |
| transform | `move` · `rotate` · `set_transform` · `clear_path` · `set_pixel_grid`                                                                                                                                                                                                                                 |
| patterns  | `duplicate_around` (circular) · `duplicate_along` (linear; twice = a grid) · `mirror`                                                                                                                                                                                                                 |
| variables | `get_variables` · `set_variable` · `set_variable_bounds` · `set_variable_unit` · `set_model_unit` · `set_field_unit` · `get_units` · `quantity` · `read_values` · `field_units` · `unit_kinds` · `rename_variable` · `remove_variable` · `unknown_variables` · `expression_help` · `check_expression` |
| history   | `get_events` · `edit_event` · `move_event` · `remove_event` · `set_rollback`                                                                                                                                                                                                                          |
| view      | `get_figure` (3D) · `get_field_figure` (along a sensor path) · `get_field_map` (plane heatmap) · `get_sweep_figure`                                                                                                                                                                                   |
| field     | `get_field` — summed B/H at points or along a sensor · `sweep` — the field against a variable                                                                                                                                                                                                         |
| undo      | `undo` · `redo` · `goto_history`                                                                                                                                                                                                                                                                      |
| I/O       | `load_scene` · `set_base_dir` · `load_script` · `load_captured` · `apply_builder_script` · `list_examples` · `load_example` · `clear_scene` · `to_dict` · `to_script` · `to_builder_script`                                                                                                           |
| bulk      | `batch` — many mutating ops in one call, one undo step                                                                                                                                                                                                                                                |

Mutating methods return `{"ok": bool, "error"?: str}`. Everything is
JSON-serializable in both directions.

Try it:

```sh
printf '%s\n' \
  '{"id":1,"method":"load_example"}' \
  '{"id":2,"method":"list_objects"}' \
  '{"id":3,"method":"get_field","params":{"points":[[0,0,0]]}}' \
  '{"id":4,"method":"to_script"}' \
| python -m magpylib_studio
```
