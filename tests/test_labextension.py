"""The JupyterLab scene tab ships built (`jupyterlab-extension/labextension/`),
committed so that installing the package needs no node. Built from what is in
the tree, or the wheel would carry an old tab without a word."""

import hashlib
import json
import pathlib
import tomllib

REPO = pathlib.Path(__file__).parent.parent
TAB = REPO / "jupyterlab-extension"
#: What the build reads -- the list `jupyterlab-extension/stamp.mjs` takes.
SOURCES = ["package.json", "package-lock.json", "tsconfig.json", "src/index.ts"]


def test_the_jupyterlab_tab_is_built_from_its_sources():
    digest = hashlib.sha256()
    for name in SOURCES:
        digest.update((TAB / name).read_bytes())
    stamp = (TAB / "labextension" / "sources.sha256").read_text().strip()
    assert stamp == digest.hexdigest(), "run `npm run build` in jupyterlab-extension/"
    # installed where JupyterLab looks for it, under the name it was built as
    built = json.loads((TAB / "labextension" / "package.json").read_text())
    shared = tomllib.loads((REPO / "pyproject.toml").read_text())["tool"]["hatch"]
    target = shared["build"]["targets"]["wheel"]["shared-data"]
    assert target["jupyterlab-extension/labextension"].endswith("/" + built["name"])
