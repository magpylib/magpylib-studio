# Writing a scene in plain magpylib — design

**Status: proposed.** A spike on magpylib's `spike/record-calls` branch
(`3c8618e6`) shows the magpylib half works, and a prototype shows studio can
record on released magpylib today (§5); nothing in studio is built. This is the
next step of `builder.md`: the same document, the same session operations,
written as a plain magpylib function whose parameters are the variables. The
builder has not been released, so its spelling is replaced, not deprecated.

---

## 1. What the builder still costs

The builder (`builder.md`) made a parametric scene writable in code, and its
rule 3 keeps the names magpylib's. But the objects are not magpylib's:
`s.magnet.Cuboid` is a stand-in that records, so the spelling has to be kept in
step by hand, and its §8 names what follows — "looks like magpylib but isn't",
`getB` on a builder object, agents writing worse builder code than magpylib.

The agent evaluations (`evals/results/2026-10-08-haiku-agent-fixes`) count it.
Where studio's spelling differs from magpylib's, an agent pays: `spin` read the
wrong way, `range(n)` refused, a saved scene opened by guessing. Plain magpylib
it already knows.

---

## 2. The proposal: a function in plain magpylib, its parameters the variables

```python
from typing import Literal

import magpylib as magpy
from magpylib_studio import Angle, Count, Length, derived, duplicate_around, scene


@scene
def ring(
    n: Count(2, 60, slider=(4, 20)) = 10,
    radius: Length(0.005, 0.08, slider=(0.016, 0.04)) = 0.023,
    tilt: Angle(-180, 180) = 0.0,
    tilt_axis: Literal["x", "y", "z"] = "z",
):
    stagger = derived("stagger", 360 / (2 * n), unit="angle")
    magnets = magpy.Collection(style_label="Ring")
    magnet = magpy.magnet.Cuboid(
        dimension=(0.01, 0.01, 0.01), polarization=(1, 0, 0), position=(radius, 0, 0)
    )
    magnets.add(magnet)
    duplicate_around(magnet, count=n, axis="z", spin=360 / n)  # studio's word
    magnets.rotate_from_angax(stagger, "z", anchor=0)
    magnets.rotate_from_angax(tilt, tilt_axis, anchor=0)
    return magnets
```

One function, three callers:

- **Plain magpylib.** `ring(n=12)` is a call like any other: real objects at
  those values, a field from `getB`, no studio anywhere. The export to plain
  magpylib is the file itself.
- **Studio.** `scene` wraps the function and hands back something callable in
  its place: called, it is the plain function above, numbers in and magpylib
  objects out. `ring.build()` calls it with the variables as handles and records
  what it does (below) into a `Scene`: the document, with its variables, bounds,
  units and steps. `ring.build(values=path)` calls it with a saved scene's
  values, which is what `Scene(values=…)` did with a rule to explain. The
  wrapper keeps the signature (`functools.wraps`), so `inspect`, pydantic and
  TangleFunction read it unchanged; `@scene` and `scene(ring)` are the same
  wrapping.
- **A notebook.** wigglystuff's `TangleFunction(ring)` renders
  `ring(n=10, radius=0.023, tilt=0.0, tilt_axis='z')` as a call expression whose
  numbers drag and whose choices click, off the same signature; a `SceneWidget`
  follows its values by calling the function. Studio's inline variables panel
  for marimo and Jupyter, with no studio code behind it.

**The call is the recording scope.** Studio does the calling, so there is no
block to open and none to forget — a forgotten `with s.recording():` would have
been a silent failure, objects built and a document without them, and the agent
evaluations say an agent finds every silent failure in time. Objects made
outside the function are not in the scene; two scenes are two functions; and a
notebook records the whole scene inside one call, so no cell boundary can drop
it.

