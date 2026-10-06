# Writing a scene in code — design

**Status: B1 is built**, with formulas (`s.sampled`) and saved values
(`Scene(values=…)`) (`magpylib_studio/build.py`, `tests/test_build.py`,
`examples/builder_demo.py`), and so are B2 (`to_builder_script`) and B3 (the
script tab shows builder code and a deliberate save applies it). Written on the
one-way branch (#12) because #12 removes the only way to write parametric code
and get a document back, and this is what replaces it. #12 should be judged with
it, not without.

---

## 1. The gap #12 leaves

Before #12, you could write parametric code: edit the script tab in the shape
`to_script` emits, save, and `parse_script` read the variables and patterns
back. That tier was defined by whatever `to_script` happened to emit
(`direction.md` §2), which is why it went.

After #12, code comes in only through `load_script`, by execution. Objects
survive; variables and patterns do not. Measured on halbach with `radius`
edited: 18 separate cuboids, no variables, and a warning saying so.

What remains for writing a parametric scene in code is the session API itself:

```python
s.set_variable("radius", 0.023)
s.add_object(
    "r1", "magnet.Cuboid", params={"position": ["=radius", 0, 0]}, parent="ring1"
)
s.duplicate_around("r1", count="=n", axis="z", spin="=360 / n")
```

Expressions as `=`-strings inside dicts, and `{"ok": …}` results to check by
hand. That is the protocol the GUI and the RPC speak, used as an authoring API.
The built-in examples are written a level lower still, as nested dicts
(`example_scene()`).

**This is AEDT's IronPython stage.** AEDT scripting ran on the recording API —
`oEditor.CreateBox(["NAME:BoxParameters", "XPosition:=", "radius", …])`, a
replay format used for writing. PyAEDT fixed that without touching the
architecture: the project stayed the artifact, design variables stayed in it,
the GUI kept editing it, and nothing parses a PyAEDT script back. What changed
was an API designed for writing.

Studio is at the same fork, and the pyAEDT export (`fem.md` M6) makes it
sharper: a scene written in code has to arrive as a document with its variables
intact, or there are no design variables to export.

---

## 2. The proposal: a builder that records, with variables that stay symbols

One module over a session. Halbach, written in it:

```python
import numpy as np
from magpylib_studio.build import Scene

s = Scene()
n = s.variable("n", 10, bounds=(2, 60), slider=(4, 20), integer=True)
radius = s.variable("radius", 0.023, bounds=(0.005, 0.08), slider=(0.016, 0.04))
gap = s.variable("gap", 0.015, bounds=(0, 0.06), slider=(0.01, 0.03))
stagger = s.variable("stagger", 360 / (2 * n))  # stored as "=360 / (2 * n)"
tilt = s.variable("tilt", 0.0, bounds=(-180, 180), slider=(-90, 90))
tilt_axis = s.variable("tilt_axis", "z", options=("x", "y", "z"))

halbach = s.Collection(id="halbach", style_label="Halbach stack")
rings, magnets = {}, {}
for number, z in ((1, 0.0), (2, gap)):  # a loop over literals is plain Python
    rings[number] = s.Collection(id=f"ring{number}", style_label=f"Ring {number}")
    halbach.add(rings[number])  # outermost first: see §3
    magnets[number] = s.magnet.Cuboid(
        id=f"r{number}",
        style_label=f"Magnet {number}",
        dimension=(0.01, 0.01, 0.01),
        polarization=(1, 0, 0),
        position=(radius, 0, z),  # stored as ["=radius", 0, "=gap"] for ring 2
    )
    rings[number].add(magnets[number])
s.Sensor(
    id="sensor",
    style_label="Sensor",
    style_size=0.005,
    position=np.linspace((0, 0, -0.015), (0, 0, 0.03), 25),
)

for magnet in magnets.values():
    magnet.duplicate_around(count=n, axis="z", spin=360 / n)
rings[2].rotate_from_angax(stagger, "z", anchor=0)  # after its copies: carries them
halbach.rotate_from_angax(tilt, tilt_axis, anchor=0)

s.save("halbach.magpy.json")  # the artifact; opens in the panel and the widget
```

Three rules make it work.

**1. Variables are handles, not numbers.** Arithmetic on a handle builds an
expression: `360 / n` becomes `"=360 / n"`. It is built as an AST and unparsed,
so precedence comes out right and the text is what `expressions.normalized`
would write. The allowed functions (`sin`, `radians`, `sqrt`, …) come as
handle-aware versions, read off `expressions._FUNCTIONS` so the two lists cannot
drift.

**2. Anything the document cannot hold fails at its line.** `if radius > 0.01:`,
`range(n)`, `float(radius)`, `math.sin(radius)` and `np.linspace(0, radius)` all
raise, and the message names the alternative: `duplicate_around(count=n)` for a
loop, `s.sin` for a function, `s.sampled` for a run of points (§7). Never
evaluate silently. A silent evaluation is the cliff come back: a script that
runs fine and loses its parametrisation without a word. Python control flow over
_literals_ stays ordinary, as the ring loop above shows.

**3. Names follow magpylib.** `s.magnet.Cuboid`, `s.Collection`, `s.Sensor`,
`style_label=`, `.rotate_from_angax(angle, axis, anchor)`,
`.move(displacement)`. Where magpylib has no word, the word is studio's:
`variable`, `duplicate_around`, `duplicate_along`, `mirror`. It reads as
magpylib with variables, not a new vocabulary. That keeps `direction.md` §1's
"every invented concept is a tax" low, and keeps agents in the part of their
training data that is dense (§8).

**Errors are raised, not reported.** Every call goes through the session method
the GUI uses, and a `{"ok": False}` comes back as an exception at the call.
"Reported, not raised" is right for the RPC, where a GUI shows the message and
an LLM retries; a script author wants the traceback line. It is the same
guardrail in the same place (`fem.md` §13.2), with one more way of saying it.

---

## 3. The trap: `.add()` is not a reparent

magpylib builds first and groups after: `ring1.add(r1)`. The session's reparent,
`move_object`, appends a `reparent` step and then pins the object's world pose
as numbers, so the object stays where it was while its group changes. That is
right for the GUI, and fatal here: `position=(radius, 0, z)` would come back
frozen.

So the builder records a create lazily. Constructing an object records nothing.
The create step is written when the object first enters the scene: added to a
collection (the create gets that parent), touched by any other call, or at the
end, at the root. That last case needs no care about order: an object nothing
touched has no steps of its own and sits in no group, so no step in the log
moves it, wherever its create falls. An `.add()` of an object that already has
steps is a real reparent, and the builder says so. Hence outermost first in the
example: `halbach.add(ring)` before `ring.add(magnet)`, or the ring would enter
the scene at the root and have to be moved.

That keeps magpylib's spelling. Whether it is too clever next to a plain
`parent=` keyword is open (§9).

---

## 4. Where it sits

```
panel, widget     ─┐                          ┌─▶ to_script          plain magpylib
agent (LM tools)  ─┼─▶ session ─▶ document ───┼─▶ to_aedt_script     fem.md M6
builder script    ─┘   operations             └─▶ to_builder_script  the script tab, §5
```

Nothing reads code back. The builder is _executed_, and execution calls the same
operations the GUI does, so there is one implementation of what an edit means
and nothing to keep in agreement with it.

**How this differs from the tracing `direction.md` §7 rejected.** Three ways:

- §7 made the `.py` the artifact. Here the document stays the artifact and the
  builder produces it, as AWS CDK produces a CloudFormation template (§4's
  table). Opening a scene never runs code.
- §7 traced what magpylib built, which is numbers after evaluation. Handles
  record the expressions, and that is what keeps the result parametric.
- §7's worry about a small unfamiliar Python API still stands. Rule 3 is the
  answer offered, and §8 below says how to find out whether it is enough.

**Every system that records a program by running it refuses to branch on what it
is recording.** JAX raises when a traced value reaches an `if` under `jit`.
torch.fx raises when a `Proxy` reaches control flow. CDK tokens and Pulumi
`Output`s stand for values that do not exist yet, and both steer you away from
branching on them. Rule 2 is that same answer: refuse loudly and name the
alternative.

**PyAEDT spells variables the way the document does.** `m3d["radius"] = "23mm"`,
then `create_box(origin=["radius", 0, 0], …)`: variables are names inside
expression strings, which is the document's own convention (`"=radius"`). The
builder's handles produce those strings, and the pyAEDT emitter writes them back
as strings. A builder script and the pyAEDT script emitted from its document
would read almost line for line alike.

---

## 5. What it changes in #12

- **`parse_script` stays deleted.** The builder is not a reader.
- **`to_script` stays the plain magpylib export.** A script anyone can run
  without studio is worth keeping as it is.
- **The script tab shows builder code, and a deliberate save applies it** (B3,
  `roadmap.md` R1). #12 first took apply-on-save away: running an edited plain
  magpylib script recovers only the objects it leaves behind, so a save that
  changed nothing still turned every variable into a number and every pattern
  into its copies. Saving offered "Build a new scene from this" instead, an
  import by execution that flattened in the same way. `to_builder_script()`
  writes one builder call per step, which is lossless, so the save could apply
  again.

That is a round trip, but through execution rather than parsing. The emitter has
one call per operation to produce, and whether `exec(to_builder_script(doc))`
rebuilds `doc` is a property tested over every example and over a scene edited
the way the panel edits one -- not an idiom-by-idiom agreement between an
emitter and a parser (`direction.md` §2). Poses are the one subtlety: the panel
merges a pin into the pin it follows, so a pose is written as one
`set_transform` with both halves, and a reparent replays through the same merge.

**Why apply-on-save returned.** The degradation that removed it was what plain
magpylib cannot say, and builder code says it. Editing `radius` in the tab and
saving changes `radius`; `r1` still sits at `=radius` and the ring is still a
pattern. The session's `apply_builder_script(path)` runs the tab, takes the
`Scene` it built and replaces the document as one undo step.

**Compared with the tab, not with the scene.** What the edited script built is
set beside the open scene built again from its own tab (`build.rebuilt`). The
same: nothing happens, so a reflexive save is free whatever the tab could not
say. Different, while the tab does not build the open scene back exactly: the
save is refused and names the first line that differs, because the edit would
carry every such difference with it and nobody made those. That is a guard for
gaps not found yet; the ones a review found are closed (hide and `show()`, a
reparented path, a step that no longer applies), except a step the History panel
moved after its pattern (§9). What it costs, said in the tab's header:

- **The tab is the studio's view.** It is regenerated from the scene after a
  save, so a helper or a loop typed into it comes back as the steps it made, and
  comments go. Code to keep goes to a file of its own: **Export as Builder
  Script…** writes it once, and nothing regenerates it after that.
- **The tab is out of date while it is being edited.** It is not re-rendered
  under unsaved or refused text, so a drag, an agent's edit or an undo made
  meanwhile is not in it, and applying it would undo them: the save asks first.
- **What no call writes does not survive a save that changes something.** An
  expression a resize set aside (`overridden`) is named at the top of the tab,
  and the save's result names it again when it goes. A save that builds the
  scene already open changes nothing and adds no undo step, so a reflexive Cmd+S
  keeps it.

**What a save refuses**, leaving the scene as it was: a script that raises (with
its line, and the tab keeps the text until it runs; a clean `exit()` is a script
that finished); one that builds no `Scene`, or several; one that would change
more than its edit (above); and plain magpylib, which would come back flattened.
Bringing plain magpylib in is an import, asked for by name: save it as a file of
its own and use Open in Magpylib Studio. A relative mesh path in the tab means
what it means in the document, relative to the scene's folder, although the tab
is a file in the editor's storage; in a builder script opened in the studio,
relative to the script's folder, where an exported one sits beside its scene.

---

## 6. Phases

**B1 — the builder.** Variables, objects, collections, transforms, patterns;
handles with arithmetic and the allowed functions; errors raised. Acceptance:
each built-in example, rewritten as a builder script, builds the example's
variables, bounds and steps, and the same field (`same_field`, as #12's tests
use). Byte equality would also pin where root-level creates fall, which §3 says
does not matter. The dict-building functions behind `EXAMPLES` could then become
those scripts, and the repo would stop writing scenes in the protocol.

**B2 — `to_builder_script` ✅.** One call per step, and the property test above:
every example, and a scene edited in the panel's ways (drags pinned in front of
a pattern, moves, turns, a reparent, a hidden ring, an object made and removed),
come back as the same document.

