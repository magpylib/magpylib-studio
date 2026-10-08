"""Monitor an agent evaluation: `marimo run evals/monitor.py` (or `marimo edit`).

Reads a results folder as `evals/run.py` writes it, so it follows a live run and opens
a finished one alike: the overview, every run, and each run's full transcript.
"""

import marimo

app = marimo.App(width="full", app_title="Agent evaluation monitor")


@app.cell
def _():
    import html
    import json
    import pathlib
    import statistics
    import time
    import urllib.request

    import marimo as mo

    RESULTS = pathlib.Path(__file__).parent / "results"

    STATUS = {  # colour, label
        "pass": ("#1a7f37", "pass"),
        "FAIL": ("#cf222e", "fail"),
        "interrupted": ("#9a6700", "interrupted"),
        "running": ("#0969da", "running"),
        "waiting": ("#6e7781", "waiting"),
    }

    CSS = """
    <style>
    .ev {font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         font-size: 14px; line-height: 1.5;}
    .ev h1 {font-size: 22px; margin: 0 0 2px 0; font-weight: 650;}
    .ev .sub {opacity: .65; font-size: 13px;}
    .ev .cards {display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0;}
    .ev .card {border: 1px solid rgba(128,128,128,.3); border-radius: 8px;
               padding: 10px 16px; min-width: 120px;}
    .ev .card .v {font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums;}
    .ev .card .l {font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
                  opacity: .6;}
    .ev .badge {display: inline-block; padding: 1px 9px; border-radius: 10px;
                font-size: 12px; font-weight: 600; color: #fff;}
    .ev table {border-collapse: collapse; width: 100%;}
    .ev th {text-align: left; font-size: 11px; text-transform: uppercase;
            letter-spacing: .06em; opacity: .6; padding: 6px 10px;
            border-bottom: 1px solid rgba(128,128,128,.35);}
    .ev td {padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,.15);
            font-variant-numeric: tabular-nums;}
    .ev .step {border: 1px solid rgba(128,128,128,.3); border-left-width: 4px;
               border-radius: 6px; padding: 8px 12px; margin: 8px 0;}
    .ev .step .who {font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
                    font-weight: 700; opacity: .75; margin-bottom: 2px;}
    .ev pre {margin: 6px 0 0 0; padding: 8px 10px; border-radius: 6px; overflow-x: auto;
             background: rgba(128,128,128,.12); font-size: 12.5px; white-space: pre-wrap;
             word-break: break-word;}
    .ev details > summary {cursor: pointer; font-size: 13px;}
    .ev .bar {display: flex; height: 10px; border-radius: 5px; overflow: hidden;
              background: rgba(128,128,128,.2);}
    </style>
    """

    def esc(value):
        return html.escape(str(value))

    def badge(status):
        colour, label = STATUS.get(status, ("#6e7781", status))
        return f'<span class="badge" style="background:{colour}">{esc(label)}</span>'

    def card(label, value):
        return (
            f'<div class="card"><div class="v">{esc(value)}</div>'
            f'<div class="l">{esc(label)}</div></div>'
        )

    def clock(seconds):
        if not seconds:
            return "-"
        h, rest = divmod(int(seconds), 3600)
        m, s = divmod(rest, 60)
        return f"{h}h {m:02d}m" if h else (f"{m}m {s:02d}s" if m else f"{s}s")

    def number(value):
        return "-" if value is None else f"{value:,}"

    return (
        CSS,
        RESULTS,
        badge,
        card,
        clock,
        esc,
        json,
        mo,
        number,
        pathlib,
        statistics,
        time,
        urllib,
    )