**Variables are parameters, their metadata standard.** A bound is
`annotated_types` (`Annotated[float, Ge(0.005), Le(0.08)]`, the constraints
pydantic reads), a choice is `Literal` or `bool`, an integer is `int`. Studio's
own facts — the unit, the slider range — ride along as further `Annotated`
metadata, which is what `Annotated` is for: a reader keeps what it knows and
passes the rest. `Length(lo, hi, slider=…)`, `Angle(…)`, `Count(…)` are sugar
that expand to exactly that, so the long standard form reads the same. Checked
against `TangleFunction`: it read the bounds, took `n` as an integer and
`tilt_axis` as a choice, and ignored the unit and slider metadata without a
word. Its default float step is 0.1, useless at 0.023 m, so the sugar emits a
`MultipleOf` from the range. The sugar sits inside `Annotated`, as
`radius: Annotated[float, Length(0.005, 0.08, slider=…)]`, never in annotation
position on its own: a call there is an invalid type form to pyright and
Pylance, a squiggle on every parameter in VS Code. `Length` is an
`annotated_types.GroupedMetadata`, which expands to `Ge`, `Le` and `MultipleOf`
for any reader that follows the protocol, as pydantic does. TangleFunction
0.5.34 does not yet — checked: it read `Ge`/`Le` written out and ignored the
grouped form — so until a pull request there lands, the examples write the
constraints out, or unpack them (`Annotated[float, *Length(…)]`, on the 3.11
floor).

**A derived variable** (`stagger`, a formula of other variables, shown in the
panel as one) cannot be a parameter, since a default cannot mention `n`; it is
one call in the body, `derived(name, formula, unit=…)`.

**Inside studio's call, a parameter is a handle**, as a builder variable is
today: arithmetic on it writes an expression, and `range(n)`, `if radius > …`
and `math.sin(radius)` refuse with the message that names the alternative
(`builder.md` rule 2). Called plainly it is a number. The annotation names the
quantity and is true either way.

**Whatever is constructed during the call is the scene**, whoever constructed
it: a helper the script defines, a loop, a library called from the body. The
hook treats magpylib's own nested calls as nested and nothing else, and the docs
replay (§3) found no page where that recorded too much. A call the recorder
cannot map is refused at its line (§7.1), never dropped.

**A property read is today's number, and nothing refuses it.** `magnet.position`
inside the call returns the resolved value, so
`position=magnet.position + (0.02, 0, 0)` records a literal and the link to
`radius` is gone without a word: the one silent cliff left, and one the
builder's stand-in objects could not fall off. The hook can tell a top-level
read from magpylib's own, so P1 warns on a top-level read of a property whose
recorded value held a handle, naming the parameter to write instead, and the
skill says the same.

**magpylib's half: a recording hook.** Inside `record(on_event, resolve)`, every
top-level construction, property assignment and transformation is reported with
its arguments as written; magpylib's own nested calls (a constructor setting its
properties, a collection moving its children) are not. `resolve` turns each
argument into a number before magpylib sees it, so a handle never reaches
magpylib's validators, transforms or kernels. Generic, about 140 lines and a
4-line hook in `BaseGeo.__init_subclass__`; studio is one user of it. Only
magpylib's own classes are wrapped: a subclass written in a script is
transparent, so the magpylib calls its methods make are what is recorded, and
its objects are reported as the magpylib class they extend (found on the docs'
`MagnetRing`, §3).

**Style needs nothing new from magpylib.** The recorder keeps the style each
object was _given_ — the style tree's `set_values()`, `style_compat`'s
equivalent on 5.2.x — and, at every recorded call, writes what changed since as
style steps, paths sorted (`color`, `magnetization.show`). An edit lands before
the next call, which is where it was written as far as any later call can tell:
a style set before `copy()` is in the copy. Given, not resolved: one `show()`
resolves every default, and recording those turned 27 steps into 759 on one docs
page. And read without making a style that was never made: reading `obj.style`
creates it, and `copy()` labels a copy differently once it exists (`Cuboid_01`
instead of none), so a recorder that looks changes what it records. P0 fixes
that in `copy()`; until then the recorder checks before it reads.

