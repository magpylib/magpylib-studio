"""The agent evaluation's tasks hold up (`evals/`, `docs/roadmap.md` R4).

A task whose check passes what it should not, or fails what it should pass,
measures the checker instead of the agent. So every task here is run against
its own reference solution, which must pass, and against a folder where nothing
was done, which must not -- in each condition it runs in. No agent is started.
"""

import json
import pathlib
import sys

import pytest

import magpylib_studio

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from evals import kit, run  # noqa: E402 - after the path that finds it
from evals.tasks import all_tasks  # noqa: E402

TASKS = all_tasks()
CASES = [
    (name, condition) for name, task in TASKS.items() for condition in task.CONDITIONS
]
SKILL = (
    pathlib.Path(magpylib_studio.__file__).parent
    / ".agents"
    / "skills"
    / "magpylib-studio"
)


def test_the_set_spans_what_it_is_meant_to_measure():
    kinds = {task.KIND for task in TASKS.values()}
    assert kinds == {"analysis", "design", "edit", "studio"}
    # most tasks run both ways, so the two conditions can be set side by side
    both = [
        name
        for name, task in TASKS.items()
        if set(task.CONDITIONS) == {"plain", "studio"}
    ]
    assert len(both) >= len(TASKS) - 2


@pytest.mark.parametrize(("name", "condition"), CASES)
def test_the_reference_passes_and_nothing_done_fails(name, condition, tmp_path):
    task = TASKS[name]
    untouched = tmp_path / "untouched"
    run.prepare(task, condition, untouched)
    assert not kit.judge(task.check, untouched, condition).ok

    done = tmp_path / "done"
    run.prepare(task, condition, done)
    task.reference(done, condition)
    verdict = kit.judge(task.check, done, condition)
    assert verdict.ok, verdict.notes


@pytest.mark.parametrize(("name", "condition"), CASES)
def test_the_prompt_says_what_to_leave_and_where_it_runs(name, condition):
    prompt = run.full_prompt(TASKS[name], condition)
    assert prompt.endswith(kit.FOOTER[condition] + "\n")
    # a deliverable is named, and the plain prompt never mentions the studio
    assert any(word in prompt for word in ("answer.json", ".magpy.json", ".py`"))
    if condition == "plain":
        assert "studio" not in prompt.lower()


def test_a_studio_folder_carries_the_skill_and_a_plain_one_does_not(tmp_path):
    task = TASKS["field_above_magnet"]
    run.prepare(task, "studio", tmp_path / "studio", SKILL)
    run.prepare(task, "plain", tmp_path / "plain", SKILL)
    assert (
        tmp_path / "studio" / ".claude" / "skills" / "magpylib-studio" / "SKILL.md"
    ).is_file()
    assert not (tmp_path / "plain" / ".claude").exists()


def test_the_agent_gets_no_more_than_the_list():
    argv = run.command("claude", "sonnet", 1.0)
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    assert argv[argv.index("--setting-sources") + 1] == "project"
    assert "--strict-mcp-config" in argv  # no claude.ai connectors either
    sandbox = json.loads(argv[argv.index("--settings") + 1])["sandbox"]
    assert sandbox["enabled"] and not sandbox["allowUnsandboxedCommands"]
    assert "WebFetch" not in argv[argv.index("--tools") + 1]
    assert not any("dangerously" in arg or "bypass" in arg.lower() for arg in argv)
    env = run.agent_env(pathlib.Path("/venv"))
    assert not any(key.startswith("CLAUDE") for key in env)
    assert env["PATH"].startswith("/venv/bin:")


def test_a_transcript_is_read_for_turns_tokens_refusals_and_the_skill():
    events = [
        {
            "type": "system",
            "subtype": "init",
            "skills": ["magpylib-studio"],
            "model": "m",
        },
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Skill",
                        "input": {"skill": "magpylib-studio"},
                    },
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "input": {"command": "python a.py"},
                    },
                ]
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "content": "TypeError: `n` cannot count a loop or index a list",
                    }
                ]
            },
        },
        {
            "type": "result",
            "subtype": "success",
            "num_turns": 7,
            "total_cost_usd": 0.12,
            "duration_ms": 30500,
            "usage": {
                "input_tokens": 10,
                "output_tokens": 20,
                "cache_read_input_tokens": 300,
            },
        },
    ]
    read = run.read_transcript([json.dumps(e) for e in events] + ["not json"])
    assert read["skill_read"] and read["refusals"] == 1
    assert read["tools"] == {"Skill": 1, "Bash": 1}
    assert (read["turns"], read["cost_usd"], read["seconds"]) == (7, 0.12, 30.5)
    assert read["skills_offered"] == ["magpylib-studio"]


