# Roadmap — what studio becomes, and in what order

**Status: plan, written 2026-10-05; amended 2026-10-06** with marimo's agent
work (§3), which reshapes R3, R5 and R6. It records where things stand, what was
learned from looking at the field and the guidelines around it, and the order to
build in. Each step says what it is, why, and when it is done. The reasoning for
the pieces already planned lives in `direction.md` (positioning, the model),
`fem.md` (validation) and `builder.md` (writing scenes in code); this file
sequences them and adds what they did not cover: agents, and Ansys both ways.

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

- Anthropic, _Writing effective tools for agents — with agents_: tools are a
  contract with a non-deterministic caller; consolidate rather than wrap an API
  endpoint by endpoint; return high-signal context, not raw identifiers or bulk
  data; make errors say how to fix them; **evaluate tools with real agents**.
- Anthropic, _Code execution with MCP_: agents that write code against an API
  instead of calling tools one at a time use far fewer tokens (one workflow:
  150k → 2k). `direction.md` §8 arrived at the same place — code for
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
  the alternative first. The write-up gives no numbers and says nothing about
  trust.
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

**What that says about studio today.** The extension exposes 24 language-model
tools that mirror the engine's operations one for one (`addObject`, `setParam`,
`rotate`, `move`, …): the wrapper shape the guideline warns against. And
`direction.md` §9.4 already calls agent reliability its thinnest evidence.
marimo's releases show three more gaps. R3 as first planned keeps reading and
computing in fixed tools around one that runs code, where marimo's experience is
that the code is the interface and fixed views are what it outgrew. The 3D view
lets a person drag, but not point an agent at a magnet and ask. And in the
notebook ecosystem the widget is for, "studio" now names a marimo product:
`magpylib-studio` reached PyPI on 31 July, a day after `marimo-studio`.