**Studio's half: a recorder that calls the builder's own internals.** Each event
becomes what the builder does today for the same call: a construction is
`Scene._object`, a transformation `_call`, `add` the lazy create of `builder.md`
§3, a style edit the style step. So:

- **The document does not change.** Same `.magpy.json`, same steps, same session
  operations, same GUI. Nothing to migrate in a saved scene.
- **The objects are real.** `getB`, `show`, paths, everything magpylib does
  works on them, at the variables' current values. `builder.md` §8.3 goes away.
- **The refusals stay where they are**, in the script's own code. Inside a
  magpylib call a handle is resolved, so magpylib never refuses it.

---

## 3. What the spike shows

On magpylib `main` (`87046ffc`) with the hook, and a throwaway recorder in place
of studio's:

- A Halbach ring of 8 cuboids, a copy, a property set, four style edits (one
  before the copy) and a sensor recorded as 42 steps; replayed at changed
  values, the field matched a direct plain-magpylib build exactly (0.0
  difference, where the change moved B by 89 %).
- The built-in Halbach example, written as the function of §2 and run with
  numbers in place of handles, gives studio's own field for the example document
  to its 6-digit rounding, at today's values and at two changed settings.
- magpylib's suite passes (1410) with the hook in place.
- **magpylib's own docs examples** (`tools/replay-magpylib-docs.py`), each page
  run plain and recorded, the recording replayed from JSON and every object
  compared — pose, field, pixels, the style it was given. Of 35 pages, 31 run
  here (four need a package or a matplotlib this machine lacks). **Recording
  changed what no page did. 27 replay exactly**, among them 1 215 objects and 3
  438 steps in `examples_force_floating`, pyvista meshes, convex hulls, current
  sheets, paths, animations and copied collections. The other four are two gaps,
  both known: a `model3d` trace, data that needs an encoding (§8.3), and a
  `CustomSource` with a Python `field_func`, which is code (§8.5).
- **Cost with nothing recording: about 0.1 µs per wrapped call**, some 4 % on
  building and moving objects, nothing measurable once a field is computed.
  Building many objects in a Python loop is the slow way in magpylib anyway; a
  path of 10 000 positions is one call.

---

## 4. Choices made

- **The scene is a function, not a listening object.** `Scene()` listening from
  the moment it is made, with `paused()`, a takeover by a newer scene and a
  warning from `save()`, was the previous answer to the forgotten block. The
  function needs none of it: the call is the scope.
- **Variables are annotated parameters**, not `s.variable(…)` calls: the
  signature is what `inspect`, pydantic, typer and wigglystuff already read, and
  the function runs as plain magpylib with its defaults. Bounds and choices in
  the standard spellings; the unit and the slider range as studio's metadata;
  `Length`, `Angle`, `Count` as grouped metadata inside `Annotated` (§2).
- **`scene` is one thing**: a wrapper that is the plain function when called and
  records through `.build()` (§2). A decorator that recorded at definition time
  would make `ring(n=12)` a document, and the plain call is the point.
- **An explicit id where the label gives none** (decided 2026-10-08):
  `name(obj, "r1")`, written by `to_builder_script` only where the id is not
  what the label gives, and rarely by hand; the skill does not teach it. The
  built-in Halbach's `r1` and `ring1` are such ids, and so is every object made
  in the panel, whose id the person typed while its label came from the type;
  without it the tab's save would refuse any panel-made scene as changing more
  than its edit. Separately, Add Object should ask for a label and derive the id
  by the recorder's rule, so the explicit name becomes rare for new scenes.
- **The hook is always on (A).** The alternatives are recorded here, not built:
  wrappers installed only while recording (B: zero cost, but global class
  patching — a method grabbed before the block is missed, `mock.patch` can
  clash, threads need a lock), or a check written inline in each method (C:
  cheaper than A, no global effects, but about 60 methods edited by hand). Move
  to C, not B, if A ever shows in a real workload.
