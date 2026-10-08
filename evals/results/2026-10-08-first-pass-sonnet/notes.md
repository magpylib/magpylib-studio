# First pass: what it says

One run per task and condition, `sonnet`, 2026-10-07 and 08. `summary.md` has
the numbers; these are the readings, and the limits on them.

## Results

- **Both conditions passed every task they can be judged on**: plain 8 of 8,
  studio 10 of 10. With one run each, a difference under about twofold is within
  the noise: the plain agent took 9 turns on `halbach_stack` in one valid run
  and 3 in the next.
- **On the eight shared tasks, studio cost 1.9 times as much** ($0.82 against
  $0.44). Reading the skill adds about 15–25k tokens a run, and the agent spends
  more turns working through the builder.
- **The largest gap is the open design, `halbach_stack`: 22 turns against 3.**
  The studio agent searched by running its builder script once per guess --
  magnet count, radius, number of rings -- one turn each. The skill shows a
  sweep over one variable, and no loop over several in one script; that is the
  first thing to change in it, and to measure again.
- **The studio-only tasks passed**: repairing a builder script the builder
  refused, and turning a plain magpylib ring into a scene with `n` and `radius`
  as sliders. That is what studio adds, and it is what plain magpylib cannot be
  scored on.
- **The skill was read in 9 of 10 studio runs**, the baseline included, where it
  is not needed; not in `sensor_at_field`.

## The task the studio agent got right and the check got wrong

As first written, the edit task asked for sixteen magnets per ring on the
example's 23 mm ring. Sixteen 10 mm cubes do not fit there: they overlap. The
studio agent noticed, widened the ring to keep the old spacing, and said so; the
check wanted the old radius and failed it. The plain agent kept the radius and
passed with magnets inside each other. The task is now twelve per ring, the most
that fit, and its check refuses overlapping magnets.

## What the harness had to learn

- **Isolation.** Run inside the checkout, Claude Code took the repository for
  its project, and the agent had the account's claude.ai connectors. Runs now
  work in a temporary folder with only the file tools and Bash.
- **Permissions.** In a mode where anything that would ask is refused, a shell
  command chaining two heredocs and a pipe was refused; the agent took that to
  mean Python was off limits and stopped with its fix written and never run.
  Both conditions are now told to run one plain command at a time; bypassing the
  checks was refused by the session's safety check, and is not used.
- **Usage limits.** The runs draw on the account's own usage. One pass hit the
  five-hour limit mid-task; such runs are now set apart as stopped by the API,
  and the runner stops at the first.
- **Sleep.** The machine slept through one run; Python's timeout on macOS does
  not count sleep. Runs are now timed by the wall clock, and long ones are run
  under `caffeinate`.
