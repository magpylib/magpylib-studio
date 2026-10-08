"""Run magpylib's own docs examples through the recording hook, and replay them.

    python tools/replay-magpylib-docs.py ~/path/to/magpylib [--python PY] [--page NAME]

The guard rail for `docs/recording.md`: magpylib's docs examples are the widest
set of real magpylib scripts there is. Every page with code cells runs twice,
each in a process of its own and with the checkout's Python unless `--python`
says otherwise:

- **plain**, to tell a page that cannot run here (a missing package, a data
  file) from one the recording broke;
- **recorded**, with every cell inside magpylib's `record` hook. The log is
  written as JSON, replayed into fresh objects, and each recorded object is set
  beside its live original: pose, field at three points, sensor pixels, and the
  style that was set.

A page is **exact** when every object comes back the same. What JSON cannot
hold -- a Python function, a `model3d` trace -- is listed apart, so a known gap
does not read as a wrong replay.

The recorder here is a stand-in for studio's (`docs/recording.md` P1): it logs
magpylib's calls as they are, without mapping them onto session operations. It
needs a magpylib with the hook (`magpylib.record`, or `magpylib._src.recording`
on the `spike/record-calls` branch).
"""

import argparse
import collections
import contextlib
import importlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import warnings

CELL = re.compile(r"^```\{code-cell\}[^\n]*\n(.*?)^```\s*$", re.DOTALL | re.MULTILINE)


def cells_of(text):
    """The code cells of a MyST page, as plain Python: option lines dropped,
    `%time stmt` run as `stmt`, other IPython magics skipped."""
    out = []
    for body in CELL.findall(text):
        lines = body.splitlines()
        if lines and lines[0].startswith("---"):  # a yaml option block
            end = lines.index("---", 1) if "---" in lines[1:] else 0
            lines = lines[end + 1 :]
        code = []
        for line in lines:
            if line.startswith(":"):
                continue
            if line.startswith("%time "):
                line = line[len("%time ") :]
            elif line.lstrip().startswith("%"):
                line = "pass  # " + line
            code.append(line)
        out.append("\n".join(code))
    return out


# --- one page, in a child process ----------------------------------------------


class Unencodable(Exception):
    pass


def same(a, b):
    """Equality that survives values whose == raises (a trace holding arrays)."""
    import numpy as np

    try:
        r = a == b
        return bool(np.all(r)) if isinstance(r, np.ndarray) else bool(r)
    except Exception:  # noqa: BLE001 - any failure means compare the text
        return repr(a) == repr(b)


def descendants(obj):
    out = []
    for child in getattr(obj, "children", ()) or ():
        out += [child, *descendants(child)]
    return out


def flat(d, prefix=""):
    out = {}
    for key, value in d.items():
        if isinstance(value, dict) and value:
            out |= flat(value, f"{prefix}{key}.")
        else:
            out[f"{prefix}{key}"] = value
    return out


def style_set(obj):
    """The style that was set on `obj`, by dotted path, without making a style
    that was never made: reading `obj.style` creates it, and `copy()` labels a
    copy differently once it exists."""
    if getattr(obj, "_style", None) is None:
        return flat(getattr(obj, "_style_kwargs", None) or {})
    if hasattr(obj.style, "set_values"):  # the property tree: what was set
        return dict(obj.style.set_values())
    return flat(obj.style.as_dict())


