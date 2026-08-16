# sandbox

The folder the Extension Development Host opens when you press F5. Nothing in
here is used by the engine or the extension; it exists so the host always starts
in the _same_ workspace.

That matters more than it sounds. VS Code gives an extension its storage per
workspace, and the studio keeps the script tab's `scene.py` there. A host
started with no folder open falls back to _global_ storage, shared with every
other folder-less window — so the script tab could come up showing the scene
from whatever you were doing last, and two hosts would fight over one file.

Save scenes here while trying things out. They are ordinary `.py` or `.json`
files and nothing collects them.

## The interpreter

This folder has no environment of its own, so `.vscode/settings.json` points the
host at the repo's `.venv`, where magpylib and the engine are both installed.
Without it the Python extension picks whatever `python` is on PATH — on macOS
the command-line-tools one, which has no magpylib in it at all.

Worth knowing because it is the feature's own failure mode, not just a
development one: the window stamps its address onto every terminal it makes,
whatever interpreter runs there, but the package has to be importable in _that_
interpreter for a script to draw. Reaching the window is necessary, not
sufficient.

## Two scripts that are not scenes

- `env_probe.py` — what a script inherits, launched each of the ways VS Code
  can launch one. It is how design decision 8 was settled, and how to re-check
  it when a VS Code release moves a launch path.
- `view_from_script.py` — two figures from one script, drawn in this window.
  Run it twice: the panels update in place.
