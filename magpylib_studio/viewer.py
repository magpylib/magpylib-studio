"""Where a script's `show()` lands when it was run from a studio window.

The engine is a child of the extension: it is handed a scene and asked for a
figure. A script is not. The user starts it, it owns its own objects, and
nothing in VS Code knows it exists — so the connection has to run the other
way, and the only thing pointing back at a particular window is the address
that window stamps on its terminals. `MAGPYLIB_STUDIO_DROP` names a directory
it watches; a script run from there leaves a figure in it and the window draws
it.

One file per `show()` call, named from the script and the call's position in
it. A rerun counts from zero again, so it overwrites the files its last run
wrote and the panels already open update in place — keeping their cameras —
instead of a second set appearing beside them.

Nothing here runs unless something was asked to draw. The stamp is an
address, not an instruction: `pytest` in the same terminal carries it too, and
a default set from an environment variable would have applied to every figure
the interpreter drew. See CONTINUE.md, design decision 8.

Deliberately free of plotly, and of anything else heavy. `backend.py` is
loaded while magpylib imports — an entry point is resolved before the defaults
tree can validate its own default backend — and this comes with it. What only
a plotly figure needs lives in `plotly_view.py`, which a script imports for
itself.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

#: Bumped when the payload's shape changes. A panel that does not know a
#: version says so rather than drawing part of it.
PAYLOAD_VERSION = 1

#: The stamp names the window's storage directory, which holds other things.
#: The views get a subdirectory of their own so only they are watched.
VIEWS_SUBDIR = "views"


def drop_dir() -> Path | None:
    """The directory this window draws from, or None if not run from one."""
    stamp = os.environ.get("MAGPYLIB_STUDIO_DROP")
    return Path(stamp) / VIEWS_SUBDIR if stamp else None


def _script_path() -> str:
    """What identifies the run — the file, where there is one.

    A REPL, `python -c` and a frozen entry point have no `__file__`. Those
    share one identity rather than having none, which keeps a REPL to a single
    panel it redraws instead of a new one per call.
    """
    main = sys.modules.get("__main__")
    path = getattr(main, "__file__", None)
    return str(Path(path).resolve()) if path else f"<{sys.executable}>"


#: How many times each script has drawn, this process. Reruns start again,
#: which is the whole addressing mechanism.
_calls: dict[str, int] = {}


def _digest(script: str) -> str | None:
    """The script's bytes, hashed. None when there is no file to read.

    Bytes rather than text: the reader on the other side hashes the file the
    same way, and decoding it first would make the two disagree over a line
    ending or an encoding rather than over the code.
    """
    try:
        return hashlib.sha256(Path(script).read_bytes()).hexdigest()
    except OSError:
        return None


def _next_call(script: str) -> int:
    index = _calls.get(script, 0)
    _calls[script] = index + 1
    return index


def _in_notebook() -> bool:
    """Whether this is a notebook kernel rather than a script.

    Kernels are started by the editor, not from a terminal, so they never carry
    the window's address -- measured, and the reason the Interactive Window came
    up clean when the stamp was probed (CONTINUE.md, design decision 8).
    """
    try:
        from IPython import get_ipython
    except ImportError:
        return False
    shell = get_ipython()
    # the same test magpylib's own `is_notebook` makes
    return shell is not None and type(shell).__name__ == "ZMQInteractiveShell"


def unaddressed(what: str) -> str:
    """Why `what` cannot draw, in terms of where the caller actually is.

    "Run it from a terminal" is sound advice to a script and none at all to a
    notebook, where there is no terminal to move to and magpylib already draws
    inline.
    """
    if _in_notebook():
        return (
            f"{what} draws in a Magpylib Studio window, and a notebook kernel "
            "has none: it is started by the editor rather than from a "
            "terminal, so it never carries the window's address. Use "
            "backend='plotly', which magpylib draws inline here anyway."
        )
    return (
        f"{what} draws in a Magpylib Studio window, and this script was not run "
        "from one (MAGPYLIB_STUDIO_DROP is unset). Run it from a terminal in a "
        "window where the extension is active, or choose another backend."
    )


def write_view(
    kind: str,
    body: object,
    *,
    title: str | None = None,
    encoder: type[json.JSONEncoder] | None = None,
    claimed: bool = False,
) -> Path | None:
    """Leave one figure where the window will find it.

    Returns the file written, or None when the script was not run from a
    studio window and there is nowhere to put it.

    `encoder` is how a caller says what its own body is made of, so that this
    module need not know: a scene payload is lists and floats already, and a
    plotly figure holds numpy arrays that only plotly's encoder can write.
    """
    views = drop_dir()
    if views is None:
        return None
    script = _script_path()
    index = _next_call(script)
    key = hashlib.sha256(f"{script}#{index}".encode()).hexdigest()[:16]
    views.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": PAYLOAD_VERSION,
        "kind": kind,
        "script": script,
        "index": index,
        "title": title,
        # True only when the window's setting chose the backend, not the
        # script. The panel has a thing to say the first time that happens and
        # nothing to say when a script asked for this itself.
        "claimed": claimed,
        # Whatever re-runs this script has to run it with the interpreter that
        # drew it: the package has to be importable there, and "python" on a
        # PATH is not the same answer. Recorded now so a Re-run offered later
        # needs no guessing, and so a stale panel can say what produced it.
        "python": sys.executable,
        # And where it ran: a script that reads a file beside itself, or writes
        # one, needs the directory it was started from rather than whatever the
        # editor would have picked.
        "cwd": os.getcwd(),
        # What the file held when it ran. Saving a file is not the same as
        # changing it -- an editor writes on every save, and a panel that
        # marks itself out of date each time is one nobody believes.
        "digest": _digest(script),
        "written": time.time(),
        "body": body,
    }
    target = views / f"{key}.json"
    # Written beside the target and moved onto it. The watcher wakes on a file
    # that is already whole; without this it can read one that is still being
    # written, and "unexpected end of JSON" is a confusing way for a panel to
    # say "too early". os.replace is atomic within a directory on both POSIX
    # and Windows.
    staging = views / f"{key}.{os.getpid()}.part"
    staging.write_text(json.dumps(payload, cls=encoder), encoding="utf-8")
    os.replace(staging, target)
    return target