- **The hook is `magpylib.record`, at the top level.** magpylib already gives
  tools top-level entry points — `register_backend` for plotting libraries,
  `show_context` as a context manager — and `record` sits beside them. `core`
  holds the field kernels, the wrong home; a namespace for one function is not
  worth one. Public, documented as an interface for tools, its event kinds and
  fields under magpylib's usual deprecation policy.
- **Ids come from `style_label`, else the class**, as the builder makes them
  (`Magnet_1`, `cuboid`, `cuboid_2`): magpylib constructors take no `id=`, and
  this adds no spelling. What an object made in the panel needs is §8.6.
- **The builder's spelling is replaced, with no alias.** It was never released,
  so no script outside this repository uses `s.magnet.Cuboid`; the README, the
  examples, the skill, the tests and the eval tasks move with P2. Saved scenes
  are untouched either way: the document does not change.
- **Patterns are studio's.** magpylib has no word for a pattern over a variable
  count; `duplicate_around(obj, …)`, `duplicate_along`, `mirror` record one step
  and make the copies with the recorder ignoring them. A Python loop over a
  _literal_ count stays plain magpylib, as in the builder.
- **Not a new document format.** Recording magpylib calls as the document was
  considered: it would replace studio's steps with a call log, a new
  `.magpy.json` version, and every GUI operation would need a magpylib call. The
  recorder gives the same spelling without it.
