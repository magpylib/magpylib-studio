"""What survives to a script, launched every way people launch one.

Run this once per launch method and compare. The question is whether an
`environmentVariableCollection` stamp reaches the process -- and, where it
does, whether anything distinguishes "a human is watching" from "pytest".
"""

import os
import sys

INTERESTING = ("VSCODE", "TERM_PROGRAM", "MAGPYLIB", "PYTEST", "PYTHONSTARTUP")


def main():
    print(f"argv0        {sys.argv[0]!r}")
    print(f"__main__     {getattr(sys.modules['__main__'], '__file__', None)!r}")
    print(f"executable   {sys.executable}")
    print(f"stdout.isatty {sys.stdout.isatty()}")
    print(f"stdin.isatty  {sys.stdin.isatty()}")
    print(f"ppid         {os.getppid()}")
    print(f"debugpy      {'debugpy' in sys.modules}  gettrace={sys.gettrace() is not None}")
    print(f"pytest       {'pytest' in sys.modules}  PYTEST_CURRENT_TEST={'PYTEST_CURRENT_TEST' in os.environ}")
    print(f"ipython      {'IPython' in sys.modules}")
    print("--- env ---")
    hits = sorted(k for k in os.environ if any(p in k for p in INTERESTING))
    if not hits:
        print("(nothing)")
    for k in hits:
        v = os.environ[k]
        print(f"{k}={v[:90]}{'…' if len(v) > 90 else ''}")


def test_env():
    """So `pytest env_probe.py -s` reports from inside a test — the case that
    decides whether a stamp may be read as consent to open a window."""
    main()


if __name__ == "__main__":
    main()
