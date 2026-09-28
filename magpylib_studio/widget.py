"""The studio's 3D view, in a notebook cell.

The same three.js scene graph the VS Code panel draws, wrapped as an
`anywidget` so that a notebook can hold it::

    import magpylib as magpy
    from magpylib_studio.widget import SceneWidget

    SceneWidget(magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1)))

`anywidget` is the widget protocol rather than a frontend, so the same object
draws in marimo, Jupyter, VS Code's notebooks and Colab. What marimo adds is
that the widget is *reactive*: a slider rebuilds the scene and the view
redraws, and a click in the view is a value the next cell reads -- which is
the parameter binding the studio's own GUI is heading for, with no protocol in
the middle, because the notebook already re-runs the cell.

Read only, and for the same reason `backend.py` is: what a view can offer to
edit is what the host can put back, and here the host is a cell that has
already run. Selection is the exception -- it is a value, not an edit -- and
`picked` gives back the magpylib objects that were clicked.

Imported only when a widget is actually drawn: the entry point magpylib
resolves while it is importing names `backend.py`, which stays down to
magpylib and numpy, and reaches this module from inside `show`. Nobody who
never draws a widget pays for ipywidgets.
"""

from __future__ import annotations

import base64
import gzip
import html
import json
import pathlib
import string

import anywidget
import traitlets

from magpylib_studio import threejs

STATIC = pathlib.Path(__file__).parent / "static"

#: How tall the scene is drawn when nobody says. Tall enough for a scene to
#: be legible in a notebook column, short enough to leave the next cell on
#: screen.
DEFAULT_HEIGHT = 420

#: What the export button saves the file as, before the browser asks.
EXPORT_NAME = "magpylib-scene.html"

#: A saved view: the widget itself, run against a model this page holds. The
#: bundle and the scene travel gzipped and in base64 -- a third of the size,
#: and nothing in them can close the script element they sit in -- and are
#: unpacked with what every current browser has. Written without `$`, which
#: is `string.Template`'s.
_PAGE = string.Template("""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>$title</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 12px;
    font: 13px/1.4 system-ui, sans-serif;
    background: #ffffff;
    color: #1f2328;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1e1e1e; color: #d4d4d4; }
  }
$css
</style>
</head>
<body>
<div id="magpy-root"></div>
<script type="text/plain" id="magpy-widget">$bundle</script>
<script type="text/plain" id="magpy-scene">$data</script>
<script type="module">
// Saved by magpylib-studio (SceneWidget.write_html): the notebook widget and
// the scene it was showing, with nothing to fetch and no notebook behind it.
async function unpack(id) {
  const text = document.getElementById(id).textContent.trim();
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
const [source, scene] = await Promise.all([
  unpack("magpy-widget"),
  unpack("magpy-scene"),
]);
const { state, run } = JSON.parse(scene);

// The model the widget is written against, held here. A frame of the run --
// what the widget would ask python for -- is answered from the run this file
// carries, so a saved path still plays.
const listeners = {};
function emit(event, value) {
  for (const listener of listeners[event] || []) listener(value);
}
const model = {
  get: (key) => state[key],
  set(key, value) {
    state[key] = value;
    emit("change:" + key, value);
  },
  save_changes() {},
  on(event, listener) {
    (listeners[event] ||= []).push(listener);
  },
  off() {},
  send(message) {
    if (message.kind !== "frame" || !run.length) return;
    const at = Math.max(0, Math.min(message.index, run.length - 1));
    setTimeout(() =>
      emit("msg:custom", { kind: "frame", ...run[at], runId: message.runId }),
    );
  },
};

// As tall as the window, less the margins.
const fit = () => model.set("height", Math.max(240, innerHeight - 26));
fit();
addEventListener("resize", fit);

const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
const widget = (await import(url)).default;
widget.render({ model, el: document.getElementById("magpy-root") });
</script>
</body>
</html>
""")


def _packed(text):
    """`text`, gzipped and in base64. `mtime=0`, so one scene is one file."""
    raw = gzip.compress(text.encode("utf-8"), mtime=0)
    return base64.b64encode(raw).decode("ascii")


def _given(objects):
    """The objects as passed, lists opened up and collections left whole."""
    for obj in objects:
        if isinstance(obj, list | tuple | set):
            yield from _given(obj)
        else:
            yield obj