class Recorder:
    """Logs magpylib's calls as JSON-able steps; style as the edits between calls."""

    def __init__(self):
        self.steps, self.ids, self.live, self.seen = [], {}, {}, {}
        self.unencodable = []

    def ref(self, obj, new=False):
        if new:
            self.ids[id(obj)] = len(self.ids)
            self.live[self.ids[id(obj)]] = obj
        if id(obj) not in self.ids:
            raise Unencodable(f"object not recorded: {type(obj).__name__}")
        return self.ids[id(obj)]

    def encode(self, value):
        import numpy as np
        from magpylib._src.obj_classes.class_BaseGeo import BaseGeo
        from scipy.spatial.transform import Rotation

        if isinstance(value, BaseGeo):
            return {"$ref": self.ref(value)}
        if isinstance(value, Rotation):
            return {"$rot": value.as_quat().tolist()}
        if isinstance(value, np.ndarray):
            if value.dtype == object:
                return [self.encode(x) for x in value.tolist()]
            return {"$arr": value.tolist(), "dtype": str(value.dtype)}
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, tuple | list):
            return [self.encode(x) for x in value]
        if isinstance(value, dict):
            return {str(k): self.encode(x) for k, x in value.items()}
        if value is None or isinstance(value, bool | int | float | str):
            return value
        raise Unencodable(f"{type(value).__module__}.{type(value).__name__}")

    def flush_styles(self):
        for oid, obj in self.live.items():
            now, before = style_set(obj), self.seen.get(oid, {})
            for path in sorted(now):
                if path in before and same(before[path], now[path]):
                    continue
                try:
                    value = self.encode(now[path])
                except Unencodable as err:
                    self.unencodable.append(f"style {path}: {err}")
                    continue
                self.steps.append(
                    {"op": "style", "id": oid, "path": path, "value": value}
                )
            self.seen[oid] = now

    def on_event(self, e):
        from magpylib._src.recording import magpylib_class

        self.flush_styles()
        try:
            step = {
                "op": e.kind,
                "args": self.encode(list(e.args)),
                "kwargs": self.encode(e.kwargs),
            }
        except Unencodable as err:
            self.unencodable.append(f"{e.kind} {e.name}: {err}")
            step = None
        if e.kind == "new":
            oid = self.ref(e.obj, new=True)
            self.seen[oid] = style_set(e.obj)
            if step is not None:
                cls = magpylib_class(type(e.obj))
                step |= {"id": oid, "type": f"{cls.__module__}:{cls.__qualname__}"}
        else:
            try:
                oid = self.ref(e.obj)
            except Unencodable as err:
                self.unencodable.append(f"{e.kind} {e.name}: {err}")
                return
            if step is not None:
                step |= {"id": oid, "name": e.name}
            if e.name == "copy":  # a copied collection brings its children
                made = [e.result, *descendants(e.result)]
                rids = [self.ref(o, new=True) for o in made]
                for o, rid in zip(made, rids, strict=True):
                    self.seen[rid] = style_set(o)
                if step is not None:
                    step["result"] = rids
        if step is not None:
            self.steps.append(step)


def replay(steps):
    import numpy as np
    from scipy.spatial.transform import Rotation

    objs = {}

    def decode(v):
        if isinstance(v, dict):
            if "$ref" in v:
                return objs[v["$ref"]]
            if "$rot" in v:
                return Rotation.from_quat(v["$rot"])
            if "$arr" in v:
                return np.array(v["$arr"], dtype=v["dtype"])
            return {k: decode(x) for k, x in v.items()}
        if isinstance(v, list):
            return [decode(x) for x in v]
        return v

    for st in steps:
        if st["op"] == "style":
            node = cur = {}
            *parts, last = st["path"].split(".")
            for part in parts:
                cur = cur.setdefault(part, {})
            cur[last] = decode(st["value"])
            objs[st["id"]].style.update(node)
            continue
        args, kwargs = decode(st["args"]), decode(st["kwargs"])
        if st["op"] == "new":
            module, qualname = st["type"].split(":")
            cls = importlib.import_module(module)
            for part in qualname.split("."):
                cls = getattr(cls, part)
            objs[st["id"]] = cls(*args, **kwargs)
        elif st["op"] == "set":
            setattr(objs[st["id"]], st["name"], args[0])
        else:
            out = getattr(objs[st["id"]], st["name"])(*args, **kwargs)
            for rid, o in zip(
                st.get("result", ()), [out, *descendants(out)], strict=False
            ):
                objs[rid] = o
    return objs