def _ring_script(path, n, radius, z_values=(0.0,)):
    path.write_text(
        "import magpylib as magpy\n\n"
        "design = magpy.Collection()\n"
        f"for z in {tuple(z_values)!r}:\n"
        f"    for i in range({n}):\n"
        f"        angle = 360 * i / {n}\n"
        "        cube = magpy.magnet.Cuboid(dimension=(0.01, 0.01, 0.01), "
        f"polarization=(1.2, 0, 0), position=({radius}, 0, z))\n"
        "        cube.rotate_from_angax(angle, 'z', anchor=None)\n"
        "        cube.rotate_from_angax(angle, 'z', anchor=0)\n"
        "        design.add(cube)\n",
        encoding="utf-8",
    )


def _wrong_halbach_single_ring(work):
    _ring_script(work / "design.py", 8, 0.02)  # 0.14 T, but a short ring bulges: 11 %


def _wrong_halbach_overlapping(work):
    _ring_script(work / "design.py", 8, 0.012, (-0.012, 0.0, 0.012))  # 9.4 mm apart


def _wrong_coil_too_many_loops(work):
    (work / "design.py").write_text(
        "import magpylib as magpy\n\ndesign = magpy.Collection(*[\n"
        "    magpy.current.Circle(diameter=0.1, current=2.2, position=(0, 0, 0))\n"
        "    for _ in range(101)\n])\n",
        encoding="utf-8",
    )


def _wrong_board_all_up(work):
    (work / "design.py").write_text(
        "import magpylib as magpy\n\ndesign = magpy.Collection(*[\n"
        "    magpy.magnet.Cuboid(dimension=(0.005,) * 3, polarization=(0, 0, 1.2),\n"
        "                        position=((i - 1.5) * 0.006, (j - 1.5) * 0.006, 0))\n"
        "    for i in range(4) for j in range(4)\n])\n",
        encoding="utf-8",
    )


def _wrong_twelve_stagger_left_behind(work):
    script = work / "halbach.py"
    text = script.read_text(encoding="utf-8").replace("n = 10 ", "n = 12 ", 1)
    text = text.replace("stagger = 360 / (2 * n)", "stagger = 18.0", 1)
    script.write_text(text, encoding="utf-8")


def _wrong_twelve_ring_widened(work):
    """What nobody asked for: twelve magnets, on a wider ring."""
    script = work / "halbach.py"
    text = script.read_text(encoding="utf-8").replace("n = 10 ", "n = 12 ", 1)
    text = text.replace("radius = 0.023 ", "radius = 0.0276 ", 1)
    script.write_text(text, encoding="utf-8")


def _wrong_twelve_made_sixteen(work):
    script = work / "halbach.py"
    text = script.read_text(encoding="utf-8").replace("n = 10 ", "n = 16 ", 1)
    script.write_text(text, encoding="utf-8")


def _wrong_repair_hard_coded(work):
    from magpylib_studio.build import Scene

    s = Scene()
    s.variable("n", 12, bounds=(4, 36), integer=True)
    radius = s.variable("radius", 0.03, bounds=(0.01, 0.1), unit="length")
    ring = s.Collection(id="ring")
    magnet = s.magnet.Cuboid(
        id="magnet",
        dimension=(0.008,) * 3,
        polarization=(1.2, 0, 0),
        position=(radius, 0, 0),
    )
    ring.add(magnet)
    magnet.duplicate_around(count=12, axis="z", spin=30)  # n no longer counts
    s.save(work / "ring.magpy.json")


WRONG = [
    ("halbach_stack", "plain", _wrong_halbach_single_ring, "spread"),
    ("halbach_stack", "plain", _wrong_halbach_overlapping, "overlapping"),
    ("coil_target", "plain", _wrong_coil_too_many_loops, "101 loops"),
    ("checkerboard", "plain", _wrong_board_all_up, "mm"),
    ("halbach_twelve", "plain", _wrong_twelve_stagger_left_behind, "field off"),
    ("halbach_twelve", "plain", _wrong_twelve_ring_widened, "field off"),
    ("halbach_twelve", "plain", _wrong_twelve_made_sixteen, "24 wanted"),
    ("repair_refused", "studio", _wrong_repair_hard_coded, "n = 16"),
]


