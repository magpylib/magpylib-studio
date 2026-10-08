"""Run the magnetics tasks with a coding agent, and count how it does.

    python evals/run.py                      # every task, both conditions, once
    python evals/run.py --tasks sweep_gap --repeats 3
    python evals/run.py --dry-run            # the folders and the commands, no agent
    python evals/run.py --recheck evals/results/<run>   # check again, no agent

Each run is one task in one condition, in a folder of its own, with Claude
Code headless (`claude -p`) as the agent:

- **plain**: Python with magpylib, from PyPI;
- **studio**: Python with magpylib-studio built from this checkout, as a wheel,
  and its skill in the folder's `.claude/skills/`, where `uvx library-skills`
  would put it.

The agent gets the task as a person would ask it, the files it starts from,
and the same tools in both conditions: reading and writing files in its
folder, and running Python. Nothing else of this machine's Claude Code setup
comes along: only project settings are read, so no user skills, plugins or
memory. What it leaves is checked by the task's own check, which builds the
design again rather than trusting what the agent says it did.

Recorded per run: whether the check passed and why, turns, tokens, cost,
time, the refusals the builder raised, and whether the skill was read.
`summary.md` sets the two conditions side by side.
"""

import argparse
import datetime
import glob
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from evals import kit  # noqa: E402 - after the path that finds it
from evals.tasks import all_tasks  # noqa: E402

ENVS = ROOT / "evals" / ".envs"
RESULTS = ROOT / "evals" / "results"
SKILL = "magpylib-studio"

#: The tools the agent has at all, the same in both conditions: no web, no
#: subagents, no MCP servers -- the account's claude.ai connectors included.
TOOLS = "Bash,Read,Write,Edit,Glob,Grep,Skill,TodoWrite"

#: Shell commands run in Claude Code's sandbox, without asking: they write
#: only in the run's folder and its temp directory and reach no network, and
#: cannot ask to leave it. A machine where the sandbox cannot start fails the
#: run rather than running it unsandboxed.
SANDBOX = json.dumps(
    {
        "sandbox": {
            "enabled": True,
            "autoAllowBashIfSandboxed": True,
            "allowUnsandboxedCommands": False,
            "failIfUnavailable": True,
        }
    }
)

#: And the file tools it may use without asking: reading and writing in the
#: folder. (Bash needs no rule: the sandbox lets it run.)
ALLOWED = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Skill",
    "TodoWrite",
    "Bash(python *)",
    "Bash(python3 *)",
    "Bash(ls *)",
]

#: What the builder says when it refuses: a scene's own refusal, or a
#: variable asked for a value it does not have yet.
REFUSALS = (
    "BuildError",
    "has no value to decide with",
    "cannot count a loop",
    "is not a number here",
    "numpy cannot",
    "is one value, not a sequence",
    "is not text",
)


# --- the two environments ---------------------------------------------------


def _uv(*args):
    subprocess.run(["uv", *args], check=True)  # noqa: S603, S607 - uv, as CONTRIBUTING has it


def environments(rebuild=False):
    """A venv per condition, under `evals/.envs/`. The studio one is rebuilt
    from this checkout every time, so it is what the checkout says now."""
    ENVS.mkdir(parents=True, exist_ok=True)
    plain = ENVS / "plain"
    if rebuild or not (plain / "bin" / "python").exists():
        _uv("venv", "--clear", "--python", "3.13", str(plain))
        _uv("pip", "install", "--python", str(plain / "bin" / "python"), "magpylib")
    studio = ENVS / "studio"
    wheels = ENVS / "wheel"
    shutil.rmtree(wheels, ignore_errors=True)
    _uv("build", "--wheel", "--out-dir", str(wheels), str(ROOT))
    (wheel,) = wheels.glob("*.whl")
    _uv("venv", "--clear", "--python", "3.13", str(studio))
    _uv(
        "pip",
        "install",
        "--no-sources",
        "--python",
        str(studio / "bin" / "python"),
        str(wheel),
    )
    return {"plain": plain, "studio": studio}


