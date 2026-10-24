# Decisions

One record per decision, numbered in the order taken, append-only. A record is
never edited after it is written: to change a decision, add a new record that
says which one it supersedes, and add "superseded by NNNN" to the old one's
status line, nothing else. Each record says what was decided, what was rejected
and why, so the question is not re-litigated later. Code cites a record by its
anchor, `docs/decisions.md#0008-units-are-metadata`, which never changes.

| #                                                                                              | Decision                                                     | Status                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| [0001](#0001-the-document-is-the-log)                                                          | The document is the log                                      | accepted, July 2026, as built                                        |
| [0002](#0002-record-the-call-not-the-result)                                                   | Record the call, not the result                              | accepted, July–August 2026, as built                                 |
| [0003](#0003-expressions-are-hermetic)                                                         | Expressions are hermetic                                     | accepted, July 2026, as built                                        |
| [0004](#0004-script-generation-is-one-way)                                                     | Script generation is one-way                                 | accepted 2026-08-24 (`9932f4f`), argued in                           |
| [0005](#0005-undo-is-snapshots)                                                                | Undo is snapshots                                            | accepted, August 2026                                                |
| [0006](#0006-a-scene-written-in-code-records-through-the-session)                              | A scene written in code records through the session          | accepted 2026-10-01 (B1, `bec78f6`), 2026-10-05 (B2), with step      |
| [0007](#0007-the-script-tab-is-builder-code)                                                   | The script tab is builder code                               | accepted 2026-10-06 (roadmap R1, `2c90793`)                          |
| [0008](#0008-units-are-metadata)                                                               | Units are metadata                                           | accepted 2026-10-06, extended 2026-10-07 (roadmap R2, #28)           |
| [0009](#0009-agents-write-builder-code-through-a-skill)                                        | Agents write builder code through a skill                    | accepted 2026-10-06 and 2026-10-07 (roadmap R3 and its four          |
| [0010](#0010-the-notebook-widget-edits-with-the-package-alone)                                 | The notebook widget edits with the package alone             | accepted 2026-09-29 (#18 and `094150d`; TASKS W1)                    |
| [0011](#0011-one-view)                                                                         | One view                                                     | accepted 2026-09-30 (`f5cb85d`; TASKS W2)                            |
| [0012](#0012-validation-is-shared-and-reported)                                                | Validation is shared and reported                            | accepted, July 2026, as built; restated for agents in `plans/fem.md` |
| [0013](#0013-the-saved-file-is-the-document)                                                   | The saved file is the document                               | accepted, August 2026, as built                                      |
| [0014](#0014-the-window-stamp-says-where-never-whether)                                        | The window stamp says where, never whether                   | accepted, August 2026 (v0.4.0)                                       |
| [0015](#0015-the-name-stays-magpylib-studio)                                                   | The name stays magpylib-studio                               | accepted 2026-10-06                                                  |
| [0016](#0016-released-magpylib-through-a-shim-until-the-release)                               | Released magpylib through a shim until the release           | accepted, August 2026 (`style_compat.py`); the same pattern is       |
| [0017](#0017-the-scene-is-a-function-in-plain-magpylib-recorded)                               | The scene is a function in plain magpylib, recorded          | accepted 2026-10-09, as built                                        |
| [0018](#0018-a-view-is-read-only-until-its-pencil-is-pressed)                                  | A view is read only until its pencil is pressed              | accepted 2026-10-09, as built; amended 2026-10-10                    |
| [0019](#0019-the-editors-panels-are-the-widgets-and-a-host-mounts-them)                        | The editor's panels are the widget's, and a host mounts them | accepted 2026-10-09, as built                                        |
| [0020](#0020-a-bare-sensor-is-drawn-at-the-studios-size-and-magpylibs-defaults-are-left-alone) | A bare sensor is drawn at the studio's size                  | accepted 2026-10-09, as built                                        |
| [0021](#0021-a-frame-is-one-message-and-a-readings-pixels-are-instances)                       | A frame is one message, a reading's pixels instances         | accepted 2026-10-10, as built                                        |
| [0022](#0022-what-the-widget-is-and-is-not)                                                    | What the widget is, and is not                               | accepted 2026-10-10                                                  |
| [0023](#0023-the-inspector-is-the-widgets-object-panel-compact)                                | The Inspector is the widget's object panel, compact          | accepted 2026-10-10, as built                                        |
| [0024](#0024-the-panels-dock-beside-the-view-and-below-a-narrow-one)                           | The panels dock beside the view, below a narrow one          | accepted 2026-10-10, as built                                        |
| [0025](#0025-a-panel-is-a-widget-of-its-own-where-a-host-places-it)                            | A panel is a widget of its own where a host places it        | accepted 2026-10-10, as built                                        |
| [0026](#0026-variants-are-named-value-sets-inside-a-scene)                                     | Variants are named value sets inside a scene                 | accepted 2026-10-11, as built (#32)                                  |
| [0027](#0027-the-scale-is-said-round-the-scene-or-in-its-corner)                               | The scale is said round the scene, or in its corner          | accepted 2026-10-12, as built; superseded in part by 0030 and 0035   |
| [0028](#0028-marimos-slow-answers-were-its-own-fixed-in-0251)                                  | marimo's slow answers were its own, fixed in 0.25.1          | accepted 2026-10-17                                                  |
| [0029](#0029-overlapping-magnets-are-found-and-said-as-you-edit)                               | Overlapping magnets are found, and said, as you edit         | accepted 2026-10-18, as built (#47)                                  |
| [0030](#0030-the-view-cube-is-the-default-scale)                                               | The view cube is the default scale                           | accepted 2026-10-18                                                  |
| [0031](#0031-the-legends-eye-fades-as-a-view-setting)                                          | The legend's eye fades, as a view setting                    | accepted 2026-10-18, as built                                        |
| [0032](#0032-field-lines-are-switched-in-the-scenes-document)                                  | Field lines are switched in the scene's document             | accepted 2026-10-18, for the field-lines prototype                   |
| [0033](#0033-the-colour-bar-cuts-a-sensors-colours-as-a-view-setting)                          | The colour bar cuts a sensor's colours, as a view setting    | accepted 2026-10-23, as built (#66)                                  |
| [0034](#0034-a-model3d-trace-is-kept-as-data)                                                  | A model3d trace is kept, as data                             | accepted 2026-10-23 (#77)                                            |
| [0035](#0035-the-corner-shows-the-axes-and-grows-the-cube-on-hover)                            | The corner shows the axes, and grows the cube on hover       | accepted 2026-10-23, as built; its arrows' look superseded by 0036   |
| [0036](#0036-the-corners-axes-say-which-way-they-point)                                        | The corner's axes say which way they point                   | accepted 2026-10-24, as built                                        |

---

## 0001. The document is the log

**Status:** accepted, July 2026, as built. **Record of:** the handoff notes
("The document IS the log") and `architecture.md`.

### Context

A scene needs undo, an editable history, and a rebuild whenever a variable
changes. Two stored representations of one structure would drift.

### Decision

- `doc["events"]` is the whole scene: `create`, `remove` and `reparent`
  alongside the transforms and the patterns. `doc["objects"]` is a projection,
  rebuilt by `_project()` on every build and never written to. Strip it from a
  document and the log reconstructs the same scene, ids, parents and field
  included; a test checks exactly that.
- `_build` is one pass that folds the whole log from the start: create →
  construct and attach, remove → detach the subtree, reparent → move it,
  transforms → replay. 1.7 ms for the 24-object example, so there is no
  invalidation machinery: editing an early event re-applies every later one for
  free.
- **What an object _is_ lives on its create event and is edited in place**:
  `set_param`, `apply_edit`, `reset_style` and `set_visible` change that event
  rather than appending. A CAD history lets you change the box you made rather
  than recording that you changed it, and it keeps the log finite under a slider
  drag.
- **What happened _to_ it is appended**: transforms, removals, reparents. A
  removal does not delete the earlier events; they ran while the object existed.
  A reparent's position in the log decides which group transforms carried it,
  which is why it is not a rewrite of the create.
- A pose pin supersedes the pin it follows: `set_transform` rewrites the
  trailing pair when they are the last thing in the log and belong to the same
  object; once anything else has happened, order matters and it appends.
- One bad event does not break the document: the fold catches per-event failures
  into `_broken` and carries on; `get_events` marks them. Ordinary edits are
  strict (rolled back and reported); edits to the log itself (`edit_event`,
  `move_event`, `remove_event`) apply and return what fell over under `broken`,
  because history that is only editable when nothing depends on it is not the
  interesting case. `load_scene` is tolerant for the same reason.
- Rollback (`set_rollback`, "Build Up To Here") is a view over the same fold;
  `to_dict` and `to_script` still see the whole document. Editing while rolled
  back inserts at that step.

### Rejected

- A stored object list beside the log: drift.
- An append-only log for parameter edits: the log would grow on every slider
  drag, and undo would then be the only way to see a previous value. Undo is
  snapshots instead ([0005](#0005-undo-is-snapshots)).

### Consequences

An event cannot be reordered above its object's create. A document with neither
`objects` nor `events` is rejected. `copy_object` clones an object's events onto
the new ids; `remove_object` drops its subtree's events. `to_script` folds the
log in order rather than hoisting definitions, because an object added to an
already-patterned group must not end up inside every copy.

---

## 0002. Record the call, not the result

**Status:** accepted, July–August 2026, as built. **Record of:** the handoff
notes on transforms, meshes and patterns; `architecture.md`.

### Decision

**Transforms are recorded magpylib calls, not derived poses.** Each event is
`{id, target, op, ...}` with `op` in `move`, `rotate_from_angax`,
`rotate_from_rotvec`, `position`, `orientation`, in the one ordered log.
magpylib owns every semantic: paths, anchors, `start`, and a Collection
transform carrying its whole subtree. `set_transform` is an absolute world pose
recorded at the end of the log, so no parent-frame correction is needed. Legacy
per-object `transforms`/`rotations` fold into the log on load, children before
parents, verified pose- and field-identical.

**A mesh is recorded as where it came from.** `TriangularMesh` is the one class
whose parameters nobody types, so a create event holds `mesh_source`: the file,
its scale and a sha256 of what was in it; the point cloud to take the hull of;
or the superquadric to sample. `_resolve_params` performs it on every build.
Named `mesh_source` because magpylib's `mesh` kwarg already means the triangle
array.

- Not inline, measured: a 1000-vertex part is a 207 KB document and a 103 KB
  script on one line, and a real CAD export is twenty times that.
- The cache is not an optimisation, measured: 20k faces reorient in 16 s and
  construct in 0.1 ms once the faces are right, and a rebuild happens on every
  slider drag. Keyed by realpath, mtime, size, scale and reorient; in memory
  only.
- Validity is data, not a warning: open, disconnected, self-intersecting, and
  `flipped`, carried on `list_objects`, `get_params` and as `warnings` on
  `get_field`, because an open mesh still computes a field and that field is
  wrong.
- What each source kind is trusted for differs: a file gets every check; a hull
  skips the self-intersection test a convex body cannot fail; a superquadric
  skips the quadratic face repair (consistently wound by construction, so one
  signed volume points it outward) and the self-intersection test. Skipped
  answers are recorded as False, not None: None reads as unasked and magpylib
  re-asks it on every redraw.
- A relative mesh path is relative to the document, which only the host knows:
  `set_base_dir(path, rebase=)`, where _opened_ paths already mean what they say
  and _moved_ ones (Save As) are rewritten.

**A pattern is one event standing for N copies.** `duplicate_around` (circular,
with `spin` per index: a Halbach ring is `spin = 360/count`), `duplicate_along`
(linear; a grid is the linear pattern applied twice, so there is no grid op to
keep in step), and `mirror`, which carries real physics: a reflection has
determinant −1 so a mirrored frame cannot be stored as a proper rotation, and
polarization is an axial vector, so the body's own z-flip symmetry `T` gives
`orientation' = S·R·T` and `polarization' = −T·J`, tested against the field
(`2(B·n)n − B` at the mirrored point). Only shapes with that symmetry can be
reflected. Copies are generated at build time, registered as real sources,
reported with `derived`, read-only but selectable, named after their source and
numbered like their id. `count` and `spin` may be expressions. A removal takes
the copies with it. Copies are added to their group in one `add` call: adding n
children one at a time is quadratic (400 ms against 1 ms for 2000, measured).

### Rejected

- Inline mesh vertices (size), and resolving a mesh on every rebuild (16 s).
- Mirroring a Tetrahedron, mesh or Polyline: it means flipping vertices, a
  different object rather than the same one placed differently. Refused by name.
- `int()`-ing a fractional pattern count: one magnet fewer than the scene
  claimed, silently. Refused (`_whole`).

### Consequences

`DOC_VERSION` 3. `to_script` emits only what happened to objects the log still
holds, and names copies after their source. The same rule, applied to writing a
scene in code, is
[0006](#0006-a-scene-written-in-code-records-through-the-session).

---

## 0003. Expressions are hermetic

**Status:** accepted, July 2026, as built. **Record of:** the handoff notes on
variables and expressions; `architecture.md`.

### Decision

- Any numeric value in a parameter or event may be an expression over
  `doc["variables"]`. The rule is spreadsheet-style: **a string starting with
  `=` is an expression, anything else is a literal**, so `"z"` stays an axis
  name and `"=360/n"` is arithmetic, with no per-field whitelist.
- Evaluated from the AST against an allow-list (arithmetic, a handful of math
  functions, `pi`/`e`/`tau`), **never `eval`**: a document is something you open
  from someone else. No attribute access, subscripts or comprehensions. Stored
  in canonical spacing, so a script is a fixed point from the first save.
- `expression_help()` and `check_expression()` are read off the allow-list that
  enforces them, with a test comparing the two, so the help cannot drift from
  what evaluates. Names are deliberately not checked while typing: one that does
  not exist yet is well formed and gets offered for creation.
- Variables carry hard bounds enforced **in `_build`**, however the value
  arrived (including through another variable's expression), soft bounds that
  only span a slider, `integer` for anything that counts (a count of 7.3 is
  refused, not rounded), and `options` for a choice such as an axis.
- A rename rewrites every expression through the AST, not the text.
- Every numeric field in the UI takes an expression; `get_params` and
  `get_transform` report the value as `written` beside the resolved one, so an
  editor touching a neighbouring axis does not resolve an expression to a
  number. Naming an unknown variable in any box creates it, prompting for a
  value.
- `sweep(variable, values, ...)` re-folds the document once per value, records
  nothing and leaves the document where it started. Affordable only because a
  rebuild is milliseconds, and it is what variables are for.

### Rejected

- `eval`, or a general-purpose language in the document
  ([direction.md](direction.md) §4, §5.4): hermeticity solves the trust problem
  rather than trading it.
- Unit-carrying values: see [0008](#0008-units-are-metadata).

### Consequences

The builder's handles write exactly these expressions
([0006](#0006-a-scene-written-in-code-records-through-the-session)). Growing the
expression language toward Starlark is deliberately unscheduled.

---

## 0004. Script generation is one-way

**Status:** accepted 2026-08-24 (`9932f4f`), argued in
[direction.md](direction.md) §2, §5.1, §6 and §7.

### Context

`to_script` wrote plain magpylib and `parse_script` read it back. The structured
tier was defined by whatever `to_script` happened to emit: matched emitter and
parser idiom pairs (`_mirror`, `_superquadric`, the `for i in range(1, n)` loop,
the `_name_copy` line emitted and then skipped), and a cliff. A helper function,
an `if`, a scipy call or an unrecognised loop dropped an expert to the flat
tier, where variables, patterns and editability are gone.

### Decision

- `parse_script` is deleted with the idiom pairs. `to_script` is export only.
  Nothing parses code back into the document.
- `load_script` imports any script by executing it with `show()` intercepted,
  and names the variables it turned into numbers.
- The document stays the artifact. Every project surveyed generates one way
  (Bazel, Jsonnet, CDK, Onshape, Godot, Terraform, marimo).

### Rejected

- **Code as the source of truth**, with structure recovered by tracing
  (direction §7): Godot shows a structured format can compose with instancing;
  Starlark shows hermetic restriction solves the trust problem; Bazel spent
  eight years walking back from Python as the config surface. It is also a
  one-way door.
- **An opaque `code` event** executed but never parsed (direction §6): the
  moment it exists, resolving a document means executing it, so the inert
  property dies while the document's limits stay.
- **Applying an edited plain script on save by execution**: tried after the
  deletion and worse than the cliff. A save that changed nothing resolved every
  expression to a number, flattened every pattern and dropped the slider limits.
  What replaced it is [0007](#0007-the-script-tab-is-builder-code).

### Consequences

`importer.py` went from 1133 to 372 lines. Writing a parametric scene in code
needed a new way in, which is
[0006](#0006-a-scene-written-in-code-records-through-the-session).

---

## 0005. Undo is snapshots

**Status:** accepted, August 2026. **Record of:** the handoff notes.

### Decision

`_undo` holds whole document copies, capped at 100 and gone on reload; `undo`,
`redo`, `goto_history` and the History view are those checkpoints. A batch is
one step, as is a drag (`begin_interaction` / `end_interaction`).

### Rejected

Undo as a pointer into the event log. It cannot be: the log is deliberately not
append-only ([0001](#0001-the-document-is-the-log)), what an object is lives on
its create event and is edited in place, so the log does not hold the previous
value to step back to. Making it hold one means appending every slider drag.
Variables and bounds are not events either. AEDT has the same shape, a history
tree plus a separate undo, for the same reason.

---

## 0006. A scene written in code records through the session

**Status:** accepted 2026-10-01 (B1, `bec78f6`), 2026-10-05 (B2), with step
order decided 2026-10-06 (`320b80a`). Design in
[plans/builder.md](plans/builder.md), which stays while
[plans/recording.md](plans/recording.md) proposes a new spelling for the same
rules.

### Context

[0004](#0004-script-generation-is-one-way) removed the only way to write
parametric code and get a document back. What remained was the session's
protocol used as an authoring API, `=`-strings in dicts and `{"ok": …}` results
to check by hand: AEDT's IronPython stage. PyAEDT fixed that without touching
the architecture, with an API designed for writing.

### Decision

- **`magpylib_studio.build`: a builder over a session.** Every call goes through
  the session operation the panel uses, so there is one implementation of what
  an edit means and nothing reads code back. Executed, never parsed.
- **Variables are handles, not numbers.** Arithmetic on a handle builds an
  expression (`360 / n` → `"=360 / n"`), built as an AST and unparsed so the
  text is what `expressions.normalized` would write; the allowed functions come
  as handle-aware versions read off `expressions._FUNCTIONS`.
- **Anything the document cannot hold fails at its line**, naming the
  alternative: `if radius > …`, `range(n)`, `float(radius)`, `math.sin(radius)`,
  `np.linspace(0, radius)`. Never evaluate silently; that is the cliff come
  back. Every system that records a program by running it refuses to branch on
  what it records (JAX, torch.fx, CDK tokens, Pulumi outputs). Control flow over
  literals stays ordinary Python.
- **Names follow magpylib**; where magpylib has no word, the word is studio's:
  `variable`, `duplicate_around`, `duplicate_along`, `mirror`, `sampled`.
- **Errors are raised, not reported**: a `{"ok": False}` comes back as
  `BuildError` at the call. Same guardrail, one more way of saying it
  ([0012](#0012-validation-is-shared-and-reported)).
- **A create is recorded lazily.** magpylib builds first and groups after, but
  the session's reparent pins the object's world pose as numbers, which would
  freeze `position=(radius, 0, z)`. So constructing records nothing; the create
  is written when the object first enters the scene (added to a collection,
  touched, or at the end at the root). An `.add()` of an object that already has
  steps is a real reparent and the builder warns. Hence outermost first.
- **Ids:** `id=` if given, else the label, else the class (`cuboid`,
  `cuboid_2`), reserved at construction so a clash is reported at that line.
- **Live or detached:** `Scene()` builds a document of its own; `Scene(session)`
  writes into a session that already holds one.
- **numpy:** its arithmetic and the functions an expression has are written as
  expressions through `__array_ufunc__`; everything else refuses, and an array
  of handles refuses.
- **Steps go in the order written** (2026-10-06): `m.duplicate_around(…)` then
  `m.move(…)` moves `m` alone, as magpylib reads it, where the panel's drag goes
  in front of the pattern so the copies follow. An agent that means the ring
  moves the collection. This closed the last gap in `to_builder_script`.
- **A run of points is a formula**: `s.sampled(of, count=, over=)` calls `of`
  once with a symbolic `t` and writes the node, so `density` still decides how
  many arrows there are.
- **`Scene(values=path)`**: a number in the script is a default and the saved
  file wins; an expression is a definition and the script wins. OpenSCAD's
  Customizer makes the same split.
- **`to_builder_script()`** writes one builder call per step, and that running
  it rebuilds the same document is a property tested over every example and over
  a scene edited the panel's ways.

### Rejected

- The session protocol as the authoring API (above).
- An explicit `parent=` keyword instead of lazy create: harder to get wrong, but
  not magpylib's spelling. Provisional; revisit with use.
- Supporting every numpy function on handles: one way to say it.

### Consequences

The halbach as builder code is about 25 lines where its document is hundreds of
lines of JSON. The builder became the agent's way in
([0009](#0009-agents-write-builder-code-through-a-skill)). The stand-in objects
("looks like magpylib but isn't") are the cost the recording plan addresses; the
rules above carry over unchanged.

---

## 0007. The script tab is builder code

**Status:** accepted 2026-10-06 (roadmap R1, `2c90793`). **Record of:**
[plans/builder.md](plans/builder.md) §5 and the roadmap's R1.

### Context

After [0004](#0004-script-generation-is-one-way) the tab could show plain
magpylib but not apply it: running an edited plain script recovers only the
objects it leaves behind. For a while saving offered "Build a new scene from
this", the same flattening import asked for by name.

### Decision

- The tab renders `to_builder_script()` under a header that says what a save
  does. A deliberate save runs it (`apply_builder_script`), takes the `Scene` it
  built and replaces the document as one undo step. Auto-save, on a delay or on
  leaving the tab, does not apply and holds the text.
- **Compared with the tab, not with the scene.** What the edited script built is
  set beside the open scene rebuilt from its own tab (`build.rebuilt`). The
  same: nothing happens and nothing is recorded, so a reflexive Cmd+S is free
  whatever the tab cannot say. Different while the tab does not build the open
  scene back exactly: the save is refused and names the first line that differs,
  so a gap not found yet cannot ride along with an edit.
- **What a save refuses**, leaving the scene as it was: a script that raises
  (with its line; the tab keeps the text), one that builds no `Scene` or
  several, one that would change more than its edit, and plain magpylib, which
  gets a pointer to Open in Magpylib Studio and is never flattened.
- A save asks first when the scene changed after the tab was written: a drag, an
  agent's edit, an undo would be undone by applying it.
- The tab is the studio's view, regenerated after a save: a helper or a loop
  typed into it comes back as the steps it made, and comments go. Code to keep
  is **Export as Builder Script…**, which nothing regenerates.
- An expression a resize set aside (`overridden`) cannot survive a save that
  changes something; the tab's header and the save's result say so.
- A relative mesh path in the tab resolves against the scene's folder; in a
  builder script opened in the studio, against the script's.

### Rejected

- Applying plain magpylib by execution: silent degradation on Cmd+S (see 0004).
- Keeping "Build a new scene from this": replaced, since builder code is
  lossless by test.

### Consequences

It is a round trip through execution, not parsing: the emitter has one call per
operation to produce, and the property that `exec(to_builder_script(doc))`
rebuilds `doc` is tested, not an idiom-by-idiom agreement between an emitter and
a parser. Poses are the one subtlety: the panel merges a pin into the pin it
follows, so a pose is written as one `set_transform` with both halves.

---

## 0008. Units are metadata

**Status:** accepted 2026-10-06, extended 2026-10-07 (roadmap R2, #28). **Record
of:** `plans/fem.md` §6, "As built".

### Context

magpylib wants bare SI. AEDT wants `"5mm"`. The UI wants `gap: 5 mm`. And
`"5mm"` does not start with `=`, so under [0003](#0003-expressions-are-hermetic)
it is a string literal; making it a quantity would break the one rule that keeps
`"z"` an axis name with no per-field whitelist.

### Decision

- **The document stays bare SI. Units are metadata.** A variable may carry a
  unit _kind_ in `variable_bounds`, beside `integer`, because it is the same
  kind of statement: `length` (m), `angle` (degrees, as magpylib turns), `field`
  (T), `current` (A), `dimensionless`. A variable with options takes none.
- A document declares the units it is _shown_ in: `model_unit` (`m`, `cm`, `mm`,
  `µm`; **metres when absent**, decided 2026-10-06) and `field_unit` (`T`, `mT`,
  `µT`; tesla when absent). Everything is SI until a scene says otherwise, and a
  unit typed (`15 mm`) is always read as itself.
- Views convert at the boundary through the engine: `get_variables`,
  `get_params`, `get_transform` and `get_events` say how each value is `shown`;
  `quantity(name, text)` and `read_values` read what was typed, in decimal, so
  1.1 mm is 0.0011. Emitters will convert at their boundary (M6, not built).
- Angles are stored and shown in degrees; `rad` typed is converted; `radians()`
  and `degrees()` in expressions are untouched.
- The builder takes `variable(…, unit=…)` and
  `Scene(model_unit=…, field_unit=…)`; a plain export says what a number
  measures in a comment. A kind or unit this engine does not know is carried and
  named, not written.
- A variable typed into a box measures what the box does (`field_units`).

### Rejected

- Unit-carrying values (above).
- Dimensional checking: `gap * current` is not caught. magpylib does not check
  dimensions either, and a dimensional algebra to serve a display concern is the
  tail wagging the dog.

### Consequences

No document migration: one that never said a unit loads, lists and saves exactly
as before (`tests/test_units.py`). A magnetization and a moment stay A/m and
A·m², which no setting covers; numbers inside a formula are SI whatever the
scene is shown in.

---

## 0009. Agents write builder code through a skill

**Status:** accepted 2026-10-06 and 2026-10-07 (roadmap R3 and its four
questions, `75d8ab7`, `a883840`, `ad08dae`). The remaining steps are roadmap R3
step 2, R4 and R5.

### Context

The extension exposed 24 language-model tools mirroring the engine's operations
one for one (`addObject`, `setParam`, `rotate`, …): the wrapper shape
Anthropic's tools guideline warns against, callable only from Copilot Chat,
invisible to an agent in a terminal. [direction.md](direction.md) §8 found the
agent evidence split: structured operations beat code for constructing geometry,
code beats discrete tool calls for orchestration, and error rates track API
surface and training-data density rather than language. Its reconciliation: the
correction loop, not the representation.

What the field did next settled it. marimo pair shipped read-only MCP tools plus
file edits, dropped them for code in the live kernel with edits "queued and
checked as a whole, as one transaction", and kept MCP only as lower-level
read-only tools. Anthropic's "Code execution with MCP" put a number on the token
cost of tools called one at a time. Onshape's reason for having agents write
FeatureScript rather than geometry: once the code exists it runs like any other
feature, no ongoing token expense, and the result is shareable and parametric.

### Decision

- **One way in: the agent's Python, written with the builder**
  ([0006](#0006-a-scene-written-in-code-records-through-the-session)). Plain
  Python whose every call is a validated operation is both of §8's halves at
  once. Reads and the field are not fixed tools: what the agent needs to look at
  depends on the task, and helpers are conveniences inside the code.
- **The agent works on its own copy first, on the open scene after.** Step 1,
  built: an Agent Skill inside the package at
  `magpylib_studio/.agents/skills/magpylib-studio/`, the library-skills layout
  magpylib's own skill uses, linked into a project by `uvx library-skills`. Its
  API reference is generated from the builder's docstrings
  (`tools/write-skill-reference.py`) with a test that the two agree, and every
  example in it is run by the tests; present tense and current capability only.
  Step 2, planned: the engine listens on a local connection only the person's
  account can use, and `magpylib-studio run script.py` runs builder code against
  the open scene, one undo step per run, refused whole with its line, as the
  tab's save is; the engine tells the panel its scene changed.
- **The gate for agent-written code is the agent's host**, as for any command it
  runs. Python cannot be fenced in honestly; the engine adds an owner-only
  connection, one undo step per run, and documents that never run code when
  opened.
- **A skill first, MCP only when a chat host needs it** (with R5's view in the
  chat): a skill is what terminal agents read, it is where marimo pair ended up,
  and it adds nothing to trust.
- **The 24 LM tools go**, breaking or not: only Copilot Chat called them, and
  the evaluation has a better baseline.
- **Evaluate with agents, before adding more** (R4): magnetics tasks with
  checkable targets, run by the same agent with plain magpylib and with the
  skill, headless and sandboxed; success, turns, tokens, cost and refusals
  recorded and kept in `evals/`. The closest prior art measured nothing.

### Rejected

- Four MCP tools first, with reading and the field as fixed tools around one
  that runs code: fixed views are what marimo outgrew.
- Keeping the LM tools for Copilot Chat.
- A text-to-geometry generator, a general CAD tool, or more one-call-per-
  operation tools (roadmap, "not to build").

### Consequences

The first evaluation pass (2026-10-08, one run each): plain 8 of 8, studio 10 of
10, studio at about twice the cost on shared tasks, the gap largest where the
agent searched one guess per run. Studio's measured case is the design a person
goes on working on, not a one-off calculation. The skill's own cost in tokens
and the spelling's distance from magpylib are what
[plans/recording.md](plans/recording.md) addresses.

Sources: Anthropic, _Writing effective tools for agents_ (2025-09) and _Code
execution with MCP_ (2025-11); MCP Apps (2026-01); the Agent Skills standard;
marimo pair, marimo-lens and marimo-studio (2026); Zoo's Zookeeper; Embodied CAD
(arXiv 2606.31252); Onshape's AI Advisor.

---

## 0010. The notebook widget edits with the package alone

**Status:** accepted 2026-09-29 (#18 and `094150d`; TASKS W1). Its marimo
measurement explained by
[0028](#0028-marimos-slow-answers-were-its-own-fixed-in-0251). **Record of:**
the editable-widget plan, now deleted.

### Context

Editing worked only in VS Code, yet the engine and the view both ship in the
Python package: a notebook can have it with nothing else installed.
`pip install "magpylib-studio[widget]"` and no extension has to be enough, and
the dependency must stay one way: the extension uses the package, never the
reverse.

### Decision

1. **The session in the kernel owns the objects.**
   `SceneWidget(..., editable=True)` builds a `MagpylibStudioSession` from the
   objects through `document_from_objects`, or from a script or `.magpy.json`.
   Editing is a flag on the view people already use, not a second class; a view
   cannot be made editable after the fact. The objects are copied into the
   session, not edited in place, so the cell that made them stays as it was.
2. **Transport: `rpc.handle` over the widget's kernel connection**, restricted
   to a short list of its own (`begin_interaction`, `end_interaction`,
   `apply_edits`, `undo`, `redo`, `get_scene`) and nothing that runs a file.
3. **Edits become calls in Python, once.** `apply_edits(edits)` in the session,
   with the batching; the VS Code host calls it too.
4. **The drag glue is one module**, `magpylib_studio/static/drag.mjs`, handed an
   `rpc` and a `render`; the panel passes webview messages, the widget its
   connection. JavaScript both sides use lives in `magpylib_studio/static/` and
   the extension copies it.
5. **The view ships built.** `magpylib_studio/static/widget.js` is committed
   with the renderer bundled in (`tools/build-widget.sh`), so installing needs
   no node; a check fails the build when it no longer matches its sources.
6. **Notebook updates once per settled edit**: a `revision` trait, and
   `last_edit`; previews during a drag go as messages, never traits, so nothing
   re-runs per frame. Without an answer from Python within 4 s the view goes
   back and says so.
7. **A CI job installs the built wheel alone**, in a fresh environment with no
   node and no extension, and runs an edit through a fake kernel connection
   (`tools/check-package-alone.py`), so a hidden dependency fails the day it
   appears.

### Rejected

- Letting the widget move the live objects in place: a notebook's objects belong
  to the cell's code; the edit is lost the next time the cell runs and the code
  stops describing what is on screen. Edits need an owner, the session.
- Porting the host's drag logic to JavaScript: a second copy to drift.
- Starting the engine as a subprocess from the widget: the kernel is Python
  already.
- Exposing all of `rpc._PUBLIC` to the view.
- Previews as traits: every frame would re-run marimo's dependent cells.

### Measured

One drag frame (a pose sent, the scene asked for again), median of 20, M4 Pro:

| magnets | stdio (the panel) | JupyterLab | marimo | scene sent |
| ------- | ----------------- | ---------- | ------ | ---------- |
| 2       | 0.9 ms            | 4.1 ms     | 3.4 ms | 5 KB       |
| 100     | 21 ms             | 27 ms      | 102 ms | 53 KB      |
| 1000    | 309 ms            | 341 ms     | 475 ms | 513 KB     |

The engine's own time dominates, as in the panel. marimo adds 60–85 ms to a call
slower than about 20 ms, cause unknown.

---

## 0011. One view

**Status:** accepted 2026-09-30 (`f5cb85d`; TASKS W2). **Record of:** the
one-view plan, now deleted.

### Context

Three places drew a scene with the studio's renderer: a notebook cell and the
script panel through the widget, and the studio panel through `studio.mjs` and
its own HTML controls. Two interfaces around one renderer: the mode keys, axis
locking, snapping and playback existed twice, and had drifted.

### Decision

1. **An editor seam in the widget**: it talks to _an editor_ (`begin`,
   `preview`, `commit`, `scene`, `undo`, `redo`) instead of the session's
   methods by name. In a notebook the editor is the kernel's calls; a host with
   its own supplies it on the model. The widget stays unaware of VS Code.
2. **The studio's editor goes through the extension host**, which already
   refreshes the tree, the Inspector, the field view, the history and the script
   tab, marks the scene unsaved and writes the crash backup.
3. **A model the studio panel holds** (`media/studioView.mjs`): `payload` from
   `get_scene`, `tree` from the engine's `object_tree` (the notebook's legend
   uses it too), `selected` kept in step with the sidebar, `hidden` read from
   what the engine says is not visible. In the studio, hiding is an edit, saved
   and undoable; in a notebook it is a view setting. The widget cannot tell them
   apart and does not have to: the model decides what the eye does.
4. **What the panel had and the widget lacked moved into the widget**: the typed
   readout and the key list, for the notebook too. Chart mode (Plotly, read
   only) stays the panel's.
5. **What went**: `studio.mjs`, the panel's status bar and controls, the second
   copies of the mode keys, `DRAG_WRITES`, axis, snap and playback code.

### Rejected

Keeping two interfaces: every control and fix made twice, or drift.

### Measured

Nothing on a drag's path changed. A redraw of the 1000-cuboid array example was
468–527 ms in the old panel and 452 ms in the new; the first try was slower
because the widget's floating panels were blurred behind (`backdrop-filter`),
composited again on every frame, 15–20 % of a frame without a GPU. The panels
are nearly opaque now and not blurred. The legend is lost in the noise.

The parity checklist tried by hand after the change is in
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## 0012. Validation is shared and reported

**Status:** accepted, July 2026, as built; restated for agents in `plans/fem.md`
§13.2.

### Decision

- Every edit goes through magpylib: style through the property tree, parameters
  through the constructors, transforms through the calls. There is no second
  validation layer.
- A mutating session method returns `{"ok": bool, "error"?: str}`. A structural
  edit that fails is rolled back by `_mutate_doc` and reported, so a GUI shows
  the message and an LLM self-corrects. The builder turns the same result into a
  `BuildError` at the call, because a script author wants the traceback line
  ([0006](#0006-a-scene-written-in-code-records-through-the-session)).
- **The caveats go in the payload, not the prompt.** `get_field` returns
  `skipped` and `warnings` beside its values: a reading that silently leaves out
  a source the caller can see is the wrong kind of quiet, and a field in the
  JSON being summarised cannot be dropped the way a prompt instruction can.
- **The engine refuses; the skill explains.** Skill text is advisory and an
  agent under pressure drops it, so a skill that tried to be the guardrail would
  be the second validation layer this project does not have.

### Consequences

For the planned FEM jobs the same rule becomes refusal-first: no residual
without convergence metadata, no solve past budget, no comparison mixing `ideal`
and `physical` (`plans/fem.md` §12.4, §13.5), designed before anything depends
on permissive behaviour.

---

## 0013. The saved file is the document

**Status:** accepted, August 2026, as built. **Record of:** the handoff notes,
design decision 5.

### Decision

- A scene saves as `.magpy.json`: exactly what `to_dict()` returns, with no
  serializer in between to drift from it. The JSON Schema at
  `vscode-extension/schemas/magpy-scene.schema.json` is registered for
  validation, and the Python suite validates every example against it, so it
  cannot describe a format the engine stopped writing.
- `DOC_VERSION` is stamped by `_canonical`, so every document that passes
  through a session carries it. Absent means the format from before the field,
  and is migrated. **Higher than we know is refused** in `load_scene`, checked
  before the "is this a scene" test, because a future format need not spell
  those keys our way.
- **Unknown keys survive.** Top level and events are stored verbatim; since
  `objects` is a projection, unknown keys there are moved onto the create event
  and projected back. Without this, opening a newer file in an older studio and
  saving would silently delete what the newer version added.
- **The script is an export, not a save.** Measured: a round trip of the halbach
  example through the plain script differs in exactly `variable_bounds` and
  `visible`. Physics survives; studio state does not.
- **Redrawing is not editing.** `refreshSurfaces()` redraws; only
  `broadcastMutation()` marks the scene as differing from its file. They were
  one function, and a view action put an unsaved mark on a saved scene.

### Rejected

A serializer or a second format between the engine and the disk.

---

## 0014. The window stamp says where, never whether

**Status:** accepted, August 2026 (v0.4.0). **Record of:** the handoff notes,
design decision 8.

### Context

A script run from a studio window should be able to draw in that window's panel.
The extension stamps `MAGPYLIB_STUDIO_DROP` on its terminals, so a script knows
where to draw. Whether it _should_ is the question, and it cannot be inferred.
Measured one launch method at a time:

| launched by                   | stamped | right?                                                               |
| ----------------------------- | ------- | -------------------------------------------------------------------- |
| integrated terminal           | yes     | yes                                                                  |
| Run button                    | yes     | yes                                                                  |
| F5 / debug                    | yes     | yes, debugpy's default console is that terminal                      |
| Interactive Window            | no      | yes, the kernel is spawned from the extension host and claims plotly |
| `pytest` in the same terminal | yes     | **no**                                                               |

A test run and a human run differ in nothing the stamp can see: `isatty()` is
True for both. The only discriminator is `PYTEST_CURRENT_TEST`, and the set it
belongs to (nox, tox, sphinx-build, nbconvert) cannot be enumerated.

### Decision

- The address is stamped always and unconditionally. The backend name is a
  separate variable, written only because a setting says to:
  `magpylib-studio.drawScriptsHere`, shipped **on** as a default rather than an
  inference, visible in `echo $MAGPYLIB_STUDIO_BACKEND`, announced once, one
  click to turn off.
- Test runs are excepted by two checks: `PYTEST_CURRENT_TEST`, which is absent
  during collection, and `pytest in sys.modules`, which covers that moment. A
  courtesy, not a general answer; the setting is the control.
- Nothing may sniff `VSCODE_*`: those are inherited by everything the extension
  host spawns, including the Interactive Window's kernel, which the notebook
  rule already owns. The stamp crosses interpreters; the package does not.

---

## 0015. The name stays magpylib-studio

**Status:** accepted 2026-10-06.

### Context

`marimo-studio` reached PyPI on 2026-07-30, a day before `magpylib-studio`, and
in the notebook ecosystem the widget is for, "studio" now names a marimo product
too.

### Decision

Keep the name. The package, extension and import names differ from marimo's, the
prefix matches the org's other packages, and a rename would touch PyPI, the
Marketplace id, the repository and every document.

---

## 0016. Released magpylib through a shim until the release

**Status:** accepted, August 2026 (`style_compat.py`); the same pattern is
proposed for recording (`plans/recording.md` §5).

### Context

Studio depends on magpylib APIs that are on main and in no release: the style
property tree's `schema()`, `set`, `set_values()` and resolved `get_style`;
later the display-backend API; proposed, a recording hook. Studio cannot wait
for a magpylib release, and the change must not show when it comes.

### Decision

Studio uses the API where magpylib has it and reproduces it from outside where
it does not, in one version-gated module per API (`style_compat.py` rebuilds the
four style operations from `style.update()` / `style.as_dict()` and serves a
generated copy of main's schema). The test suite runs against both magpylibs in
CI. When the release comes, studio's minimum moves to it and the shim goes;
nothing a user wrote or saved changes.

### Cost

A shim reaches into `magpylib._src`, which is private; it is tested on each
magpylib studio supports, and it can be slower (recording on 5.2.3 was 15 ms
against 4 ms for one scene). The 3D scene graph has no shim: without the
display-backend API the studio draws the plotly figure instead.

---

## 0017. The scene is a function in plain magpylib, recorded

**Status:** accepted 2026-10-09, as built; supersedes the spelling of
[0006](#0006-a-scene-written-in-code-records-through-the-session), whose rules
carry over. **Record of:** the recording plan, now deleted.

### Context

The builder's objects were stand-ins: `s.magnet.Cuboid` recorded, but `getB` on
it was nothing, and the spelling had to be kept in step with magpylib's by hand.
The agent evaluations counted the cost of every place the spelling differed.
Plain magpylib an agent already knows, and magpylib's own docs are the widest
set of real scripts there is.

### Decision

- **A scene is a function whose parameters are the variables.** Bounds are
  `annotated_types` constraints inside `Annotated`, as pydantic and wigglystuff
  read them; a choice is `Literal`; the unit and the slider range ride along as
  studio's metadata; `Length`, `Angle`, `Count` and `Bounds` are grouped
  metadata that expand to the standard constraints. A variable defined by a
  formula is `derived(name, formula)` in the body. Parameters need a default
  each; a `bool`, or a name without its `Literal`, is refused at the decorator.
- **One function, three callers.** Called plainly it is magpylib: numbers in,
  objects out, patterns as real copies. `fn.build()` calls it with the
  parameters as handles and records what it does into the document;
  `fn.build(values=path)` takes a saved scene's values. A notebook's view takes
  the function, marked or plain, and builds it (amended 2026-10-10); in a file
  the mark says which function is the scene. The decorator returns a wrapper
  that is the plain function when called; one that recorded at definition time
  would make `ring(n=12)` a document.
- **magpylib reports its calls through a hook**, `record(on_event, resolve)`:
  every top-level construction, property assignment and transformation, with the
  arguments as written; magpylib's own nested calls are not. `resolve` turns a
  handle into a number before magpylib sees it. The hook is proposed upstream
  (`magpylib.record`, always on, about 0.1 µs a call); until it ships, studio
  carries a copy and wraps magpylib's classes from outside
  ([0016](#0016-released-magpylib-through-a-shim-until-the-release)). The two
  write the same documents, checked on released 5.2.3 and main.
- **The call is the recording scope.** Whatever is constructed during it is the
  scene, whoever constructed it; an object made before is refused by name. The
  session's own rebuilds, the mesh resolver and a pattern's copies run as
  magpylib's own work and are not recorded.
- **A construction is a create step at the root.** `group.add(obj)` on a fresh
  object moves its create inside the group, as if made there; on one with steps
  it is a reparent, with a warning. `obj.parent = group` is a reparent outright,
  keeping the pose, as the tree's drag does. Arguments are kept in the order
  written. An id is the variable the object is assigned to, where that name held
  no other object while the function ran -- read off the running function's
  frame, never parsed from its source; else the label, else the class, settled
  once the function has returned. `name(obj, id)` still says one outright, and
  the writer emits it only where the name it writes cannot be the id -- since
  2026-10-12; before, ids came from labels and every built-in example's script
  named each object by hand.
- **Style is read between calls**, as magpylib keeps what an object was given
  before its style is ever made, and written as edits by dotted path; the
  recorder never creates a style, since `copy()` labels a copy differently once
  one exists.
- **A property read is today's number, and a warning says so** where the value a
  scene holds there is a variable: the one silent cliff the function form cannot
  close.
- **Studio's words**: `derived`, `duplicate_around`, `duplicate_along`,
  `mirror`, `place`, `sampled`, `hide`, `show`, `remove`, `TriangularMesh`,
  `name`. Everything else is magpylib's.
- **The writer emits the same form**: `@scene def design(...)`, parameters
  annotated, `derived` lines, one line per step, `place` for a pose pin,
  `obj.parent = group` for a reparent, `hide` and `show` at the end, and a
  `return` of the root objects, with imports aliased where a variable takes a
  word's name. The tab, Open in Magpylib Studio and the skill moved with it.

### Rejected

- The listening object (`Scene()` recording from the moment it is made): global
  state, a `paused()` block, a takeover and a warning on save, where the
  function needs none of it.
- The builder's spelling kept as an alias: never released, so nothing used it.
- Recording magpylib calls as a new document format, and array-API tracing (the
  plan's §4).
- A grouped-metadata sugar in bare annotation position: an invalid type form to
  pyright and Pylance.
- `name(obj, id)` in generated scripts (2026-10-12): the variable an object is
  assigned to already names it, so it is the id, read off the running function;
  `name()` stays for an id no variable gives.
- Dropping `derived` for a plain `stagger = 360 / (2 * n)` (decided 2026-10-12,
  kept): unlike `name()`, it says what Python cannot -- that the formula is a
  variable of the scene, listed in the panel and named in every formula that
  uses it, and its unit. Without it, `stagger / 2` would carry the formula's
  text, already pasted in by the time anything records it, and the unit would be
  a guess from the first use. Its double name is the `x = Symbol('x')` idiom. It
  stands with the pattern words, which also say what plain magpylib cannot.

### Measured

Every built-in example round-trips through the writer to the same document on
magpylib main and on released 5.2.3; the Halbach function builds the example's
document and, called plainly, its field at the defaults and at other values.
magpylib's own docs through the recorder
(`tools/replay-magpylib-docs.py --studio`, each page's cells as one scene
function's body, the document's objects set beside the live ones): of the 23
pages that run in this environment, 19 are exact, pose and field, one differs
only in `model3d` traces (the data gap), two are refused at their line for a
`CustomSource` (the code gap), and one, with 1,215 objects, times out at ten
minutes, since every recorded call rebuilds the scene. Twelve pages need a
package this environment lacks.

## 0018. A view is read only until its pencil is pressed

**Status:** accepted 2026-10-09, as built; amended 2026-10-10: the view for
looking only is spelt `editable="never"`, `None` kept as the same thing.
Supersedes the sentence in
[0010](#0010-the-notebook-widget-edits-with-the-package-alone) that a view
cannot be made editable after the fact. The rest of 0010 stands. **Record of:**
where `editable` is decided, raised over the view's toolbar.

### Context

`editable` was decided when the view was made, and most views are read only: a
cell shows objects to look at, and only now and then does someone want to move
one. Asking for the handles meant going back to the cell and writing
`editable=True` into a view already on the page. The session is still the only
place an edit can be kept: a view of the cell's own objects has nowhere to put a
drag.

### Decision

- **Read only by default, with a pencil among the view's tools that puts the
  handles out.** `editable` is whether they are out: `editable=True` from the
  start, the pencil later, `view.editable = True` from code. The view sets the
  trait itself and saves it, so in marimo the cells that read the view re-run as
  they do for a selection. `editable="never"` (first spelt `None`, still read
  so) is a view for looking only, a figure handed to someone else: no pencil,
  and the trait refuses to turn on.
- **A scene written in code, or a path, is shown as its own session.** Nothing
  is copied: the document is the one source, so its field, its file and its code
  read the same session the view draws, a drag is a step in that scene, and a
  variable set from a notebook control rebuilds it with the drag's pins on top.
  The pencil only puts the handles out there.
- **The cell's own objects are copied on the press**, under the names the cell
  gave them, as `editable=True` does at the start. `update` reads its caller's
  variables when the objects are given and keeps only the names of what is
  shown, so the view holds nothing else of the namespace. The session's first
  drawing is no edit: `revision` stays.
- **One way for the session.** A view with a scene of its own is not re-pointed:
  `update` after the pencil is refused, naming the pencil, since re-pointing
  would throw the edits away. Set back, `editable` only puts the handles away;
  the session stays. A view of other objects is a new one.
- **Undo stops where the scene started, and `reset` goes back there.** A load is
  where a scene begins, not an edit of what was open: `load_scene` starts the
  history itself, so in the panel the first undo after opening a file or a
  script takes back the first edit, never the scene. A scene function's build
  forgets its own steps once built, and the view forgets what a session did
  before it: neither is an edit. The script tab's save and a reset replace the
  document too, but as edits, kept as one step each. The view keeps a snapshot
  from its start, and `reset()`, or the arrow under the undo buttons, restores
  it as one step that undo takes back.
- **Shown only where it can act**: not on a saved page, which has no python, and
  not on a bare `show` that handed over no objects. The studio panel is left as
  it was, the view being the editor there.

### Rejected

- A pencil that forks every view into a copy, a built scene's included: built
  first. After a press the notebook's field, file and code described the
  function's document while the view showed a copy, and the next knob drag
  rebuilt the document and stranded the edits. A built scene is a session
  already; the view shows that one.
- A pencil that only shows and hides the handles everywhere, with
  `editable=True` still deciding at construction whether a session exists: the
  common case, a cell's own objects already on the page, would still have to be
  declared in code to be edited.
- A module-level default read when the argument is left out: it moves the choice
  out of each call but still decides at construction, and is a second place a
  notebook's behaviour comes from.

## 0019. The editor's panels are the widget's, and a host mounts them

**Status:** accepted 2026-10-09, as built for the Variables panel
(`feat/variables-in-widget`). **Record of:** `plans/variables-in-widget.md`,
deleted when merged.

### Context

The VS Code extension carried the editor's chrome -- the Scene tree, the
Inspector, the Variables view, the history, the script tab, the field view -- as
sidebar views of its own: about eleven thousand lines with no life outside VS
Code, while the direction says the package is the product and the extension one
consumer ([direction.md](direction.md) §1, §5.3). The notebook widget had the
view, the handles and the legend, and for the variables an ipywidgets control
beside it (`variable_sliders()`); the marimo demo spent two cells explaining
that its knobs let go of the view once the pencil was pressed, because the view
had no knobs of its own. The sidebar's scripts turned out to be host-neutral in
everything but transport: `inspector.js` and `variables.js` reach the engine
through one `rpc(method, params)` that posts a message to VS Code, the seam the
widget points at its kernel connection.

### Decision

- **The editor goes into the widget; the host keeps what is host-shaped.** A
  panel about the scene the view draws -- the variables now; the Inspector and
  the history next -- is a module in `magpylib_studio/static/`, handed an `rpc`
  and what else it needs, knowing no host. The widget floats it over the view;
  the VS Code sidebar mounts the same module in its webview
  (`media/variables.mjs`, a wrapper routing the calls through the provider), so
  the layout there stays and the logic lives once. The checks that drove the
  sidebar's script under the DOM shim drive the module (`webview-harness.js`,
  `mountVariables`).
- **Field views and script editing stay with the host.** Every host renders a
  plotly figure natively, and plotly.js would triple the bundle; a code editor
  inside the widget fights the notebook for focus and keys, and the notebook has
  one. So do the file, the process, the terminal stamp and the structural
  dialogs built on QuickPick.
- **The widget's variables panel shows with the handles**, as an edit surface: a
  view is read only until its pencil is pressed
  ([0018](#0018-a-view-is-read-only-until-its-pencil-is-pressed)), and moving a
  variable is an edit like a drag. Not on a saved page, and not in the studio
  panel, whose host shows the variables in its sidebar. A value under the
  pointer is a `set_variable` marked `preview` on the view's message, applied
  and answered without a word to the notebook, the view redrawing from
  `get_scene`; the release settles once, `last_edit` reading
  `{"by": "set_variable", "variable", "value"}`. A `variables` trait,
  `{name: value}` as resolved, follows the session, so a cell reads the knobs
  without re-pointing the view. `VIEW_CALLS` grows by `get_variables`,
  `set_variable`, `restore_variable`, `quantity` and `expression_help`: still
  nothing that runs a file.
- **The view's model owns the numbers.** `variables` is assignable: what differs
  is set as one edit, and the trait reads the scene back. Another control's
  trait is tied to it with `traitlets.link` -- the demo's call expression,
  linked widget to widget in a cell that names no marimo element, since one
  naming an element re-runs on its every change -- and is an input and a
  display, never a second owner. marimo re-runs a cell only on a change the
  frontend made (a trait set from python is a mutation it does not track), so
  cells read the view, not the control.
- **Nothing over the view that cannot act.** A panel in the widget is compact:
  the rows, the limits in the tooltips, no help block, no action without a host
  action, a choice as its dropdown alone, its inputs underlined as the readout's
  are, its toggle at the foot of the edit column, the editor's one home, the
  hover bar above being the view's. The sidebar keeps the fuller form through
  the module's options, not a second copy. Looked at in a real browser before it
  is called done.

### Rejected

- Everything into the widget, field views and script tab included: plotly.js and
  a code editor in every cell, for what the host does better.
- Sliders of the widget's own with the sidebar's script kept: every control and
  fix made twice, which [0011](#0011-one-view) refused once already.
- The panel inside the studio panel too: the host would have to be told of each
  commit, and nothing asks for it while the sidebar shows the same rows.
- Adding, renaming and removing variables from the widget: in a notebook the
  scene function is where that happens.
- Two owners for one number: host knobs pushed into the session by a cell. The
  cell re-ran on the view's edits too, could not tell a knob that moved from a
  variable the view moved, and wrote the knobs' values back over the slider.
- The history as a widget panel: the widget has undo, redo and reset; the steps
  list, with moving, dropping and editing events and rollback, is the structural
  surface direction.md §5.3 keeps minimal, and in a notebook the scene function
  is the log. It stays the extension's tree.

### Consequences

`variable_sliders()` stays, unreleased; removing it is a line of its own once
the panel has been used. The marimo demo shows the view editable from the start,
its call expression linked to the view's variables, and reads the view. The
sidebar lost no behaviour; `restore` moved from a host action to a call the
panel makes itself. The Inspector is the next panel, once the engine answers an
expression naming a variable the scene lacks -- today a VS Code dialog, its one
host-side behaviour beyond transport (roadmap). Slots for a host's own layout,
and a widget per panel for hosts that place outputs apart, wait for a host that
asks; JupyterCAD 3.1 put its toolbar and side panel in the cell widget the same
way, for JupyterLab alone.

## 0020. A bare sensor is drawn at the studio's size, and magpylib's defaults are left alone

**Status:** accepted 2026-10-09, as built.

### Context

The studio draws sensors and dipoles at their stated size rather than scaled to
the scene, so that moving one object cannot rescale every other
([architecture](architecture.md), the 3D view). The engine's own `add_object`
wrote `SENSOR_SIZE`, 5 mm, into every sensor it made, and the comment beside it
said why: magpylib's default size of 1 is then one metre of glyph. A sensor made
in a scene function, or passed as a plain object, carried no size, and a 25 mm
ring drew with a metre-long probe over it; the marimo demo had sized its sensor
by hand. The pin was also a change to `magpy.defaults` that stayed, so once the
studio had drawn in a kernel, a notebook's own `show()` of a bare sensor was a
metre across too.

### Decision

- **The pin is a context.** `threejs.pinned_scene_units()` sets metres, absolute
  sizing and the studio's default size for sensors and dipoles, and puts every
  default back on the way out. `get_scene` and the chart's `get_figure` draw
  under it; nothing else touches `magpy.defaults`.
- **A size the style does not say is the studio's**, 5 mm, at draw time: the
  document stays what the person wrote. A size the style does say is kept.
  `SENSOR_SIZE` lives in `threejs.py`; the examples go on writing it into their
  sensors, so their scripts say it.

### Rejected

- Writing the size into every document at create, for the recorder and the
  import as `add_object` does: one convention instead of two, but a presentation
  value in every saved scene, which is direction.md §11's open question.
- Keeping the pin global and adding the size to it: a 5 mm probe is a better
  surprise than a metre, but a notebook's own figure still changed because the
  studio had drawn once.

## 0021. A frame is one message, and a reading's pixels are instances

**Status:** accepted 2026-10-10, as built. Its marimo premise explained by
[0028](#0028-marimos-slow-answers-were-its-own-fixed-in-0251).

### Context

Dragging a variable or a handle in a notebook was slower in marimo than in VS
Code. Measured on the demo's Halbach, the engine cost the same everywhere, 13 ms
a frame; what differed was the transport. Each frame was two messages, a preview
and `get_scene`, of which the second carried 127 KB, 101 KB of it the 7 × 7
probe's field arrows as one merged mesh; and
[0010](#0010-the-notebook-widget-edits-with-the-package-alone) had measured
marimo adding 60 to 85 ms to any message past 20 ms, where stdio adds nothing.
Two such trips a frame is a drag at eight frames a second.

### Decision

- **A preview's answer carries the scene when the view asks.** The view's
  message says `scene`, python puts `get_scene()` into the answer, and the view
  redraws from it: one message a frame, in the panel's drag and the variables
  panel's alike. Not a trait: nothing is told to the notebook per frame, as
  before. A host's own editor, the VS Code panel's, goes on asking.
- **A sensor whose pixels read the field is a `pixels` item**: a position, a
  direction, a size and a colour per pixel, which the renderer draws as
  instances of one shape, the arrow magpylib draws, a cone, or a cube. The sizes
  and colours are computed as `make_Sensor` computes them, with magpylib's own
  helpers; magpylib is kept from drawing the pixels itself by a pixel size of 0
  for the length of the capture, and keeps the sensor's axes. The frame is 38
  KB, and the payload's `ranges` reach the arrows. A run's frames keep
  magpylib's whole drawing, so playback is untouched; the 2D `arrow` symbol
  stays magpylib's lines.

### Rejected

- Binary buffers for the mesh: a third of the bytes, but the arrows would still
  be built as a mesh every frame, and marimo's support for buffers is
  unverified.
- Rounding the mesh's floats: half the bytes, for the same mesh.
- Instancing in a run's frames too: the run machinery fits traces frame to
  frame, and pixels are not traces; nothing plays a run while dragging.

### Measured

The demo's Halbach, 24 magnets and a 7 × 7 probe: 127 KB and two messages a
frame before; 38 KB and one after. `get_scene` 10.4 ms before, 9.6 ms after, the
field being computed twice.

## 0022. What the widget is, and is not

**Status:** accepted 2026-10-10. The boundary the editor's panels move inside
([0019](#0019-the-editors-panels-are-the-widgets-and-a-host-mounts-them)),
written down before the next one so that it is not drawn by accident.

### Decision

The widget is **the view of one scene, and its editor.**

- It draws the scene the same in every host that can show an anywidget or a web
  view: a notebook cell, the VS Code panel, a saved page.
- It edits what is in the scene and where: the handles, the variables, the
  selection's properties, undo. Its panels hang on the edit column and show only
  what can act; state stays in sight, commands hide until reached for.
- It tells its host once per settled edit and reads back what the host sets,
  through traits and nothing else. A frame of a drag is one message.
- It asks the engine for everything it shows. It never computes a field,
  resolves an expression or sizes an object itself.

It is **not**:

- an analysis surface: no field maps, sweeps, tables or plots. Those are the
  host's cells and panels, on the engine's calls.
- a code surface: no script editing, no agent in it. The scene function lives in
  the notebook or the file; the script tab is the editor's.
- a file or project manager: it exports a page and a picture; the host opens and
  saves, and holds several scenes.
- a framework for pages, reports or dashboards. marimo-studio, Panel and the
  hosts do that; the widget is what they place.
- a second implementation of anything the engine does.
- a place to add, remove, group or pattern objects: it edits what exists. In a
  notebook that is written in code; in VS Code it is the sidebar's dialogs.

### What follows

The readout, the numbers the handles write, may take units and a variable's
name, since those are about where things are; it stays the fields the handles
write. The Inspector, the selection's properties, is the next panel on the
column. A figure of the field, a table of the scene or a script never is.

### Rejected

- Growing by what is easy to add: each panel is a tax on a reader of the view,
  and a cell is a bounded box.
- No boundary at all, deciding each panel on its merits: that is how the VS Code
  sidebar came to carry eleven thousand lines.

## 0023. The Inspector is the widget's object panel, compact

**Status:** accepted 2026-10-10, as built. **Record of:**
`plans/inspector-in-widget.md`, deleted when merged.

### Context

The second of the editor's panels to move into the widget
([0019](#0019-the-editors-panels-are-the-widgets-and-a-host-mounts-them)),
inside the boundary of [0022](#0022-what-the-widget-is-and-is-not): the
selection's properties. The sidebar's Inspector was a thousand lines of vanilla
JavaScript whose only host-bound line posted the message, plus one host-side
behaviour: a value naming a variable the scene lacks was asked about in a VS
Code dialog before the engine saw it.

### Decision

- **One module, two densities.** `static/inspector.mjs` is the Inspector, handed
  an `rpc`. The sidebar mounts it in full -- header, step, parameters, pose, the
  style tree with its filter -- through a thin wrapper. The widget mounts it
  compact: the header, the parameters and the pose of the selection, and the
  style tree folded under one heading, read when it is opened and not before,
  its filter inside. The tree is thirty-odd properties in eight groups for a
  plain magnet, the panel's whole height open and one line closed; the steps
  belong to the tree that shows them, and a cell is a bounded box.
- **It hangs on the column, one panel at a time.** An object toggle beside the
  sliders opens it; opening either panel closes the other; both go with the
  handles. It follows the selection, and reads the scene back once an edit
  settles.
- **The engine makes a name the scene lacks.** `set_param` and `set_transform`
  take `define`, as `apply_edits` does, and make a bare name at the value it
  replaces, in the field's kind of unit, in the same step; the module asks for
  it on every write and says what was made. The sidebar's dialog stays in front
  for now and goes with its own line.
- **The readout stays.** Its numbers move at pointer rate while a handle moves;
  the panel's pose row is the same numbers at rest. If the two read as one thing
  said twice, the readout folds into the panel's row later.

### Rejected

- No style in the widget, the first cut: a notebook has no sidebar to send the
  colour of a magnet to, and the view's objects are its own copies, so a style
  set on the kernel's object afterwards is not in the view.
- A curated few instead of the tree, label and colour and opacity: the next
  three would be asked for, and it is a second list to keep. The whole tree
  folded costs one line and keeps one form.
- The step editor in the widget: a step is picked in the tree, which the
  widget's legend is not.
- A second implementation of the forms for the widget: every field made twice,
  which [0011](#0011-one-view) refused once already.

## 0024. The panels dock beside the view, and below a narrow one

**Status:** accepted 2026-10-10, as built, after a spike that rendered three
layouts at three widths (commit a4d3dfe).

### Context

The variables and object panels floated over the right of the view, docked
beside the edit column
([0019](#0019-the-editors-panels-are-the-widgets-and-a-host-mounts-them)). In a
cell 480 pixels wide the object panel covered the scene, and a float has nowhere
to go on a narrow view: the trouble is room, not position. The VS Code sidebar's
answer, panels a host lays out anywhere, is the host's; a notebook has hosts
too, and the widget is not a window manager
([0022](#0022-what-the-widget-is-and-is-not)).

### Decision

- **A column, not a float.** A panel opens in a column beside the view, a third
  of the width, and the view refits to what is left. A handle on the column's
  inner edge drags its width. One line of title and the mark that closes it; the
  column's toggles, pressed, say which panel is open, so the dock has no tabs of
  its own.
- **A sheet below a narrow view.** Under 720 pixels the column becomes a sheet
  below the view, and the widget grows by it, up to 260 pixels, the sheet
  scrolling past that: the view keeps its height, and the edit column beside it
  the room it needs.
- **Only what the moment needs.** With the object panel open the readout is put
  away, its numbers being the panel's pose row, and comes back for the length of
  a drag, when they move faster than a panel reads. Pose and properties are
  headings, not folds; style folds. `V` and `O` open the panels from the
  keyboard, for the hand that pressed `W`.
- **Hosts that place things get a widget per panel**, later, as the roadmap has
  it: the column is the default when nothing else is arranged.

### Rejected

- Dragging the panels about the view: a position to remember, lost on re-render,
  and no room gained where room is short.
- A left or right choice: the legend is top-left, the tools top-right, the
  column right; beside the column is the one place.
- Tabs in the dock's head: the column's toggles already switch, and the same
  control twice is clutter.
- The view giving up its lower part to the sheet, the cell keeping its height:
  rendered, a 460-pixel view left the edit column clipped at both ends, since
  the column and a sheet together want more than the view has; and a notebook's
  outputs grow with what is in them anyway.

## 0025. A panel is a widget of its own where a host places it

**Status:** accepted 2026-10-10, as built.

### Context

The widget docks its panels beside its view
([0024](#0024-the-panels-dock-beside-the-view-and-below-a-narrow-one)), and that
is the whole answer where a cell is the only layout there is. Notebook hosts
have layouts of their own -- an ipywidgets box, marimo's columns and sidebar,
JupyterLab's sidecar -- and a person who wants the sliders in a side column has
them in the host's hands already, if the panel is a thing the host can place.
[0019](#0019-the-editors-panels-are-the-widgets-and-a-host-mounts-them) left
room for it: "a widget per panel for hosts that place outputs apart, when a host
asks".

### Decision

- **`view.panel(kind)` is a widget.** `ScenePanel` mounts the same module the
  view docks, under a model of its own, against the view's session through the
  view: a call is answered under the panel's model, and the view draws and tells
  the notebook as it does for its own panels. The view's revision, selection and
  theme are mirrored to it as traits.
- **The view stays the editor.** A panel apart adds no entry point to the
  session: it may call what the view may call, and a previewed value redraws the
  view by handing it the scene, where the view's own panel redraws from the
  answer. The notebook is told at the release, as for a drag.
- **One source, two bundles.** `panel.js` is the editor's modules without the
  renderer, built from the same sources under the same stamp, and checked
  against them as `widget.js` is.

### Rejected

- A second model inside the view's widget, one per panel: anywidget has one
  model per widget, and a panel the host can place is a widget.
- The panel talking to the kernel on its own: two editors of one session, each
  drawing and telling the notebook, where the view already does both.

## 0026. Variants are named value sets inside a scene

**Status:** accepted 2026-10-11, as built (#32). **Record of:**
`plans/several-scenes.md` and the review of #32.

### Context

A second setting of the same design -- a compact ring and a wide one, a nominal
and a worst case -- was a second file: a copy of the whole scene, drifting from
the first with its first edit. Roadmap R9 named variants as not separate scenes:
"a named value set inside the scene, as OpenSCAD's Customizer keeps presets".

### Decision

- **A variant is a named set of values for the variables that hold one**: a
  finite number, or a choice's name; never a formula, which is what a variable
  is rather than a value it was left at. The document keeps them as
  `variants: {name: {variable: value}}`, in the variables' order. An older
  studio carries the key untouched
  ([0013](#0013-the-saved-file-is-the-document)), so the version stays 3.
- **Not a mode.** Using one sets the variables it names, as one step to undo.
  Which one the scene is in is read off the variables, never stored: of those
  whose values hold, the one naming the most. A variant may leave variables out,
  and those keep their values.
- **Checked as the combination it makes.** Values the limits refuse, its own or
  a formula's following them, are refused when it is saved; a change of limits
  that would strand one is refused, naming it; one a later formula strands is
  listed as unusable, shown and not offered.
- **In code, the mark holds them**: `@scene(variants={...})`, each value checked
  against its parameter's annotation where it is written. `ring.variants[name]`
  is a plain mapping, so `ring(**ring.variants["wide"])` is plain magpylib at
  those values. The script tab writes them back in the signature's order, and
  names at its top what the mark cannot hold. A saved scene's variants are laid
  over the mark's by name when the document is first read; one the scene can no
  longer take whole is left out with a warning, and the mark's of that name
  stays.
- **In the panel, a toggle each**, the one in force pressed, one press one step;
  a dropdown past four. In a notebook, `view.save_variant(name)` keeps the
  values from a cell and hands back the scene function's parameters, for the
  mark; making, renaming and removing variants there is code's
  ([0022](#0022-what-the-widget-is-and-is-not)).
- Saving, renaming and removing a variant rebuild nothing: no object follows a
  variant until it is used.

### Rejected

- **Variants as files**, a copy of the scene per setting: the copies drift apart
  with the first edit.
- **A sidecar file of values**, as OpenSCAD keeps its presets beside the
  `.scad`: a second file to move, rename and version with each scene, for what
  is part of what the scene says.
- **An active variant that slider edits are written into**, as CAD
  configurations have it: sliders with a mode, and where an edit lands a matter
  of state.
- **Formulas in a variant**: one that put a number in a formula's place would
  undo a definition each time it was used.
- **The dropdown alone**: two clicks, and plain, where a few toggles take one.

## 0027. The scale is said round the scene, or in its corner

**Status:** accepted 2026-10-12, as built; its default superseded by
[0030](#0030-the-view-cube-is-the-default-scale), and the cube's look and its
snap by [0035](#0035-the-corner-shows-the-axes-and-grows-the-cube-on-hover).
**Record of:** `plans/view-cube.md`, now deleted.

### Context

The view said its scale one way: the graduated box, Plotly's, round the scene
and ticked on three edges. Right for a figure, and in the way while editing: it
frames the scene a little wider than the objects, and its numbers sit over
whatever is near its edge. CAD views say the same two things -- which way the
scene faces, and how big it is -- in a corner instead: a view cube and a scale
bar.

### Decision

- **`axes` takes three values**: `"box"`, the default; `"cube"`; and `"none"`.
  `True` and `False`, which the trait took before there was a choice, are read
  as the box and none, so a cell that says `axes=False` and a page saved before
  this keep working. The widget's button goes round the three.
- **The cube is a control, the bar is part of the picture.** A click on a face,
  an edge or a corner of the cube looks from there -- twenty-six views, through
  `axisView`, snapped as the 1, 3 and 7 keys snap; a press on it never picks
  what is behind it, and the handles stand down until it is let go. The PNG a
  view saves keeps the bar, in the corner the cube left, and not the cube.
- **Both are drawn by the renderer into its own canvas**, after the scene in the
  same frame: a second scene in a corner viewport, and a plane in pixel space.
  No frame of their own: a view at rest still draws nothing.
- **Lengths are said in the unit that reads best** -- `1 mm`, not `0.001 m` --
  whatever unit the payload's axis labels name: the bar's length, and the box's
  numbers and axis names, in one unit for all three axes so their numbers
  compare.
- **The bar is measured at the orbit centre**: a round length, 1, 2 or 5 times a
  power of ten. Exact in a parallel view; in perspective, exact at the depth of
  the point the view turns about, which is what F puts on the selection.
- **The host says what it floats over the corner** (`keepClear`): the rectangles
  of its editing column and its transport, whenever either comes, goes or moves.
  The square stands clear of them, and the renderer measures nothing between
  times.

### Rejected

- **three's `ViewHelper`**: a ball of axes, not a cube, and its views assume y
  up -- in a z-up scene they come out rolled.
- **The cube as HTML over the canvas**: it would stay behind when a pooled
  renderer moved on, and be missing from a resting view's picture.
- **A scale bar only in parallel view**, where it is exact everywhere: the
  default view is perspective, and a bar exact at the orbit centre says more
  than none.
- **Animated turns to the chosen view**: the keys snap, and so does this.
- **The host's insets as CSS properties the renderer reads**: a style read per
  frame and per pointer move, for a value that changes when a column comes or
  goes.

## 0028. marimo's slow answers were its own, fixed in 0.25.1

**Status:** accepted 2026-10-17. Supersedes the line in
[0010](#0010-the-notebook-widget-edits-with-the-package-alone)'s measurements
that marimo adds 60–85 ms to a call slower than about 20 ms, cause unknown,
which [0021](#0021-a-frame-is-one-message-and-a-readings-pixels-are-instances)
started from. Both decisions stand. **Record of:** a drag bench on the marimo
demo's Halbach, in every host, kept out of the repo and since removed; a drag in
a real marimo is measured by `vscode-extension/harness/drag-rate.mjs`
(`npm run drag-rate`).

### Context

0010 found marimo slower than JupyterLab and the VS Code panel by a near-fixed
amount on any call past about 20 ms, and could not say why. 0021 halved the
messages a drag frame sends on account of it. Measured again, with the frame the
view sends today, the amount was marimo's and is gone.

### Decision

- **The cause was marimo's run mode, and marimo has fixed it.** Under
  `marimo run` the kernel is a thread of the server. In 0.24.0 it handed each
  message to the websocket writer from a thread of its own, with
  `asyncio.Queue.put_nowait`, which does not wake the server's event loop: the
  answer waited until the loop woke for something else, about every 100 ms. A
  short call was answered while the loop was still awake from the request that
  brought it, which is why only calls past about 20 ms paid, and a frame came to
  the next 100 ms tick: 0010's 102 and 475 ms. `marimo edit`, whose kernel is a
  process the loop reads itself, never had it. 0.25.1 hands over with
  `call_soon_threadsafe`.
- **Nothing in the widget works round it.** A notebook's transport costs about 3
  ms a frame over the panel's stdio, in JupyterLab and marimo alike: a
  millisecond to python and one and a half back.
- **0021 stands.** One message a frame is a round trip fewer on every host, and
  the 38 KB frame is what every host carries.

### Rejected

- **Keeping marimo's loop awake from the widget**, a timer poking it: reaching
  from the kernel into marimo's server, for a bug its release has fixed.
- **Asking for marimo 0.25.1 in the package**: marimo is not a dependency, and
  the demo's instructions install the latest.

### Measured

One frame of a magnet dragged, `apply_edits` with the scene in the answer,
median of 30, M4 Pro. The radius slider, `set_variable` as a preview, is the
same to a millisecond. The engine is 9.5 ms of the demo's frame and 45 ms of the
heavier one's; not counted are the renderer, the same everywhere, and the VS
Code webview's messages.

| host                  | demo: 24 magnets, 7 × 7 probe | 96 magnets, 25 × 25 probe |
| --------------------- | ----------------------------- | ------------------------- |
| VS Code panel (stdio) | 8.9 ms                        | 44 ms                     |
| JupyterLab            | 12.2 ms                       | 51 ms                     |
| marimo 0.25.1, run    | 12.3 ms                       | 51 ms                     |
| marimo 0.25.1, edit   | 11.7 ms                       | 51 ms                     |
| marimo 0.24.0, run    | 101 ms                        | 103 ms                    |
| marimo 0.24.0, edit   | 11.7 ms                       | 51 ms                     |
| scene sent            | 34 KB                         | 132 KB                    |

## 0029. Overlapping magnets are found, and said, as you edit

**Status:** accepted 2026-10-18, as built on #47. **Record of:** the parts of
`plans/overlaps.md` that are built; the plan keeps what is not.

### Context

Magpylib adds the magnetizations of two magnets wherever they overlap. A magnet
pushed into its neighbour therefore computes a field that looks right and is
not, and nothing says so: the most common silent mistake in a scene. Touching is
not that mistake. A Halbach ring, a stack, a shaft in its bore and a coil on its
core all touch on purpose, and many touch along a face, a line or a point that a
looser test reads as an overlap.

### Decision

- **Two objects overlap when they interpenetrate by more than 1 nm**
  (`collisions.TOL`); touching never counts. Every solid is shrunk by half that
  before it is tested, so faces that touch end up apart.
- **Every shape is convex pieces with exact support functions.** Cuboid,
  Cylinder, Sphere, Tetrahedron and a convex mesh are one piece each, with
  nothing curved turned into triangles. A CylinderSegment is cut into wedges,
  each between an outer convex stand-in and an inner one, halved while the two
  disagree, and cleared at once by its bore. A mesh that is not convex is its
  triangles and a check that nothing sits wholly inside it. A current loop is
  cut like a ring; wires and sheets are checked against magnets, never against
  each other; sensors and dipoles never overlap.
- **Two pieces are decided by MPR**, on 72,000 near-contact cases all right.
- **The check takes magpylib objects and imports nothing from studio**
  (`magpylib_studio/collisions.py`), so it can move into magpylib whole.
- **Every scene says which pairs overlap**, a drag's previews included, how deep
  each goes, and -- where something moves along a path -- the pairs at each
  step. A view nobody edits says it too. `get_overlaps` lists them, `get_gap`
  measures two objects, and `list_objects` names each object's.
- **It is said where the eye is**: an amber outline in the 3D view, a warning at
  the end of each overlapping row of the legend and of the Objects tree, and
  above the legend a count that steps through the pairs.
- **An overlap meant -- a cut-out -- is marked by the person**, pair by pair
  (`set_overlap_intended`), kept in the document as `intended_overlaps`, carried
  through the script tab, one step to undo. Marked, it is counted apart and
  drawn faint, never hidden.

### Rejected

- **Triangulating every shape**: a tessellated cylinder is smaller than the
  cylinder, so a shaft touching its bore reads as a gap or an overlap depending
  on which side the facets fall.
- **GJK's yes/no form**: it called up to 12 % of exactly touching curved pairs
  overlapping. **GJK's distance form** for the yes/no: it missed 21 % of slight
  sphere overlaps within its iterations. It measures gaps instead.
- **Guessing intent from opposite polarizations**: a magnet reversed by mistake
  inside another is exactly the error to report.
- **The check in the browser**, at pointer rate: a second implementation, and
  notebooks, agents and the RPC would not have it. A drag frame costs a few
  milliseconds in Python, with the shapes of what did not move kept.
- **A red outline**, which vanished on magpylib's red north poles; **magenta**,
  which said nothing about what was wrong. **Lines joining an overlapping
  pair**: the two are already in contact, so the line is a few pixels inside
  them.

---

## 0030. The view cube is the default scale

**Status:** accepted 2026-10-18; supersedes the default of
[0027](#0027-the-scale-is-said-round-the-scene-or-in-its-corner), whose other
rules carry over.

### Context

0027 gave the view three ways to say its scale and made the graduated box the
default. Its own context says what the box costs while editing: it frames the
scene a little wider than the objects, and its numbers sit over whatever is near
its edge. Alex chose the cube as the default instead.

### Decision

- **`axes` is `"cube"` unless something says otherwise**: in the widget, in the
  studio's panel, in a figure the `studio` and `widget` backends draw, and in a
  page saved without a choice.
- **The button goes round from it**: cube, box, none, and the cube again. The
  default's next is still the other way to say the scale, and none still comes
  last.
- **`True` is still the box**, and `False` none. A page saved with a choice
  keeps it.

### Rejected

- **Reading `True` as the cube**: `True` is what a view held when the box was
  the only scale there was, so it says the box, and a cell or a saved page from
  then still draws what it drew.

---

## 0031. The legend's eye fades, as a view setting

**Status:** accepted 2026-10-18, as built, after trying it in a saved page.

### Context

To see a sensor inside a Halbach ring, the ring had to be hidden, and then it
was gone. Its opacity is in the Inspector's style tree
([0023](#0023-the-inspector-is-the-widgets-object-panel-compact)), but set there
it is an edit of the scene, made to look inside.

### Decision

- **Press the eye and slide sideways.** Left fades what the row holds, right
  brings it back, 100 pixels from a tenth to whole. A press that does not slide
  is the click, which hides as before. While it slides a thin bar along the
  row's foot shows the level; at rest the eye is filled to it and stays in
  sight, as a hidden row's does. A collection's row fades what it holds.
- **A share of the object's own opacity, kept by id**: the widget's `faded`,
  beside `hidden`, carried over a rebuild and kept by a saved page. The renderer
  draws each step of a slide; the model is told once, at the release.
- **A view setting in every host.** In the studio the panel's model keeps it and
  does not tell the host: not saved, not undone. The scene's opacity stays the
  Inspector's.
- **A faded object is looked through.** It stops writing depth, so what is
  inside it shows whole, and a click in the view goes on to the first object
  behind it that is not faded, taking the faded one only where nothing else is.

### Rejected

- **An opacity gizmo among the handles**: one number, with no direction in space
  to drag along, and the handles edit what is in the scene and where
  ([0022](#0022-what-the-widget-is-and-is-not)).
- **A slide on the row**: the row selects three ways, frames on a double click
  and points on hover, and a select click that wobbled would fade.
- **Both the eye and the row**: two gestures for one thing.
- **A see-through key** that fades all but the selection: sliding the outer
  collection's eye does it, on the thing to look through.
- **An edit in the studio, as hiding is there** ([0011](#0011-one-view)): a look
  inside would be an undo step and a line in the script and the file, and a
  written opacity would replace the object's own, which a fade multiplies.
- **The level as a percentage beside the eye**: it covered the end of the row.
- **Sliding to nothing hides**: hiding stays the click's, so faded and hidden do
  not blur.

## 0032. Field lines are switched in the scene's document

**Status:** accepted 2026-10-18, for the field-lines prototype
([#45](https://github.com/magpylib/magpylib-studio/issues/45)).

### Context

The lines' switch was a widget trait and a flag on the session: gone when the
view went, never in the scene's file, and nowhere in the VS Code panel, whose
view has no kernel to set a trait on. #45 asked where to keep it: a magpylib
style property, or the studio's document.

### Decision

- **The document's**, as `"field_lines": true`, beside `intended_overlaps`: a
  key the engine carries and does not build from, so the script tab keeps it.
  `set_field_lines(on)` switches it as one step to undo, with no rebuild, and
  over RPC.
- **Saved, unlike a fade
  ([0031](#0031-the-legends-eye-fades-as-a-view-setting))**, because it says
  what the scene shows of the field, as hiding does, and a file reopened without
  its lines would look like a different scene.
- **Every host reads it there.** A notebook's `field_lines` trait follows the
  document after each edit, undo and redo; asked for when a view is made, it is
  where editing starts, not an edit. The panel takes it from the scene the
  engine sends and tells the host when its button flips it, as hiding is told.
- **On or off for the whole scene**, for every sensor that reads the field.

### Rejected

- **A magpylib style property per sensor** (`style.pixel.field.lines`): the
  right home in the end, since the lines are that sensor's drawing and every
  backend could read it, but an API change to magpylib after 6.0. When it lands,
  the document's key becomes the sensors' property.
- **A view setting, not saved**, as a fade is: lost on every reopen, and the
  panel's view would have nothing to keep it in.

## 0033. The colour bar cuts a sensor's colours, as a view setting

**Status:** accepted 2026-10-23, as built
([#66](https://github.com/magpylib/magpylib-studio/pull/66)).

### Context

A sensor whose pixels the field colours showed its colours with no scale: they
said more and less, not how much. Its strongest spot, next to a magnet, took
most of the colormap and left the rest of the plane one colour. Two sensors,
each coloured over what it reads, gave the same colour to different fields.

### Decision

- **A bar on the right, beside the editing column**, for the selected sensor or
  else the first the field colours, in the table its pixels and field lines
  already take (`fieldlines.colours`), so the three agree. None for a hidden
  sensor, or one whose pixels and lines are both hidden.
- **Two handles cut a range.** The table stretches over the cut, and the field
  past either end takes that end's colour, on the pixels and the lines alike,
  recoloured in the browser with no trip to python. A typed value may reach past
  what the sensor reads, so two scenes can be coloured on one scale; the bar
  then reaches the cut and marks where the readings end.
- **A view setting, as a fade is
  ([0031](#0031-the-legends-eye-fades-as-a-view-setting))**: `color_range`,
  `{id: [low, high]}` in SI, and `color_shared`, carried over a rebuild and kept
  by a saved page. The studio panel keeps both and does not tell the host: not
  in the document, not undone.
- **One scale for the sensors whose tables are one**, by a switch under the bar:
  the same colormap, scaling and field, which is what a table depends on besides
  its sensor's span. They colour over what they read together, a cut is all of
  theirs, and one bar, "4 sensors · |B|", stands for them. A pattern's copies
  come under their source's id and are that sensor: one scale over all they
  read, always.
- **The bar says what each sensor is coloured over** (`colouring`): a range per
  sensor on screen, cut or shared. The renderer groups nothing, so what it draws
  is what the bar says.
- **It steps aside while a run plays or shows a later step**: those steps are
  magpylib's drawing, in its colours for that step.
- **The PNG carries it**, as it carries the scale bar: a field's colours without
  their scale say nothing.

### Rejected

- **Ticks along the bar**: on a 13-pixel bar they crowded out the values. Its
  ends, the cut's ends and the value under the pointer say what is read.
- **Grey past the cut**, as some tools draw what is out of range: there the
  pixels take the end colour, so the bar shows that colour, hatched.
- **A card round the bar**: it covered the scene. A halo keeps the text legible.
- **Saved in the document, as the field lines' switch is
  ([0032](#0032-field-lines-are-switched-in-the-scenes-document))**: the cut is
  a way of looking at the field, as a fade is a way of looking inside, not a
  change to what the scene shows.
- **Grouping in the renderer as well as in the bar**: it counted a hidden sensor
  the bar left out, and the two disagreed.
- **A bar per sensor, on screen or in the PNG**: three crowd the view and a
  hundred cannot be drawn. A shared scale lets one bar say them all.
- **The name as the button to the next sensor's bar**: it lies over the band, so
  a press there has to drag. Arrows under the bar do it instead.

## 0034. A model3d trace is kept, as data

**Status:** accepted 2026-10-23, with Alex
([#77](https://github.com/magpylib/magpylib-studio/pull/77)).

### Context

A script whose object had a `model3d` trace did not open: `style.set_values()`
hands back the traces as magpylib objects, the import put them in the document,
and the runner died writing it as JSON, saying only that no scene came back. A
scene function dropped every trace, with a warning.

### Decision

- **A trace is held as the values set on it**, what `add_trace` takes, numpy as
  lists: kept by the import and the recorder alike, drawn in the 3D view, and
  written into both scripts. JSON has no tuple, so `args` is made one again
  where magpylib takes it.
- **A trace made at show time is left out and said**: an `updatefunc`, or `args`
  given as a function, is code, and the document holds data. The import names
  the object; the recorder warns, as it did.
- **A runner answer that is not JSON is an error naming the value**, not a
  process that ends without a word.

### Rejected

- **Leaving every trace out with a warning**: smaller files and nothing new to
  round-trip, but a script's custom shapes would not survive opening it, though
  they are plain data. A large mesh makes a large document and a long line in
  the script tab; that is the cost taken.

## 0035. The corner shows the axes, and grows the cube on hover

**Status:** accepted 2026-10-23, with Alex, as built; supersedes the look of
[0027](#0027-the-scale-is-said-round-the-scene-or-in-its-corner)'s cube and its
snap, whose other rules carry over. Its arrows' flat look superseded by
[0036](#0036-the-corners-axes-say-which-way-they-point).

### Context

0027's cube sat in the corner at full size whatever the pointer did: flat faces
shaded a step apart, names in the axis colours, a green slab under the pointer,
and a click that jumped the view. Ten other looks were tried side by side, live,
in a page: one rounded cube with four rules for x, y and z arrows (never,
always, only on hover, only at rest), a cube that stays small until the pointer
reaches it, glass, a chamfered cube, faces tinted by axis, a line drawing, and
axis balls. Alex chose the small one, with the axes alone at rest.

The first view was asked about at the same time: magpylib's backends were
thought to show +y running down to the left. Rendered, none does. All four look
from the same side -- matplotlib by its default (30 degrees up, -60 round),
Plotly from `eye=(1, -1.5, 1.4)` (38, -56), pyvista from its isometric view
turned by `azimuth=-90` (35, -45), the widget from (29, -51) -- so +x runs down
to the right and +y up to the right in each. Matplotlib's is the reference: the
others start near it.

### Decision

- **At rest the corner shows the axes alone**: x, y and z arrows in the handles'
  colours, named at their tips, at 70 % of their size grown. They say which way
  the scene faces at a glance, which is what the corner is for while nothing
  points at it.
- **With the pointer on the corner's square, it grows**, and a cube comes up
  round the arrows, which move out to run along its edges from its -x, -y, -z
  corner. What the cube hides of them shows faintly. The cube is rounded, lit
  from the upper left, its faces named in the theme's ink. The part a click
  would look from is lit in the focus colour, by the same rule the click is
  decided by, and asked again as the cube grows or turns under a pointer that
  has stopped.
- **A click turns the view over 0.4 s**, as the 1, 3 and 7 keys do. A drag, the
  wheel, framing or a camera handed in takes over from a turn on its way. With
  less motion asked for, it jumps, and the corner grows at once.
- **The square is 84 pixels at rest**, as the cube's was, room for the axes
  turned any way, and that is what stands clear of what a host floats over the
  view. Grown it is 112, up and left out of the corner, room for the arrows past
  the cube; it may reach in under a column that stops short of the corner.
- **The bar stands low in the middle of the foot**, beside the axes at rest --
  left of them only in a view too narrow for both. A picture leaves the corner
  out and keeps the bar where it is on screen.
- **A view first looks from where matplotlib's does**: 30 degrees up, -60 round.

### Rejected

- **Arrows only on hover, on a cube shown always**: gone when a glance wants
  them. **Only at rest**: taken away under a pointer that is aiming.
- **A cube always shown, with the arrows always on it**: Alex wanted the corner
  out of the way.
- **Glass, a chamfered cube, faces tinted by axis, a line drawing**: tried, and
  not chosen.
- **Six axis balls in place of a cube**: six views instead of twenty-six.
- **The arrows from the cube's middle**: through the faces' names.
- **The square at 112 pixels at rest too**: in a short view the edit column and
  the colour bar beside it reach down within that of the foot, and pushed the
  axes left of both.
- **The bar beside the corner**, as 0027 had it: Alex wanted the axes in the
  corner and the bar in the middle, low beside them.
- **Plotly's first view, or pyvista's**: each is magpylib's to set, and both
  start near matplotlib's, which the widget now takes exactly.

## 0036. The corner's axes say which way they point

**Status:** accepted 2026-10-24, with Alex, as built; supersedes the flat look
of [0035](#0035-the-corner-shows-the-axes-and-grows-the-cube-on-hover)'s arrows,
whose other rules carry over.

### Context

At rest the corner showed three arrows drawn flat, one colour each, in a
parallel view. Nothing in that picture said which end of an arrow was nearer: an
arrow coming toward the eye and one going away at the same angle were drawn the
same, and the cross read as well from below as from above. Alex found it had no
sense of depth. The arrows are thin at rest -- a shaft under two CSS pixels, a
head about four -- so a cue has to show at that size. Six looks were rendered
side by side, at four views and in both themes: as it was, faded with depth,
faded and shaded, in perspective, in perspective and faded, and that with the
names grown with depth.

### Decision

- **The corner is seen in perspective**, through 30 degrees, whatever the view
  is seen in. An arrow coming toward the eye ends in a larger head and name than
  one going away. The square sees as far round the cube's middle as it did, at
  the middle's depth; 30 degrees is narrow enough that what comes nearest still
  stands inside it. The cube, grown, is seen the same way.
- **An arrow fades as it goes behind**, along its length: whole where the axes
  start, down to 40 % where it would be an arrow's length behind. Its name fades
  with its tip. In the screen's plane, or coming nearer, it is drawn whole.

### Rejected

- **Shading the arrows**, lit as the cube is: at rest a shaft is under two
  pixels across, and no light shows on it.
- **Growing the names with depth**, past what perspective does: the near name
  came out too large for the corner.
- **A stronger fade**, eased down to 35 %: in the first view y points away, and
  its name was hard to read on a dark page.
- **The corner in the view's own projection**, parallel in a parallel view: the
  depth the arrows say would go, in the view where nothing else says it.
- **Fading toward the page's colour, as fog**: over a magnet behind the corner,
  a faded arrow would show the page's colour instead of the magnet.
