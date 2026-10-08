# Roadmap — what studio becomes, and in what order

**Status:** written 2026-10-05, amended 2026-10-06 and 2026-10-07, restructured
2026-10-08. This is the one list of what is next: each step says what it is,
why, and when it is done. What is built is in the
[changelog](../vscode-extension/CHANGELOG.md) and
[architecture.md](architecture.md); why the project is shaped this way is in
[direction.md](direction.md); each decision taken on the way is a record in
[decisions.md](decisions.md).

The positioning the order serves (direction.md §1): studio is the verifiable
magnetics design loop. Humans, code and agents edit one parametric document;
every candidate gets an exact field in milliseconds; FEM validation is one step
away; the log replays.

---

## 1. The steps, in order

### R1 — The script tab shows builder code, and its save applies ✅

Done 2026-10-06:
[decision 0007](decisions.md#0007-the-script-tab-is-builder-code).

### R2 — Units ✅

Done 2026-10-06 and 07: [decision 0008](decisions.md#0008-units-are-metadata).
The emitters' side of the boundary waits for R7.

### R3 — The agent interface: builder code, on its own copy first, then on the open scene

**Decided 2026-10-07**:
[decision 0009](decisions.md#0009-agents-write-builder-code-through-a-skill).
The code is the interface, and how it reaches the engine comes second.

**What.** One way in: the agent's Python, written with the builder. In scope for
that code:

| In scope              | What it is                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| a `Scene`             | builder calls: `Scene()` on its own copy; on the open scene (step 2), one undo step per run, refused whole (R1) |
| reads                 | the scene as builder code (`to_builder_script`), and the variables                                              |
| the field             | `get_field` and `sweep` on the scene's session; summaries as helpers if R4 shows they are worth having          |
| `validate` (after R7) | the FEM job API, refusal-first, per `plans/fem.md` §12–13                                                       |

**Step 1 — on its own copy: the skill ✅** (2026-10-07). An Agent Skill inside
the package, `magpylib_studio/.agents/skills/magpylib-studio/`, in the
library-skills layout, so it ships with the version it describes and
`uvx library-skills` links it into a project. The agent writes a builder script,
runs it with plain Python, reads the field through the scene's session, and the
person opens the result in the studio. Its API reference is generated from the
builder with a test that the two agree, and the tests run every example in it.

**Step 2 — on the open scene: a way in.** The person sees the agent's edits
arrive in the panel, each one an undo away. Today only the extension reaches the
engine, through the stdio of the process it started. The engine also listens on
a local connection only the person's account can use (with a token, as Jupyter's
kernels and marimo's server have one), and a small command runs builder code
against the open scene — `magpylib-studio run script.py`, the counterpart of
marimo pair's `execute-code`. The engine then has to tell the panel that its
scene changed, which the panel today learns only from its own calls; FEM's jobs
need the same server-initiated messages (V3), and so does the notebook view.
**Every run takes a scene** — its file — defaulting to the open one, so several
open scenes (R9) changes nothing about it.

**In a marimo notebook the way in exists already.** Through marimo pair an agent
runs code in the kernel that holds an editable `SceneWidget`'s session, reads
`widget.selected` and assigns it. Missing there: the view follows edits made
through its own calls only, so builder code run against its session from outside
leaves it stale until the next. A change hook on the session closes that — step
2's message, in the kernel.

**MCP when a host needs it.** Only a host with no terminal — Claude Desktop,
ChatGPT — needs an MCP server, and there running Python is new power. So it
comes with R5's view in the chat, which is MCP anyway, as an adapter over step
2's entry point, each run approved in the chat.

**Done when.** A run against the open scene lands as one undo step, refused
whole with its line when it fails, and the panel shows it without being asked.

### R4 — Evaluate with agents, before adding more

**What.** About twenty magnetics tasks with checkable targets: a Halbach ring
with B ≥ 0.1 T uniform to 2 % across a bore in at most N magnets; a coil giving
1 mT on axis 5 cm away with at most 100 turns; a sweep with the field reported
at a probe; a scene whose edit was refused, to repair; after R5, "this magnet".
Run first by an agent with plain magpylib and by the same agent with the skill,
headless; then through R3's step 2 and marimo pair once they exist. Record
success, tokens, turns and refusals. Keep the set in the repo and re-run it when
the interface changes.

**Why.** direction.md §9.4 names agent reliability the thinnest evidence and
asks for it to be counted. marimo pair's write-up gives no numbers, and
marimo-lens's paper says its effects "remain to be established".

**Started 2026-10-07:** [evals/](../evals/README.md), the runner and the first
ten tasks. First pass 2026-10-08, one run each, sonnet: plain 8/8, studio 10/10,
studio at 1.9× the cost on the shared tasks, most of it on the open design,
where the agent searched one guess per turn. **Next:** a multi-variable search
in the skill, measured again; three runs each for a spread; the other ten tasks.

### R5 — Pointing at the scene, then the view in the chat

**Amended 2026-10-06** after marimo-lens: attention first, the chat second.

**What, first: the person points, and the agent points back.** Mark a magnet, a
collection or a region of the 3D view and leave a note; the agent receives the
object ids, the steps that made them (the log's events, and the builder lines
that write them), the variables they depend on, and an image. The other way, the
agent outlines objects, frames them, and walks the person through a design, one
object and one sentence at a time. Lens's rule holds here too: pointing edits
nothing; the agent edits, through R3. Two routes, sharing that provenance:

- **in marimo**, the widget as a source of Lens targets: its legend rows carry
  `data-marimo-lens-target`, the object's label, and a `render-source` naming
  the builder line that creates the object, so Lens points at magnets with
  nothing of studio's own in between. Check first that Lens finds them inside
  the widget's own DOM, and what its image capture makes of the WebGL canvas.
- **in VS Code**, the same channel natively: the tree's and the view's
  selection, and a note, handed to the agent through R3's way in.

**Then: the view in the chat, as an MCP App.** The agent builds, and the person
sees the scene and drags its variables in the same conversation, the sliders
calling back. `to_html` already makes the view one self-contained HTML file;
what is missing is the host bridge for the sliders. Check the current MCP Apps
spec before building.

**Why the order.** Pointing serves the places the work already happens and costs
little, since `selected` is synced both ways already. The chat view serves one
more place, at the price of a host bridge.

### R6 — A skill for magpylib-studio

**Folded into R3** and started as its step 1. What it says: magpylib's
conventions (SI units, diameter not radius, polarization in the object's own
frame), the builder's rules, what each refusal means and how to fix it, and,
once R5 exists, how to point and be pointed at. Present tense and current
capability only (`plans/fem.md` §13.1): authoring and the field now, the open
scene when step 2 exists, FEM when FEM exists.

### R7 — FEM, with the order amended

`plans/fem.md` as planned, in this order:

1. units (R2) ✅;
2. the physics layer (M1);
3. the pyAEDT emitter (M6), **checked at tier 0 on the Maxwell seat against
   magpylib**, with the signature conformance (§8.4) and golden text (§8.3) in
   CI — written one scene to one design, so a folder of scenes can later become
   one AEDT project of several designs (R9);
4. the open solver (M2–M4) after, for validation CI can run and for tiers 1+.

**Why the change.** `plans/fem.md` §7 puts the open solver first so the
translation is never validated by eye. But tier 0's oracle is magpylib itself,
exact for μr = 1, so checking the Maxwell export against it is numerical, not
visual. **The cost:** until the open solver exists, validation is a manual run
on a licensed seat (§8.6), not CI. Why an emitter and not an LLM translating:
`plans/fem.md` §15.

### R8 — Values and results back from Ansys

**What.** Two flows back, no geometry: **design variable values** after an
Optimetrics run, into the studio's variables of the same names (with R2's unit
conversion), the `Scene(values=…)` split again; and **Maxwell's field at the
sensor points**, into the comparison view (`plans/fem.md` §12).

**Why not geometry.** An AEDT project holds far more than magpylib can:
booleans, iron, nonlinear B-H, windings, boundaries, mesh settings. Mapping that
back is lossy and wrong without saying so.

### R9 — Several scenes: a project is a folder, a scene is a file

**What.** No container format. A scene is one `.magpy.json` (and the builder
script it came from, where there is one); a project is the folder that holds
them. Several projects open is several windows or a multi-root workspace, and
needs nothing built. Several scenes open is the work:

- **one tab per scene** — the studio as a VS Code custom editor for
  `.magpy.json`, so opening a scene file opens it in the studio, side by side
  with others;
- **the sidebar follows the active tab** — tree, Variables, History and
  Inspector show whichever scene is in front;
- **one engine, a session per open scene** — requests routed by scene. The
  sessions are independent already (each notebook view has its own), so this is
  cheaper than a process per scene.

**Why a folder and not a file of scenes.** It is what Godot and Unity do, what
notebooks do and what VS Code is built around; `plans/instancing.md` already
decided that a definition lives in its own file; and one scene per file is one
diff per scene.

**Not separate scenes:** variants (mostly a set of variable values; a named
value set inside the scene, as OpenSCAD's Customizer keeps presets, may be the
right size of thing — open) and parameters shared across scenes (wait for
instancing).

**When.** The contract now (R3's code takes a scene); the editor after R7. Today
the extension holds one engine, one panel and one scene file as module-level
state, and the engine serves one session; the refactor touches all of it, and
nothing before R7 needs it.

### R10 and later

- **Structure kept in sync as a layer** (`plans/builder.md` §7, level 2) —
  designed, not started; it is an override layer, and `plans/instancing.md`
  warns where those go wrong.
- **Instancing** (`plans/instancing.md`, F2; the GUI as its parameter binder,
  F3) — unchanged; a placed instance is one more builder call when it exists.
- **A scene as a page anyone can open** — `to_html` with the views for listed
  variable values computed ahead, as marimo-studio's prepared exports do; and
  the widget inside a marimo-studio view.

## 2. Also tracked

Work that is not a step above but gates one, named as the old task list named it
so that older notes still read:

- **M1 — `susceptibility` / μr as a documented magpylib property.** The
  `physical`-mode input (`plans/fem.md` §3.2). Without a shared convention the
  exporter invents its own home for μr and it differs from
  `magpylib-material-response`'s, and tier 1's three-way comparison silently
  compares magnets that are not the same magnet. Done when merged upstream, or a
  documented studio-side convention exists that material-response also reads.
- **M2 — Public constructor-parameter introspection in magpylib.** Studio
  hardcodes `_PARAM_ATTRS`; the physics layer needs the identical table, so a
  new magnet class in core would fall silently through both copies. Done when
  `get_params` reads it instead of the literal tuple.
- **V3 — Jobs in the RPC protocol.** A worker subprocess, server-initiated
  notifications, a job id space, cancellation. `serve()` is a strictly serial
  blocking loop, so a solve through it freezes the whole UI; mesh reorientation
  already blocks it for 16 s. Shared with R3 step 2's "the scene changed"
  message.
- **V4 — Refusal-first job API.** Errors, not warnings, on a residual without
  convergence metadata, a solve past budget, a comparison mixing `ideal` and
  `physical` (`plans/fem.md` §13.5). Decide the shape early even if the work
  lands late: the cost rises the longer callers depend on permissive behaviour.
- **V5 — Source/probe hash partition.** A content hash over field-affecting
  events only, excluding sensors and pixel grids. Solve once, probe forever;
  undo back to a solved state is a cache hit.
- **F4 — Grow `expressions.py` toward Starlark.** Deliberately not scheduled
  (direction.md §5.4): the right answer and the expensive one. Nothing forces
  the choice yet.

**Not scheduled, and why:** anything downstream of `plans/fem.md`'s G3 spike
(the solver is undecided until measured); the skill's FEM part (a skill may only
describe an API that exists).

## 3. Decisions waiting on Alex

Ask each one as a plain question with a recommended answer; the R3 four went
unanswered for two days because nobody asked them.

- **The order in R7:** tier 0 on the Maxwell seat before the open solver.
- **R5's order:** pointing at the scene before the view in the chat.
- **A project is a folder of scene files** (R9), rather than a container format;
  and whether variants are named value sets inside a scene.
- **`plans/recording.md`:** the scene as a function with annotated parameters,
  and an explicit `name(obj, id)` for ids a label does not give.
