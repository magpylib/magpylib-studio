"""The tasks, one module each. A task module has:

- `TITLE`, one line, and `KIND`: "analysis" (a number to find), "design" (a
  design to make to a target), "edit" (a given scene to change) or "studio"
  (something only the studio's interface asks of an agent);
- `CONDITIONS`, the ones it runs in: "plain" (magpylib alone) and "studio"
  (magpylib-studio and its skill too);
- `prompt(condition)`, what the agent is asked, as a person would ask it;
- `inputs(condition)`, the files it starts from, as {name: text};
- `check(work, condition)`, a `kit.Verdict` on what it left in `work`;
- `reference(work, condition)`, a deliverable that passes, for the tests.
"""

import importlib
import pkgutil


def all_tasks():
    """Every task, by module name, in name order."""
    names = sorted(
        name
        for _, name, _ in pkgutil.iter_modules(__path__)
        if not name.startswith("_")
    )
    return {name: importlib.import_module(f"{__name__}.{name}") for name in names}
