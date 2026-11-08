# JupyterLab scene tab: prototype

**Question.** After decisions 0056 and 0057 the view, its model and its panels
are the package's. Is JupyterLab then a cheap studio host: a `.magpy.json`
opened as a tab, edited, saved, without moving more into the package first?

**Answer so far: yes for the document loop, in 195 lines of TypeScript and no
change to the package.** Checked in a real JupyterLab 4.6.6, headless Chrome, on
the Halbach example (`node jlab-drive.mjs`, kept beside the session, not in the
repo).

## What works

| step                                               | result                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| open `halbach.magpy.json` from the file browser    | the tab is the default for `.magpy.json`; a kernel starts where the file is  |
| the scene drawn                                    | the package's editable widget: legend, tools, Variables, Inspector, variants |
| an edit (`n` 12 to 8, here set through the kernel) | the tab is marked unsaved                                                    |
| Save                                               | the file holds `n = 8`, read back by a fresh session                         |
| the file changed on disk (`n = 16`), then Revert   | the scene takes it as one undo step, "changed on disk"                       |
| close the tab                                      | its kernel shuts down with it                                                |

JupyterLab brings the rest without code here: the unsaved mark, Save and Save
As, Revert, its check that the file changed since it was read, autosave.

## How

- The kernel runs `SceneWidget(path, editable=True)`, as a notebook cell would,
  in the document's own session.
- The widget manager is the one JupyterLab makes for a notebook
  (`registerWidgetManager`, exported by `@jupyter-widgets/jupyterlab-manager`),
  which knows every registered widget module, anywidget's among them.
- After each settled edit (`revision`) the kernel sends the scene's document
  over a comm; the tab puts it in JupyterLab's text model and marks it unsaved.
  A text the model takes from elsewhere -- Revert -- goes back as
  `replace_scene`.

## What it took, that a real version would clean up

1. **A private kernel API**: `SceneWidget._editing("save").to_dict()` and
   `_show(...)`. The package change to make: a public `view.document` (the
   `.magpy.json` text) and `view.take_document(text)` (one undo step).
2. **The notebook's widget manager on a text document**: it reads saved widget
   state off notebook metadata, so the tab hands it the context with a model
   that has none; and it binds its renderer a moment after it finds the kernel,
   which the tab waits for.
3. **The output trusted**, as a notebook's own outputs are: the widget renderer
   is not a safe one.
4. **The session started by hand, on the default kernel**: a text document has
   no language to pick a kernel by. The default kernel must have
   `magpylib-studio[widget]` installed.

## Not done

- The view's height follows the tab (fixed at 640 px here).
- The script tab, the several-scenes side bar, the field and history views: the
  VS Code shell's, not attempted.
- Packaging. The built extension is 24 KB. Options: ship it prebuilt in the
  wheel (`share/jupyter/labextensions/`, committed as `widget.js` is, so
  installing needs no node), or a separate `magpylib-studio-jupyterlab` package.
  Either way it needs JupyterLab >= 4.4 and ipywidgets 8.
- marimo has no extension point for a file type: there the widget in a cell is
  the studio, as now.

## Run it

```bash
cd jupyterlab-extension
npm install
PATH=<venv with jupyterlab>/bin:$PATH npm run build
ln -sfn "$PWD/labextension" <venv>/share/jupyter/labextensions/magpylib-studio-jupyterlab
<venv>/bin/jupyter lab   # open a .magpy.json from the file browser
```

## Log

- 2026-11-08: scaffolded; `registerConsoleWidgetManager` is not exported, the
  notebook's `registerWidgetManager` is, used with a metadata-less model; the
  document's session needed starting by hand; the widget showed as text until
  the output was trusted. The loop above checked end to end.
