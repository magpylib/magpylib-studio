# Haiku, studio tasks: what failed, and what the fixes did

One run per line, `haiku`, 2026-10-08. `summary.md` has each evaluation's
table; the transcripts stay in the timestamped folders, outside git. The
summaries say checkout `e4d4a57` for every run before `39f4e45` existed; the
`code` column says what the agent's environment actually held.

| #   | task, condition         | code                    | passed | turns | cost $ |
| --- | ----------------------- | ----------------------- | ------ | ----- | ------ |
| 1   | make_parametric, studio | `e4d4a57`               | 1/1    | 8     | 0.08   |
| 2   | repair_refused, studio  | `e4d4a57`               | 0/1    | 8     | 0.09   |
| 3   | repair_refused, studio  | + the `spin` docs       | 1/1    | 10    | 0.10   |
| 4   | sweep_gap, plain        | (plain magpylib)        | 1/1    | 5     | 0.04   |
| 4   | sweep_gap, studio       | + the `spin` docs       | 1/1    | 21    | 0.13   |
| 5   | sweep_gap, studio       | + `dir()` and `guide()` | 1/1    | 16    | 0.10   |
| 6   | sweep_gap, studio       | `39f4e45`               | 1/1    | 11    | 0.08   |

## Readings

- **Building a scene works** (1): the agent turned the plain ring script into a
  scene with `n` and `radius` as variables.
- **`spin` was misread** (2): the agent replaced the refused loop with
  `duplicate_around` correctly but wrote `spin=2 * 360 / n`, counting the turn
  round the ring twice; the field was off by 96-98 %. After the docstring and the
  skill said `spin` is the extra turn about the copy's own axis (3), it passed.
- **Opening a saved scene was guessed** (4, 5): the agent never loaded the skill
  and spent most of its turns on `dir()` and `help()`, guessing
  `magpylib_studio.build(path)` and `Scene(values=path)`. `dir()` listed nothing,
  then listed `build` without it resolving. With `39f4e45` -- the error naming
  `load_scene` and `sweep`, the `Scene` docstring pointing to the session, the
  skill's description leading with `.magpy.json` -- it loaded the skill first and
  took 11 turns (6).
- **Studio still costs about twice plain on a one-off sweep** (6 against 4): the
  skill read and one round on the shape `sweep` returns. For a one-off
  calculation an agent with plain magpylib is cheaper; studio's case is the
  design a person goes on working on.

## Limits

One run each: a turn count can halve between two runs of the same thing. Each
reading rests on what the transcript shows the agent doing, not on the
numbers alone.