def compare(live, again):
    import magpylib as magpy
    import numpy as np

    def field(obj, observers):
        try:
            return obj.getB(observers)
        except Exception as e:  # noqa: BLE001 - an error is an outcome to compare
            return f"raises {type(e).__name__}"

    bad = []
    for oid, a in live.items():
        b, kind = again.get(oid), type(a).__name__
        if b is None:
            bad.append(f"{oid} {kind}: not rebuilt")
            continue
        try:
            if not np.allclose(a.position, b.position, rtol=1e-12, atol=1e-15):
                bad.append(f"{oid} {kind}: position")
            if not np.allclose(
                a.orientation.as_matrix(), b.orientation.as_matrix(), atol=1e-12
            ):
                bad.append(f"{oid} {kind}: orientation")
            if isinstance(a, magpy.Sensor):
                pa, pb = np.asarray(a.pixel, float), np.asarray(b.pixel, float)
                if not np.allclose(pa, pb, equal_nan=True):
                    bad.append(f"{oid} {kind}: pixel")
            elif not isinstance(a, magpy.Collection) and hasattr(a, "getB"):
                at = np.atleast_2d(a.position)[0]
                obs = at + np.array(
                    [[0.011, 0.023, 0.031], [0.0013, -0.0021, 0.0034], [1.1, -2.3, 0.7]]
                )
                fa, fb = field(a, obs), field(b, obs)
                if isinstance(fa, str) or isinstance(fb, str):
                    if not (isinstance(fa, str) and isinstance(fb, str) and fa == fb):
                        bad.append(f"{oid} {kind}: field")
                elif not np.allclose(fa, fb, rtol=1e-9, atol=1e-18, equal_nan=True):
                    bad.append(f"{oid} {kind}: field")
            sa, sb = style_set(a), style_set(b)
            diff = sorted(
                k for k in set(sa) | set(sb) if not same(sa.get(k), sb.get(k))
            )
            if diff:
                bad.append(f"{oid} {kind}: style {', '.join(diff[:3])}")
        except Exception as e:  # noqa: BLE001
            bad.append(
                f"{oid} {kind}: compare raised {type(e).__name__}: {str(e)[:80]}"
            )
    return bad


def quiet_display():
    import matplotlib.pyplot as plt
    import plotly.graph_objects as go

    plt.show = lambda *_, **__: None
    go.Figure.show = lambda *_, **__: None
    with contextlib.suppress(ImportError):
        import pyvista as pv

        pv.OFF_SCREEN = True
        pv.Plotter.show = lambda *_, **__: None


def run_page(page, mode):
    """Run one page; return what happened, as a dict."""
    os.environ.setdefault("MPLBACKEND", "Agg")
    warnings.filterwarnings("ignore")
    page = pathlib.Path(page).resolve()
    result = {"page": page.name, "mode": mode}
    start = time.perf_counter()
    cells = cells_of(page.read_text(encoding="utf-8"))
    result["cells"] = len(cells)
    quiet_display()

    # a copy of the page's folder, with docs/_static where the page expects it
    docs = pathlib.Path(str(page).split("/docs/")[0]) / "docs"
    rel = page.parent.relative_to(docs)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="magpy-docs-"))
    shutil.copytree(page.parent, tmp / "docs" / rel)
    (tmp / "docs" / "_static").symlink_to(docs / "_static")
    here = os.getcwd()
    os.chdir(tmp / "docs" / rel)

    recorder = Recorder()
    listening = contextlib.nullcontext()
    if mode == "record":
        try:
            from magpylib import record
        except ImportError:
            from magpylib._src.recording import record
        listening = record(recorder.on_event)
    error = None
    namespace = {"__name__": "__main__"}
    with contextlib.redirect_stdout(io.StringIO()), listening:
        for i, code in enumerate(cells):
            try:
                exec(compile(code, f"{page.name}[{i}]", "exec"), namespace)  # noqa: S102 - the docs' own code
            except Exception as e:  # noqa: BLE001 - a page's failure is the result
                where = traceback.extract_tb(e.__traceback__)[-1]
                first = str(e).splitlines()[0][:120] if str(e) else ""
                error = f"cell {i}: {type(e).__name__}: {first} @ {os.path.basename(where.filename)}:{where.lineno}"
                break
        if mode == "record":
            recorder.flush_styles()
    os.chdir(here)
    shutil.rmtree(tmp, ignore_errors=True)

    result["ran"], result["error"] = error is None, error
    if mode == "record":
        result["objects"], result["steps"] = len(recorder.live), len(recorder.steps)
        result["unencodable"] = sorted(set(recorder.unencodable))
        result["mismatches"], result["replay_error"] = [], None
        try:
            again = replay(json.loads(json.dumps(recorder.steps)))
            result["mismatches"] = compare(recorder.live, again)
        except Exception as e:  # noqa: BLE001
            where = traceback.extract_tb(e.__traceback__)[-1]
            result["replay_error"] = (
                f"{type(e).__name__}: {str(e)[:120]} @ line {where.lineno}"
            )
    result["seconds"] = round(time.perf_counter() - start, 1)
    return result