**B3 — the script tab ✅.** Builder code, applied on a deliberate save (§5,
`docs/roadmap.md` R1): `apply_builder_script` in the session, the tab rendering
`to_builder_script()` under a header that says it is regenerated, auto-save not
applying, and **Export as Builder Script…** for code someone keeps. Tested in
the engine (an edit applies as one step and changes nothing else; a reflexive
save is unchanged across the scenes the panel leaves, and those the tab cannot
say; a save that would change more than its edit, a failing script, one with no
`Scene` and plain magpylib are each refused and change nothing) and in VS Code
(edit `radius` in the tab and save, and the document follows; a broken script
leaves the scene alone and stays in the tab; plain magpylib is refused with the
message).

**Independent of FEM.** `fem.md` M6 consumes the document, not the builder, so
neither waits for the other. B1 is what makes "write it in code, export it to
Maxwell with its design variables" true end to end.

**Units** go on `variable(…, unit="length")` once `fem.md` §6's unit kinds
exist; the builder does not invent its own.

**Instancing** (`instancing.md`) is compatible. A Python function over the
builder, like the `ring` loop above, is reuse at authoring time: the document
gets the expanded result. An instance is reuse in the document. When instancing
exists, placing one is one more builder call.

---

## 7. Formulas, and keeping a script and a scene in sync