def skill_in(venv):
    """The skill as the installed package carries it."""
    (found,) = glob.glob(
        str(venv / "lib" / "python*" / "site-packages" / "magpylib_studio")
    )
    return pathlib.Path(found) / ".agents" / "skills" / SKILL


# --- one run ----------------------------------------------------------------


def full_prompt(task, condition):
    return f"{task.prompt(condition)}\n\n{kit.FOOTER[condition]}\n"


def prepare(task, condition, work, skill=None):
    """The folder the agent starts in: the task's files, and the skill where
    Claude Code finds a project's skills."""
    work.mkdir(parents=True, exist_ok=True)
    for name, text in task.inputs(condition).items():
        (work / name).write_text(text, encoding="utf-8")
    if condition == "studio" and skill is not None:
        shutil.copytree(skill, work / ".claude" / "skills" / SKILL)


def agent_env(venv, work=None, local=None):
    """A clean environment: this machine's identity and the condition's
    Python, and nothing of the session that started the run -- and, given
    `local` ({"base_url", "model"}), the way to a local model."""
    keep = ("HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM")
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env["PATH"] = f"{venv / 'bin'}:/usr/bin:/bin:/usr/sbin:/sbin"
    env["VIRTUAL_ENV"] = str(venv)
    env["MPLBACKEND"] = "Agg"  # a figure is drawn to nothing
    env["BROWSER"] = "true"  # and a page opens nowhere
    env["PYTHONDONTWRITEBYTECODE"] = "1"  # site-packages is outside the sandbox
    if work is not None:
        # matplotlib's cache is in the home folder, outside the sandbox: told
        # nothing, it warns on every import, into the agent's output
        env["MPLCONFIGDIR"] = str(work / ".matplotlib")
    if local is not None:
        # Claude Code against a local server that speaks Anthropic's API --
        # Ollama, LM Studio, llama.cpp. Every model it would ask for, the main
        # one and the small one it uses for chores, is the local one; nothing
        # else leaves the machine.
        env["ANTHROPIC_BASE_URL"] = local["base_url"]
        env["ANTHROPIC_AUTH_TOKEN"] = "local"  # noqa: S105 - a local server takes any
        for tier in ("OPUS", "SONNET", "HAIKU"):
            env[f"ANTHROPIC_DEFAULT_{tier}_MODEL"] = local["model"]
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    return env


def local_models(base_url):
    """The models a local server holds, as Ollama or an OpenAI-style
    server lists them, or a ConnectionError saying what to start."""
    readers = (
        ("/api/tags", lambda data: [m["name"] for m in data["models"]]),
        ("/v1/models", lambda data: [m["id"] for m in data["data"]]),
    )
    for path, read in readers:
        url = base_url.rstrip("/") + path
        try:
            with urllib.request.urlopen(url, timeout=5) as answer:  # noqa: S310 - the server named on the command line
                return read(json.loads(answer.read()))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    raise ConnectionError(
        f"no model server answers at {base_url}: start one (`ollama serve`), "
        "or pass --base-url"
    )


def command(claude, model, budget):
    return [
        claude,
        "-p",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--tools",
        TOOLS,
        "--strict-mcp-config",
        "--setting-sources",
        "project",
        "--settings",
        SANDBOX,
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        *ALLOWED,
        "--max-budget-usd",
        str(budget),
    ]


def read_transcript(lines):
    """What a stream-json transcript says about the run."""
    out = {"tools": {}, "refusals": 0, "skill_read": False, "skills_offered": None}
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            # what the agent was given, to show nothing else came along
            out["skills_offered"] = event.get("skills")
            out["tools_offered"] = event.get("tools")
            out["mcp_servers"] = [s.get("name") for s in event.get("mcp_servers", [])]
            out["model"] = event.get("model")
            out["cwd"] = event.get("cwd")
        elif kind == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") != "tool_use":
                    continue
                name = block.get("name", "?")
                out["tools"][name] = out["tools"].get(name, 0) + 1
                said = json.dumps(block.get("input", {}))
                if (name == "Skill" and SKILL in said) or (
                    name == "Read" and f"skills/{SKILL}" in said
                ):
                    out["skill_read"] = True
        elif kind == "user":
            for block in event.get("message", {}).get("content", []):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    text = json.dumps(block.get("content", ""))
                    if any(marker in text for marker in REFUSALS):
                        out["refusals"] += 1
        elif kind == "result":
            usage = event.get("usage", {})
            out.update(
                finished=event.get("subtype"),
                turns=event.get("num_turns"),
                cost_usd=event.get("total_cost_usd"),
                seconds=(event.get("duration_ms") or 0) / 1000,
                input_tokens=usage.get("input_tokens", 0),
                output_tokens=usage.get("output_tokens", 0),
                cache_read_tokens=usage.get("cache_read_input_tokens", 0),
                cache_write_tokens=usage.get("cache_creation_input_tokens", 0),
                answer=event.get("result"),
            )
            # the model never answered: a limit, an outage -- not the task
            if event.get("api_error") or event.get("api_error_status"):
                out["api_error"] = event.get("api_error") or event.get(
                    "api_error_status"
                )
    return out


