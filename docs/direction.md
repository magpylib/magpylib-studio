# Direction — what magpylib-studio is for, and what follows for the model

**Status.** §1 (positioning) is settled. §5 (the architectural proposal) follows
from the evidence in §4 and is not implemented. §7 records the alternative that
was argued first and rejected — kept because the reasoning is worth having, and
because it is how this file's conclusion arrived. Companion to `CONTINUE.md`
(what is built), `docs/fem.md` (where validation goes) and `TASKS.md` (what to
do).

---

## 1. The positioning

The original pitch was _magnetics without much Python_ — a GUI for people with
minimal Python skills. That audience is being commoditised by coding agents, and
the pitch erodes with it.

The pitch that replaces it: **studio is the binding that makes expert work
structured, reproducible, parametric and cheap to re-run.** The Python package
is the product; the VS Code extension is one consumer of it.

The gap is real. Everything studio does can be done with plain VS Code, Python
and magpylib core — and routinely is, at the cost of a pile of bespoke
scaffolding per project, in tokens and in hours, that does not carry to the next
problem. Studio's job is to make that scaffolding a dependency instead of a
rewrite.

Two constraints follow, and they bind hard:

- **Not a do-it-all tool.** Every invented concept is a tax on a user who has to
  learn it and an agent who has to be told about it.
- **The learning curve stays flat.** For this audience that means things they
  already know, not things we designed.

And the principle §4 establishes empirically, stated here because everything
below depends on it:

> **Data is the artifact. A small, deterministic language generates it. The GUI
> edits the data. Nobody round-trips.**

---

## 2. The problem is the round trip, not the document

`CONTINUE.md` states the principle that governs the document model:

> **"Two stored representations of one structure would drift, so there is only
> one."**

Written about `doc["objects"]` being a projection of `doc["events"]`. It is
correct, and it applies again one level up — because **the event log and the
script are two representations of one structure.** Both are ordered logs of
build operations. They drift, and the machinery that stops them drifting is
already visible:

- `parse_script` exists solely to read back what `to_script` wrote.
- Matched emitter/parser idiom pairs: `_mirror`, `_superquadric`, the
  `for i in range(1, n): …copy()…` loop shape, the `_name_copy` assignment that
  is emitted and then deliberately skipped on the way back in.
- Every new expressive feature costs **two** pieces of code that must agree
  forever.

And the failure is not graceful.
[`importer.py:861`](../magpylib_studio/importer.py):

> _"A script in the shape `to_script` emits -> (document, None), or (None,
> reason) when it is anything else and **has to be executed**."_

Two tiers with a cliff between them:

| Tier           | Reached when                                 | You get                                          |
| -------------- | -------------------------------------------- | ------------------------------------------------ |
| **Structured** | the script is exactly what `to_script` emits | variables, events, patterns, editability, sweeps |
| **Flat**       | anything else                                | the scene; **the parametric structure is gone**  |

The structured tier is not defined by a grammar. It is defined by _whatever
`to_script` currently happens to emit_. A helper function, an `if`, a scipy
call, a loop that is not the recognised idiom — any of them drops an expert to
the flat tier, which is precisely the tier that is not reusable, not parametric
and not replayable.

**The cliff sits exactly between what studio is for and what an expert writes.**

Note what this diagnosis does _not_ say. It does not say the document is the
wrong artifact. It says the round trip is the wrong mechanism. §7 is what
happens when those two get conflated.

---

## 3. Pressure test: how much of the GUI is really structural?

What would a parameter-bound viewer actually lose? The extension contributes
**53 commands**. Classified:

| Bucket                           | n      | If the GUI stops editing structure          |
| -------------------------------- | ------ | ------------------------------------------- |
| Session, file and view           | 17     | file operations the editor already provides |
| History and undo                 | 10     | editor undo and git                         |
| Variables                        | 6      | parameters                                  |
| Pose and parameters              | 5      | parameter binding — survives                |
| Presentation (style, visibility) | 2      | survives, and is genuinely GUI-shaped       |
| **Structural model edits**       | **13** | the actual question                         |

