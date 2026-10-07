# Roadmap — what studio becomes, and in what order

**Status: plan, written 2026-10-05; amended 2026-10-06** with marimo's agent
work (§3), which reshapes R3, R5 and R6, **and 2026-10-07**, when R3's four open
questions were decided (§6) and its first step started. It records where things
stand, what was learned from looking at the field and the guidelines around it,
and the order to build in. Each step says what it is, why, and when it is done.
The reasoning for the pieces already planned lives in `direction.md`
(positioning, the model), `fem.md` (validation) and `builder.md` (writing scenes
in code); this file sequences them and adds what they did not cover: agents, and
Ansys both ways.

---

## 1. Where things stand

- **PR #12** (`feat/one-way-script-generation`, open, CI green) holds:
  - one-way generation — `parse_script` and the old `apply_script` gone
    (`direction.md` §5.1); the script tab's save, briefly an offer to import,
    applies builder code since R1;
  - the builder, `magpylib_studio.build` (`builder.md` B1): magpylib's spelling
    with variables that stay variables, formulas (`s.sampled`), saved values
    (`Scene(values=…)`);
  - `to_builder_script()` (B2): a scene as builder code which, run, builds the
    same document — tested over every example and a panel-edited scene;
  - `load_script` opening a builder script whole, so **Open in Magpylib Studio**
    on a builder script is the full editable scene; an import of plain magpylib
    names the variables it turned into numbers;
  - `SceneWidget.variable_sliders()`, and `examples/builder_demo.py` written for
    the three ways in (the studio, a notebook, a plain run);
  - **R1, done:** the script tab shows builder code, and a deliberate save
    applies it (`apply_builder_script`), as one undo step; plain magpylib is
    refused, and **Export as Builder Script…** writes code to keep.
