# Tasks

What to do next, ordered by what gates what. The reasoning behind each item
lives in the plan it came from — this file stays thin enough to work from.

| Question                    | Document                                 |
| --------------------------- | ---------------------------------------- |
| What is this?               | [README.md](README.md)                   |
| What is built?              | [CONTINUE.md](CONTINUE.md)               |
| **What do I do next?**      | **this file**                            |
| Why is it going that way?   | [docs/direction.md](docs/direction.md)   |
| How does instancing work?   | [docs/instancing.md](docs/instancing.md) |
| How does FEM validation go? | [docs/fem.md](docs/fem.md)               |

**Track F (foundation) is primary.** It is what studio _is_ under the
positioning in `docs/direction.md` §1, and everything else is an application of
it. M runs in parallel because its lead time is upstream review rather than
ours. V is downstream of F except for V1, which is orthogonal — a different repo
that touches none of this.

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
opt-in. `load_script` is unchanged.

**Done.** `importer.py` 1133 → 372 lines, `apply_script` and
`_round_trip_warnings` removed, the extension rewired, 261 tests green and ruff
clean.

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

## Not scheduled, and why

- **Anything downstream of `docs/fem.md`'s G3 spike** — the solver is
  deliberately undecided until it is measured.
- **F4** — see above.
- **The agent skill** (`docs/fem.md` M9) — a skill may only describe an API that
  exists.
