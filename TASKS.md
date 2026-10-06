# Tasks

What to do next, ordered by what gates what. The reasoning behind each item
lives in the plan it came from — this file stays thin enough to work from.

| Question                             | Document                                           |
| ------------------------------------ | -------------------------------------------------- |
| What is this?                        | [README.md](README.md)                             |
| What is built?                       | [CONTINUE.md](CONTINUE.md)                         |
| **What do I do next?**               | **this file**                                      |
| In what order, and why that order?   | [docs/roadmap.md](docs/roadmap.md)                 |
| Why is it going that way?            | [docs/direction.md](docs/direction.md)             |
| How does instancing work?            | [docs/instancing.md](docs/instancing.md)           |
| How is a scene written in code?      | [docs/builder.md](docs/builder.md)                 |
| How does FEM validation go?          | [docs/fem.md](docs/fem.md)                         |
| How does editing in a notebook work? | [docs/editable-widget.md](docs/editable-widget.md) |
| Why is there one view?               | [docs/one-view.md](docs/one-view.md)               |

**Track F (foundation) is primary.** It is what studio _is_ under the
positioning in `docs/direction.md` §1, and everything else is an application of
it. M runs in parallel because its lead time is upstream review rather than
ours. V is downstream of F except for V1, which is orthogonal — a different repo
that touches none of this. W is independent of all three: it puts the engine as
it is today in a notebook. A (agents) builds on F1b's builder.

**The order across tracks is in [docs/roadmap.md](docs/roadmap.md) §4**: B3 (R1,
done), units (R2), the agent's way in and its evaluation (R3–R4), then FEM with
tier 0 checked on the Maxwell seat before the open solver (R7), then several
scenes open at once — a project is a folder, a scene a file (R9).

---

## Track F — Foundation

### F1 — Kill the round trip ✅

**What.** `parse_script` goes, with the matched emitter/parser idiom pairs
(`_mirror`, `_superquadric`, the `for i in range(1, n)` loop shape, the
`_name_copy` line emitted and then skipped). `to_script` becomes export and
recording only.

**Why.** `docs/direction.md` §2 and §5.1. Every project in its §4 table
generates one-way. This is a deletion with a known shape and it shrinks the
surface F2 has to work in.

**Decided while doing it.** Applying by execution was tried first and is worse
than the cliff: running an edited script recovers only the objects it leaves
behind, so a save that changed nothing still resolved every expression to a
number, flattened every pattern into its copies and dropped the slider limits —
silent degradation on `Cmd+S`. So `apply_script` is gone too, and saving the tab
offers "Build a new scene from this" instead: the same capability, explicit and
opt-in. `load_script` is unchanged. (Since replaced: the tab is builder code
now, and its save applies again — F1b, B3.)

**Done.** `importer.py` 1133 → 372 lines, `apply_script` and
`_round_trip_warnings` removed, the extension rewired, 261 tests green and ruff
clean.

### F1b — Write a scene in code (B1, B2, B3 ✅)

**What.** `magpylib_studio.build`: magpylib's spelling, with variables that stay
variables, recording through the session operations the GUI uses. Design in
[docs/builder.md](docs/builder.md).

**Why.** F1 removed the only way to write parametric code and get a document
back. Without this, code reaches the document only by execution, which keeps the
objects and loses the variables — and a scene with no variables has no design
variables to export to Maxwell.

**Done (B1).** `Scene`, variables as handles that refuse to be evaluated, lazy
creates so `.add()` never reparents, `SceneWidget(scene, editable=True)` and
`SceneWidget.set_variable`, `s.sampled` for a run of points as a formula, and
`Scene(values=…)` so a slider left in a saved scene survives a re-run. The
halbach and quiver examples written with it are the examples' own documents.
`load_script` names the variables it turned into numbers. Demo:
`examples/builder_demo.py`.

**Done (B2).** `to_builder_script()`: the scene as builder code which, run,
builds the same document -- tested over every example and a panel-edited scene.
A builder script opens in the studio as the scene it built (`load_script`), and
`SceneWidget.variable_sliders()` gives a notebook the Variables panel's
controls. `examples/builder_demo.py` is written for all three ways in.