- **#12 merged** (2026-10-06, `320b80a`).
- **R2, units, merged** (#28, 2026-10-06): what a variable measures, shown in SI
  unless the scene says otherwise, and read in whatever unit is typed (`15 mm`).
- **R3, step 1 started** (2026-10-07): the skill, shipped inside the package;
  the 24 LM tools removed the same day.
- **On `main`**: the first-fit zoom fix (`0af7f01`) — the axes' `Box3Helper` was
  measured as the unit cube it is built as, so scenes in centimetres opened as a
  speck. A browser-harness check guards it.

---

## 2. The positioning, sharpened

`direction.md` §1 stands: studio is the binding that makes expert work
structured, reproducible, parametric and cheap to re-run. Looking at the field
narrows what that means in practice:

> **Studio is the verifiable magnetics design loop: humans, code and agents edit
> one parametric document; every candidate gets an exact field in milliseconds;
> FEM validation is one step away; the log replays.**

What agents lack in most engineering tools is exactly that loop — a fast, exact,
checkable answer to "is this design any good", and a trail that replays.
Text-to-geometry is not the gap: it is crowded and unsolved (§3), and studio's
edge there would be nil.

**Not to build:** a text-to-geometry generator; a general CAD tool; a second
stored representation, or any parsing of code back into one; more one-call-per-
operation agent tools; a framework for building pages, reports or dashboards out
of a scene — marimo-studio builds those from a notebook (§3), and studio's part
is a view that works inside one.

---

## 3. What the field and the guidelines say

**The established and frontier tools converge on one shape.** One artifact; code
as the agent's medium; a GUI that edits the same artifact. Zoo's agent writes
and _executes_ KCL and checks the result with engineering measures; Onshape's
writes FeatureScript; COMSOL's chatbot writes API code against the model tree.
Studio now has the same shape: the document, builder code that rebuilds it
exactly, and the panel editing it.

**Text-to-CAD is the crowded part and still unsolved.** Zoo, Autodesk's Neural
CAD and Onshape's AI Advisor all work on it, and a 2026 survey finds no tool
producing fully editable parametric models from text.

**There are guidelines for the agent side, and they are specific.**

- Anthropic, _Writing effective tools for agents — with agents_ (September
  2025): tools are a contract with a non-deterministic caller; consolidate
  rather than wrap an API endpoint by endpoint; return high-signal context, not
  raw identifiers or bulk data; make errors say how to fix them; **evaluate
  tools with real agents**.
- Anthropic, _Code execution with MCP_ (November 2025): agents that write code
  against an API instead of calling tools one at a time use far fewer tokens.
  Its one number is a worked example, an agent loading only the tool definitions
  a Google Drive → Salesforce task needs: 150k → 2k. The same post states the
  price: "Running agent-generated code requires a secure execution environment
  with appropriate sandboxing, resource limits, and monitoring" — R3's trust
  question (§6). `direction.md` §8 arrived at the same place — code for
  orchestration, structured operations for building — and the builder is both at
  once: plain Python whose every call is a validated operation.
- **MCP Apps** (the first official MCP extension, stable since January 2026): a
  tool can return an interactive UI that the host renders in the chat — Claude,
  ChatGPT, VS Code and others.
- **Agent Skills** (an open standard since late 2025, read by Claude Code,
  Codex, VS Code and many more): packaged know-how, a `SKILL.md` loaded on
  demand.

**marimo has gone down the agent road a step ahead, in the same ecosystem.** Its
notebooks are the closest prior art studio has: a reactive document, the
anywidget protocol studio's notebook view already speaks (`TASKS.md` W1), and a
team that ships to agents as Agent Skills. Three of its 2026 releases bear on
R3–R6 directly.

- **marimo pair** (April; the design written up in July): a skill that puts the
  agent inside the running notebook. Its first version let the agent look
  through read-only MCP tools and change the notebook by editing its `.py` file.
  It was dropped: "the MCP tools worked for questions we had anticipated",
  reading and writing took different paths, and "the extra calls added latency
  and token use". What replaced it is code: an `execute-code` CLI into the live
  kernel, and a code mode (`marimo._code_mode`) whose edits queue and apply on
  exit "as one transaction", after the checks any notebook edit gets — "If a
  check fails, marimo rejects the whole batch." That is R1's save, and the shape
  R3 plans for `run_builder`, reached independently by a team that had shipped
  the alternative first. How it reaches the kernel, and whom it trusts, are in
  its README rather than the write-up: the notebook is already a local web
  server, which the skill's script finds by itself when it runs with
  `--no-token`, or with `MARIMO_TOKEN` when it does not; and each call is a
  shell command the agent's host may ask the person to approve — the README says
  to allow the two scripts in `.claude/settings.json`. Neither gives a number.
  marimo did not drop MCP: its server is still there (`--mcp`, experimental),
  with "lower-level, read-only tools", and its docs say "If your goal is to have
  a coding agent drive a live notebook, see marimo pair instead."
- **marimo-lens** (30 September; a paper at IEEE VIS 2026): an anywidget that
  lets the person point. Mark a point or a region of any output and leave a
  note, and the agent receives the mark, the note, the cell that produced the
  output, the cells it depends on, and an image. The agent points back: `reveal`
  brings a cell, a selection or an ordered walkthrough into view, and `resolve`
  files a request away with a summary. Any element becomes a target by carrying
  `data-marimo-lens-*` attributes — a label, and a `render-source` path and
  line. "Lens never edits or runs cells itself… Lens owns attention." The paper
  shows one walkthrough and measures nothing: its effects "remain to be
  established".
- **marimo-studio** (1 October; on PyPI as `marimo-studio` since 30 July,
  "Custom views for marimo notebooks"): views of one notebook for each audience
  — slides, an article, a dashboard — in any web framework, each in its own
  folder beside the notebook, every value traced to the cell that made it
  (`marimo-studio validate` reports names a view uses that the notebook no
  longer defines). Prepared exports run the notebook ahead of time for the
  control settings a view lists, up to 10,000 states, and serve the results as
  static files; a widget's captured model is replayed, and a preflight reports
  what still needs live Python.

**What that said about studio, on 2026-10-06.** The extension exposed 24
language-model tools that mirrored the engine's operations one for one
(`addObject`, `setParam`, `rotate`, `move`, …): the wrapper shape the guideline
warns against. They were VS Code's language-model tools, which Copilot Chat
calls; an agent working in a terminal — Claude Code, Codex — never saw them.
They went on 2026-10-07 (R3). And `direction.md` §9.4 already calls agent
reliability its thinnest evidence. marimo's releases show three more gaps. R3 as
first planned keeps reading and computing in fixed tools around one that runs
code, where marimo's experience is that the code is the interface and fixed
views are what it outgrew. The 3D view lets a person drag, but not point an
agent at a magnet and ask. And in the notebook ecosystem the widget is for,
"studio" now names a marimo product: `magpylib-studio` reached PyPI on 31 July,
a day after `marimo-studio`.

Sources:
[tools guideline](https://www.anthropic.com/engineering/writing-tools-for-agents),
[code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp),
[MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/),
[Agent Skills](https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/),
[Zookeeper](https://docs.zoo.dev/research/zookeeper),
[AI CAD in 2026](https://blog.texocad.ai/posts/ai-cad-software-2026),
[Embodied CAD](https://arxiv.org/pdf/2606.31252),
[marimo pair](https://marimo.io/blog/marimo-pair),
[notebooks as a tool for agents](https://marimo.io/blog/notebooks-as-a-tool-for-agents),
[marimo pair's README](https://github.com/marimo-team/marimo-pair),
[marimo's MCP docs](https://github.com/marimo-team/marimo/blob/main/docs/guides/editor_features/mcp.md),
[marimo-lens](https://marimo.io/blog/introducing-marimo-lens),
[Point, Revise, Review](https://arxiv.org/html/2609.19839v1),
[Lens targets](https://marimo-team.github.io/marimo-lens/reference/attributes.md),
[marimo-studio](https://marimo.io/blog/introducing-marimo-studio),
[prepared exports](https://marimo-team.github.io/marimo-studio/guide/run-and-share.md),
[library skills](https://tiangolo.com/ideas/library-agent-skills).

---

## 4. The next steps, in order

### R1 — The script tab shows builder code, and its save applies ✅

**Done** on #12, as written below, with what a review before pushing found:

- **B2 was not lossless everywhere**, and a save would have carried each gap.
  Fixed in the builder and the writer: a collection hidden around a magnet shown
  again, or one added after, came back all hidden (`show()` now exists); a
  reparented path gained two steps per run; a step that no longer applies made
  the tab fail to render at all. So that no gap found later is carried silently
  either, the save compares the edited script with the open scene built back
  from its own tab: the same, nothing happens (a reflexive save is free,
  always); different while the tab does not build the open scene back exactly,
  the save is refused and names the line. The last gap the review found, a step
  the History panel moved after its pattern, closed when builder steps went in
  the order written (decided 2026-10-06, §6).
- A relative mesh path in the tab resolves against the scene's folder, and in an
  opened builder script against the script's; auto-save (on a delay or on
  leaving the tab) does not apply and holds the text; a save asks first when the
  scene changed after the tab was written (a drag, an agent, an undo), since
  applying the tab would undo that; `exit()`, `quit()` and `input()` in a script
  no longer reach the engine's own stdin; a save while the history is rolled
  back keeps the script's order.
- An old leak: a script with a syntax error left magpylib's `show()` patched for
  the rest of the engine's life (`load_script` had it too).

**What.** The tab renders `to_builder_script()`; a deliberate save runs it and
replaces the document with the scene it built, as one undo step (autosave still
does not). A new session method, `apply_builder_script(path)`: run, take the
`Scene`, replace; a script that fails or builds no `Scene` changes nothing and
says so, and the tab keeps its text until it runs. Pasted plain magpylib is
refused with a pointer to Open in Magpylib Studio, never flattened. "Build a new
scene from this" goes; `exportScript` gains a builder variant ("Export as
builder script…") for code someone keeps.

**Why.** #12 removed apply-on-save because running plain magpylib could only
recover objects. Builder code is lossless by test (B2), so editing a number in
the tab and saving comes back without the degradation. Not a return of the round
trip: nothing is parsed, the tab is executed through the panel's operations.

**Costs, said in the tab's header.** The tab is the studio's view, regenerated
after a save, so a helper or a loop typed into it comes back as the steps it
made; code to keep goes to a file of its own. An expression a resize set aside
(`overridden`) cannot survive a save; the result says so.

**Done when.** The integration test is "edit `radius` in the tab, save, the
document follows" again; a broken script leaves the scene alone; plain magpylib
is refused with the message; `direction.md` §5.1 and `builder.md` §5 say why
apply-on-save returned. **Then #12 is a complete proposal** — merge it.

### R2 — Units ✅

**Done** (2026-10-06; `fem.md` §6, "As built"): a unit kind per variable, a
model unit per document (metres unless it says otherwise), and every view that
shows or reads a variable's value doing it in that unit — the Variables panel,
its properties, the sweep, the notebook sliders. The builder takes
`variable(…, unit=…)` and `Scene(model_unit=…)`; the examples say what their
variables measure; documents without units are unchanged. The emitter's side of
the boundary waits for M6. Then (2026-10-07) everywhere else a value is shown:
the Inspector, every box that asks for a length, step labels, and the field
plots in a field unit (`field_unit`, T unless the scene says mT or µT); the
assistant's set-variable tool takes a unit.

**What.** `fem.md` §6 as written: a unit kind per variable, a model unit per
document, conversion at the boundary, the UI showing `gap: 5 mm`. The builder
takes `variable(…, unit="length")`.

**Why first among the new features.** The builder, the agent tools and the Ansys
export all carry variables across a boundary that has units, and each one built
before this is one more place to migrate.

### R3 — The agent interface: builder code, on its own copy first, then on the open scene

**Amended 2026-10-06** after marimo pair (§3): the code is the interface, and
how it reaches the engine comes second. Planned first as four MCP tools; what
changes is that reading and the field stop being fixed tools. **Decided
2026-10-07** (§6): two steps, a skill first and MCP only when a chat host needs
it, the agent's host as the gate, and the 24 LM tools gone.

**What.** Replace the 24 one-per-operation tools with one way in: the agent's
Python, written with the builder. In scope for that code:

| In scope              | What it is                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| a `Scene`             | builder calls: `Scene()` on its own copy; on the open scene (step 2), one undo step per run, refused whole (R1) |
| reads                 | the scene as builder code (`to_builder_script`), and the variables                                              |
| the field             | `get_field` and `sweep` on the scene's session; summaries as helpers if R4 shows they are worth having          |
| `validate` (after R7) | the FEM job API, refusal-first, per `fem.md` §12–13                                                             |

What the agent needs to look at depends on the scene and the task, which a fixed
tool cannot anticipate; helpers are conveniences inside the code, not the only
views there are.

**Step 1 — on its own copy: the skill** (started 2026-10-07). An Agent Skill,
`magpylib-studio`, inside the package at
`magpylib_studio/.agents/skills/magpylib-studio/`: the library-skills layout,
which magpylib's own skill uses too (magpylib#992), so it ships with the version
it describes and `uvx library-skills` links it into a project. It teaches the
builder as it runs today: the agent writes a builder script, runs it with plain
Python, reads the field through the scene's session, and the person opens the
result in the studio — Open in Magpylib Studio on the script, or the saved
`.magpy.json`. Nothing has to be built for that to work, and nothing new is
reachable: it is Python in the agent's terminal. Its API reference is generated
from the builder, with a test that the two agree, and the tests run every
example in it (`fem.md` §13.1, §13.4). R4 can measure it with no editor in the
loop.

**Step 2 — on the open scene: a way in.** The person sees the agent's edits
arrive in the panel, each one an undo away. Today only the extension reaches the
engine, through the stdio of the process it started. The engine also listens on
a local connection only the person's account can use (with a token, as Jupyter's
kernels and marimo's server have one), and a small command runs builder code
against the open scene — `magpylib-studio run script.py`, the counterpart of
marimo pair's `execute-code`. The engine then has to tell the panel that its
scene changed, which the panel today learns only from its own calls; FEM's jobs
need the same server-initiated messages (`fem.md` §12.1, `TASKS.md` V3), and so
does the notebook view (below). **Every run takes a scene** — its file —
defaulting to the open one, so several open scenes (R9) changes nothing about
it.

**Trust: the agent's host.** The agent's Python runs with the person's rights,
as any script does. Python cannot be fenced in honestly (`direction.md` §4,
finding 3); a hermetic language is the real answer and the expensive one
(`direction.md` §5.4). So the gate is the one every other command the agent runs
goes through: its host asks first — Claude Code before each command, unless told
once that it may. That is marimo pair's model, and it reaches nothing the agent
could not already reach with `python` in the same terminal; Anthropic's caveat
(§3) is about running agent code as a service, with nobody there to ask. The
engine adds what it can: a connection only the person's account can open, one
undo step per run, and documents that never run code when opened
(`expressions.py`), so a scene from someone else stays safe to open. The skill
says so.

**MCP when a host needs it.** Only a host with no terminal — Claude Desktop,
ChatGPT — needs an MCP server, and there running Python is new power: a chat
that could not touch the machine could then run code on it. So it comes with
R5's view in the chat, which is MCP anyway, as an adapter over step 2's entry
point, each run approved in the chat.

**The 24 LM tools went** on 2026-10-07, once the skill was in. Only Copilot Chat
called them, and R4 has a better baseline than them.

**In a marimo notebook the way in exists already.** Through marimo pair an agent
runs code in the kernel that holds an editable `SceneWidget`'s session, reads
`widget.selected` (what the person clicked) and assigns it (which moves the
outline). Missing there: the view follows edits made through its own calls only,
so builder code run against its session from outside leaves it stale until the
next. A change hook on the session closes that — step 2's message, in the
kernel.

**Why.** The guideline (§3) and the code-execution evidence point here, marimo's
pair is the same conclusion reached by a team that shipped the tool-call shape
first, and the halbach as builder code is about 25 lines where its document is
hundreds of lines of JSON — in a form models have seen a great deal of. The
order is cost: step 1 needs no code in the engine, and step 2 brings the
connection, the messages and the command.

### R4 — Evaluate with agents, before adding more

**What.** About twenty magnetics tasks with checkable targets, for example:

- a Halbach ring with B ≥ 0.1 T, uniform to 2 % across a 20 mm bore, in at most
  N magnets;
- a coil giving 1 mT on axis 5 cm away with at most 100 turns;
- "sweep the gap from 1 to 5 mm and report the field at the probe";
- repair a scene whose edit was refused (the agent has to read the refusal);
- after R5, "this magnet" — a request that only makes sense with what the person
  pointed at.

Run them two ways first: an agent with plain magpylib and no studio — the
question of 2026-10-05, whether studio earns its place over an agent writing
magpylib itself — and the same agent with the studio skill (R3, step 1), which
needs no editor, so the set runs headless. Then through R3's way into the open
scene and through marimo pair, once those exist. Record success, tokens, turns
and refusals hit. Keep the set in the repo and re-run it when the interface
changes.

**Why.** `direction.md` §9.4 names agent reliability as the thinnest evidence
and asks for it to be counted. This counts it, which the closest prior art has
not: marimo pair's write-up gives no numbers, and marimo-lens's paper says its
effects "remain to be established".

### R5 — Pointing at the scene, then the view in the chat

**Amended 2026-10-06** after marimo-lens (§3): attention first, the chat second.

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
  nothing of studio's own in between. Lens reads those attributes from the
  document it is shown in, so check first that it finds them inside the widget's
  own DOM, and what its image capture makes of the WebGL canvas.
- **in VS Code**, the same channel natively: the tree's and the view's
  selection, and a note, handed to the agent through R3's way in.

**Then: the view in the chat, as an MCP App**, as first planned: the agent
builds, and the person sees the scene and drags its variables in the same
conversation, the sliders calling back. `to_html` already makes the view one
self-contained HTML file; what is missing is the host bridge for the sliders.
Check the current MCP Apps spec before building.

**Why the order.** Pointing serves the places the work already happens — the
notebook and the editor — and costs little, since `selected` is synced both ways
already. The chat view serves one more place, at the price of a host bridge.
Both are the facilitator idea made concrete: one document, the agent and the
person both on it.

### R6 — A skill for magpylib-studio

**Folded into R3** (2026-10-06): the skill is how R3 ships, as marimo pair and
marimo-lens both ship as skills. **Started 2026-10-07** as R3's step 1, in
`magpylib_studio/.agents/skills/magpylib-studio/`. What it says stays as
planned: magpylib's conventions (SI units, diameter not radius, polarization in
the object's own frame), the builder's rules, what each refusal means and how to
fix it, and, once R5 exists, how to point and be pointed at. Its API reference
is generated from the builder, with a test that the two agree (`fem.md` §13.4).
Present tense and current capability only (`fem.md` §13.1): authoring and the
field now, the open scene when step 2 exists, FEM when FEM exists.

### R7 — FEM, with the order amended

`fem.md` as planned, in this order:

1. units (R2);
2. the physics layer (M1);
3. the pyAEDT emitter (M6), **checked at tier 0 on the Maxwell seat against
   magpylib**, with the signature conformance (§8.4) and golden text (§8.3) in
   CI — written one scene to one design, so a folder of scenes can later become
   one AEDT project of several designs (R9);
4. the open solver (M2–M4) after, for validation CI can run and for tiers 1+.

**Why the change.** `fem.md` §7 puts the open solver first so the translation is
never validated by eye. But tier 0's oracle is magpylib itself — exact for μr =
1 — so checking the Maxwell export against it is numerical, not visual, which is
§7's actual concern. **The cost:** until the open solver exists, validation is a
manual run on a licensed seat (§8.6), not CI.

### R8 — Values and results back from Ansys

**What.** Two flows back, no geometry:

- **design variable values** after an Optimetrics run, into the studio's
  variables of the same names (with R2's unit conversion) — the
  `Scene(values=…)` split again: structure where it was written, values back;
- **Maxwell's field at the sensor points**, into the comparison view (`fem.md`
  §12).

**Why not geometry.** An AEDT project holds far more than magpylib can —
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
notebooks do and what VS Code is built around; `instancing.md` already decided
that a definition lives in its own file, so a scene can place another across
files; and one scene per file is one diff per scene.

**Not separate scenes:**

- **variants** — in AEDT a variant is a copied design; here it is mostly a set
  of variable values, so a named value set inside the scene, as OpenSCAD's
  Customizer keeps presets, may be the right size of thing (open);
- **parameters shared across scenes** (AEDT's `$project` variables) — wait for
  instancing, where a scene placing another with arguments covers most of it.

**Towards Ansys.** A folder of scenes maps onto one AEDT project with a design
per scene and shared parameters as project variables, which is why R7 writes one
scene to one design.

**When.** The contract now (R3's code takes a scene); the editor after R7. Today
the extension holds one engine, one panel and one scene file as module-level
state, and the engine serves one session — the refactor touches all of it, and
nothing before R7 needs it.

### R10 and later

- **Structure kept in sync as a layer** (`builder.md` §7, level 2) — designed,
  not started; it is an override layer, and `instancing.md` warns where those go
  wrong.
- **Instancing** (`TASKS.md` F2) — unchanged; a placed instance is one more
  builder call when it exists.
- **A scene as a page anyone can open** — `to_html` with the views for listed
  variable values computed ahead, as marimo-studio's prepared exports do, so its
  sliders work on static hosting; and the widget inside a marimo-studio view,
  which replays a widget's captured model (its preflight says what still needs
  live Python).

---

## 5. Why an emitter, and not an LLM translating magpylib to PyAEDT

An LLM will write a plausible PyAEDT script from a magpylib one, and for a
one-off draft that is fine. As the workflow it is not:

1. **The traps are silent.** Diameter vs radius, centre vs corner, polarization
   in the object's frame composed with its orientation, J→Hc, mm vs m, the size
   of the air region (`fem.md` §3.1, §10.1): each gives a field that looks right
   and is not — `fem.md` §10.8's "looks authoritative" trap.
2. **A plain script does not say which numbers are design variables.** The
   quiver's import showed it; the LLM guesses. The document knows.
3. **It is not repeatable.** Fifty variants are fifty translations to check, and
   tokens each time; an emitter is deterministic and free to run.
4. **PyAEDT drifts** (`pyaedt` → `ansys.aedt.core`, renamed keywords). The
   emitter's CI check catches it; a model's training lags.
5. **Checking the LLM's output needs tier 0 anyway** — which is this machinery.

So the agent calls the tested emitter, through R3's way in. And none of it needs
studio's GUI: `fem.md` §4 puts the object-level translation in `magpylib-fem`,
which works on plain magpylib objects; studio adds the parametric half.

---

## 6. Decisions waiting on Alex

Ask each one as a plain question with a recommended answer: listed here, the R3
four went unanswered for two days because nobody asked them.

- **The §7 amendment** (R7): tier 0 on the Maxwell seat before the open solver.
- **R5's order:** pointing at the scene (marimo-lens targets in a notebook, the
  same channel in VS Code) before the view in the chat.
- **A project is a folder of scene files** (R9), rather than a container format;
  and whether variants are named value sets inside a scene.

**Decided** (2026-10-06):

- **Step order in a builder script: as written.** A step written after a pattern
  comes after it, as magpylib reads it; the panel's drag still goes in front of
  the pattern so the copies follow. It closed R1's last gap (`builder.md` §9).
- **The name stays `magpylib-studio`**, `marimo-studio` notwithstanding (§3):
  the package, extension and import names differ, the prefix matches the org's
  other packages, and a rename would touch PyPI, the marketplace id, the repo
  and every doc.

**Decided** (2026-10-07), R3's four:

- **The agent works on its own copy first, on the open scene after.** Step 1 is
  the skill over the builder as it runs today; step 2 gives the engine a local
  connection only the person's account can use, and a command that runs builder
  code against the open scene.
- **The gate for agent-written code is the agent's host**, as for any command it
  runs. The engine adds an owner-only connection, one undo step per run, and
  documents that never run code when opened.
- **The 24 LM tools go**, breaking or not: only Copilot Chat calls them. Done
  the same day.
- **A skill first, MCP when a chat host needs it** (R5's view in the chat): a
  skill is what terminal agents read, it is where marimo pair ended up, and it
  adds nothing to trust.

---

## 7. Working notes for whoever picks this up

- **The main checkout is shared.** Other sessions work in it; check `git status`
  and the branch before switching, and use a worktree when it is busy.
- **Commits and pushes only with consent**, force-pushes always pinned
  (`--force-with-lease=<branch>:<sha>`).
- **pre-commit.ci pushes "style: pre-commit fixes" commits to PR branches.** A
  rejected push is usually that: rebase on it, never force over it.
- **CI runs the engine against released magpylib too.** It has no
  display-backend API, so a test that draws (`get_scene`) fails there; ask the
  objects instead, or skip as the widget tests do.
- **The widget bundle is built** (`tools/build-widget.sh`) and committed; a
  check verifies it matches its sources. A notebook kernel keeps the bundle it
  loaded — restart it, and relaunch the extension (F5) to pick up engine
  changes.
- **The browser harness is slow**: run it once, at the end, in the background.
  When a view bug passes the harness pages, reproduce it in headless Chrome
  against the real page before theorising (the zoom bug was found that way).
- **`git grep -E` has no `\b`**: use `-w`, or a search that matches nothing
  passes for "no references".