And the structural thirteen thin out. Four (`addMesh`, `importMesh`,
`meshFromPoints`, `meshFromFormula`) are file-or-formula import whose product is
one operation. `renameObject` is a rename. `copyObject` / `cutObject` /
`pasteObject` are clipboard.

**Irreducibly structural: five.** `addObject`, `removeObject`, `newCollection`,
`moveTo` (reparent), `duplicateAround`.

Five of fifty-three. Whatever the model decision, the structural surface a GUI
must support is far smaller than the command count suggests.

---

## 4. Prior art: what established teams shipped

A structured model and a text program describing the same thing is not a
magnetics problem. It has been fought out in build systems, configuration, CAD,
notebooks and game engines, and the outcomes are uniform enough to count as
evidence.

| Project                   | Artifact (the truth)    | Authoring surface                                                          | Round-trip? |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------- | ----------- |
| **Bazel** (Google)        | build graph             | **Starlark** — restricted Python: deterministic, hermetic, no recursion    | no          |
| **Jsonnet / Grafonnet**   | JSON                    | **Jsonnet** — pure functional, hermetic, "a small extension to JSON"       | no          |
| **AWS CDK**               | CloudFormation template | TypeScript / Python                                                        | no          |
| **Onshape**               | Part Studio document    | **FeatureScript** — Extrude, Fillet and Helix are themselves FeatureScript | no          |
| **Unity / Godot**         | scene and prefab files  | editor edits the data; scripts are separate                                | no          |
| **Terraform**             | state                   | HCL                                                                        | no          |
| FreeCAD, SolidWorks, AEDT | model / feature tree    | GUI; macros are recordings                                                 | no          |
| CadQuery / build123d      | code                    | viewer, plus parameters                                                    | no          |
| **marimo**                | pure `.py`              | reactive notebook UI                                                       | none needed |

**1. Nobody maintains bidirectional sync.** Every project picked a direction.
The canonical counter-example — WYSIWYG HTML editors round-tripping designer
edits against hand-written markup — is remembered as a cautionary tale.

**2. The pattern is not "code instead of data". It is "add functions to the data
format".** Jsonnet is _"a very small and carefully chosen extension to JSON"_.
Starlark is Python with recursion, top-level `for`, and global reassignment
removed. Neither replaced the data with a general-purpose language.

**3. Hermeticity is how the trust problem was solved, not traded.** Starlark
cannot reach the file system, the network or the clock, which makes it _"safe to
execute untrusted code"_; determinism is _"a design requirement… to ensure
reproducible builds"_. Jsonnet: _"the same JSON should be generated regardless
of the environment"_. **Studio already has the seed of this** — `expressions.py`
is a mini-Starlark: AST allow-list, no attribute access, no subscripts, no
comprehensions, never `eval`, deterministic, built for exactly the stated reason
that "a document is something you open from someone else".

**4. Google walked the general-purpose-language road and walked back.** Bazel
relied on the Python interpreter for build scripts from 2007, hit "scalability,
performance and maintenance issues", and spent until 2015 building a restricted
replacement.

**5. A structured format _can_ compose.** Godot saves any scene subtree as a
file and instances it as often as you like, parameterised per instance with
`@export` variables. Onshape custom features are the same idea: the standard
features are functions in FeatureScript, and a user-written one behaves
identically. **This is the component library, inside a model-is-truth system.**
(Godot's version has real rough edges — instance values resetting to scene
defaults is a recurring complaint — so it is proven, not free.)

**6. GUI-as-parameter-binder is solved and boring.** OpenSCAD's Customizer reads
top-level variable declarations with comment annotations, renders widgets, and
**does not modify the `.scad`** — preset values go to a sidecar `.json`.
Storybook's controls bind to component args. Streamlit re-runs the script with
new values.

**Counter-evidence, honestly.** HCL still outsells Pulumi and CloudFormation
became a compilation target rather than dying, which argues for keeping a
generated serialisation rather than for making code authoritative. And of ten
million Jupyter notebooks studied, **36 % were not reproducible** — what happens
when the artifact is neither cleanly code nor cleanly data.

