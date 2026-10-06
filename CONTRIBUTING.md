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
window opens, the Extension Development Host, with `sandbox/` as its workspace.

Hooks run on every push via pre-commit.ci (`.pre-commit-config.yaml`), and
locally with `pre-commit run --all-files`: ruff and prettier for formatting,
ruff for linting (the ruleset is pinned in `pyproject.toml`, because ruff's
defaults move), plus workflow and `pyproject` validation. The one commit that
only reformats is listed in `.git-blame-ignore-revs`;
`git config blame.ignoreRevsFile .git-blame-ignore-revs` makes local blame skip
it, as GitHub already does.

## What is checked, and where

The engine's tests run against both magpylib versions
(`.venv/bin/python -m pytest -q`).

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
save/open path: a file that opens back as the same scene, a save that goes to
the file it came from without asking, a document from a newer version being
refused without disturbing the open one, and the crash backup being written and
restorable.

Both suites and the packaging run in CI on every push, the engine against **both
magpylib versions** — the claim above used to be checked by hand. Pushing a `v*`
tag builds the `.vsix` and attaches it to a GitHub release.

Both halves are published: the engine on PyPI (`pip install magpylib-studio`)
and the extension on the Marketplace under the `magpylib` publisher. That order
mattered — an extension whose first act is "now go and pip install this git URL"
fails at first contact, before anyone sees a feature — and it is what lets
**Install the Engine** set the engine up for you rather than tell you to. The
`.vsix` attached to each release is the same build, for anyone who would rather
install it by hand.

## The project's documents

| Question                             | Document                                           |
| ------------------------------------ | -------------------------------------------------- |
| What is built?                       | [CONTINUE.md](CONTINUE.md)                         |
| What is next?                        | [TASKS.md](TASKS.md)                               |
| Why is it going that way?            | [docs/direction.md](docs/direction.md)             |
| How does instancing work?            | [docs/instancing.md](docs/instancing.md)           |
| How does FEM validation go?          | [docs/fem.md](docs/fem.md)                         |
| How does editing in a notebook work? | [docs/editable-widget.md](docs/editable-widget.md) |
| Why is there one view?               | [docs/one-view.md](docs/one-view.md)               |

The three at the root are the state, the work and the front door; `docs/` holds
the long-form thinking behind them.

How the engine works inside — the document format, the design decisions and the
JSON-RPC protocol — is in [docs/architecture.md](docs/architecture.md).