def _tree(objects):
    """The Collection hierarchy under `objects`, and every object in it by id.

    It has to come from the objects. The payload cannot carry it: every trace
    under a Collection is stamped with the *outermost* one's legendgroup, so
    three levels of nesting arrive looking like one.

    Each object appears once, where it sits in its collection. One that was
    passed and is also inside another that was passed is shown in its
    collection rather than a second time at the top.
    """
    given = list(_given(objects))
    inside = {id(child) for obj in given for child in getattr(obj, "children_all", ())}
    found = {}

    def node(obj):
        key = str(id(obj))
        found[key] = obj
        return {
            "id": key,
            "label": getattr(obj.style, "label", None) or type(obj).__name__,
            "kind": type(obj).__name__,
            "children": [node(child) for child in getattr(obj, "children", ())],
        }

    roots = [
        node(obj)
        for obj in given
        if id(obj) not in inside and str(id(obj)) not in found
    ]
    return roots, found


def _positions(tree, at=""):
    """Each node's id, and where it sits: ``"0"``, ``"0/1"``, ``"0/1/3"``.

    The same addressing the legend folds by.
    """
    for i, node in enumerate(tree):
        path = f"{at}/{i}" if at else str(i)
        yield node["id"], path
        yield from _positions(node["children"], path)


