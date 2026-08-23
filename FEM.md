# FEM integration — plan

Companion to `CONTINUE.md`. Written to be committed and edited in place as
decisions land. Where a decision is made, the reason it was made _and_ the
reason the alternative was rejected are both recorded — the alternatives here
are all defensible, so a bare verdict would be re-litigated in six months.

Status: **nothing is built yet.** This is M0.

---

## 1. The thesis

Magpylib computes the field of ideally polarized bodies, analytically, in
milliseconds. FEM computes the field of real materials in a truncated domain,
numerically, in minutes. The interesting thing is not that one checks the other.
It is that **the gap between them is a measurable quantity, and that quantity is
the domain boundary of the analytic model.**

The pitch is therefore not "validate magpylib with FEM". It is:

> Prototype parametrically in magpylib at 1.7 ms a rebuild, then spend FEM time
> only on the handful of configurations that matter — and get told, in numbers,
> where the analytic model stopped being trustworthy.

`magpylib-material-response` sharpens this rather than obsoleting it. Its
`apply_demag(collection, susceptibility=...)` is a dense interaction-matrix MoM
over meshed cells; it buys self-demagnetization, inhomogeneous polarization and
linear soft-magnetic μr ~ 1000. It does **not** buy nonlinear B-H (saturation),
eddy currents, transients or thermal coupling. So once it is integrated, the FEM
claim narrows from the vague "validates everything" to the sharp and defensible
**"finds the saturation boundary, and audits the MoM in its hard regime"**.

### 1.1 The standing rule

> **Never report a difference between two methods without having converged
> both.**

Both sides have knobs — mesh refinement and domain size on the FEM side, cell
count on the MoM side, `meshing` on `getFT`. A comparison that sweeps neither is
two unconverged numbers with the residual reported as physics. This rule is why
every fixture in §8 carries convergence metadata, and why the M3 gate is about
_convergence_ rather than about a single error figure.

---

## 2. The validation ladder

The backbone of the whole plan. Each tier turns on exactly one physical effect,
has a different oracle, and answers a different question. **Do not merge tiers**
— a disagreement that could have come from two sources tells you nothing.

| Tier  | Physics on                        | Oracle                                   | What a pass means                                                            |
| ----- | --------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| **0** | μr = 1, one body, vacuum          | magpylib analytic (**exact**)            | The _translation_ is correct: pose, units, sign, Hc, geometry                |
| **1** | μr = 1.05 (NdFeB self-demag)      | material-response, cross-checked by FEM  | Three-way agreement; and the size of magpylib's own error is now _measured_  |
| **2** | linear soft-magnetic, μr ~ 1000   | FEM (material-response under audit)      | The MoM is trustworthy at N cells — or it is not, and we know the N          |
| **3** | nonlinear B-H                     | FEM only (FEMM in 2D)                    | Both analytic methods are **out of domain**; the deliverable is the boundary |
| **4** | force & torque                    | `getFT` vs virtual work / Maxwell stress | Deferred; see §10.5                                                          |
| —     | eddy currents, transient, thermal | —                                        | **Explicitly out of scope.** Named so nobody expects it.                     |

**Tier 0 is the only tier where the answer is known a priori**, and it is
therefore the only tier that can find bugs in our own code rather than in
physics. It gets the harshest criteria and it gates everything downstream.

**Tier 1 is the first publishable artifact.** Magpylib's own docs already teach
this by hand — "the remanence corresponds to the `polarization` magnitude when
no material response is modeled (typically 95% correct)", with a pointer to a
demagnetization-factor table on magpar.net. Tier 1 turns that sentence into a
generated curve over L/D.

---

## 3. Architecture: one physics layer, several consumers

```
            ┌───────────────────────────────────────────┐
            │  physics layer  (target-free, pure)       │
            │  pose · geometry · J→(Hc,μr) · units      │
            └───────────────────────────────────────────┘
                 │            │             │
        ┌────────┘            │             └────────┐
        ▼                     ▼                      ▼
  open solver driver    pyAEDT emitter        (COMSOL/MPh, later)
  solve() in-process    text, no license      near-free once layer exists
        │                     │
        └──────────┬──────────┘
                   ▼
        comparison + fixtures + convergence
                   │
                   ▼
        studio: document → variables, log, sweep, UI
```

