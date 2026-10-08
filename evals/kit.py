"""What the tasks share: reading an agent's answer, loading its design, and
saying whether it holds.

A check never trusts the agent's own report of what it built. A number is
read from `answer.json`; a design is built again from the file the agent left
-- in a subprocess, by `evals/extract.py` -- and measured here.
"""

import dataclasses
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np

EXTRACT = pathlib.Path(__file__).with_name("extract.py")

#: How commands are run here, the same for both conditions. The agent runs in
#: a permission mode that refuses whatever it would otherwise ask about, and a
#: shell command that chains or pipes several steps is one it asks about --
#: told nothing, an agent read the refusal as Python being off limits and
#: stopped with its fix written and never run.
RULE = (
    "Write files with the file tools, and run one plain command at a time -- "
    '`python script.py`, `python -c "..."`, `ls`: a shell command that chains '
    "or pipes several steps may be refused here."
)

#: What both conditions are told about the folder they work in.
FOOTER = {
    "plain": "Python 3 with magpylib is installed: run it as `python`. Work in "
    f"this folder; everything the task needs is here. {RULE}",
    "studio": "Python 3 with magpylib and magpylib-studio is installed: run it "
    f"as `python`. Work in this folder; everything the task needs is here. {RULE}",
}

PLAIN_DESIGN = (
    "Deliver a Python script, `design.py`, that builds the design with magpylib "
    "and leaves it in a `magpylib.Collection` assigned to a top-level variable "
    "named `design`."
)
STUDIO_DESIGN = (
    "Deliver the design as a Magpylib Studio scene saved to `design.magpy.json`, "
    "so that I can open it in the studio."
)


@dataclasses.dataclass
class Verdict:
    """Whether a run did the task, why not, and what else was seen."""

    ok: bool
    notes: list = dataclasses.field(default_factory=list)
    extras: dict = dataclasses.field(default_factory=dict)

    def __post_init__(self):
        self.ok = bool(self.ok)  # a numpy comparison is not a bool JSON can write


class Missing(Exception):
    """The deliverable is not there, or cannot be read."""


def answer(work, *keys):
    """`answer.json`, holding at least `keys`."""
    path = pathlib.Path(work) / "answer.json"
    if not path.is_file():
        raise Missing("no answer.json")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        raise Missing(f"answer.json is not JSON: {e}") from e
    absent = [key for key in keys if key not in data]
    if absent:
        raise Missing(f"answer.json lacks {', '.join(absent)}")
    return data


def close(value, target, rel=0.01, abs_=0.0):
    """Whether `value` is `target` to within `rel` of it, or `abs_`."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return False
    return abs(value - target) <= max(rel * abs(target), abs_)


def design(
    work,
    condition,
    *,
    name="design",
    scene=None,
    points=None,
    sets=None,
    overlaps=False,
    timeout=120,
):
    """What the agent built: plain -- the script `{name}.py`, its assembly in
    the variable `name`; studio -- the scene `{scene or name}.magpy.json`,
    with `sets` applied to its variables first."""
    work = pathlib.Path(work).resolve()  # the script runs from inside it
    if condition == "plain":
        path = work / f"{name}.py"
        request = {"kind": "plain", "path": str(path), "name": name}
    else:
        path = work / f"{scene or name}.magpy.json"
        request = {"kind": "studio", "path": str(path), "set": sets or {}}
    if not path.is_file():
        raise Missing(f"no {path.name}")
    if points is not None:
        request["points"] = np.asarray(points, dtype=float).tolist()
    request["overlaps"] = overlaps
    with tempfile.TemporaryDirectory() as scratch:
        asked = pathlib.Path(scratch) / "request.json"
        told = pathlib.Path(scratch) / "answer.json"
        asked.write_text(json.dumps(request), encoding="utf-8")
        try:
            run = subprocess.run(  # noqa: S603 - our own script, on the agent's file
                [sys.executable, str(EXTRACT), str(asked), str(told)],
                cwd=work,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise Missing(f"{path.name} did not finish in {timeout} s") from e
        if run.returncode != 0 or not told.is_file():
            last = (run.stderr.strip().splitlines() or ["(nothing on stderr)"])[-1]
            raise Missing(f"{path.name} does not load: {last}")
        return json.loads(told.read_text(encoding="utf-8"))


def of_type(built, kind):
    return [s for s in built["sources"] if s["type"] == kind]


def magnitudes(built):
    return np.linalg.norm(np.asarray(built["B"], dtype=float), axis=-1)


def judge(check, work, condition):
    """Run a task's check, turning a missing deliverable into a failed one."""
    try:
        return check(pathlib.Path(work), condition)
    except Missing as e:
        return Verdict(False, [str(e)])