def run_one(name, task, condition, folder, args, envs):
    # A dry run has no environments: it shows the folder with the checkout's skill.
    skill = (
        skill_in(envs["studio"])
        if envs
        else ROOT / "magpylib_studio" / ".agents" / "skills" / SKILL
    )
    prompt = full_prompt(task, condition)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "prompt.md").write_text(prompt, encoding="utf-8")
    argv = command(args.claude, args.model, args.budget)
    if args.dry_run:
        prepare(task, condition, folder / "work", skill)
        print(f"{name} [{condition}]: {' '.join(argv[:2])} … in {folder / 'work'}")
        return None
    # The agent works outside this checkout: inside it, Claude Code would take
    # the repository for its project -- its memory, its settings -- and the
    # reference solutions would be a folder away. The folder is kept after.
    work = pathlib.Path(tempfile.mkdtemp(prefix=f"magpy-eval-{name}-{condition}-"))
    prepare(task, condition, work, skill)
    with (
        open(folder / "transcript.jsonl", "w", encoding="utf-8") as transcript,
        open(folder / "stderr.txt", "w", encoding="utf-8") as stderr,
    ):
        agent = subprocess.Popen(  # noqa: S603 - the agent, in its own folder
            argv,
            stdin=subprocess.PIPE,
            cwd=work,
            env=agent_env(envs[condition], work, args.local_server),
            stdout=transcript,
            stderr=stderr,
            text=True,
        )
        agent.stdin.write(prompt)
        agent.stdin.close()
        # By the wall clock: subprocess's own timeout counts monotonic time,
        # which on macOS stops while the machine sleeps, so a run on a laptop
        # left overnight would never be stopped.
        deadline = time.time() + args.timeout
        started_wall, started_awake = time.time(), time.monotonic()
        while agent.poll() is None:
            if time.time() > deadline:
                agent.kill()
                agent.wait()
                stderr.write(f"\nstopped after {args.timeout} s\n")
                break
            time.sleep(1)
    # The difference between the two clocks is how long the machine slept.
    slept = (time.time() - started_wall) - (time.monotonic() - started_awake)
    (folder / "run.json").write_text(
        json.dumps({"slept_seconds": slept}), encoding="utf-8"
    )
    shutil.copytree(
        work,
        folder / "work",
        symlinks=True,
        ignore=shutil.ignore_patterns(".matplotlib"),
    )
    shutil.rmtree(work, ignore_errors=True)
    _forget(work)
    return judge(name, task, condition, folder)


def _forget(work):
    """Remove the project folder Claude Code made for a run's temp folder in
    ~/.claude/projects: an empty memory folder, one per run otherwise."""
    name = re.sub(r"[^A-Za-z0-9]", "-", str(work.resolve()))
    made = pathlib.Path.home() / ".claude" / "projects" / name
    if "magpy-eval-" in name and made.is_dir():
        shutil.rmtree(made, ignore_errors=True)


def _plain(value):
    """What JSON cannot write as it is: a numpy number, a path."""
    return value.item() if hasattr(value, "item") else str(value)


