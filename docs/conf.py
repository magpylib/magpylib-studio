"""Sphinx configuration for the magpylib-studio docs, built as magpylib's and
magpylib-material-response's are: MyST-NB pages, the pydata theme.

The example pages are written at each build from `magpylib_studio.examples`,
where each example is written once (see `_write_examples`), so the gallery,
the notebooks and these pages cannot drift apart.
"""

from __future__ import annotations

import ast
import datetime as dt
import importlib.metadata
import pathlib
import re
from typing import Any

project = "magpylib-studio"
copyright = f"{dt.datetime.now(tz=dt.UTC).year}, Alexandre Boisselet"  # noqa: A001 - Sphinx reads this name
author = "Alexandre Boisselet"
version = release = importlib.metadata.version("magpylib_studio")

extensions = [
    "myst_nb",
    "sphinx.ext.autodoc",
    "sphinx_autodoc_typehints",
    "sphinx_copybutton",
    "sphinx_design",
]

source_suffix = [".rst", ".md"]
exclude_patterns = [
    "_build",
    "**.ipynb_checkpoints",
    "Thumbs.db",
    ".DS_Store",
    ".env",
    ".venv",
    "**/*.ipynb",
    # the project's own working pages, read on GitHub
    "architecture.md",
    "decisions.md",
    "direction.md",
    "roadmap.md",
    "plans/**",
]

html_theme = "pydata_sphinx_theme"

html_theme_options: dict[str, Any] = {
    "logo": {
        "text": "Magpylib Studio",
        "image_light": "_static/images/magpylib_logo.png",
        "image_dark": "_static/images/magpylib_logo.png",
    },
    "header_links_before_dropdown": 5,
    "navbar_align": "content",
    "navbar_center": ["navbar-nav"],
    "icon_links": [
        {
            "name": "GitHub",
            "url": "https://github.com/magpylib/magpylib-studio",
            "icon": "https://img.shields.io/github/stars/magpylib/magpylib-studio?style=social",
            "type": "url",
        },
    ],
    "navigation_with_keys": False,
    "footer_start": ["copyright"],
    "footer_end": [],
    "use_edit_page_button": True,
    "navigation_depth": 3,
    "collapse_navigation": False,
    # the examples' gallery takes the width the page's contents would
    "secondary_sidebar_items": {"**": ["page-toc", "sourcelink"], "examples/index": []},
}

html_context = {
    "github_user": "magpylib",
    "github_repo": "magpylib-studio",
    "github_version": "main",
    "doc_path": "docs/",
}

myst_enable_extensions = [
    "colon_fence",
    "deflist",
    "dollarmath",
    "html_admonition",
    "html_image",
    "replacements",
    "smartquotes",
    "substitution",
    "tasklist",
]
# so that links to a page's sections by their titles resolve
myst_heading_anchors = 3

autodoc_member_order = "bysource"
# The docstrings write code in single backticks, as Markdown does: code here
# too, not reST's italics, and its quotes left straight.
default_role = "code"
always_document_param_types = False

html_static_path = ["_static"]
html_css_files = ["fullwidth.css"]
# the example views follow the theme switch, as the pages round them do
html_js_files = ["webcode/viewTheme.js"]

HERE = pathlib.Path(__file__).parent
REPO = HERE.parent
EXAMPLES_DIR = HERE / "examples"
#: the examples' saved pages, which their pages show
VIEWS_DIR = HERE / "_static" / "examples"

_PAGE = """\
# {title}

{notebook}{text}

<iframe class="magpy-example" src="../_static/examples/{module}.html"
  title="{title}, in the 3D view" loading="lazy"></iframe>

The view is the scene as a saved page: {holds}. To edit it and drag its sliders,
open it {where}

```python
from magpylib_studio.examples import EXAMPLES
from magpylib_studio.widget import SceneWidget

SceneWidget(EXAMPLES["{key}"].scene, editable=True{lines})
```

Written as a scene function, with what it imports, it reads:

```python
{code}
```
"""

#: Where an example has a marimo notebook: a link that runs it in molab,
#: marimo's hosted notebooks, which install what its script header names.
_NOTEBOOK = """\
[![Open in molab](https://marimo.io/molab-shield.svg)](https://molab.marimo.io/github/magpylib/magpylib-studio/blob/main/examples/marimo/{path})

"""

_INDEX = """\
# Examples

Each example is a scene written as a plain magpylib function whose parameters
are its variables. Its page shows it in the 3D view, says how to open it to
edit, and shows how it is written. These are the VS Code gallery's own
(**Magpylib Studio: Load Example Scene…**), with its pictures, and all are in
`magpylib_studio.examples`.

::::{{grid}} 1 2 3 4
:gutter: 2

{cards}
::::

{others}

```{{toctree}}
:maxdepth: 1
:hidden:

{pages}
```
"""