@pytest.mark.parametrize(("name", "condition", "write", "says"), WRONG)
def test_a_plausible_wrong_answer_fails(name, condition, write, says, tmp_path):
    task = TASKS[name]
    run.prepare(task, condition, tmp_path)
    write(tmp_path)
    verdict = kit.judge(task.check, tmp_path, condition)
    assert not verdict.ok
    assert says in " ".join(verdict.notes), verdict.notes


def test_a_run_is_judged_and_written_down(tmp_path, capsys):
    """What the runner does once the agent is done, short of the agent."""
    task = TASKS["repair_refused"]
    run.prepare(task, "studio", tmp_path / "work")
    task.reference(tmp_path / "work", "studio")
    (tmp_path / "transcript.jsonl").write_text("", encoding="utf-8")
    result = run.judge("repair_refused", task, "studio", tmp_path)
    written = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert result["ok"] is True and written["ok"] is True
    assert "pass" in capsys.readouterr().out


def test_a_design_is_found_from_a_relative_path(tmp_path, monkeypatch):
    """`--recheck evals/results/...` hands the checks relative folders."""
    task = TASKS["checkerboard"]
    run.prepare(task, "plain", tmp_path / "work")
    task.reference(tmp_path / "work", "plain")
    monkeypatch.chdir(tmp_path)
    assert kit.judge(task.check, pathlib.Path("work"), "plain").ok


def test_a_run_the_model_never_answered_is_not_a_failure(tmp_path, capsys):
    """A usage limit is not the task's to fail: such a run is set apart."""
    task = TASKS["field_above_magnet"]
    run.prepare(task, "plain", tmp_path / "work")
    limit = {
        "type": "result",
        "is_error": True,
        "num_turns": 1,
        "api_error": "usage_limit_reached",
        "api_error_status": 429,
    }
    (tmp_path / "transcript.jsonl").write_text(json.dumps(limit), encoding="utf-8")
    result = run.judge("field_above_magnet", task, "plain", tmp_path)
    assert result["ran"] is False and "stopped by the API" in result["notes"][0]
    out = tmp_path / "summary"
    out.mkdir()
    run.summarize(
        [result], out, {"started": "t", "model": "m", "repeats": 1, "commit": "c"}
    )
    assert "Interrupted, and left out above: 1" in (out / "summary.md").read_text()


def test_a_run_the_machine_slept_through_is_not_a_failure(tmp_path):
    """Slept through, a run times out on the wall clock having done nothing."""
    task = TASKS["field_above_magnet"]
    run.prepare(task, "plain", tmp_path / "work")
    (tmp_path / "transcript.jsonl").write_text("", encoding="utf-8")
    (tmp_path / "run.json").write_text(json.dumps({"slept_seconds": 5220}))
    result = run.judge("field_above_magnet", task, "plain", tmp_path)
    assert result["ran"] is False and "slept 87 min" in result["notes"][0]


def test_a_local_model_is_reached_and_nothing_else_is_changed():
    venv = pathlib.Path("/venv")
    assert not any(key.startswith("ANTHROPIC") for key in run.agent_env(venv))
    local = {"base_url": "http://localhost:11434", "model": "qwen3:8b"}
    env = run.agent_env(venv, local=local)
    assert env["ANTHROPIC_BASE_URL"] == "http://localhost:11434"
    assert {
        env[f"ANTHROPIC_DEFAULT_{t}_MODEL"] for t in ("OPUS", "SONNET", "HAIKU")
    } == {"qwen3:8b"}


def test_a_local_server_that_is_not_there_says_what_to_start():
    import socket

    with socket.socket() as probe:  # a port nothing listens on
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with pytest.raises(ConnectionError, match="ollama serve"):
        run.local_models(f"http://127.0.0.1:{port}")


def test_a_local_run_is_summarized_by_time_and_without_cost(tmp_path):
    result = {
        "task": "t",
        "condition": "plain",
        "ok": True,
        "ran": True,
        "turns": 4,
        "seconds": 300.0,
        "cost_usd": 1.23,
        "refusals": 0,
        "skill_read": False,
    }
    meta = {"started": "s", "model": "qwen3:8b", "repeats": 1, "commit": "c"}
    run.summarize([result], tmp_path, {**meta, "local": "http://localhost:11434"})
    text = (tmp_path / "summary.md").read_text()
    assert (
        "no cost: a local model" in text and "| 300 |" in text and "1.230" not in text
    )