# --- every page, and the summary -----------------------------------------------


def verdict(plain, recorded):
    if not plain.get("ran"):
        return "cannot run here"
    if not recorded.get("ran"):
        return "BROKEN BY RECORDING"
    if recorded.get("replay_error"):
        return "replay error"
    if recorded.get("mismatches"):
        return "replay differs"
    if not recorded.get("objects"):
        return "no objects"
    return "exact"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("magpylib", type=pathlib.Path, help="a magpylib checkout")
    parser.add_argument(
        "--python", help="the interpreter (default: the checkout's .venv)"
    )
    parser.add_argument("--page", action="append", help="only these pages (file names)")
    parser.add_argument(
        "--out", type=pathlib.Path, help="write each result as a JSON line"
    )
    parser.add_argument(
        "--one", nargs=2, metavar=("PAGE", "MODE"), help=argparse.SUPPRESS
    )
    args = parser.parse_args()

    if args.one:  # the child: one page, one mode
        print("RESULT " + json.dumps(run_page(*args.one)))
        return 0

    python = args.python or str(args.magpylib / ".venv" / "bin" / "python")
    pages = sorted(
        p
        for p in (args.magpylib / "docs" / "_pages").rglob("*.md")
        if "{code-cell}" in p.read_text(encoding="utf-8")
        and (not args.page or p.name in args.page)
    )
    results = collections.defaultdict(dict)
    sink = args.out.open("w", encoding="utf-8") if args.out else None
    for page in pages:
        for mode in ("plain", "record"):
            try:
                proc = subprocess.run(  # noqa: S603 - this file, with the given interpreter
                    [python, __file__, str(args.magpylib), "--one", str(page), mode],
                    capture_output=True,
                    text=True,
                    timeout=600,
                    check=False,
                )
                line = next(
                    (x for x in proc.stdout.splitlines() if x.startswith("RESULT ")),
                    None,
                )
                tail = (proc.stderr.strip().splitlines() or ["?"])[-1][:160]
                res = (
                    json.loads(line[7:])
                    if line
                    else {"ran": False, "error": f"no result: {tail}"}
                )
            except subprocess.TimeoutExpired:
                res = {"ran": False, "error": "timeout after 600 s"}
            res |= {"page": page.name, "mode": mode}
            results[page.name][mode] = res
            if sink:
                sink.write(json.dumps(res) + "\n")
                sink.flush()
        plain, recorded = results[page.name]["plain"], results[page.name]["record"]
        print(
            f"{page.name[:44]:44} {recorded.get('objects', '-'):>5} {recorded.get('steps', '-'):>6}"
            f"  {verdict(plain, recorded)}",
            flush=True,
        )

    counts = collections.Counter(
        verdict(m["plain"], m["record"]) for m in results.values()
    )
    print("\n" + ", ".join(f"{n} {v}" for v, n in counts.most_common()))
    for name, m in sorted(results.items()):
        plain, recorded = m["plain"], m["record"]
        v = verdict(plain, recorded)
        if v == "cannot run here":
            print(f"  {name}: {plain.get('error')}")
        elif v in ("BROKEN BY RECORDING", "replay error"):
            print(f"  {name}: {recorded.get('error') or recorded.get('replay_error')}")
        elif v == "replay differs":
            print(f"  {name}: {'; '.join(recorded['mismatches'][:3])}")
        for gap in recorded.get("unencodable", [])[:3]:
            print(f"    {name}: cannot hold {gap[:110]}")
    return 1 if counts["BROKEN BY RECORDING"] else 0


if __name__ == "__main__":
    sys.exit(main())