#: A gallery card, with the picture the extension's gallery shows
#: (`vscode-extension/media/gallery/`, drawn by `npm run gallery`) in the
#: page's theme.
_CARD = """\
:::{{grid-item-card}}
:link: {module}
:link-type: doc
:class-card: magpy-gallery-card

```{{image}} ../../vscode-extension/media/gallery/{key}-light.webp
:alt: {title}
:class: only-light
```

```{{image}} ../../vscode-extension/media/gallery/{key}-dark.webp
:alt: {title}
:class: only-dark
```

**{title}**

{sentence}
:::
"""

_OTHERS = """\
The tests and the evaluations are written against {count} more, which the
gallery does not show:

{items}
"""


def _holds(example):
    """What its saved page lets one do, which depends on the example."""
    built = example.scene.build()
    does = ["orbit it", "open its legend"]
    if example.scene.variants:
        does.append("click its variants")
    if built.session.path_steps() > 1:
        does.append("play its run")
    return ", ".join(does[:-1]) + " and " + does[-1]


def _code(module):
    """The example's module as it would be copied: its imports, helpers and
    scene function, without its title, and without the function's docstring,
    which the page shows above as its text."""
    path = REPO / "magpylib_studio" / "examples" / f"{module}.py"
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    drop = set()
    for node in ast.parse(source).body:
        title = isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "TITLE" for t in node.targets
        )
        if title:
            drop.update(range(node.lineno - 1, node.end_lineno))
        if isinstance(node, ast.FunctionDef) and node.name == module:
            doc = node.body[0]
            drop.update(range(doc.lineno - 1, doc.end_lineno))
    kept = "\n".join(line for k, line in enumerate(lines) if k not in drop)
    return re.sub(r"\n{3,}", "\n\n\n", kept).strip()


def _write_examples(_app=None):
    """One page per example, and their index, from `magpylib_studio.examples`:
    written at each build, never by hand, so they say what the examples say.
    Pages of examples gone are taken away."""
    from magpylib_studio.examples import EXAMPLES
    from magpylib_studio.widget import SceneWidget

    EXAMPLES_DIR.mkdir(exist_ok=True)
    VIEWS_DIR.mkdir(parents=True, exist_ok=True)
    cards, others, pages = [], [], []
    for key, example in EXAMPLES.items():
        where = (
            "in VS Code, **Magpylib Studio: Load Example Scene…**, or in a notebook:"
            if example.gallery
            else "in a notebook:"
        )
        page = _PAGE.format(
            title=example.title,
            text=example.text,
            module=example.module,
            holds=_holds(example),
            where=where,
            key=key,
            lines=", field_lines=True" if example.field_lines else "",
            code=_code(example.module),
            notebook=_NOTEBOOK.format(path=example.notebook)
            if example.notebook
            else "",
        )
        view = SceneWidget(example.scene.build(), field_lines=example.field_lines)
        _write(VIEWS_DIR / f"{example.module}.html", view.to_html(title=example.title))
        _write(EXAMPLES_DIR / f"{example.module}.md", page)
        sentence = example.summary
        if example.gallery:
            cards.append(
                _CARD.format(
                    title=example.title,
                    module=example.module,
                    key=key,
                    sentence=sentence,
                )
            )
        else:
            others.append(f"- [{example.title}]({example.module}.md) — {sentence}")
        pages.append(example.module)
    _write(
        EXAMPLES_DIR / "index.md",
        _INDEX.format(
            cards="\n".join(cards),
            others=(
                _OTHERS.format(
                    count=["one", "two", "three"][len(others) - 1]
                    if len(others) <= 3
                    else len(others),
                    items="\n".join(others),
                )
                if others
                else ""
            ),
            pages="\n".join(pages),
        ),
    )
    for folder, suffix in ((EXAMPLES_DIR, ".md"), (VIEWS_DIR, ".html")):
        for stale in folder.glob(f"*{suffix}"):
            if stale.stem not in {*pages, "index"}:
                stale.unlink()


def _write(path, text):
    """Written only when it changed, so Sphinx rebuilds only what did."""
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")


def _no_edit_button(_app, pagename, _templatename, context, _doctree):
    """A generated page has no file of its own to edit: its example's
    module is the source, and the page says where it is."""
    if pagename.startswith("examples/"):
        context["theme_use_edit_page_button"] = False


def setup(app):
    app.connect("builder-inited", _write_examples)
    app.connect("html-page-context", _no_edit_button)