---

## 5. The proposal: keep the document, kill the round trip, add instancing

Three changes, in increasing order of cost. The first two are the ones the
evidence makes obvious.

### 5.1 One-way generation

`to_script` becomes export and recording only. **`parse_script` goes**, along
with the matched idiom pairs and the two-tier cliff that comes with them.

This is what every project in §4 does, and it is the whole of §2's problem. The
document remains the artifact; the script stops pretending to be a second one.

Cost, stated because it is a UI decision and not only a deletion: the script tab
stops being applied on save. `load_script` and `apply_script` keep working by
execution, which is what they already fall back to.

### 5.2 Parameterised instancing

A scene subtree that can be instanced with arguments — Godot's `@export`,
Onshape's custom feature, Jsonnet's function.

This is the missing feature, not code-as-truth. All four wanted units of reuse —
component library, study recipe, agent workflow, provenance harness — are
composition units, and **§4's finding 5 is that a structured format can compose
if it has instancing plus exported parameters.** Studio has neither today, which
is why the reuse story currently runs through the script and falls off the
cliff.

### 5.3 What the GUI becomes

**A viewer with parameter binding.** Introspect the exported parameters, render
widgets, rebuild, draw. Structural editing stays available for the five commands
in §3 that need it; everything else is parameters.

The sync surface shrinks to "parameters → widgets", which cannot drift. Proven
shape: OpenSCAD Customizer, Storybook controls, Streamlit.

### 5.4 Later and optional: grow `expressions.py` toward Starlark

User-defined functions over the builders, still hermetic and deterministic. That
buys composition _and_ safety _and_ reproducibility, with documents still
openable from strangers.

Flagged as optional deliberately. §4's examples are multi-year efforts by funded
teams — Starlark took Google eight years to arrive at. 5.1 and 5.2 are the
affordable extraction; this is the ambitious version and it should not be
started on the strength of this document.

Meanwhile plain Python stays available as the **orchestration** layer that calls
the API — sweeps, studies, validation loops. That is where code genuinely wins
(§8) and it costs nothing to allow.

---

## 6. Why a code escape hatch is worse than either end

The tempting compromise: keep the document authoritative and add a first-class
`code` event, carried opaquely, executed but never parsed. It removes the cliff
without giving up structured editing.

It fails for one specific reason. **The moment that hatch exists the inert
document property dies anyway** — resolving a document now means executing it.
So it pays code's largest cost while keeping the document's limits: still no
parameterised import, still a schema to learn, and now Python embedded in JSON
with no editor, no imports and no tooling.

This is also why §5.4 is the honest version of the same wish: if arbitrary
computation is going into documents, it should go in as a hermetic language, not
as an opaque blob.

---

## 7. Recorded and rejected: code as the source of truth

The first version of this document argued that the `.py` should become the
model, with structure recovered by **tracing** — builders recording what they
built as they ran — rather than by parsing. The cliff dies either way, so it is
a real alternative and it was argued at length. Three findings moved the
conclusion off it.

**Godot refutes the composition argument.** The case rested on "documents cannot
do parameterised import without reinventing functions badly". Scene instancing
with `@export` is exactly parameterised import in a structured format (§4,
finding 5). Composition needs instancing, not a general-purpose language.

**Starlark refutes the trust trade.** The case accepted that opening a scene
would mean executing code, and proposed a derived inert format to recover
archival safety. But hermetic restriction _solves_ the problem rather than
trading it, and studio already has the seed of one in `expressions.py`.

**Bazel is the cautionary tale for the exact move.** Google started with Python
as the config surface and spent eight years replacing it.

Two further reasons not to spend the risk budget there: it is a **one-way door**
(`to_script` makes model→code easy; `parse_script` is what makes the reverse
hard, and it is the thing being deleted), and it bets agent reliability on a
small, unfamiliar Python API — the bad quadrant in §8.

What survives from that version: the diagnosis (§2), the pressure test (§3), the
parameter-bound viewer (§5.3), and the observation that a script must be
executed to be understood — which is why the artifact stays data.