def judge(name, task, condition, folder):
    lines = (folder / "transcript.jsonl").read_text(encoding="utf-8").splitlines()
    read = read_transcript(lines)
    timing = folder / "run.json"
    slept = json.loads(timing.read_text())["slept_seconds"] if timing.is_file() else 0
    # Not a failure of the task: the agent never got to it, or was cut off --
    # by a usage limit, an outage, or the machine sleeping under it.
    if read.get("api_error"):
        read["interrupted"] = f"stopped by the API: {read['api_error']}"
    elif slept > 60:
        read["interrupted"] = f"the machine slept {slept / 60:.0f} min during the run"
    if read.get("interrupted"):
        verdict = kit.Verdict(False, [read["interrupted"]])
    else:
        verdict = kit.judge(task.check, folder / "work", condition)
    result = {
        "task": name,
        "kind": task.KIND,
        "condition": condition,
        "ok": verdict.ok,
        "ran": not read.get("interrupted"),
        "notes": verdict.notes,
        **verdict.extras,
        **read,
    }
    (folder / "result.json").write_text(
        json.dumps(result, indent=2, default=_plain), encoding="utf-8"
    )
    mark = "pass" if verdict.ok else ("FAIL" if result["ran"] else "----")
    print(f"{mark}  {name} [{condition}]  {'; '.join(verdict.notes)[:150]}")
    return result


# --- the summary --------------------------------------------------------------


def _median(results, key):
    values = [r[key] for r in results if isinstance(r.get(key), int | float)]
    return statistics.median(values) if values else None


def summarize(results, out, meta):
    """`summary.json` and `summary.md`: per task, the conditions side by side."""
    (out / "summary.json").write_text(
        json.dumps({"meta": meta, "results": results}, indent=2), encoding="utf-8"
    )
    lines = [
        f"# Agent evaluation, {meta['started']}",
        "",
        f"Model `{meta['model']}`, {meta['repeats']} run(s) per task and condition, "
        f"checkout `{meta['commit']}`. Tokens are input + output, cache reads "
        "included; time is the median run's, in seconds; "
        + (
            f"no cost: a local model, at {meta['local']}."
            if meta.get("local")
            else "cost is what Claude Code reported."
        ),
        "",
        "| task | condition | passed | turns | tokens | time s | cost $ | refusals "
        "| skill read |",
        "| ---- | --------- | ------ | ----- | ------ | ------ | ------ | -------- "
        "| ---------- |",
    ]
    for r in results:
        r["tokens"] = sum(
            r.get(k) or 0
            for k in (
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
            )
        )
    skipped = [r for r in results if not r.get("ran", True)]
    results = [r for r in results if r.get("ran", True)]
    groups = {}
    for r in results:
        groups.setdefault((r["task"], r["condition"]), []).append(r)
    for (task, condition), runs in sorted(groups.items()):
        passed = sum(r["ok"] for r in runs)
        cost = None if meta.get("local") else _median(runs, "cost_usd")
        seconds = _median(runs, "seconds")
        lines.append(
            f"| {task} | {condition} | {passed}/{len(runs)} | {_median(runs, 'turns')} | "
            f"{_median(runs, 'tokens')} | {'' if seconds is None else f'{seconds:.0f}'} | "
            f"{'' if cost is None else f'{cost:.3f}'} | "
            f"{sum(r['refusals'] for r in runs)} | "
            f"{sum(r['skill_read'] for r in runs)}/{len(runs)} |"
        )
    totals = {}
    for r in results:
        total = totals.setdefault(r["condition"], {"runs": 0, "passed": 0, "cost": 0.0})
        total["runs"] += 1
        total["passed"] += r["ok"]
        total["cost"] += r.get("cost_usd") or 0
    lines += ["", "| condition | passed | cost $ |", "| --------- | ------ | ------ |"]
    for condition, total in sorted(totals.items()):
        lines.append(
            f"| {condition} | {total['passed']}/{total['runs']} | {total['cost']:.2f} |"
        )
    if skipped:
        lines += [
            "",
            f"Interrupted, and left out above: {len(skipped)} -- "
            + ", ".join(
                f"{r['task']} [{r['condition']}]: {r['interrupted']}" for r in skipped
            ),
        ]
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


# --- the command line ---------------------------------------------------------