@app.cell
def _(RESULTS, mo):
    refresh = mo.ui.refresh(options=["5s", "10s", "30s"], default_interval="10s")
    _folders = sorted((p.name for p in RESULTS.glob("20*") if p.is_dir()), reverse=True)
    folder = mo.ui.dropdown(
        _folders, value=_folders[0] if _folders else None, label="Results"
    )
    condition = mo.ui.dropdown(
        ["all", "plain", "studio"], value="all", label="Condition"
    )
    status = mo.ui.dropdown(
        ["all", "pass", "FAIL", "interrupted", "running", "waiting"],
        value="all",
        label="Status",
    )
    mo.hstack(
        [folder, condition, status, refresh], justify="start", align="end", gap=1.5
    )
    return condition, folder, refresh, status


@app.cell
def _(RESULTS, folder, json, refresh, time):
    _tick = refresh.value  # a new tick re-reads the folder
    root = RESULTS / folder.value
    now = time.time()

    meta = {}
    _summary = root / "summary.json"
    if _summary.is_file():
        meta = json.loads(_summary.read_text(encoding="utf-8")).get("meta", {})

    rows = []
    for _run in sorted(root.glob("runs/*/*")):
        _done = _run / "result.json"
        _result = (
            json.loads(_done.read_text(encoding="utf-8")) if _done.is_file() else {}
        )
        _log = _run / "transcript.jsonl"
        _begun = _run / "prompt.md"
        if _result:
            _state = (
                "pass"
                if _result.get("ok")
                else ("FAIL" if _result.get("ran", True) else "interrupted")
            )
        else:
            _state = "running" if _log.is_file() else "waiting"
        _seconds = _result.get("seconds")
        if _state == "running" and _begun.is_file():
            _seconds = now - _begun.stat().st_mtime
        rows.append(
            {
                "task": _run.parent.name,
                "condition": _run.name.split("-")[0],
                "run": _run.name,
                "status": _state,
                "turns": _result.get("turns"),
                "tokens": sum(
                    _result.get(k) or 0
                    for k in (
                        "input_tokens",
                        "output_tokens",
                        "cache_read_tokens",
                        "cache_write_tokens",
                    )
                )
                or None,
                "seconds": _seconds,
                "skill_read": _result.get("skill_read"),
                "refusals": _result.get("refusals"),
                "notes": "; ".join(_result.get("notes", [])),
                "path": str(_run),
            }
        )
    return meta, root, rows


@app.cell
def _(json, mo, refresh, urllib):
    _tick = refresh.value
    try:
        with urllib.request.urlopen(
            "http://localhost:11434/api/ps", timeout=1.5
        ) as _reply:
            _models = json.loads(_reply.read()).get("models", [])
        if _models:
            _lines = [
                f"**{m['name']}**: {m.get('size', 0) / 1e9:.1f} GB, "
                f"{m.get('size_vram', 0) * 100 // max(m.get('size', 1), 1)}% on GPU, "
                f"context {m.get('context_length', '?')}"
                for m in _models
            ]
            server = mo.md("Ollama · " + " · ".join(_lines))
        else:
            server = mo.md("Ollama · up, no model loaded")
    except OSError:
        server = mo.md("Ollama · not reachable")
    return (server,)