- **Not array-API tracing.** Tracing values through an array-API magpylib (#981)
  records arithmetic — quaternion products — not steps, needs SciPy's opt-in
  `SCIPY_ARRAY_API`, and today loses expressions silently in every rotation and
  in Sphere, Circle and Polyline. Worth having for JAX and GPUs; not this.

---

## 5. Until magpylib releases the hook

Studio cannot wait for a magpylib release, and the change must not show when it
comes. So it goes the way `style_compat.py` went for the style tree: studio uses
`magpylib.record` where magpylib has it, and puts the same hook on itself where
it does not.

**`record_compat`: the hook from outside.** Released magpylib (5.2.3, checked)
has the classes and methods the hook wraps — `BaseGeo`, the eight `move` and
`rotate_*`, `Collection.add` and `remove` — but neither the hook nor
`__init_subclass__`. Studio carries a copy of magpylib's `recording.py` and, on
the first `scene(fn)`, wraps every object class from outside once, and chains a
`BaseGeo.__init_subclass__` so classes made later are wrapped too. Style needs
no shim (§2).

**Checked on three magpylibs** with one recorded scene (a Halbach ring, a copy
styled before it was copied, a sensor): released 5.2.3 with the copy, `main`
with the copy, and the spike branch with its own hook. All three write
**byte-identical documents**, and each replays at changed values to the exact
field of a direct build. That is the property the transition rests on, so it is
a test: one scene, recorded on each magpylib in CI, the documents compared. That
check compared resolved styles; with style now recorded as given (§2), it holds
only if `style_compat`'s given values on 5.2.x match `set_values()` on the tree,
which P1 checks first.

**When the release comes**, studio's minimum moves to it and `record_compat`
goes. Nothing a user wrote or saved changes.

**What the copy costs:**

- It reaches into `magpylib._src` (`class_BaseGeo.BaseGeo` and the classes below
  it), stable across 5.2.x and `main` but private. It is version-gated, like
  `style_compat`, and tested on each magpylib studio supports.
- Recording is slower on 5.2.3 (15 ms against 4 ms for the scene above), from
  `as_dict()` on the older style objects at every call; it grows with objects
  times calls. On a magpylib with `observe`, only the objects it reports as
  edited need comparing, which keeps the output and drops the cost.
- Once installed, the wrappers stay for the session: about 0.1 µs a call when
  nothing records, as with the hook itself (§3).

---

## 6. Phases

**P0 — magpylib: the hook, public.** As `magpylib.record` (§4), docs, tests (the
spike's four, plus "type in, type out" for every class and transform), a
release. With it: `copy()` labels a copy the same whether or not the original's
style was ever read (§2), and `Trace3d`'s `==` stops raising on a trace that
holds arrays. Not a blocker: studio ships on `record_compat` (§5) until then.

**P1 — the recorder.** `scene(fn)` with `.build()` and `.build(values=…)`, the
annotations and their sugar, `derived`, the patterns as functions, on
`record_compat`. Acceptance, as B1's was: each built-in example written as a
function builds the same document as its builder script — same variables, bounds
and steps, and the same field (`same_field`) — on every magpylib studio
supports, the documents byte-identical across them; and called plainly with its
defaults, each gives the field its document gives. And magpylib's docs, through
`tools/replay-magpylib-docs.py` on studio's recorder in place of the stand-in:
no page broken by recording, the 27 exact pages still exact, and the two gaps
(§3) closed or refused at their line.

**P2 — the tab, the skill, a notebook.** `to_builder_script` writes a function
in the new spelling; the script tab and apply-on-save are unchanged in mechanism
(`builder.md` §5), with the `@scene` mark telling the studio which function in a
file is the scene. `SKILL.md`, `examples/builder_demo.py`, the eval tasks and
`help()` switch, and `s.magnet.Cuboid` goes (§4). A marimo example:
`TangleFunction(halbach)` above a `SceneWidget` that follows it, the Halbach
ring explored by dragging numbers in its own call expression.

**P3 — measure.** The studio tasks again, Haiku only, one run each: the
spelling's whole point is fewer turns.

---

## 7. What would make this wrong

1. **magpylib's API moves under the mapping.** The hook is generic, but the
   recorder maps each method onto a session operation; a renamed or new method
   is a gap until mapped. Mitigation: an unmapped call is refused at its line,
   not dropped.
2. **Real scripts call what has no session operation** — `rotate` with a SciPy
   `Rotation`, `reset_path`, `remove`, `start=` on a path — often enough that
   the refusals bite. Count them on the examples and the notebooks before P1
   ends.
3. **The hook reads as studio's in magpylib.** It must stand alone: undo stacks,
   serializers and teaching tools can use it. If it cannot be argued without
   studio, it does not belong in magpylib.
4. **Nobody wants the function.** A flat script — variables, then objects, cell
   by cell — is how a notebook is written, and the function is a wrapper around
   it. If people and agents keep writing the flat form and wrapping it after,
   the wrapper is a tax (`direction.md` §1), and the listening-scene form (§4)
   comes back as the second way in.
5. **Property reads leak numbers oftener than the warning catches** (§2): the
   warning sees a read of a value a handle produced, not a number copied by
   hand. Count reads on the examples and the notebooks with the refusals (2).

---

## 8. Open questions

1. **Lazy create (`builder.md` §3)** carries over as the recorder's rule for
   `add`; does magpylib's own `add` semantics (the child keeps its absolute
   pose) make any of it simpler?
2. **A variable in a style value** (`opacity=fade`): refused for now; the style
   tree validates values, so it would need its own resolve.
3. **`model3d` traces** arrive as `Trace3d` objects and need an encoding before
   a style step can hold them.
4. **A path over a variable** (`np.linspace(0, stroke, 100)`): a variable
   refuses to become an array, so a recorded path needs `sampled` (`builder.md`
   §7), as the builder does today.
5. **A `CustomSource` with a Python `field_func`** is code, and a document holds
   none. Refused at its line, or kept as an importable `module:function` that
   opening the scene imports — which is running code, what `direction.md` §7
   rejected for the document?
6. **Names.** `scene`, `derived`, `Length`, `Angle`, `Count` are placeholders,
   as the builder's were (`builder.md` §9).
