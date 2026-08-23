# Tasks — preparing for the FEM work

The executable breakdown sitting between `FEM.md` (the plan) and doing it.
`DIRECTION.md` holds the architectural position; the review that produced this
list found the two do not collide.

## The review finding that matters

The direction research landed on **keep the document as the artifact**, and
`FEM.md` §12.1 already assumes exactly that: a cache key over source-affecting
events, `sources_all` / `sensors_all` as the partition, `set_rollback` and
`undo` as free FEM navigation. Had the answer been code-as-truth, all of §12.1
would need rewriting to a trace hash. It does not.

**So the open direction question blocks nothing below.** One positive
interaction rather than a dependency: parameterised instancing would give FEM a
library of validated assemblies and sweeps over instance parameters.

## Ordering

- **C starts now** — no blockers at all; needs no solver and no studio change.
- **B starts now, in parallel** — the longest lead, and it is upstream review
  time rather than ours.
- **A1 and A2 before any studio-side FEM UI.** A2's cost rises the longer it
  waits.
- **D is independent**, and shrinks the maintenance surface before FEM adds to
  it.

---

## Group A — studio work the FEM plan needs

### A1 — Jobs in the RPC protocol

**What.** Worker subprocess, server-initiated notifications, a job id space,
cancellation.

**Why.** `serve()` is a strictly serial blocking loop: one line in, one line
out, in order; every write echoes a request `id`, so there are no
server-initiated messages; and there is no `threading`, `asyncio` or
`subprocess` anywhere in the engine. A solve through it freezes the scene tree,
the inspector, the sliders and the 3D view for minutes. It also pays for
something already wanted — mesh reorientation blocks the same loop at 16 s for
20k faces.

**Done when.** A long call runs without blocking any other request, reports
progress, and can be cancelled; the existing test suite still passes.

**Blocks.** `FEM.md` M7, and all three workflows in §12.

### A2 — Refusal-first job API

**What.** The job API **errors**, rather than warns, on: a residual without
convergence metadata, a solve past budget, and a comparison mixing `ideal` and
`physical` mode.

**Why.** §13.5. A human glances at a "provisional" badge; an agent ignores a
warning field and hill-climbs on mesh noise, confidently, for hours. And the
guardrail cannot live in a skill file — the README's _"there is no second
validation layer"_ settles where it goes. Cheap now, expensive once callers
depend on permissive behaviour.

**Done when.** Each of the three refusals has a test asserting an error rather
than a warning.

### A3 — Source/probe hash partition

**What.** A content hash over field-affecting events only — magnets, currents,
anything with μr ≠ 1, and the transforms carrying them — excluding sensors and
pixel grids.

**Why.** Solve once, probe forever. Moving a sensor must not invalidate a solve.

**Done when.** Moving a sensor leaves the hash unchanged; changing a magnet
changes it; and undoing back to a previous state reproduces that state's earlier
hash exactly. The last property is what turns history navigation into free FEM
navigation.

### A4 — Units

**What.** A unit _kind_ on a variable, beside `integer`; one model unit per
document; emitters convert at the boundary; the UI formats.

**Why.** AEDT wants `"5mm"`, solvers want consistent SI, and `FEM.md` §6 chose
metadata over unit-carrying values so no document migrates. Cheaper than that
section implies: `_PARAM_UNITS` already sits beside `_PARAM_ATTRS`.

**Done when.** Every existing document loads unchanged and the script round-trip
is stable.

**Blocks.** M6.

---

## Group B — magpylib core (start now; upstream lead time is the constraint)

### B1 — `susceptibility` / μr as a documented property

**What.** A real property on magnets, rather than the attribute
`magpylib-material-response` monkey-attaches and searches parents for.

**Why.** It is the `physical`-mode input. Without a shared convention the
exporter invents its own home for μr and it differs from material-response's —
at which point tier 1's three-way comparison silently compares magnets that are
**not the same magnet**, and the discrepancy looks like physics.

**Done when.** Merged upstream, or a documented studio-side convention exists
that material-response also reads.

### B2 — Public constructor-parameter introspection

**What.** One accessor upstream replacing studio's hardcoded `_PARAM_ATTRS`.

**Why.** The physics layer needs the identical table, so a new magnet class in
core would fall silently through **both** copies.

**Done when.** `get_params` reads it instead of the literal tuple.

---

## Group C — the physics layer (unblocked, start today)

### C1 — Package skeleton and the home decision

**What.** Settle `FEM.md` §4's split — physics on magpylib objects in a
standalone package, parametrics on the document in studio — and create it.

**Done when.** It imports, has CI, and depends only on magpylib.

### C2 — Conventions module

**What.** Pose → euler, J → (Hc, μr, world direction), geometry-parameter
normalisation. Pure functions, no solver, no vendor, no document.

**Why.** `FEM.md` §3.1's table, verified against a live checkout — including the
two off-by-two traps: `Cylinder` and `Sphere` take **diameter**, and `Cuboid`
takes **full** edge lengths while `create_box` takes a corner.

**Done when.** Every row of that table is pinned by a test.

### C3 — The ideal / physical switch

**What.** A required mode argument with no default.

**Why.** §3.2. A μr = 1 magnet and a μr = 1.05 magnet with the same Br are
different magnets. `ideal` validates our translation; `physical` measures the
modelling error. Conflating them yields a comparison that means nothing while
looking rigorous.

**Done when.** No call site can omit it.

### C4 — Solver-free conformance tests

**What.** The `getJ` occupancy test, plus the volume/centroid check beside it.

**Why.** Catches centre-vs-corner, diameter-vs-radius, degrees-vs-radians,
local-vs-world polarisation and a wrong Euler convention — with **nothing
installed**.

**Done when.** Green for `Cuboid`, `Cylinder`, `Sphere` and `CylinderSegment`
against a pure-Python membership evaluator. This is `FEM.md`'s **G1**.

---

## Group D — drag reduction

### D1 — Kill `parse_script`; `to_script` becomes export only

**What.** Remove the read-back path and the matched emitter/parser idiom pairs
(`_mirror`, `_superquadric`, the `for i in range(1, n)` loop shape, the
`_name_copy` line that is emitted and then skipped).

**Why.** `DIRECTION.md` §2's cliff and §5.1, and every project in its §4 table
generating one-way. Shrink the maintenance surface before FEM adds to it.

**Careful.** `load_script`, `apply_script` and the script tab depend on it. The
script tab stops being applied on save — that is a UI change, not only a
deletion, and it needs deciding rather than discovering.

**Done when.** The round trip is gone, import still works by execution, and the
two-tier cliff is no longer reachable.

### D2 — ~~Rewrite `DIRECTION.md`~~ **done**

Rewritten around _data is the artifact / one-way generation / parameterised
instancing_, with code-as-truth kept as §7's recorded-and-rejected alternative
and §4 carrying the Bazel, Jsonnet, Onshape, Godot and OpenSCAD evidence.

---

## Not started, and why

- **Anything downstream of `FEM.md`'s G3 spike** — the solver is deliberately
  undecided until it is measured.
- **Parameterised instancing** (`DIRECTION.md` §5.2) — the missing reuse
  feature, and the answer to all four units of reuse. Agreed in principle, not
  scoped, and not a FEM dependency, so it is deliberately not in the groups
  above.
- **Growing `expressions.py` toward Starlark** (`DIRECTION.md` §5.4) — the right
  answer and the expensive one. Nothing forces the choice yet.
- **The agent skill (M9)** — a skill may only describe an API that exists.
