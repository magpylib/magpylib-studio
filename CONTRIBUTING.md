# Contributing

## Setting up

```sh
git clone https://github.com/magpylib/magpylib-studio.git
cd magpylib-studio

# the engine
uv venv --python 3.13 .venv
VIRTUAL_ENV=$PWD/.venv uv pip install -e ".[dev]"
.venv/bin/python -m pytest -q

# the extension (from vscode-extension/)
npm install
npm run compile     # tsc + eslint + webview, contribution and version checks
npm test            # twenty-seven tests in a real Extension Development Host
npm run check:widget-browser  # the notebook widget, driven in headless Chrome
```

Then open **the repo root** in VS Code and press `F5` — not the
`vscode-extension/` folder: the launch config is at the root so the engine stays
in the workspace you can edit, and F5 compiles before it launches. A second
window opens, the Extension Development Host, with `sandbox/` as its workspace —
a fixed folder, because extension storage is per workspace and the script tab
lives there; with no folder open it would fall back to storage shared with every
other folder-less window. Three configs: **Run Extension** (compiles first),
**Run Extension (no build)** for when `npm run watch` is already going, and
**Extension Tests**.

Hooks run on every push via pre-commit.ci (`.pre-commit-config.yaml`), and
locally with `pre-commit run --all-files`: ruff and prettier for formatting,
ruff for linting (the ruleset is pinned in `pyproject.toml`, because ruff's
defaults move), plus workflow and `pyproject` validation. The one commit that
only reformats is listed in `.git-blame-ignore-revs`;
`git config blame.ignoreRevsFile .git-blame-ignore-revs` makes local blame skip
it, as GitHub already does.

## What is checked, and where

The engine's tests run against both magpylib versions
(`.venv/bin/python -m pytest -q`): released magpylib has no display-backend API,
so a test that draws (`get_scene`) fails there; ask the objects instead, or skip
as the widget tests do.

The extension is checked at three levels, all wired into `npm run compile` so
they run before every F5 and before packaging: type-checking and ESLint over
both the host code and the webview scripts; two contribution checks (every
declared command registered, every menu clause matching a context value the tree
can set, every palette entry safe to invoke with no argument); and a DOM harness
that runs a panel's real script against a real engine
(`npm run inspect -- halbach`). On top of that, `npm test` runs twenty-seven
integration tests **inside a real Extension Development Host** — activation, the
engine subprocess answering through the virtual `scene.json`, a removal taking a
pattern's copies with it, the script tab applying an edit on save, the engine
being killed mid-session and coming back holding the same scene, and the whole
save/open path. Two notes: the user-data dir is forced into the system temp dir
because a unix socket path cannot exceed 103 characters; and `.vscode-test/`
holds a 300 MB VS Code download, gitignored.

Both suites and the packaging run in CI on every push, the engine against **both
magpylib versions**, and a job installs the built wheel alone and runs an edit
through a fake kernel connection (`tools/check-package-alone.py`). Pushing a
`v*` tag builds the `.vsix` and attaches it to a GitHub release; the engine goes
to PyPI and the extension to the Marketplace from the same tag, which is what
lets **Install the Engine** set the engine up rather than tell you to.

**By hand, the view**, after a change to the renderer, the widget or the studio
panel (the parity checklist from
[decision 0011](docs/decisions.md#0011-one-view)):

- a pick selects in the Scene tree and the Inspector; ⌘-click adds; the sidebar
  selecting moves the outline;
- a drag keeps the Inspector's numbers and the field view live, is one undo
  step, and says when it takes a value from a variable;
- a patterned source and a polarization aim redraw from the engine mid-drag; a
  dragged sensor shows its reading;
- H hides and ⇧H isolates, as edits, shown again from the Scene tree or the
  legend;
- paths play and scrub; the typed readout takes a value; snap, one-axis drags,
  world/object axes, projection, framing and the view keys;
- Chart mode, with Animate; the theme follows VS Code's;
- the panel survives being hidden and restored, and a window reload.

**The browser harness is slow**: run it once, at the end, in the background.
When a view bug passes the harness pages, reproduce it in headless Chrome
against the real page before theorising; the first-fit zoom bug was found that
way.

## Working notes

- **The main checkout is shared.** Other sessions work in it; check `git status`
  and the branch before switching, and use a worktree when it is busy.
- **Commits and pushes only with consent**, force-pushes always pinned
  (`--force-with-lease=<branch>:<sha>`).
- **pre-commit.ci pushes "style: pre-commit fixes" commits to PR branches.** A
  rejected push is usually that: rebase on it, never force over it.
- **The widget bundle is built** (`tools/build-widget.sh`) and committed; a
  check verifies it matches its sources. A notebook kernel keeps the bundle it
  loaded — restart it — and relaunch the extension (F5) to pick up engine
  changes.
- **`git grep -E` has no `\b`**: use `-w`, or a search that matches nothing
  passes for "no references".
- **The skill's reference is generated** (`tools/write-skill-reference.py`) from
  the builder's docstrings, and `tests/test_skill.py` fails when it is not what
  the code says today: regenerate after changing a docstring.

## Gotchas

- **Webview JavaScript lives in `media/*.js|mjs`**, loaded under a nonce CSP,
  never inside TypeScript template literals: there the compiler sees only a
  string, a `\n` written singly became a real line break inside a quoted string,
  and the Inspector rendered blank with no error anywhere, because a script that
  cannot parse cannot report that it did not parse.
  `harness/check-webview-scripts.js` refuses a webview script that grows back
  inside a template literal. Escapes meant for the webview must be doubled; if a
  panel is ever blank, run the checker first.
- **The message contract is silent the other way too**: the host posting a type
  the webview does not handle does nothing. Every panel's handler ends with an
  `else` that puts `unhandled message: X` on screen; keep it.
- **NaN never reaches the wire.** magpylib lifts the pen between the segments of
  a trace with NaN; `json.dumps` writes a bare `NaN`, `JSON.parse` rejects it,
  and the client then drops the response without resolving its request, so the
  panel waits forever. `threejs.py` sends `null` and the view restores the NaN;
  bounds are taken over finite points only. Both halves are checked.
- `get_figure` is `json.loads(fig.to_json())`: plotly's encoder handles numpy.
  Do not use `to_plotly_json()`, which leaves numpy in.
- Style paths are **dotted** (`magnetization.arrow.width`) in the document and
  the RPC; a constructor's `style=` needs them nested.
- **`to_script` folds the log in order** rather than hoisting definitions: an
  object added to an already-patterned group must not be defined above the loop
  that copies the group, or it is built into every copy.
- **`Collection.add` is quadratic** when called once per child: a pattern's
  copies are collected and added in one call, in the engine and in the emitted
  script (400 ms against 1 ms for 2000 children). `copy()` and magpylib's own
  rotation are the remaining linear costs; measure before looking for more.
- **A relative mesh path is relative to the document**, which only the host
  knows: the extension rebases paths on Save As before the bytes are written,
  and the crash backup passes the scene's directory explicitly.
- **Sliders commit on release**; the value box updates live during the drag.
  Multi-step paths still require numbers, because the UI divides the total
  across the steps.

## The documents

How the documents are organised, and the rules that keep them from contradicting
each other, are in [CLAUDE.md](CLAUDE.md). In short: how it works is
[docs/architecture.md](docs/architecture.md), what is next is
[docs/roadmap.md](docs/roadmap.md), what was decided and why is one section each
in [docs/decisions.md](docs/decisions.md), and a design in flight is a plan in
[docs/plans/](docs/plans/) until it is built.
