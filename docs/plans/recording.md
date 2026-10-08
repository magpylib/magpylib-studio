# Writing a scene in plain magpylib — design

**Status: proposed.** A spike on magpylib's `spike/record-calls` branch
(`f24f5228`) shows the magpylib half works, and a prototype shows studio can
record on released magpylib today (§5); nothing in studio is built. This is the
next step of `builder.md`: the same document, the same session operations,
written in magpylib's own spelling instead of a copy of it. The builder has not
been released, so its spelling is replaced, not deprecated.

---

## 1. What the builder still costs

The builder (`builder.md`) made a parametric scene writable in code, and its rule
3 keeps the names magpylib's. But the objects are not magpylib's: `s.magnet.Cuboid`
is a stand-in that records, so the spelling has to be kept in step by hand, and
its §8 names what follows — "looks like magpylib but isn't", `getB` on a builder
object, agents writing worse builder code than magpylib.

The agent evaluations (`evals/results/2026-10-08-haiku-agent-fixes`) count it.
Where studio's spelling differs from magpylib's, an agent pays: `spin` read the
wrong way, `range(n)` refused, a saved scene opened by guessing. Plain magpylib
it already knows.

---

## 2. The proposal: magpylib reports its calls, studio records them

```python
import magpylib as magpy
from magpylib_studio.build import Scene

s = Scene()  # from here on, magpylib calls are recorded into s
radius = s.variable("radius", 0.023, bounds=(0.005, 0.08), unit="length")
n = s.variable("n", 10, integer=True)

ring = magpy.Collection(style_label="Ring")
magnet = magpy.magnet.Cuboid(
    dimension=(0.01, 0.01, 0.01), polarization=(1, 0, 0), position=(radius, 0, 0)
)
ring.add(magnet)
s.duplicate_around(magnet, count=n, axis="z", spin=360 / n)  # studio's word
ring.rotate_from_angax(15, "x")
print(ring.getB((0, 0, 0)))  # a real field, at today's values

with s.paused():  # scratch, not in the scene
    probe = magpy.misc.Dipole(moment=(0, 0, 1))

s.save("ring.magpy.json")
```

**The scene listens from the moment it is made**, as pyplot draws into the
current figure: no block to open, so none to forget. Forgetting a
`with s.recording():` would have been a silent failure — objects built, a
document without them — and the agent evaluations say an agent finds every
silent failure in time. A new `Scene()` takes over from the one before; objects
that should stay out go under `with s.paused():`; and `save()` warns when
magpylib objects were made while no scene was listening, so what is left of the
edge is not silent either.

**magpylib's half: a recording hook.** Inside `record(on_event, resolve)`, every
top-level construction, property assignment and transformation is reported with
its arguments as written; magpylib's own nested calls (a constructor setting its
properties, a collection moving its children) are not. `resolve` turns each
argument into a number before magpylib sees it, so a variable never reaches
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
resolves every default, and recording those turned 27 steps into 759 on one
docs page. And read without making a style that was never made: reading
`obj.style` creates it, and `copy()` labels a copy differently once it exists
(`Cuboid_01` instead of none), so a recorder that looks changes what it records.
P0 fixes that in `copy()`; until then the recorder checks before it reads.

**Studio's half: a recorder that calls the builder's own internals.** Each event
becomes what the builder does today for the same call: a construction is
`Scene._object`, a transformation `_call`, `add` the lazy create of
`builder.md` §3, a style edit the style step. So:

- **The document does not change.** Same `.magpy.json`, same steps, same session
  operations, same GUI. Nothing to migrate in a saved scene.
- **The objects are real.** `getB`, `show`, paths, everything magpylib does
  works on them, at the variables' current values. `builder.md` §8.3 goes away.
- **The refusals stay where they are.** A variable still refuses to become a
  number in the script's own code — `range(n)`, `if radius > …`,
  `math.sin(radius)` — with the message that names the alternative. Inside a
  magpylib call it is resolved, so magpylib never refuses it.

---

## 3. What the spike shows

On magpylib `main` (`87046ffc`) with the hook, and a throwaway recorder in place
of studio's:

- A Halbach ring of 8 cuboids, a copy, a property set, four style edits (one
  before the copy) and a sensor recorded as 42 steps; replayed at changed
  values, the field matched a
  direct plain-magpylib build exactly (0.0 difference, where the change moved B
  by 89 %).
- magpylib's suite passes (1410) with the hook in place.
- **magpylib's own docs examples** (`tools/replay-magpylib-docs.py`), each page
  run plain and recorded, the recording replayed from JSON and every object
  compared — pose, field, pixels, the style it was given. Of 35 pages, 31 run
  here (four need a package or a matplotlib this machine lacks). **Recording
  changed what no page did. 27 replay exactly**, among them 1 215 objects and
  3 438 steps in `examples_force_floating`, pyvista meshes, convex hulls, current
  sheets, paths, animations and copied collections. The other four are two gaps,
  both known: a `model3d` trace, data that needs an encoding (§8.3), and a
  `CustomSource` with a Python `field_func`, which is code (§8.5).
- **Cost with nothing recording: about 0.1 µs per wrapped call**, some 4 % on
  building and moving objects, nothing measurable once a field is computed.
  Building many objects in a Python loop is the slow way in magpylib anyway; a
  path of 10 000 positions is one call.

---

## 4. Choices made

