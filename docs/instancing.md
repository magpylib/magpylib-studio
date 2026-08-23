# Parameterised instancing — design

**Status: design, not implemented.** The highest-design-risk item in `TASKS.md`,
written up before code because the open questions in §5 are real and would
otherwise get answered by accident.

Why it exists: `docs/direction.md` §5.2. All four wanted units of reuse —
component library, study recipe, agent workflow, provenance harness — are
_composition_ units, and §4 finding 5 is that a structured format can compose if
it has instancing plus exported parameters. Studio has neither today, which is
why the reuse story currently runs through the script and falls off the cliff.

---

## 1. What the prior art already settles

Three systems solve this problem, and they agree on the two things that looked
hardest.

**A definition lives in its own file.** Godot saves any scene subtree as a
`.tscn` and instances it by reference. An Onshape custom feature is a
FeatureScript function in a separate document, referenced by version. Jsonnet
imports a function from another file. All three, independently. That settles the
crux — definitions are documents, not inline fragments.

**An instance supplies arguments; it does not reach inside.** Godot allows
arbitrary property overrides on an instance, and that is exactly where its
recurring bugs live — exported values resetting to scene defaults, references
shared between instances that should be independent. The lesson is available for
free: **parameters only, no arbitrary overrides.** An instance may set what the
definition declared and nothing else.

---

## 2. The parameter declaration already exists

The useful observation. A document already carries `variables` and
`variable_bounds`; together they are a signature in everything but name:

```json
"variables": { "n": 10, "radius": 0.023, "stagger": "=360/(2*n)" },
"variable_bounds": { "n": { "integer": true, "allowed": [3, 40] } }
```

Instancing is mostly **letting another document supply those**. A definition is
not a new kind of object — it is a scene document whose variables are treated as
its parameters.

---

## 3. Proposed shape

An **instance** is one event, in the same log as everything else:

```json
{
  "id": "e7",
  "op": "instance",
  "target": "ring1",
  "definition": "rings/halbach.magpy.json",
  "sha256": "…",
  "args": { "n": 12, "radius": 0.03 }
}
```

`_build` resolves it the way it resolves everything else — one more case in the
fold: load the definition, bind `args` over its variable defaults, fold its
events into a Collection, attach that Collection as `target`. The copies a
pattern makes are already built this way, so the machinery for "objects that
exist without a spec of their own" is in place.

`to_script` emits a call. That is the shape a person would write by hand, and it
is what makes a definition exportable as a function.

### What it buys

- **Component library** — a folder of definition documents.
- **Study recipe** — sweep an instance's `args` rather than a global variable.
- **FEM** (`docs/fem.md`) — validated assemblies become definitions; the
  `sha256` is already the pin a fixture needs.
- **Provenance** — a scene names exactly which version of which part it used.

---

## 4. What it does not change

The document stays the artifact. This is not a step toward code-as-truth — it is
the feature that makes code-as-truth unnecessary, which is `docs/direction.md`
§7's whole argument.

---

## 5. Open questions

1. **Version pinning and updates.** The `sha256` above pins a definition, which
   is what reproducibility requires — but then updating a part is an explicit
   re-pin, like a lockfile. Is that the right ergonomics, or does it need a
   "check for updates" affordance? Godot does not pin and instances break;
   Onshape pins to a version and updating is deliberate. Onshape looks right.
2. **Nested instances.** A definition containing an instance. Needs cycle
   detection — `move_object` already cycle-checks a reparent, so the idea
   exists, but this one spans files.
3. **Composition with patterns.** `duplicate_around` on an instance should work,
   since an instance resolves to a Collection and that is what the pattern ops
   already take. Verify rather than assume.
4. **Editing through an instance.** Godot allows it; it is where the bugs are.
   Proposal: **refuse**, by name, the way `mirror` refuses a Tetrahedron.
   Editing an instance means editing its definition.
5. **Are a document's variables really its signature?** Simplest is yes, and §2
   argues it. The risk is that every scratch variable becomes public API. If
   that bites, the fix is a declared subset — but adding the distinction up
   front is a concept nobody asked for yet.
6. **Is a same-document definition worth having?** A named fragment, for when a
   second file is overkill. Prior art says no — all three put it in a file — and
   it is an extra concept. Probably no.

---

## 6. What would make this wrong

- **If most reuse turns out to be within one document**, definitions-as-files is
  overhead and question 6 flips.
- **If parameters-only proves too restrictive.** Godot allows overrides for a
  reason, even if the reason costs it bugs. If real use keeps hitting the wall,
  the answer is more declared parameters, not arbitrary overrides — but that is
  a prediction, and it should be checked rather than assumed.