---

## 8. What agents actually need — the evidence is split

Three findings that do not agree, and the reconciliation matters more than any
of them.

- **Structured operations beat code for constructing geometry.** Embodied CAD's
  agent selects from a skill library rather than emitting scripts, because
  errors in generated CAD code are "invisible at the token level but fatal at
  the CAD-kernel level": 100 % executable rate against 0 % for code-oriented
  baselines. Schema-enforced structured output fails <0.1 % against 5–10 % for
  free-form JSON.
- **Error rates track API surface and training-data density, not language.** One
  measured comparison across CAD-as-code engines: OpenSCAD ~0.4 errors per
  generation, build123d 1.4–1.7, CadQuery worse — because "a large, fluent,
  chainable API with hundreds of methods" is what models have not seen enough
  of. A small unfamiliar Python API is the bad quadrant.
- **Code beats discrete tool calls for orchestration.** Agents writing code to
  drive tools rather than calling them one at a time cut token use by 50–98 %,
  and code-first agents outperform on chaining and parallelisation.

**The reconciliation is the correction loop, not the representation.** Onshape's
MCP server has agents _generate_ FeatureScript and then "run it, evaluate the
results, identify errors, and revise" — code generation works there because the
loop is tight. Studio already has that asset, stated as a principle: _"a bad
edit is reported, not raised — so a GUI shows an error and an LLM self-corrects.
There is no second validation layer."_

So: **structured operations for building, code for orchestrating, and keep the
surface small and the loop tight either way.**

One more finding worth acting on, because it is the token complaint answered
directly. Onshape's stated reason for having agents write features rather than
geometry: _"The AI is used to generate the FeatureScript. Once the code exists,
it runs like any other custom feature"_ — no ongoing token expense, and the
result is shareable and parametric rather than a one-off. **The artifact of AI
work should be a reusable parameterised thing, not a scene.** That is §5.2's
argument arriving from the agent side.

---

## 9. Where this is wrong

1. **If beginners stay a primary audience**, the GUI must keep full structural
   edit power and §5.3 is too aggressive. §1's premise is load-bearing and is an
   assumption, not a finding.
2. **If the five structural commands in §3 turn out to be used constantly**,
   parameter binding is not enough. Measurable.
3. **If parameterised instancing proves as awkward as Godot's**, §5.2 costs more
   than it looks. Godot's known instance-value bugs are the warning.
4. **If agents break structured edits more than code**, §8's reconciliation is
   wrong. Purely empirical, and worth counting rather than assuming — this is
   the thinnest evidence in the document.

Evidence that would move §5 as a whole: an established project maintaining true
bidirectional model↔code sync in production. Evidence that would not: more
examples of one-way generation.

---

## 10. Migration, and what survives

Nothing here requires migrating a document. The artifact does not change; what
changes is that one direction of a two-way arrow is removed and a feature is
added.

| Survives                               | Retires                          |
| -------------------------------------- | -------------------------------- |
| the document, `to_dict`, `DOC_VERSION` | `parse_script`                   |
| `to_script`, as export and recording   | the matched emitter/parser pairs |
| field, figures, field maps, sweeps     | the two-tier cliff               |
| `expressions.py` — and §5.4 grows it   | the script tab applying on save  |
| the whole of `docs/fem.md`             |                                  |

`docs/fem.md` is unaffected in particular: §12.1 already assumes the document
stays the artifact, keys its cache on source-affecting events, and treats `undo`
and `set_rollback` as free navigation over the same fold.

---

## 11. Open questions

- **Style: written into the document, or a viewer overlay?** In the document is
  honest; an overlay is clean but is a second representation again, which is
  what §2 objects to.
- **What is the instancing unit** — a Collection subtree with exported
  parameters, or something narrower? Godot's rough edges are about exactly this.
- **How do the five structural commands feel in a parameter-first GUI?** Worth
  prototyping before §5.3 is committed to.
- **Does §5.4 ever get started?** It is the right answer and the expensive one,
  and nothing forces the choice yet.