- **The hook is always on (A).** The alternatives are recorded here, not built:
  wrappers installed only while recording (B: zero cost, but global class
  patching — a method grabbed before the block is missed, `mock.patch` can clash,
  threads need a lock), or a check written inline in each method (C: cheaper
  than A, no global effects, but about 60 methods edited by hand). Move to C, not
  B, if A ever shows in a real workload.
- **The hook is `magpylib.record`, at the top level.** magpylib already gives
  tools top-level entry points — `register_backend` for plotting libraries,
  `show_context` as a context manager — and `record` sits beside them. `core`
  holds the field kernels, the wrong home; a namespace for one function is not
  worth one. Public, documented as an interface for tools, its event kinds and
  fields under magpylib's usual deprecation policy.
- **Ids come from `style_label`, else the class**, as the builder makes them
  (`cuboid`, `cuboid_2`): magpylib constructors take no `id=`, and this adds no
  spelling.
- **The builder's spelling is replaced, with no alias.** It was never released,
  so no script outside this repository uses `s.magnet.Cuboid`; the README, the
  examples, the skill, the tests and the eval tasks move with P2. Saved scenes
  are untouched either way: the document does not change.
- **Patterns are studio's.** magpylib has no word for a pattern over a variable
  count; `s.duplicate_around(obj, …)`, `s.duplicate_along`, `s.mirror` record one
  step and make the copies with the recorder ignoring them. A Python loop over a
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
the first `Scene()`, wraps every object class from outside once, and
chains a `BaseGeo.__init_subclass__` so classes made later are wrapped too. Style
needs no shim (§2).

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

- It reaches into `magpylib._src` (`class_BaseGeo.BaseGeo` and the classes
  below it), stable across 5.2.x and `main` but private. It is version-gated,
  like `style_compat`, and tested on each magpylib studio supports.
- Recording is slower on 5.2.3 (15 ms against 4 ms for the scene above), from
  `as_dict()` on the older style objects at every call; it grows with objects
  times calls. On a magpylib with `observe`, only the objects it reports as
  edited need comparing, which keeps the output and drops the cost.
- Once installed, the wrappers stay for the session: about 0.1 µs a call when
  nothing records, as with the hook itself (§3).

---

## 6. Phases

**P0 — magpylib: the hook, public.** As `magpylib.record` (§4), docs, tests (the
spike's three, plus "type in, type out" for every class and transform), a
release. A scene listens for as long as it lives (§2), not for a block, so
`record` needs a start/stop form beside `with`. With it: `copy()` labels a copy
the same whether or not the original's style was ever read (§2), and
`Trace3d`'s `==` stops raising on a trace that holds arrays. Not a blocker:
studio ships on `record_compat` (§5) until then.

**P1 — the recorder.** `Scene()` starts listening, mapping each magpylib event
onto the builder's internals, on `record_compat`; `s.paused()`, the takeover by
a newer scene, and `save()`'s warning go with it. Acceptance, as B1's was: each
built-in example written in plain magpylib builds the same document as its
builder script — same variables, bounds and steps, and the same field
(`same_field`) — on every magpylib studio supports, and the documents are
byte-identical across them. And magpylib's docs, through
`tools/replay-magpylib-docs.py` on studio's recorder in place of the stand-in:
no page broken by recording, the 27 exact pages still exact, and the two gaps
(§3) closed or refused at their line.

**P2 — the tab and the skill.** `to_builder_script` writes the new spelling; the
script tab and apply-on-save are unchanged in mechanism (`builder.md` §5).
`SKILL.md`, the examples, the eval tasks and `help()` switch, and
`s.magnet.Cuboid` goes (§4).

**P3 — measure.** The studio tasks again, Haiku only, one run each: the
spelling's whole point is fewer turns.

---

## 7. What would make this wrong

1. **magpylib's API moves under the mapping.** The hook is generic, but the
   recorder maps each method onto a session operation; a renamed or new method
   is a gap until mapped. Mitigation: an unmapped call is refused at its line,
   not dropped.
2. **Real scripts call what has no session operation** — `rotate` with a SciPy
   `Rotation`, `reset_path`, `remove`, `start=` on a path — often enough that the
   refusals bite. Count them on the examples and the notebooks before P1 ends.
3. **The hook reads as studio's in magpylib.** It must stand alone: undo stacks,
   serializers and teaching tools can use it. If it cannot be argued without
   studio, it does not belong in magpylib.
4. **A notebook drops the listener between cells.** The hook keeps the active
   recorder in a context variable; if a kernel runs each cell in a context of
   its own, a scene built over several cells stops recording after the first,
   without a word. Not checked yet: P1 tests it in a real kernel before
   anything else, and if it holds, studio keeps its current scene in a plain
   global and the hook's start/stop form (P0) takes one.

---

## 8. Open questions

1. **Lazy create (`builder.md` §3)** carries over as the recorder's rule for
   `add`; does magpylib's own `add` semantics (the child keeps its absolute
   pose) make any of it simpler?
2. **A variable in a style value** (`opacity=fade`): refused for now; the style
   tree validates values, so it would need its own resolve.
3. **`model3d` traces** arrive as `Trace3d` objects and need an encoding before a
   style step can hold them.
4. **A path over a variable** (`np.linspace(0, stroke, 100)`): a variable refuses
   to become an array, so a recorded path needs `s.sampled` (`builder.md` §7),
   as the builder does today.
5. **A `CustomSource` with a Python `field_func`** is code, and a document holds
   none. Refused at its line, or kept as an importable `module:function` that
   opening the scene imports — which is running code, what `direction.md` §7
   rejected for the document?