@app.cell
def _(CSS, badge, card, clock, esc, meta, mo, number, root, rows, server, statistics):
    _states = ("pass", "FAIL", "interrupted", "running", "waiting")
    _counts = {s: sum(r["status"] == s for r in rows) for s in _states}
    _finished = _counts["pass"] + _counts["FAIL"]
    _rate = f"{100 * _counts['pass'] / _finished:.0f}%" if _finished else "-"
    _done = [r for r in rows if r["status"] in ("pass", "FAIL")]
    _times = [r["seconds"] for r in _done if r["seconds"]]
    _tokens = sum(r["tokens"] or 0 for r in _done)

    _bar = "".join(
        f'<div style="width:{100 * _counts[s] / max(len(rows), 1)}%;background:{c}"></div>'
        for s, c in zip(
            _states,
            ("#1a7f37", "#cf222e", "#9a6700", "#0969da", "#8c959f"),
            strict=True,
        )
    )

    def _side(task, cond):
        mine = [r for r in rows if r["task"] == task and r["condition"] == cond]
        if not mine:
            return "<td>-</td><td></td><td></td>"
        state = (
            mine[0]["status"]
            if len(mine) == 1
            else ("pass" if all(r["status"] == "pass" for r in mine) else "FAIL")
        )
        times = [r["seconds"] for r in mine if r["seconds"]]
        return (
            f"<td>{badge(state)}</td>"
            f"<td>{clock(statistics.median(times) if times else None)}</td>"
            f"<td>{number(sum(r['tokens'] or 0 for r in mine) or None)}</td>"
        )

    _body = "".join(
        f"<tr><td><b>{esc(t)}</b></td>{_side(t, 'plain')}{_side(t, 'studio')}</tr>"
        for t in sorted({r["task"] for r in rows})
    )
    _head = (
        "<tr><th>task</th><th>plain</th><th>time</th><th>tokens</th>"
        "<th>studio</th><th>time</th><th>tokens</th></tr>"
    )
    _sub = " · ".join(
        x
        for x in (
            f"started {meta.get('started', root.name[:15])}",
            f"checkout {meta['commit']}" if meta.get("commit") else "",
            f"{meta['repeats']} run(s) per task and condition"
            if meta.get("repeats")
            else "",
            f"{len(rows)} runs on disk",
            "finished" if meta else "in progress",
        )
        if x
    )
    mo.vstack(
        [
            mo.Html(
                f'{CSS}<div class="ev"><h1>{esc(meta.get("model") or root.name[16:])}</h1>'
                f'<div class="sub">{esc(_sub)}</div><div class="cards">'
                f"{card('passed', _counts['pass'])}{card('failed', _counts['FAIL'])}"
                f"{card('interrupted', _counts['interrupted'])}"
                f"{card('running', _counts['running'])}"
                f"{card('waiting', _counts['waiting'])}{card('pass rate', _rate)}"
                f"{card('median run', clock(statistics.median(_times)) if _times else '-')}"
                f"{card('tokens, finished', number(_tokens or None))}</div>"
                f'<div class="bar">{_bar}</div>'
                f'<h3 style="margin:22px 0 6px">Tasks, conditions side by side</h3>'
                f"<table>{_head}{_body}</table></div>"
            ),
            server,
        ]
    )
    return


@app.cell
def _(condition, mo, rows, status):
    _shown = [
        r
        for r in rows
        if condition.value in ("all", r["condition"])
        and status.value in ("all", r["status"])
    ]
    table = mo.ui.table(
        [
            {
                "task": r["task"],
                "run": r["run"],
                "status": r["status"],
                "turns": r["turns"],
                "tokens": r["tokens"],
                "seconds": round(r["seconds"]) if r["seconds"] else None,
                "skill read": r["skill_read"],
                "refusals": r["refusals"],
                "notes": r["notes"][:140],
            }
            for r in _shown
        ],
        selection="single",
        page_size=15,
        label=f"Runs ({len(_shown)}): pick one for its full record",
    )
    table  # noqa: B018 - marimo shows a cell's last expression
    return (table,)


