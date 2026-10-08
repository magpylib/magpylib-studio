# Agent evaluation

Magnetics tasks with checkable targets, run by a coding agent with and without
magpylib-studio, so that whether studio earns its place over an agent writing
magpylib itself is counted rather than argued (`docs/roadmap.md` R4,
`docs/direction.md` §9.4).

## What a run is

One task, in one condition, in a folder of its own, with Claude Code headless
(`claude -p`) as the agent:

| condition | Python has                                | the folder has                                       |
| --------- | ----------------------------------------- | ---------------------------------------------------- |
| `plain`   | magpylib, from PyPI                       | the task's files                                     |
| `studio`  | magpylib-studio, built from this checkout | the task's files, and the skill in `.claude/skills/` |

Both get the task as a person would ask it, and the same setting, kept apart
from this machine's own Claude Code and from this checkout:

- **The folder is a temporary one, outside any repository.** Inside the
  checkout, Claude Code took the repository for its project, with its memory,
  and the reference solutions were a folder away. It is copied into the results
  afterwards, and the empty project folder Claude Code makes for it in
  `~/.claude/projects` is removed.
- **Tools:** the file tools, Bash and Skill. No web, no subagents, no MCP
  servers (`--strict-mcp-config`: the account's claude.ai connectors too), and
  only project settings, so no user skills, plugins or memory. Claude Code's own
  built-in skills remain, the same in both conditions.
- **Shell commands run in Claude Code's sandbox:** they write only in the folder
  and its temp directory, reach no network, cannot ask to leave it, and a
  machine where it cannot start fails the run.
- **Permissions are checked, never bypassed** (`dontAsk`: whatever would ask is
  refused). A command that chains or pipes several steps is one that asks, so
  both conditions are told: write files with the file tools and run one plain
  command at a time. Told nothing, an agent read a refusal as Python being off
  limits and stopped with its fix written and never run.

What the agent leaves is checked by the task, which builds the design again from
the file -- in a subprocess, `extract.py` -- rather than trusting what the agent
says it did. Recorded per run: passed or not and why, turns, tokens, cost, time,
the refusals the builder raised, and whether the skill was read.

## The tasks

| task                 | kind     | conditions | asks for                                                         |
| -------------------- | -------- | ---------- | ---------------------------------------------------------------- |
| `field_above_magnet` | analysis | both       | one number off one magnet: the baseline                          |
| `sensor_at_field`    | analysis | both       | where on a magnet's axis \|B\| is 50 mT                          |
| `sweep_gap`          | analysis | both       | Bz between two magnets of a given scene, over five gaps          |
| `halbach_uniformity` | analysis | both       | centre field and spread between the rings of the Halbach example |
| `halbach_stack`      | design   | both       | 0.1 T uniform to 3 % from 10 mm cubes, which takes stacked rings |
| `coil_target`        | design   | both       | 1 mT on axis 50 mm out, within limits on loops, current, size    |
| `checkerboard`       | design   | both       | a 4 × 4 board of alternating cubes                               |
| `halbach_twelve`     | edit     | both       | the example's rings made twelve magnets, the rest as it was      |
| `repair_refused`     | studio   | studio     | a builder script that loops over a variable, made to work        |
| `make_parametric`    | studio   | studio     | a plain ring turned into a scene with `n` and `radius` sliders   |

Each is a module in `tasks/` with its prompt, its starting files, its check and
a reference solution. `tests/test_evals.py` holds every check to its reference
(which must pass), to a folder where nothing was done, and to plausible wrong
answers (which must not), so a check that measures itself instead of the agent
fails in CI.

## Running it

```sh
.venv/bin/python evals/run.py --dry-run           # the folders and commands only
.venv/bin/python evals/run.py --tasks sweep_gap   # one task, both conditions
.venv/bin/python evals/run.py --repeats 3         # everything, three times
.venv/bin/python evals/run.py --recheck evals/results/<run>   # check again, no agent
```

It needs `uv` and Claude Code: `claude` on the PATH, `CLAUDE_BIN`, `--claude`,
or the one the VS Code extension carries. The model is `--model` (default
`sonnet`); each run stops at `--budget` dollars (default 2) and `--timeout`
seconds of wall-clock time. The two Python environments live in `evals/.envs/`;
the studio one is rebuilt from the checkout on every run.

Keep a laptop awake while it runs --
`caffeinate -i .venv/bin/python evals/run.py` on a Mac. A run the machine slept
through is not a measurement: the first full pass had one, an agent's command
timing out across a fifteen-minute sleep and its run taking twice the turns to
recover.

Results go to `evals/results/<date>-<model>/`: `summary.md` sets the conditions
side by side per task, and `runs/` holds each run's folder, prompt, transcript
and result. Only the summaries are kept in git.

## Adding a task

A module in `tasks/` with `TITLE`, `KIND`, `CONDITIONS`, `prompt(condition)`,
`inputs(condition)`, `check(work, condition)` and `reference(work, condition)`
(see `tasks/__init__.py`). Ask for a deliverable a check can read --
`answer.json`, `design.py` leaving a `design` collection, or `design.magpy.json`
-- and give `tests/test_evals.py` a plausible wrong answer for it.