Sources:
[tools guideline](https://modelcontextprotocol.info/docs/tutorials/writing-effective-tools/),
[code execution with MCP](https://www.marktechpost.com/2025/11/08/anthropic-turns-mcp-agents-into-code-first-systems-with-code-execution-with-mcp-approach/),
[MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/),
[Agent Skills](https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/),
[Zookeeper](https://docs.zoo.dev/research/zookeeper),
[AI CAD in 2026](https://blog.texocad.ai/posts/ai-cad-software-2026),
[Embodied CAD](https://arxiv.org/pdf/2606.31252),
[marimo pair](https://marimo.io/blog/marimo-pair),
[notebooks as a tool for agents](https://marimo.io/blog/notebooks-as-a-tool-for-agents),
[marimo-lens](https://marimo.io/blog/introducing-marimo-lens),
[Point, Revise, Review](https://arxiv.org/html/2609.19839v1),
[Lens targets](https://marimo-team.github.io/marimo-lens/reference/attributes.md),
[marimo-studio](https://marimo.io/blog/introducing-marimo-studio),
[prepared exports](https://marimo-team.github.io/marimo-studio/guide/run-and-share.md).

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
  the save is refused and names the line. One such gap stays, guarded: a step
  the History panel moved after its pattern (open question below).
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

### R2 — Units

**What.** `fem.md` §6 as written: a unit kind per variable, a model unit per
document, conversion at the boundary, the UI showing `gap: 5 mm`. The builder
takes `variable(…, unit="length")`.

**Why first among the new features.** The builder, the agent tools and the Ansys
export all carry variables across a boundary that has units, and each one built
before this is one more place to migrate.

### R3 — The agent interface: builder code against the live scene

**Amended 2026-10-06** after marimo pair (§3): the code is the interface, and
how it reaches the engine comes second. Planned first as four MCP tools; what
changes is that reading and the field stop being fixed tools.

**What.** Replace the 24 one-per-operation tools with one way in: the agent's
Python, run against the open scene. In scope for that code:

| In scope                     | What it is                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| the open scene, as a `Scene` | builder calls, live: one undo step per run, refused whole with its line and message (R1) |
| reads                        | the scene as builder code (`to_builder_script`), and the variables                       |
| field helpers                | summaries — min, max, mean, uniformity — not arrays unless asked                         |
| `validate` (after R7)        | the FEM job API, refusal-first, per `fem.md` §12–13                                      |

What the agent needs to look at depends on the scene and the task, which a fixed
tool cannot anticipate; the helpers are conveniences inside the code, not the
only views there are. **Every run takes a scene** — its file — defaulting to the
open one, so several open scenes (R9) changes nothing about it.

**Shipped as** an Agent Skill (R6's content) and a small CLI that runs code in
the running engine, as marimo pair ships `execute-code`, so any agent that reads
skills has it; an MCP server wraps the same entry point for hosts without skills
(Claude Desktop, ChatGPT). The VS Code LM tools become a pass-through, or go.
For the CLI the engine has to be reachable from outside the editor, which it is
not yet: it is a subprocess on the extension's stdio (a local socket, or the
extension relaying, would do — decide here).

**In a marimo notebook the way in exists already.** Through marimo pair an agent
runs code in the kernel that holds an editable `SceneWidget`'s session, reads
`widget.selected` (what the person clicked) and assigns it (which moves the
outline). Missing there: the view follows edits made through its own calls only,
so builder code run against its session from outside leaves it stale until the
next. A change hook on the session closes that.

**Why.** The guideline (§3) and the code-execution evidence point here, marimo's
pair is the same conclusion reached by a team that shipped the tool-call shape
first, and the halbach as builder code is about 25 lines where its document is
hundreds of lines of JSON — in a form models have seen a great deal of.

**Open: the trust model.** Agent-written Python runs in the engine, with the
user's rights. That is the same trust as opening a script, but an agent writes
more of them, faster. Python cannot be sandboxed honestly; the real answer is
`direction.md` §5.4 (a hermetic language). Until then: say so in the skill, and
keep the engine's working directory and environment narrow. marimo's write-up
does not address it either. Decide before shipping R3.

### R4 — Evaluate with agents, before adding more

**What.** About twenty magnetics tasks with checkable targets, for example:

- a Halbach ring with B ≥ 0.1 T, uniform to 2 % across a 20 mm bore, in at most
  N magnets;
- a coil giving 1 mT on axis 5 cm away with at most 100 turns;
- "sweep the gap from 1 to 5 mm and report the field at the probe";
- repair a scene whose edit was refused (the agent has to read the refusal);
- after R5, "this magnet" — a request that only makes sense with what the person
  pointed at.

Run them with today's 24 tools and with R3's code, in VS Code and through marimo
pair; record success, tokens, turns and refusals hit. Keep the set in the repo
and re-run it when the interface changes.

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
marimo-lens both ship as skills. What it says stays as planned: magpylib's
conventions (SI units, diameter not radius, polarization in the object's own
frame), the builder's rules, what each refusal means and how to fix it, and how
to point and be pointed at (R5). Its API reference is generated from the
builder, with a test that the two agree (`fem.md` §13.4). Present tense and
current capability only (`fem.md` §13.1): authoring now, FEM when FEM exists.

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

- **#12 merged**, now that R1 is built on it (R1 itself was approved as
  described).
- **Step order in a builder script.** The panel puts a move or a turn of a
  patterned object _in front of_ its pattern, so a drag moves the whole ring;
  builder calls go through the same operation, so `m.duplicate_around(…)` then
  `m.move(…)` moves every copy, where magpylib's own reading of those two lines
  moves `m` alone. It is also why the tab cannot write a step the History panel
  put after a pattern (R1 refuses that save rather than carry the difference).
  Recording a script's steps in the order they are written would close both; it
  changes what such a hand-written script means (`builder.md` §9).
- **#12 as a draft** until then, so it reads as a proposal.
- **The §7 amendment** (R7): tier 0 on the Maxwell seat before the open solver.
- **Removing the 24 LM tools** in R3 (the package is a preview, so breaking is
  acceptable).
- **R3 shipped as a skill and a CLI**, with MCP as an adapter (§3, marimo pair),
  rather than as an MCP server first; and how the engine is reached from outside
  the editor.
- **The trust model for agent-written code** (R3).
- **R5's order:** pointing at the scene (marimo-lens targets in a notebook, the
  same channel in VS Code) before the view in the chat.
- **The name.** `marimo-studio` ("Custom views for marimo notebooks", on PyPI
  since 30 July 2026, announced 1 October) now names a product in the notebook
  ecosystem the widget is for, and `magpylib-studio` reached PyPI a day later.
  Keep the name, or change it while the users are few.
- **A project is a folder of scene files** (R9), rather than a container format;
  and whether variants are named value sets inside a scene.

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