**A run of points is a formula.** The document can say "the quiver's arrows are
`density²` points, laid out by this formula of `t`" (a `sampled` node), which
`np.linspace` over a variable cannot: it needs the count now.
`s.sampled(of, count=…, over=…)` calls `of` once with a symbolic `t` and writes
the node, so the quiver written with the builder is the example's own document,
and `density` still decides how many arrows there are.

**The document is the source of truth.** A builder script produces it once, when
it runs; after that the two are independent. That allows two ways of working,
one upstream per scene: the document first (the GUI and agents edit it, scripts
are exports), or the script first (it is in git, the document is rebuilt from
it, and the GUI is for exploring). What breaks is treating both as upstream of
the same scene.

**How much can be kept in sync without parsing.** Writing a GUI edit back into
hand-written code means finding and rewriting text, which is parsing. Short of
that, three levels:

1. **Values — built.** `Scene(values=path)`: the script declares the variables,
   the saved scene holds their values, and the next run takes them. A number in
   the script is a default and the file wins; an expression is a definition and
   the script wins. OpenSCAD's Customizer is the same split (`direction.md` §4,
   finding 6), and it covers the commonest edit: a slider.
2. **Structure, as a layer — designed, not built.** The scene file records which
   steps the script made; GUI edits are a layer of steps on top, by object id; a
   re-run swaps the script's steps and replays the layer, reporting any that no
   longer apply (which the session already does for a scene it opens). Nothing
   is parsed or rewritten. It is an override layer, though, and `instancing.md`
   warns that Godot's override bugs live exactly there.