**Done (B3).** The script tab shows builder code, and a deliberate save applies
it ([docs/roadmap.md](docs/roadmap.md) R1): `apply_builder_script` runs the tab
and replaces the document with the `Scene` it built, as one undo step. A save
that builds the scene already open records nothing; a script that fails, builds
no `Scene` or is plain magpylib is refused and changes nothing, and the tab
keeps its text until it runs. The edit is compared with the open scene built
back from its own tab, so a save that would change more than its edit is refused
too; a review before pushing found such gaps in B2 and closed them, bar one left
open as a decision (roadmap §6, step order). Auto-save still does not apply.
**Export as Builder Script…** writes code to keep. Why apply-on-save returned:
`docs/direction.md` §5.1, `docs/builder.md` §5.

**Next.** #12 merges. Structure kept in sync as a layer of GUI steps over a
script's (`docs/builder.md` §7, level 2) is designed, not started.

### F2 — Parameterised instancing

**What.** A definition document with declared parameters, and an `instance`
event that references it with arguments. Design in
[docs/instancing.md](docs/instancing.md).

**Why.** The missing reuse feature. All four wanted units of reuse are
composition units, and a structured format composes if it has instancing plus
exported parameters.

**Design first.** Six open questions in `docs/instancing.md` §5 — version
pinning, nested instances, composition with patterns, editing through an
instance, whether a document's variables are its signature, and whether
same-document definitions are worth having. This is the highest-design-risk item
in the plan and the most tempting to start coding.

**Done when.** Design questions closed, then: an instance resolves in `_build`,
`to_script` emits a call, a definition round-trips by hash, and a pattern of
instances works.

### F3 — GUI as parameter binder

**What.** Introspect a definition's parameters, render widgets, rebuild, draw.

**Depends on** F2 — there are no parameters to bind until definitions exist.

**Why.** `docs/direction.md` §5.3. The sync surface shrinks to "parameters →
widgets", which cannot drift. Proven shape: OpenSCAD Customizer, Storybook
controls, Streamlit.

### F4 — Grow `expressions.py` toward Starlark

**Deliberately not scheduled.** `docs/direction.md` §5.4 — the right answer and
the expensive one. Starlark took Google eight years. Nothing forces the choice
yet.

---

## Track M — magpylib core (start now; the constraint is upstream review)

### M1 — `susceptibility` / μr as a documented property

**Why.** It is the `physical`-mode input (`docs/fem.md` §3.2). Without a shared
convention the exporter invents its own home for μr and it differs from
`magpylib-material-response`'s — at which point tier 1's three-way comparison
silently compares magnets that are **not the same magnet**, and the discrepancy
looks like physics.

**Done when.** Merged upstream, or a documented studio-side convention exists
that material-response also reads.

### M2 — Public constructor-parameter introspection

**Why.** Studio hardcodes `_PARAM_ATTRS`; the physics layer (V1) needs the
identical table, so a new magnet class in core would fall silently through
**both** copies.

**Done when.** `get_params` reads it instead of the literal tuple.

---

## Track V — Validation

Full plan and its gates in [docs/fem.md](docs/fem.md). Only V1 is orthogonal to
Track F; the rest build on the foundation and should follow it.

**Order amended** ([docs/roadmap.md](docs/roadmap.md) R7, pending a yes): units,
the physics layer, then the pyAEDT emitter checked at tier 0 on the Maxwell seat
against magpylib, and the open solver after. Back from Ansys: design variable
values and the field at the sensors, never geometry (R8).

### V1 — The physics layer (orthogonal — start any time)

Package skeleton and the §4 home decision · conventions module (§3.1's verified
table, including the two off-by-two traps) · the required `ideal`/`physical`
mode switch (§3.2) · solver-free conformance: the `getJ` occupancy test plus the
volume/centroid check.

**Why it can run alongside F.** Different repo, magpylib objects only, no
solver, no studio change, no open decision. Reaches `docs/fem.md`'s **G1** with
nothing installed.

### V2 — Units