def find_claude():
    """`claude` on the PATH, else the one VS Code's Claude Code extension carries."""
    found = os.environ.get("CLAUDE_BIN") or shutil.which("claude")
    if found:
        return found
    bundled = sorted(
        glob.glob(
            os.path.expanduser(
                "~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude"
            )
        )
    )
    return bundled[-1] if bundled else None


def main(argv=None):
    tasks = all_tasks()
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tasks", help="comma-separated task names (default: all)")
    parser.add_argument("--conditions", default="plain,studio")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--model", default="sonnet")
    parser.add_argument(
        "--budget", type=float, default=2.0, help="USD per run, at most"
    )
    parser.add_argument(
        "--timeout", type=int, help="seconds per run (1200; 3600 with --local)"
    )
    parser.add_argument(
        "--local",
        metavar="MODEL",
        help="a model on a local server that speaks Anthropic's API (Ollama: "
        "`ollama pull MODEL`, then `ollama serve`), instead of Anthropic's",
    )
    parser.add_argument("--base-url", default="http://localhost:11434")
    parser.add_argument("--claude", default=find_claude())
    parser.add_argument("--rebuild-envs", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--recheck", type=pathlib.Path, help="a results folder")
    args = parser.parse_args(argv)
    # A local model reads Claude Code's long system prompt at laptop speed.
    args.timeout = args.timeout or (3600 if args.local else 1200)
    args.local_server = None
    if args.local:
        args.model = args.local
        args.local_server = {"base_url": args.base_url, "model": args.local}

    if args.recheck:
        results = []
        for folder in sorted(args.recheck.glob("runs/*/*")):
            name, condition = folder.parent.name, folder.name.split("-")[0]
            results.append(judge(name, tasks[name], condition, folder))
        summary = args.recheck / "summary.json"
        meta = (
            json.loads(summary.read_text(encoding="utf-8"))["meta"]
            if summary.is_file()
            else {
                "started": args.recheck.name,
                "model": "?",
                "repeats": "?",
                "commit": "?",
            }
        )
        summarize(results, args.recheck, meta)
        return 0

    chosen = args.tasks.split(",") if args.tasks else list(tasks)
    unknown = sorted(set(chosen) - set(tasks))
    if unknown:
        parser.error(f"no such task: {', '.join(unknown)}")
    if not args.dry_run and not args.claude:
        parser.error("no claude found: pass --claude or set CLAUDE_BIN")
    if args.local and not args.dry_run:
        try:
            held = local_models(args.base_url)
        except ConnectionError as e:
            parser.error(str(e))
        if args.local not in held and f"{args.local}:latest" not in held:
            parser.error(
                f"{args.base_url} has no {args.local!r} (it has: "
                f"{', '.join(held) or 'nothing'}): `ollama pull {args.local}`"
            )
    conditions = args.conditions.split(",")
    started = datetime.datetime.now().strftime("%Y-%m-%d-%H%M")
    label = re.sub(r"[^A-Za-z0-9.]+", "-", args.model)  # qwen3:8b -> qwen3-8b
    out = RESULTS / f"{started}-{label}{'-dry' if args.dry_run else ''}"
    envs = None if args.dry_run else environments(args.rebuild_envs)
    commit = subprocess.run(  # noqa: S603 - git, on this checkout
        ["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],  # noqa: S607
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    meta = {
        "started": started,
        "model": args.model,
        "repeats": args.repeats,
        "commit": commit,
        "budget_usd": args.budget,
        **({"local": args.base_url} if args.local else {}),
    }
    results = []
    for name in chosen:
        task = tasks[name]
        for condition in conditions:
            if condition not in task.CONDITIONS:
                continue
            for k in range(1, args.repeats + 1):
                folder = out / "runs" / name / f"{condition}-{k}"
                result = run_one(name, task, condition, folder, args, envs)
                if result is not None:
                    results.append(result)
                if (
                    result is not None
                    and result.get("api_error") == "usage_limit_reached"
                ):
                    # every run after this one would hit the same limit
                    print(
                        "usage limit reached: stopping; rerun what is left with --tasks"
                    )
                    summarize(results, out, meta)
                    return 1
    if results:
        summarize(results, out, meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