class SceneWidget(anywidget.AnyWidget):
    """A magpylib scene as a three.js scene graph.

    Built from the `Scene` a display backend is handed, so everything
    magpylib draws -- magnets, currents, sensors, field arrows, paths,
    `style.model3d` extras -- arrives the way `show` composed it.
    """

    _esm = STATIC / "widget.js"
    _css = STATIC / "widget.css"

    #: The scene as buffers. Replacing it redraws, keeping the camera.
    payload = traitlets.Dict().tag(sync=True)
    #: Which objects are outlined, by the ids `payload` uses. Written by a
    #: click in the view or the legend and readable from the notebook -- and
    #: the other way about: assigning to it moves the outline.
    selected = traitlets.List(traitlets.Unicode()).tag(sync=True)
    #: Which objects are not drawn, by the same ids. Written by the legend's
    #: eye, and assignable from the notebook like `selected`.
    hidden = traitlets.List(traitlets.Unicode()).tag(sync=True)
    #: Whether the graduated box -- the scene's scale -- is drawn. A cell can
    #: put it away for a clean picture, and an export keeps it that way.
    axes = traitlets.Bool(True).tag(sync=True)
    #: Light or dark. ``"auto"`` wears whatever the view sits on -- the
    #: notebook's output area, which is not always the page's theme -- and
    #: the system's setting when nothing behind it says.
    theme = traitlets.Enum(("auto", "light", "dark"), default_value="auto").tag(
        sync=True
    )
    #: The objects `identify` was given, as their Collection hierarchy: nodes
    #: of ``{id, label, kind, children}``. What the legend draws. Empty for a
    #: bare ``magpy.show(..., backend="widget")`` on a magpylib that does not
    #: hand its backends the objects -- see `_from_scene`.
    tree = traitlets.List().tag(sync=True)
    height = traitlets.Int(DEFAULT_HEIGHT).tag(sync=True)
    #: Steps in the run, how long it should take, and whether it starts over
    #: at the end -- magpylib's own animation settings. One frame means there
    #: is nothing to play and the view shows no controls for it.
    frames = traitlets.Int(1).tag(sync=True)
    duration = traitlets.Float(5.0).tag(sync=True)
    repeat = traitlets.Bool(False).tag(sync=True)

    def __init__(self, *objects, animation=False, **kwargs):
        """A view of `objects` -- or of nothing yet, to `update` later.

        Takes what `magpylib.show` takes: ``animation=True`` captures the
        paths so the view can play them, and anything else is passed through.
        And, as any widget does, the starting value of its traits --
        ``height``, ``theme``, ``axes``. A keyword that names a trait is the
        widget's; the rest are magpylib's, and the two share no names.

        Returned rather than displayed, which is what a notebook wants from
        the last line of a cell. In marimo, wrap it in ``mo.ui.anywidget(...)``
        to have the cell's value follow the selection.
        """
        traits, kwargs = self._split(kwargs)
        super().__init__(**traits)
        #: The captured run, kept only when there is one that motion cannot
        #: play -- see `_adopt`. Every frame holds every trace of the scene
        #: as computed at that step, so this is the megabytes the payload
        #: deliberately does not carry. Frames are served from here one at a
        #: time, as the panel serves them.
        self._scene = None
        self._objects = {}
        #: Where the view was last looking, as it reported: a message, not a
        #: trait, for the reason given where the view sends it. Kept for
        #: `to_html`, so a file saved from a cell opens on the same view.
        self._camera = None
        self.on_msg(self._on_message)
        if objects:
            # The traits again, after the scene: drawing one sets the run's
            # length, pace and repeat from what magpylib says, and a `repeat`
            # given here is the caller's word, not magpylib's.
            self.update(*objects, animation=animation, **kwargs, **traits)
        elif kwargs:
            # Nothing to draw them with, and dropped quietly they would look
            # like they had been ignored when the objects came.
            raise TypeError(f"no objects to draw with {', '.join(kwargs)}")

    @classmethod
    def _split(cls, kwargs):
        """`kwargs` as the widget's traits, and the rest: magpylib's."""
        names = cls.class_trait_names()
        own = {key: value for key, value in kwargs.items() if key in names}
        return own, {key: value for key, value in kwargs.items() if key not in own}

    @classmethod
    def _from_scene(cls, scene):
        """A view of `scene`: what ``magpy.show(..., backend="widget")`` is.

        Named by the objects magpylib hands over with the scene, where it
        does (`Panel.objects`): they are what the legend's nesting and a
        click's object come from, which no trace can carry. A magpylib that
        hands over only the scene leaves the widget with ids and nothing to
        name them by -- see `identify`.
        """
        widget = cls()
        widget._adopt(scene)
        objects = [obj for panel in scene.panels for obj in _objects_of(panel)]
        if objects:
            widget.identify(*objects)
        return widget

    def _adopt(self, scene):
        """Draw `scene`, in one update.

        `hold_sync` because these are four traits and the view reads them
        together: sent one at a time, a payload can arrive at a browser that
        still believes the last scene's frame count, and the playback controls
        are drawn from it.
        """
        run = len(scene.frames) > 1
        # A run that is its first frame moved about travels as the motion and
        # plays in the browser, kernel or none. Only one that changes shape
        # as it goes is kept here, to be served a frame at a time.
        played = threejs.played_payload(scene) if run else None
        with self.hold_sync():
            self._scene = scene if run and played is None else None
            self.frames = len(scene.frames)
            self.duration = float(scene.animation.time)
            self.repeat = bool(scene.animation.repeat)
            self.payload = played or threejs.view_payload(scene, index=0)

    def update(self, *objects, animation=False, **kwargs):
        """Point this view at `objects`.

        The alternative to making a new widget, and the reason to prefer it in
        a reactive notebook: a slider re-runs the cell it is read in, so a
        widget made there is a *new* one on every drag -- a new element,
        a bar rebuilt from nothing, and a camera that goes back to the framing
        it started with, losing whatever the user had zoomed in on. Updating
        one that is already on the page replaces the drawn objects and leaves
        the view alone.

        Takes what the constructor takes, traits too; a scene is re-captured
        whole, because that is what magpylib composes.

        Returns nothing, deliberately. This is the last line of a cell, and a
        cell's value is its last expression: returning `self` -- which is a
        widget, and renders -- draws a *second* live view of the same scene
        under the one being updated, with its own WebGL context.
        """
        # `_capture` is what `scene_payload` uses for the same reason: it is
        # the one path that hands back the `Scene` a display backend is given,
        # with the capabilities this view declares, without a second widget
        # (and a second comm) being made to throw away.
        # One message, not two: sent apart, the browser would draw the new
        # scene against the old tree, and the legend would list objects that
        # are no longer there beside ones it cannot name.
        traits, kwargs = self._split(kwargs)
        with self.hold_sync():
            self._adopt(threejs._capture(objects, animation=animation, **kwargs))
            self.identify(*objects)
            # after `identify`, so that a selection given here is not carried
            for name, value in traits.items():
                setattr(self, name, value)

    def identify(self, *objects):
        """Name the objects the scene was drawn from, and return self.

        The payload keys traces by ``id(obj)``, which is an address: it says
        which traces belong together, and nothing else. Handing the objects
        back turns it into an identity -- `picked` resolves a click to the
        magpylib object, and the view can say what it is called -- and holding
        them here is also what keeps the address meaning what it meant.

        What was selected or hidden carries over to these objects: an object
        passed again keeps its place in both, and one that is not moves to
        whatever now sits where it sat in the tree. That second case is the
        usual one in a reactive notebook -- a slider rebuilds the objects, so
        they are new ones at new addresses -- and "the lower ring" means the
        ring in that place, not the address it happened to be at. It is how
        the legend keeps what is folded, for the same reason. Whatever has
        nowhere to go is dropped.
        """
        before = dict(_positions(self.tree))
        tree, objects = _tree(objects)
        after = {path: key for key, path in _positions(tree)}

        def carried(ids):
            out = []
            for key in ids:
                # An id among the new objects is the same object: the old ones
                # are still held in `_objects`, so no new one can have been
                # given an old one's address.
                if key not in objects:
                    key = after.get(before.get(key))
                if key is not None and key not in out:
                    out.append(key)
            return out

        with self.hold_sync():
            self.tree = tree
            self.selected = carried(self.selected)
            self.hidden = carried(self.hidden)
        self._objects = objects
        return self

    @property
    def picked(self):
        """The objects that are selected, in the order they were clicked.

        Empty when the widget was not given the objects (`identify`), which is
        the case for a bare ``magpy.show(..., backend="widget")`` on a
        magpylib that does not hand them to its backends: the ids are still
        there in `selected`, but there is nothing to resolve them to.
        """
        return [self._objects[key] for key in self.selected if key in self._objects]

    def to_html(self, title="magpylib scene"):
        """This view as one HTML file that needs nothing else.

        The widget itself, not a picture of it: orbit, legend, keys and the
        selection and hiding as they are now, running against a model the
        page holds. A captured run travels with it -- as its motion, or every
        frame of one that changes shape -- so a path still plays.

        It opens where the view was looking, as the view last said -- which a
        view says once it stops moving. One never drawn has not said, and the
        page frames the scene.
        """
        return _PAGE.substitute(
            title=html.escape(title),
            css=(STATIC / "widget.css").read_text(encoding="utf-8"),
            bundle=_packed((STATIC / "widget.js").read_text(encoding="utf-8")),
            data=_packed(json.dumps(self._saved(), allow_nan=False)),
        )

    def _saved(self):
        """What a saved page holds: the model's state as it is now, and --
        for a run the payload does not carry as motion -- every frame of it,
        which the page answers for itself."""
        state = {
            "payload": self.payload,
            "tree": self.tree,
            "selected": list(self.selected),
            "hidden": list(self.hidden),
            "axes": self.axes,
            "theme": self.theme,
            "height": self.height,
            "frames": self.frames,
            "duration": self.duration,
            "repeat": self.repeat,
            "camera": self._camera,
            # no python behind the page, so nothing to ask for another export
            "standalone": True,
        }
        run = (
            []
            if self._scene is None
            else [threejs.frame_payload(self._scene, i) for i in range(self.frames)]
        )
        return {"state": state, "run": run}

    def write_html(self, file, title="magpylib scene"):
        """Write `to_html` to `file`: a path, or anything open for writing.

        Named and shaped as Plotly's `Figure.write_html` is, and like it
        returns nothing -- so, as the last line of a cell, it shows nothing.
        """
        page = self.to_html(title)
        if hasattr(file, "write"):
            file.write(page)
        else:
            pathlib.Path(file).write_text(page, encoding="utf-8")

    def _on_message(self, _widget, content, _buffers):
        """Answer the view: one frame of the run, or the view as a file --
        or keep where it says it is looking.

        Frames are asked for one at a time rather than handed over in one go,
        for the reason the panel does: the whole run is every trace of every
        step, and one frame is all anyone is looking at.
        """
        kind = content.get("kind") if isinstance(content, dict) else None
        if kind == "frame" and self._scene is not None:
            frame = threejs.frame_payload(self._scene, content.get("index", 0))
            # Said back as asked: the view drops a frame of a run it has
            # since been re-pointed away from.
            self.send({"kind": "frame", **frame, "runId": content.get("runId")})
        elif kind == "camera":
            self._camera = content.get("camera")
        elif kind == "export":
            self._camera = content.get("camera") or self._camera
            page = self.to_html()
            self.send({"kind": "export", "html": page, "filename": EXPORT_NAME})


def _objects_of(panel):
    """The objects magpylib drew in `panel`, where it says (`Panel.objects`,
    newer than the display-backend API itself) -- none where it does not."""
    return getattr(panel, "objects", ())


def display(widget):
    """Put `widget` in the cell's output, in whichever notebook this is.

    marimo first, because it is also importable in a Jupyter kernel and only
    it can say whether it is the one running. Neither answering is not an
    error: a script drawing with this backend gets the widget back from
    `show(return_fig=True)` and can do as it likes with it.
    """
    try:
        import marimo

        if marimo.running_in_notebook():
            marimo.output.append(widget)
            return True
    except ImportError:
        pass
    try:
        from IPython.core.getipython import get_ipython
        from IPython.display import display as ipy_display

        if get_ipython() is not None:
            ipy_display(widget)
            return True
    except ImportError:
        pass
    return False