**The split is the whole design.** It is what converts "an untestable
proprietary integration" into "a well-tested pure function plus a string
template". Get it wrong and no test strategy rescues the Ansys path.

### 3.1 What is in the layer

Pure functions over magpylib objects. No solver import, no vendor import, no
document. Every convention below was **verified against magpylib 5.x in this
checkout**, not read off documentation:

| Quantity          | magpylib                                                                                                   | Verified                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Cuboid`          | `position` = **center**; `dimension` = **full** edge lengths (a,b,c); body spans ±dim/2 in the local frame | `getJ` at center = J, just past the +x face = 0         |
| `Cylinder`        | `dimension` = (**diameter**, height); axis = local z; z ∈ ±h/2                                             | `getJ` at z=1.9 = J, z=2.1 = 0 for h=4                  |
| `Sphere`          | `diameter`, not radius                                                                                     | —                                                       |
| `CylinderSegment` | `dimension` = (r1, r2, h, φ1, φ2), **degrees**; position = center of the full cylinder; z ∈ ±h/2           | probe inside at (1.5, 0.1, 0), outside at z=0.6 for h=1 |
| polarization      | `.polarization` is in the **local frame**                                                                  | 90° about x maps (0,0,1) → (0,−1,0)                     |
| world-frame J     | `orientation.apply(polarization)`                                                                          | matches `getJ` inside the body exactly                  |
| magnetization     | M = J/μ0                                                                                                   | 1 T → 795 774.715 564 55 A/m, μ0 = 1.256 637 061 27e−6  |
| pose → euler      | `orientation.as_euler("ZXZ", degrees=True)` (scipy uppercase = **intrinsic**)                              | 90° about x → (0, 90, 0)                                |

Two off-by-two traps are recorded above deliberately: `Cylinder` and `Sphere`
take **diameter**, and `Cuboid` takes **full** edge lengths while `create_box`
takes a corner. Both are the kind of bug that produces a plausible-looking
field.

### 3.2 The ideal/physical switch — do not skip this

A magpylib magnet is μr = 1 by construction. A Maxwell magnet with the same Br
and μr = 1.05 is **a different magnet**, and it will disagree — correctly.

So every emitter takes an explicit mode:

- **ideal** (μr = 1): reproduces magpylib exactly. Used for tier 0. Validates
  _our translation_.
- **physical** (μr from the datasheet): the real magnet. Used for tiers 1+.
  Measures _the modelling error_.

Conflating these is the single easiest way to produce a comparison that means
nothing while looking rigorous. The mode is a required argument with no default.

### 3.3 What is _not_ in the layer

Anything that touches the studio document: variables, the event log, `sweep()`,
`_scene_extent()`, the UI. See §4.

---

## 4. Where the code lives

Asked to compare rather than assume. Three options, and the recommendation is a
split rather than a pick.

**A. Standalone `magpylib-fem`.** Operates on magpylib objects only. _For:_ a
plain magpylib user gets the validation story without ever opening studio —
which matters, since tier-1 is a community deliverable. Heavy solver deps and a
heavy CI matrix (NGSolve wheels, possibly Windows for FEMM) stay out of studio's
181-test suite and its 0.26 s cold start. Own release cadence. _Against:_ a
third repo; and the _parametric_ half genuinely needs the document, so it would
be stranded.

**B. Inside magpylib-studio.** _For:_ direct access to the document, the event
log, `sweep()` and `_scene_extent()`; one repo, no version dance. _Against:_
solver dependencies land in a package whose selling point is being a light
engine; a plain magpylib user gets nothing.

**C. Inside magpylib core.** _Rejected._ Core is deliberately analytic-only and
has no parametric document to export from. A vendor emitter there is a coupling
with no upside for the library's actual job.

### Recommendation: A **and** B, split at the real seam

Not a compromise — the actual boundary:

- **`magpylib-fem`**: everything that operates on _magpylib objects_. Geometry
  and material translation, pose, the occupancy test (§8.2), solver drivers,
  comparison metrics, fixtures. Solvers as optional extras.
- **magpylib-studio**: everything that operates on the _document_. Variables →
  design variables, event log → modeler history, `sweep()` → parametric setup,
  the residual view. Depends on `magpylib-fem` as an extra.

One half is physics and needs only objects; the other is parametrics and needs
the document. This also makes the gates clean: **M1–M4 land entirely in
`magpylib-fem`** and are worth having even if studio integration never happens.

Honest cost: two repos to version together, and one integration test spanning
them. Confirm this at M1, when the layer's surface is concrete.

---

## 5. Solver selection — staged, decided by a spike

Deliberately not decided here. Criteria first, then a timeboxed spike, then the
verdict is written back into this section.

### 5.1 Criteria

1. **3D.** Non-negotiable for real assemblies (a Halbach ring is not 2D).
2. **Permanent magnet as a first-class source** — a magnetization or coercivity
   source term without hacks.
3. **Python-native, pip-installable** — the "stays in studio" requirement.
4. **License** compatible with a BSD-3 package: LGPL acceptable as an optional
   import; **GPL only at subprocess distance**; never a hard dependency.
5. **Open-boundary handling.** The accuracy-limiting factor (§10.1).
6. **Nonlinear B-H** for tier 3.
7. **CI wheels** on linux + macOS arm64 + windows.
8. **Force/torque post-processing** for tier 4.

### 5.2 Candidates

|                               | 3D   | PM source        | Python                      | License  | Open bdy           | Nonlinear |
| ----------------------------- | ---- | ---------------- | --------------------------- | -------- | ------------------ | --------- |
| **NGSolve/Netgen**            | ✓    | ✓ tutorial       | ✓✓ pip, `netgen.occ`        | LGPL     | ✗ DIY              | DIY       |
| **Gmsh + GetDP**              | ✓    | ✓✓ mature `.pro` | gmsh pip / getdp subprocess | GPL ⚠    | ✓✓ shell transform | ✓         |
| **Elmer**                     | ✓    | ✓                | ✗ SIF files                 | LGPL     | partial            | ✓         |
| **FEMM + pyfemm**             | ✗ 2D | ✓✓               | ✓                           | free-ish | ✓                  | ✓✓        |
| dolfinx / scikit-fem / PyMFEM | ✓    | you write it     | ✓                           | —        | DIY                | DIY       |

**The honest read: GetDP is stronger on physics, NGSolve is stronger on
integration.** NGSolve's `netgen.occ` gives `Box`/`Cylinder`/`Sphere` primitives
that mirror magpylib's the same way pyAEDT's modeler does, so one geometry
emitter serves both targets — that is a real architectural saving. GetDP brings
mature magnetostatic formulations _including_ a shell transformation for the
open boundary, which is the thing most likely to dominate our error budget. This
tension is exactly why it is a spike and not a verdict.

FEMM is not a competitor: it is a **2D nonlinear oracle**. Seconds per solve and
decades of validation mean you can run hundreds of axisymmetric cases, which is
how tier 3 gets any statistical weight. Plan to have it _as well_, not
_instead_.

The pure-FEM-library options are rejected as backends for one reason: you would
be writing a solver (gauge fixing, truncation, PM source term) rather than
integrating one. Keep one of them in mind only as an independent reference
implementation for a single hand-checked case.

### 5.3 The hedge

**Define the driver interface before the spike, not after.**

```python
solve(bodies, region, probes, *, mode, refinement) -> B_at_probes  (+ metadata)
```

If the interface is small enough, two backends cost little and the decision
stops being irreversible. The spike then produces two working implementations
rather than one plus regret.

---

## 6. Units — resolve, with the cheapest correct answer

`CONTINUE.md` flags units as "the one open question on the parametric side" and
warns that migrating variables later will hurt. FEM export forces the issue:
AEDT wants `"5mm"`, solvers want consistent SI.

### The decision

**The document stays bare SI. Units become metadata, not values.**

- A variable gains an optional **unit kind** (`length` m, `angle` deg, `field`
  T, `current` A, `dimensionless`, plus the existing `integer`) stored beside
  `integer` in `variable_bounds`.
- A document declares one **model unit** for emitters (mm typical).
- Emitters convert SI → model units at the boundary and emit `"5mm"`.
- The UI formats and parses with the kind: `gap: 5 mm`, not `0.005`.

### Why not unit-carrying values

Because `"5mm"` does not start with `=`, so today it is a **string literal**.
Making it a quantity breaks the one rule expressions.py is built on — _a string
starting with `=` is an expression, anything else is a literal_ — which is the
rule that keeps `"z"` an axis name with no per-field whitelist. That rule is
worth more than dimensional analysis.

### What this buys, and what it does not

**Buys:** zero document migration (every existing document stays valid — the
`CONTINUE.md` worry becomes moot), untouched evaluator semantics, readable AEDT
output, readable sliders.

**Does not buy:** dimensional _checking_. `gap * current` will not be caught.
That is the honest cost, and it is the right trade — magpylib does not check
dimensions either, and inventing a dimensional algebra to serve a display
concern is the tail wagging the dog.

**Precedent, not invention:** `integer` already lives in `variable_bounds`
because it is "the same kind of statement" as a bound. A unit kind is the same
kind of statement again.

**Wrinkle to handle:** angles are stored in degrees (magpylib's
`rotate_from_angax` convention) while `expressions.py` exposes `radians()` and
`degrees()`. The `angle` kind must record which, and the emitter must not
double-convert.

---

## 7. Why this order

Physics layer → open solver → Ansys. The tempting order is the reverse, because
`to_aedt_script()` is the deliverable with an immediate use at work. Resist it.

**FEM output carries enormous rhetorical weight.** "Maxwell says 43.2 mT" ends
arguments. An unvalidated translation that produces confident wrong numbers is
strictly worse than having no tool at all, because it is believed. Building the
Ansys emitter first means the translation is only ever validated by eyeball —
and eyeball validation of a plausible-looking field is not validation.

Doing the open path first means that by the time the AEDT script exists, its
physics layer has already been checked against an exact analytic solution and an
independent numerical one.

---

## 8. Testing a target you cannot run in CI

Principle: **never test the vendor. Test the emitter as text, and test the
physics where you can run it.**

### 8.1 Pure unit tests of the physics layer

No solver, no vendor, no document. Every convention in §3.1 pinned by a test.
Milliseconds. Runs everywhere. This is most of the correctness.

### 8.2 The `getJ` occupancy test — solver-free geometry conformance

The cheapest high-value test in the plan, and it needs nothing installed.

`magpy.getJ(obj, points)` returns the world-frame polarization: **J inside the
body, zero outside** (verified). So:

> Sample `getJ` on a grid. Compare against a point-membership predicate built
> from the _emitted_ geometry. Any disagreement is a translation bug.

This catches the entire class of translation errors — center-vs-corner,
diameter-vs-radius, degrees-vs-radians, local-vs-world polarization, wrong euler
convention — **before a single solve**, and it does it by comparing magpylib
against our own emitter rather than against a solver's opinion.

Applicability is honest: it works wherever a membership predicate exists on the
target side — a pure-Python evaluator for the primitives, and NGSolve/OCC where
the material coefficient can be evaluated at points. **It does not work for
AEDT**, which cannot be queried without a license; that path relies on §8.3–8.5
instead.

### 8.3 Golden text + AST conformance

Every emitter's output is deterministic strings; snapshot them. The project
already has this discipline (canonical expression spacing, fixed document key
order — "the same document is the same text however it was assembled"), so a new
emitter inherits it.

Then parse the emitted script with `ast` and check every call against an
allow-list with the right arity and kwargs.

### 8.4 pyAEDT signature conformance — the trick worth knowing

**`ansys-aedt-core` is pure Python and pip-installs without AEDT.** Only
instantiating `Maxwell3d()` needs a license. So CI can introspect the real
signatures for free:

```python
import ast, inspect
from ansys.aedt.core.modeler.modeler_3d import Modeler3D
# every call in the emitted script: does the method exist? are the kwargs real?
```

This catches the _actual_ failure mode — pyAEDT renaming a kwarg on
`pip install -U`. There is precedent: the package already moved from `pyaedt` to
`ansys.aedt.core`. Zero license cost, highest value per line in the suite.

### 8.5 Open-solver reference solves

Nightly / `-m solver`, not on every PR. Compared against committed fixtures.

### 8.6 The licensed Maxwell gate

Manual, before a release, on the Maxwell 3D seat. A handful of reference scenes,
not a suite. Regenerates the AEDT fixtures; **the diff is reviewed**.

### 8.7 Fixture discipline

`fixtures/<scene>.<solver>.json`, holding: scene hash, solver name + version,
mesh and domain parameters, probe points, B values, **and convergence metadata**
(§1.1). Regeneration is an explicit command. A change in numbers without a
change in scene is a finding, not a rubber stamp.

### 8.8 ⚠ Publishing benchmark numbers

Ansys license agreements commonly restrict publishing benchmark or comparison
results. Since the audience is both work and community: **publish the
open-solver numbers freely; keep Maxwell numbers as local fixtures unless the
terms have been checked.** This is one more argument for the open path being
primary rather than a nice-to-have.

---

## 9. Milestones and gates

Front-loaded so the cheap, reversible work comes first and each stage can stop
without waste.

**M0 — Decide and record.** This document. _No gate._

**M1 — Physics layer, target-free.** Pure functions plus tests; §3.1 conventions
and §3.2 mode switch. Lands in `magpylib-fem`. No solver, no vendor, no
document. → **G1:** every convention pinned by a test; occupancy test (§8.2)
green for the four primitives against a pure-Python membership evaluator. _This
milestone is worth having even if everything after it is abandoned._

**M2 — Driver interface + reference scene set.** Define `solve(...)` (§5.3).
Choose ~6 scenes: cube, cylinder, sphere, facing pair, Halbach ring, magnet +
pole piece. → **G2:** the interface is implementable on paper for both
candidates.

**M3 — The spike. Two backends, one scene, measured.** Timeboxed. A 10 mm cube,
1 T, μr = 1, probes on a line from 5 mm to 50 mm. Measure tier-0 error against
_both_ convergence knobs, wall-clock at an interactive mesh, lines of code,
install friction on three platforms. → **G3 (go/no-go):** tier-0 error converges
under mesh refinement **and** domain growth to < 0.5 % of mean |B| on the probe
line, in at least one backend, at tolerable cost. **If it does not converge,
stop and re-plan** — everything downstream is worthless without tier 0. Write
the verdict back into §5.

**M4 — Tiers 0 and 1 across the reference set.** Fixtures committed. Three-way
agreement: analytic / material-response / FEM. → **G4:** the "magpylib alone is
X % low" curve over L/D reproduces the expectation the docs already state (~5 %
for typical geometries). _First publishable artifact._

**M5 — Units.** §6. Independent of M1–M4, blocks M6. → **G5:** every existing
document loads unchanged; script round-trip stable.

**M6 — pyAEDT emitter.** Reuses M1 wholesale. Golden text + AST + signature
conformance in CI; manual Maxwell gate produces AEDT fixtures. → **G6:** tier-0
agreement in Maxwell matches the open solver's tier-0 agreement to within the
two solvers' own spread.

**M7 — Studio integration.** Document → FEM; `sweep()` → parametric comparison;
residual view; domain-size diagnostic. → **G7:** a slider drag re-runs analytic
instantly and queues FEM asynchronously without blocking the UI.

**M8 — Tiers 2 and 3, and the boundary story.** Soft-magnetic; saturation with
FEMM as the 2D nonlinear oracle. Public deliverable: _here is where the analytic
model stops_.

**Later / maybe never:** tier 4 force, filament currents, reverse import.

---

## 10. Known hard parts

### 10.1 Open boundary — the likeliest source of a fake result

Magpylib solves an unbounded problem exactly. FEM truncates. **Truncation error
will dominate tier 0 unless it is managed**, and it will look exactly like a
translation bug.

Mitigations, in order: mandatory domain-size sweeps alongside mesh sweeps;
GetDP's shell transformation if the spike goes that way; AEDT's balloon boundary
on the Ansys side, which approximates open boundaries far better than a zero-A
outer wall.

**A diagnostic worth building:** compare magpylib's analytic far field against
the FEM field _on the truncation surface_. If they differ by more than a set
tolerance, the box is too small — reported to the user rather than silently
absorbed into the residual. (Using the analytic field as an outer Dirichlet
condition to shrink the box is a tempting extension, but it is only valid when
no soft-magnetic body perturbs the far field. Treat it as a speculative
optimization, not a given.)

### 10.2 Where you are allowed to evaluate

FEM fields are worst at material interfaces and inside sources; magpylib is
exact there. A comparison at a point on a magnet face compares FEM's weakest
number against an exact one and reports the difference as error. **Rule:
evaluate at least one element size away from any interface**, and record the
clearance in the fixture.

### 10.3 Filament currents have no FEM analogue

`current.Circle` and `current.Polyline` are ideal filaments: infinite field on
the wire, no volume. FEM needs a cross-section, and Maxwell needs closed loops
or terminals on a boundary. This is a _modelling decision the user must make_,
not something an exporter may guess. Follow the existing precedent — `mirror`
refuses a Tetrahedron by name, honestly — and either refuse or require an
explicit cross-section.

### 10.4 material-response scaling

`apply_demag` builds a dense interaction matrix: O(n²) in cells. Tier 2 (μr
~ 1000) is exactly where cell counts want to explode and the matrix conditions
badly. Use `max_dist` / `pairs_matching`, and cap scene size in tier-2 fixtures.

### 10.5 Force is cancellation-prone

`getFT` (meshed dipole sums, `meshing` on `BaseTarget`) versus virtual work or a
Maxwell stress integral: both are differences of large quantities, both are
mesh-noise-dominated, both have independent convergence knobs. Folding force
into tiers 0–3 would contaminate them. It gets its own tier, its own criteria,
and it goes last.

_(Sanity check already run: two 1 m, 1 T cubes 3 m apart, both polarized +z,
give −2331 N on the target — side-by-side parallel dipoles repel. The sign is
right, which is the first thing to check in any force comparison.)_

### 10.6 License hygiene

Studio is BSD-3. LGPL (NGSolve, Elmer) is fine as an _optional import_. GPL
(gmsh, GetDP) stays at **subprocess distance** and never becomes a hard
dependency. FEMM has its own free-but-not-OSI license. And see §8.8 for Ansys.

### 10.7 Two-repo skew

If the A+B split is taken, `magpylib-fem` and studio must be versioned together
and one integration test must span them. Small, but real, and it is the price of
the split.

### 10.8 The "looks authoritative" trap

Restating §7 as a standing risk, because it outlives the ordering decision: a
wrong number with a solver's name on it is more dangerous than no number. Every
tier-0 regression is a release blocker, not a warning.

---

## 11. Open questions

- **Which solver.** Decided by G3. Verdict gets written into §5.
- **Home of code.** §4 recommends the A+B split; confirm at M1 when the layer's
  surface is concrete.
- **Analytic-field boundary condition** as a domain-shrinking accelerator
  (§10.1) — worth a measurement, not yet worth a commitment.
- **The reverse direction.** FEM result → magpylib source (interpolated field or
  `CustomSource`), which would close the loop for system-level modelling. The
  magpylib docs already gesture at exactly this: _"the field might not be
  accessible through Magpylib, e.g. when demagnetization is included, but it can
  be computed with a 3rd party FE tool"_. Not planned; noted because the docs
  asked for it first.
- **Is tier 4 (force) worth the trouble at all**, given §10.5.