Unit _kind_ on a variable beside `integer`; one model unit per document;
emitters convert at the boundary. Cheaper than `docs/fem.md` §6 implies —
`_PARAM_UNITS` already sits beside `_PARAM_ATTRS`. **Interacts with F2**: a
definition's parameters want units for the same reason its variables do.

### V3 — Jobs in the RPC protocol

Worker subprocess, server-initiated notifications, a job id space, cancellation.
`serve()` is a strictly serial blocking loop with no threading, asyncio or
subprocess anywhere in the engine, so a solve through it freezes the whole UI
for minutes. Also pays for mesh reorientation blocking the same loop at 16 s.

### V4 — Refusal-first job API

Errors, not warnings, on: a residual without convergence metadata, a solve past
budget, a comparison mixing `ideal` and `physical`. `docs/fem.md` §13.5 — an
agent ignores a warning field and hill-climbs on mesh noise. **Cost rises the
longer callers depend on permissive behaviour**, so decide the shape early even
if the work lands late.

### V5 — Source/probe hash partition

A content hash over field-affecting events only, excluding sensors and pixel
grids. Solve once, probe forever. Undo back to a previous state must reproduce
that state's earlier hash — that property is what turns history navigation into
free FEM navigation.

---

## Track W — The notebook widget

### W1 — Edit in a notebook

**What.** `SceneWidget(..., editable=True)`: the widget with the studio's
handles, backed by a session in the kernel; undo, `to_script`, live objects.
Plan in [docs/editable-widget.md](docs/editable-widget.md).

**Why.** Editing works only in VS Code today, yet the engine and the view both
ship in the Python package: a notebook can have it with nothing else installed.

**Done when.** The first slice works in Jupyter and marimo from the wheel alone,
and the VS Code panel uses the same drag code.

### W2 — One view

**What.** The VS Code studio panel draws the notebook widget, as the script
panel does, so there is one set of controls. Plan in
[docs/one-view.md](docs/one-view.md).

**Why.** Two interfaces around one renderer: every control and fix is made
twice, or the two drift — and they have.

**Done when.** `studio.mjs` and the panel's own controls are gone, and the
checklist in `docs/one-view.md` §5 passes by hand in VS Code.

---

## Track A — Agents

Plan in [docs/roadmap.md](docs/roadmap.md) R3–R6, amended 2026-10-06 after
marimo's agent work (roadmap §3). The guideline it follows: consolidate tools,
return high-signal results, and evaluate with agents; marimo's experience adds
that the agent's code is the interface, not a set of fixed tools around it.

### A1 — Builder code against the live scene (R3)

One way in: the agent's Python run against the open scene — builder calls (one
undo step per run, refused whole with its line, as R1's save is), the scene as
builder code and its variables to read, and field summaries as helpers in scope
— in place of the 24 one-per-operation LM tools. Shipped as an Agent Skill and a
CLI into the running engine, with MCP as an adapter for hosts without skills
(pending a yes, roadmap §6); the engine has to be reachable from outside the
editor for that. In marimo, marimo pair already reaches an editable widget's
session; the view must follow edits made to it from outside. Decide the trust
model for agent-written code first.

### A2 — An agent evaluation set (R4)

About twenty magnetics tasks with checkable targets, run with the old tools and
the new, in VS Code and through marimo pair; success, tokens, turns and refusals
recorded and kept.

### A3 — Pointing, then the view in the chat (R5)

The person marks magnets in the 3D view and leaves a note; the agent gets their
ids, the steps and builder lines that made them and their variables, and points
back. In marimo, as marimo-lens targets on the widget's legend; in VS Code, the
same channel natively. Then the 3D view interactive in the chat, as an MCP App,
its sliders calling back.

### A4 — The skill (R6, folded into A1)

The `SKILL.md` A1 ships: conventions, the builder's rules, what each refusal
means, how to point; a reference generated from the builder and tested against
it; current capability only.

## Not scheduled, and why

- **Anything downstream of `docs/fem.md`'s G3 spike** — the solver is
  deliberately undecided until it is measured.
- **F4** — see above.
- **The agent skill** (`docs/fem.md` M9) — a skill may only describe an API that
  exists.
