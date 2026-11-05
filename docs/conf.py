"""Sphinx configuration for the magpylib-studio docs, built as magpylib's and
magpylib-material-response's are: MyST-NB pages, the pydata theme.

The example pages are written at each build from `magpylib_studio.examples`,
where each example is written once (see `_write_examples`), so the gallery,
the notebooks and these pages cannot drift apart.
"""

from __future__ import annotations

import datetime as dt
import importlib.metadata
import pathlib
from typing import Any

project = "magpylib-studio"
copyright = f"{dt.datetime.now(tz=dt.UTC).year}, Alexandre Boisselet"  # noqa: A001 - Sphinx reads this name
author = "Alexandre Boisselet"
version = release = importlib.metadata.version("magpylib_studio")

extensions = [
    "myst_nb",
    "sphinx.ext.autodoc",
    "sphinx.ext.intersphinx",
    "sphinx.ext.napoleon",
    "sphinx_autodoc_typehints",
    "sphinx_copybutton",
]

# a page with code to run is executed at each build
nb_execution_timeout = 120

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

intersphinx_mapping = {
    "python": ("https://docs.python.org/3", None),
    "numpy": ("https://numpy.org/doc/stable", None),
    "magpylib": ("https://magpylib.readthedocs.io/en/stable", None),
}

autodoc_member_order = "bysource"
# The docstrings write code in single backticks, as Markdown does: code here
# too, not reST's italics, and its quotes left straight.
default_role = "code"
always_document_param_types = False

suppress_warnings = ["mystnb.unknown_mime_type"]

html_static_path = ["_static"]
html_css_files = ["fullwidth.css"]

HERE = pathlib.Path(__file__).parent
EXAMPLES_DIR = HERE / "examples"
#: the examples' saved pages, which their pages show
VIEWS_DIR = HERE / "_static" / "examples"

_PAGE = """\
# {title}

{text}

<iframe class="magpy-example" src="../_static/examples/{module}.html"
  title="{title}, in the 3D view" loading="lazy"></iframe>

The view is the scene as a saved page: orbit it, open its legend, click its
variants and play its run. To edit it and drag its sliders, open it in
{where}. Written as a scene function, it reads:

```{{literalinclude}} ../../magpylib_studio/examples/{module}.py
:language: python
:pyobject: {module}
```
"""

_INDEX = """\
# Examples

Each example is a scene written as a plain magpylib function whose parameters
are its variables: open it in the 3D view below, drag its sliders, and read how
it is written. The same examples are in the VS Code gallery (**Magpylib
Studio: Load Example Scene…**) and in `magpylib_studio.examples`.

{items}

```{{toctree}}
:maxdepth: 1
:hidden:

{pages}
```
"""


def _write_examples(_app=None):
    """One page per example, and their index, from `magpylib_studio.examples`:
    written at each build, never by hand, so they say what the examples say."""
    from magpylib_studio.examples import EXAMPLES
    from magpylib_studio.widget import SceneWidget

    EXAMPLES_DIR.mkdir(exist_ok=True)
    VIEWS_DIR.mkdir(parents=True, exist_ok=True)
    items, pages = [], []
    for key, example in EXAMPLES.items():
        notebook = (
            f"a notebook, `SceneWidget(EXAMPLES[{key!r}].scene.build(), "
            "editable=True)` with `EXAMPLES` from `magpylib_studio.examples`"
        )
        where = (
            "VS Code, **Magpylib Studio: Load Example Scene…**, or in " + notebook
            if example.gallery
            else notebook
        )
        page = _PAGE.format(
            title=example.title, text=example.text, module=example.module, where=where
        )
        view = SceneWidget(example.scene.build(), field_lines=example.field_lines)
        (VIEWS_DIR / f"{example.module}.html").write_text(
            view.to_html(title=example.title), encoding="utf-8"
        )
        path = EXAMPLES_DIR / f"{example.module}.md"
        if not path.exists() or path.read_text(encoding="utf-8") != page:
            path.write_text(page, encoding="utf-8")
        items.append(f"- [{example.title}]({example.module}.md) — {example.summary}")
        pages.append(example.module)
    index = _INDEX.format(items="\n".join(items), pages="\n".join(pages))
    path = EXAMPLES_DIR / "index.md"
    if not path.exists() or path.read_text(encoding="utf-8") != index:
        path.write_text(index, encoding="utf-8")


def setup(app):
    app.connect("builder-inited", _write_examples)