3. **The script as a generated view — built (B3).** Regenerate the builder
   script from the document on every edit and apply its save by execution.
   Always in sync, because the script is machine-owned: helpers, loops and
   comments are normalized away at the next save or GUI edit.

**A builder script opens whole.** `load_script` -- Open in Magpylib Studio --
runs a script; one that left a `Scene` behind made a document, and that document
is what opens: variables, formulas and patterns, with nothing to guess and
nothing to warn about. In a notebook,
`SceneWidget(scene, editable=True).variable_sliders()` is the Variables panel's
controls for the same scene, bound both ways.

**Any other script says what it lost.** `load_script` keeps what a plain
magpylib script built; its top-level numbers come back as numbers. The import
now names them (a loop's index, read off the compiled script, excepted), where
before a scene with sliders could come back with none and say nothing.

---

## 8. What would make this wrong

1. **Nobody writes scenes in code.** If the GUI, and agents over the LM tools,
   cover it, the builder is surface for nobody and `direction.md` §1's tax for
   nothing. Watch whether the notebooks, the demos and the FEM work get written
   against it.
2. **The refusals bite constantly.** JAX's are among its most complained-about
   behaviour. If ordinary scripts keep tripping over an `if` or an `np.linspace`
   on a variable, rule 2 is still right, but the builder is unpleasant to use.
3. **"Looks like magpylib but isn't" confuses more than a distinct spelling
   would**: someone calls `getB` on a builder object and expects a field.
4. **Agents write worse builder code than they make tool calls** (`direction.md`
   §9.4). Countable: give the same tasks both ways.

---

## 9. Open questions, and what B1 chose for now

Each has a provisional answer in B1, to revisit with use.

- **Ids.** An explicit `id=`, or generated from the label or type? The tree and
  the exported script both show them. _B1:_ `id=` if given, else the label, else
  the class (`cuboid`, `cuboid_2`), reserved at construction so a clash is
  reported at that line.
- **Lazy create (§3) or an explicit `parent=`.** Lazy keeps magpylib's spelling;
  explicit is harder to get wrong. _B1:_ lazy, with `Collection(*children)` and
  `.add()`, and a warning on the one reparent it cannot avoid.
- **Live or detached.** Calls against a live session are mutations with undo, so
  a builder script run in the panel's engine lands in its history. A `Scene()`
  of its own builds a document in memory. Probably both, with detached as the
  default. _B1:_ both — `Scene()` and `Scene(session)` — and a notebook view of
  a `Scene` edits its session rather than a copy.
- **Coverage.** Editor state such as `overridden`, mesh stamps and hidden
  styles: builder calls, or out of scope and carried some other way? B2's
  property test forces the answer. _B2:_ everything a person or an agent can
  make is written -- a hidden object as its style before hiding, then `hide()`,
  and `show()` for one shown again inside a hidden collection -- and what has no
  call, an expression a resize set aside (`overridden`), a key this engine does
  not know or a step that no longer applies, is named in a comment at the top of
  the script.
- **Step order.** The panel puts an edit to a patterned object in front of its
  pattern, so that a drag moves the whole ring, and builder calls go through the
  same operation: `m.duplicate_around(…)` then `m.move(…)` moves every copy,
  where magpylib's reading of those lines moves `m` alone. It is also why a step
  the History panel moved after a pattern cannot be written back, which R1's
  save refuses rather than carry. _Open:_ recording a script's steps in the
  order written closes both, and changes what such a script means.
- **numpy.** Support `np.sin(handle)` through `__array_ufunc__`, or refuse numpy
  on handles entirely and keep one way to say it? _B1:_ numpy's arithmetic and
  the functions an expression has are written as expressions (so `np.pi * r` and
  `np.sin(tilt)` work); every other numpy function refuses.
- **Names.** `magpylib_studio.build` and `Scene` are placeholders.