@app.cell
def _(CSS, badge, card, clock, esc, json, mo, number, pathlib, rows, table):
    if not table.value:
        mo.stop(True, mo.md("_Pick a run above to see its transcript._"))
    _pick = table.value[0]
    _row = next(
        r for r in rows if (r["task"], r["run"]) == (_pick["task"], _pick["run"])
    )
    _dir = pathlib.Path(_row["path"])

    def _read(name, limit=20000):
        f = _dir / name
        text = f.read_text(encoding="utf-8", errors="replace") if f.is_file() else ""
        return text[-limit:]

    _who = {
        "assistant": ("#0969da", "model"),
        "user": ("#8250df", "tool output / user"),
        "system": ("#6e7781", "system"),
    }
    _steps, _tools = [], {}
    for _line in _read("transcript.jsonl", 10**8).splitlines():
        try:
            _msg = json.loads(_line).get("message", {})
        except ValueError:
            continue
        _colour, _name = _who.get(_msg.get("role", "system"), _who["system"])
        _content = _msg.get("content")
        if isinstance(_content, str):
            _content = [{"type": "text", "text": _content}]
        for _b in _content or []:
            _kind = _b.get("type")
            if _kind == "text":
                _text = esc(_b["text"][:8000])
                _html = f"<div style='white-space:pre-wrap'>{_text}</div>"
            elif _kind == "thinking":
                _think = _b.get("thinking", "")
                _html = (
                    f"<details><summary>{len(_think)} characters</summary>"
                    f"<pre>{esc(_think[:8000])}</pre></details>"
                )
            elif _kind == "tool_use":
                _tools[_b.get("name")] = _tools.get(_b.get("name"), 0) + 1
                _args = esc(json.dumps(_b.get("input"), indent=1)[:6000])
                _html = f"<b>{esc(_b.get('name'))}</b><pre>{_args}</pre>"
            elif _kind == "tool_result":
                _raw = _b.get("content")
                if isinstance(_raw, list):
                    _raw = "\n".join(
                        x.get("text", "") for x in _raw if isinstance(x, dict)
                    )
                _html = (
                    f"<details><summary>{len(str(_raw))} characters</summary>"
                    f"<pre>{esc(str(_raw)[:6000])}</pre></details>"
                )
            else:
                continue
            _label = {
                "tool_use": "tool call",
                "tool_result": "tool result",
                "thinking": "reasoning",
            }.get(_kind, _name)
            _edge = "#bf8700" if _kind == "tool_use" else _colour
            _steps.append(
                f'<div class="step" style="border-left-color:{_edge}">'
                f'<div class="who">{len(_steps) + 1} · {esc(_label)}</div>{_html}</div>'
            )

    _used = ", ".join(
        f"{k} ×{v}" for k, v in sorted(_tools.items(), key=lambda kv: -kv[1])
    )
    _cards = "".join(
        [
            card("turns", "-" if _row["turns"] is None else _row["turns"]),
            card("tokens", number(_row["tokens"])),
            card("time", clock(_row["seconds"])),
            card("tool calls", sum(_tools.values())),
            card("skill read", {True: "yes", False: "no"}.get(_row["skill_read"], "-")),
            card("refusals", "-" if _row["refusals"] is None else _row["refusals"]),
        ]
    )
    _head = (
        f'{CSS}<div class="ev"><h2 style="margin:18px 0 2px">{esc(_row["task"])} '
        f'<span class="sub">/ {esc(_row["run"])}</span> {badge(_row["status"])}</h2>'
        f'<div class="sub">{esc(_row["notes"]) or "no verdict notes yet"}</div>'
        f'<div class="cards">{_cards}</div>'
        f'<div class="sub">Tools used: {esc(_used) or "none yet"}</div></div>'
    )

    def _code(text):
        shown = esc(text or "(nothing yet)")
        return mo.Html(f'{CSS}<div class="ev"><pre>{shown}</pre></div>')

    _work = _dir / "work"
    _files = (
        sorted(
            str(p.relative_to(_work))
            for p in _work.rglob("*")
            if p.is_file() and not any(part.startswith(".") for part in p.parts)
        )
        if _work.is_dir()
        else []
    )
    mo.vstack(
        [
            mo.Html(_head),
            mo.ui.tabs(
                {
                    f"Transcript ({len(_steps)})": mo.Html(
                        f'{CSS}<div class="ev">{"".join(_steps) or "<i>nothing yet</i>"}</div>'
                    ),
                    "Prompt": _code(_read("prompt.md")),
                    "Verdict": _code(_read("result.json")),
                    "Answer": _code(_read("work/answer.json")),
                    "Files": _code("\n".join(_files)),
                    "stderr": _code(_read("stderr.txt")),
                }
            ),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
