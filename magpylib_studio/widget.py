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

Read only by default, and for the same reason `backend.py` is: what a view
can offer to edit is what the host can put back, and here the host is a cell
that has already run. Selection is the exception -- it is a value, not an
edit -- and `picked` gives back the magpylib objects that were clicked.

``editable=True`` is the other way round: the objects are copied into a
studio session in the kernel rather than left to the cell, so an edit has
somewhere to be kept. Dragged there, a magnet moves in the session, can be
undone, and comes back out as code. A scene written in code, or a path -- a
script's objects, or a scene the studio saved -- is a session already, and
the view shows that session itself, nothing copied, with the handles away
until asked.

The pencil among the view's tools asks: it puts the handles out. On a view
of a session, that is all it does. On a view of the cell's own objects, the
objects are copied into a session first, under the cell's names for them,
and ``editable`` reads True from that moment -- the one way a view changes
what it shows after it is made.

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
import os
import pathlib
import string
import sys
import warnings

import anywidget
import numpy as np
import traitlets

from magpylib_studio import threejs

STATIC = pathlib.Path(__file__).parent / "static"

#: How tall the scene is drawn when nobody says; see `threejs.DEFAULT_HEIGHT`.
DEFAULT_HEIGHT = threejs.DEFAULT_HEIGHT

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
    #: Whether the view's handles are out. Out, its objects are a studio
    #: session's, which keeps what a drag does to them -- see `objects`:
    #: ``SceneWidget(..., editable=True)`` from the start, or the pencil among
    #: the view's tools later, which is ``view.editable = True`` from code. A
    #: view of the cell's own objects copies them into a session at that
    #: moment; one of a scene written in code, or of a path, has a session
    #: already and only puts the handles out. A view of nothing refuses,
    #: having nothing to edit. Set back -- the pencil pressed again -- the
    #: handles go away; the session, and the edits in it, stay. ``None`` is
    #: a view for looking only: no pencil, and the trait refuses to turn on.
    editable = traitlets.Bool(False, allow_none=True).tag(sync=True)
    #: Counts the edits the notebook has been told of, in an editable view: a
    #: drag's end, an undo, a redo, a `set` or a `set_variable` -- each that
    #: changed something. A cell that reads the widget in marimo re-runs when
    #: it changes, and ``observe(..., "revision")`` hears of each in Jupyter.
    #: Not the poses in between, which would be once a frame.
    revision = traitlets.Int(0).tag(sync=True)
    #: What the edit `revision` counted was: ``{"by": "drag" | "set" | "undo" |
    #: "redo", "objects": [...], "changed": {id: {field: value}}}`` for a drag
    #: or a `set`, and for an undo or a redo the step it took back or put back,
    #: by the session's name for it (``"step"``); for a `set_variable`,
    #: ``{"by": "set_variable", "variable": name, "value": value}``. Set
    #: before `revision`, so a callback on that reads this one's news.
    last_edit = traitlets.Dict().tag(sync=True)
    #: The scene's variables as resolved, ``{name: value}``, in a view with a
    #: scene of its own: what the view's own sliders set -- the variables
    #: panel among its tools, with the handles -- and what a cell reads to
    #: follow them. Changes once per settled edit, with `revision`. Empty for
    #: a view of the cell's own objects, which has no variables.
    #:
    #: Assignable, like `selected`: ``view.variables = {"n": 12}`` sets what
    #: differs, as one edit, and the trait reads the scene back, every
    #: variable included. So another control's trait can be tied to it both
    #: ways with ``traitlets.link`` -- a wigglystuff call expression, say --
    #: and the two move together; the view's model is the one that owns the
    #: numbers. A name the scene has no variable of is refused.
    variables = traitlets.Dict().tag(sync=True)

    #: What an editable view may ask of its session: a drag, and undoing one;
    #: the variables, to list and to set, with a typed value read through
    #: `quantity` and the expression help. Nothing that runs a file -- a
    #: script or a scene to load -- which the view has no need of.
    VIEW_CALLS = frozenset(
        {
            "begin_interaction",
            "end_interaction",
            "apply_edits",
            "undo",
            "redo",
            "reset",
            "get_scene",
            "get_variables",
            "set_variable",
            "restore_variable",
            "quantity",
            "expression_help",
        }
    )
    #: The calls after which the scene is settled, and the notebook is told.
    _SETTLES = frozenset({"end_interaction", "undo", "redo"})
    #: The calls that edit a variable: settled too, unless the message says
    #: the value is a preview -- the pointer still on the slider -- in which
    #: case the release settles, as a drag's does.
    _VARIABLE_EDITS = frozenset({"set_variable", "restore_variable"})

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

        ``editable=True`` puts out the studio's handles -- W moves, E turns,
        R resizes, P aims a polarization, L swaps the world's axes for the
        object's own -- and undoes a drag at a time (Cmd/Ctrl+Z). The objects
        are copied into a studio session, named after the variables that hold
        them, and edited there: the cell that made them is left as it was, and
        running it again does not take the edits away. `objects` are the
        objects as edited, and `to_script` what was done. One path in place of
        the objects is a magpylib script, run to find its objects, or a
        ``.magpy.json`` scene the studio saved. A scene written in code
        (`magpylib_studio.build.Scene`) is edited as it is, not copied.

        A scene written in code, or a path, given without ``editable`` is
        shown as it is -- its own session, the handles away -- and the pencil
        among the view's tools puts them out. On a view of the cell's own
        objects the pencil first copies them into a session, under the names
        the cell gave them, and `editable` reads True from that moment.
        ``view.editable = True`` is the pencil from code. ``editable=None``
        is a view for looking only, a figure handed to someone else: no
        pencil, and `editable` refuses to turn on.
        """
        traits, kwargs = self._split(kwargs)
        editable = traits.pop("editable", False)
        super().__init__(**traits)
        #: The captured run, kept only when there is one that motion cannot
        #: play -- see `_adopt`. Every frame holds every trace of the scene
        #: as computed at that step, so this is the megabytes the payload
        #: deliberately does not carry. Frames are served from here one at a
        #: time, as the panel serves them.
        self._scene = None
        self._objects = {}
        #: The studio session an editable view's objects belong to; None for a
        #: view of the cell's own.
        self._session = None
        #: Where the view was last looking, as it reported: a message, not a
        #: trait, for the reason given where the view sends it. Kept for
        #: `to_html`, so a file saved from a cell opens on the same view.
        self._camera = None
        #: The objects the view was last pointed at, and the caller's names
        #: for them: what a session is made of when editing is asked for
        #: after the view is made -- the pencil, or `editable = True`.
        self._given = []
        self._named = {}
        self.on_msg(self._on_message)
        # The caller's names -- its own variables, then its module's -- so the
        # script that comes back out says `ring` where the cell did. Read here,
        # while the caller is the frame above.
        named = _names_above()
        given = list(threejs._given(objects))
        # A scene written in code, or a path, is a session of its own: the
        # view shows that session, drawn by the engine, and nothing else
        # beside it -- the cell's objects would have no place in it.
        own = [
            obj
            for obj in given
            if _is_built(obj) or isinstance(obj, (str, os.PathLike))
        ]
        if own and len(given) > 1:
            raise TypeError(
                "a scene written in code, or a path, is shown on its own: "
                "SceneWidget(scene)"
            )
        if editable or own:
            if animation or kwargs:
                words = ", ".join(["animation"] * bool(animation) + list(kwargs))
                raise TypeError(
                    f"a view of a scene's session takes objects and traits, not {words}"
                )
            if not given:
                raise TypeError(
                    "nothing to edit: SceneWidget(*objects, editable=True), "
                    "or a script or a saved scene in their place"
                )
            if isinstance(given[0], (str, os.PathLike)):
                self._edit(_session_from(pathlib.Path(given[0])), handles=editable)
            elif _is_built(given[0]):
                # Its own session, not a copy: the scene the code wrote is the
                # one the view edits, so a drag shows in `to_dict()` after.
                self._edit(given[0].session, handles=editable)
            else:
                self._edit(_session_of(given, named))
        elif objects:
            # The traits again, after the scene: drawing one sets the run's
            # length, pace and repeat from what magpylib says, and a `repeat`
            # given here is the caller's word, not magpylib's.
            self._repoint(objects, named, animation, {**kwargs, **traits})
        elif kwargs:
            # Nothing to draw them with, and dropped quietly they would look
            # like they had been ignored when the objects came.
            raise TypeError(f"no objects to draw with {', '.join(kwargs)}")
        if editable is None and self._session is None:
            self.editable = None  # never: a session's view said so in `_edit`

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
        # A run that is its first frame moved about travels as the motion, and
        # what changes as it goes is carried with it: the view plays it, kernel
        # or none. Only a run too big to carry is kept here, to be served a
        # frame at a time.
        payload, served = threejs.run_payload(scene)
        with self.hold_sync():
            self._scene = served
            self.frames = len(scene.frames)
            self.duration = float(scene.animation.time)
            self.repeat = bool(scene.animation.repeat)
            self.payload = payload

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
        self._repoint(objects, _names_above(), animation, kwargs)

    def _repoint(self, objects, named, animation, kwargs):
        """`update`, with the caller's names for the objects already read."""
        # `_capture` is what `scene_payload` uses for the same reason: it is
        # the one path that hands back the `Scene` a display backend is given,
        # with the capabilities this view declares, without a second widget
        # (and a second comm) being made to throw away.
        # One message, not two: sent apart, the browser would draw the new
        # scene against the old tree, and the legend would list objects that
        # are no longer there beside ones it cannot name.
        self._not_editable("update")
        traits, kwargs = self._split(kwargs)
        with self.hold_sync():
            self._adopt(threejs._capture(objects, animation=animation, **kwargs))
            self.identify(*objects)
            # after `identify`, so that a selection given here is not carried
            for name, value in traits.items():
                setattr(self, name, value)
        # Only the names of what is shown: the rest of the namespace is the
        # notebook's, and a view that held it would hold everything in it.
        self._named = {
            name: obj for name, obj in named.items() if str(id(obj)) in self._objects
        }

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
        self._not_editable("identify")
        given = list(threejs._given(objects))
        before = dict(_positions(self.tree))
        tree, objects = threejs.object_tree(objects)
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
        self._given = given
        return self

    @property
    def picked(self):
        """The objects that are selected, in the order they were clicked.

        Empty when the widget was not given the objects (`identify`), which is
        the case for a bare ``magpy.show(..., backend="widget")`` on a
        magpylib that does not hand them to its backends: the ids are still
        there in `selected`, but there is nothing to resolve them to.
        """
        objects = self.objects
        return [objects[key] for key in self.selected if key in objects]

    @property
    def objects(self):
        """The objects in the view, by the ids `selected` and `hidden` use.

        In an editable view, the session's, as edited: live magpylib objects
        to compute with, rebuilt by every edit -- so keep the widget rather
        than these. In any other, the objects it was given.
        """
        if self._session is None:
            return dict(self._objects)
        entries = self._session.list_objects(copies="count")
        return {entry["id"]: self._session._objs[entry["id"]] for entry in entries}

    def to_script(self):
        """An editable view's scene as a magpylib script: what was built, and
        every edit."""
        return self._editing("to_script").to_script()

    def set(self, object_id, *, position=None, orientation=None, **params):
        """Edit an object from the notebook, as a drag in the view does.

        `position` is where it goes, in world coordinates, and `orientation`
        how it is turned, as a rotation vector in degrees -- the pose a drag
        reports. Any other keyword is a parameter by its magpylib name:
        ``dimension=``, ``polarization=``, ``current=``. All of it is one
        step to undo, drawn, and told to the notebook as a drag's end is.

        A value the object already has -- exactly: a slider hands back the
        number it was given -- is no edit at all. That is what lets a slider
        and the view follow each other: the slider sets a value, the view's
        `revision` moves the slider to it, and the slider's own echo of that
        changes nothing and records nothing.

        Refused, it changes nothing and raises, saying why.
        """
        from magpylib_studio.session import _plain

        session = self._editing("set")
        obj = session._objs[object_id]
        now = {
            "position": np.atleast_2d(obj.position)[-1],
            "orientation": np.atleast_2d(obj.orientation.as_rotvec(degrees=True))[-1],
        }
        changed = {
            key: _plain(value)
            for key, value in (("position", position), ("orientation", orientation))
            if value is not None and not _same(value, now[key])
        }
        calls = []
        if changed:
            calls.append(
                {
                    "method": "set_transform",
                    "params": {"object_id": object_id, **changed},
                }
            )
        for name, value in params.items():
            if not _same(value, getattr(obj, name, None)):
                changed[name] = _plain(value)
                call = {"object_id": object_id, "name": name, "value": _plain(value)}
                calls.append({"method": "set_param", "params": call})
        result = session.apply_calls(calls, f"set {object_id}")
        if not result.get("ok", True):
            raise ValueError(f"{object_id}: {result.get('error')}")
        edit = {"by": "set", "objects": [object_id], "changed": {object_id: changed}}
        self._show(edit)

    def set_variable(self, name, value):
        """Change a variable of an editable view's scene, as the studio's
        Variables panel does: everything written in it follows, and it is one
        step to undo. A slider wired here drives the scene the way the
        panel's does. Refused, it changes nothing and raises, saying why."""
        from magpylib_studio.session import _plain

        session = self._editing("set_variable")
        result = session.set_variable(name, _plain(value))
        if not result.get("ok", True):
            raise ValueError(f"{name}: {result.get('error')}")
        self._show({"by": "set_variable", "variable": name, "value": _plain(value)})

    def undo(self):
        """Take back an editable view's last edit -- a whole drag at a time.
        Returns whether there was one. Stops where this view's editing
        started: a built scene's own building, or a session's steps from
        before the view, are not the view's to undo."""
        return self._step("undo")

    def reset(self):
        """Take the scene back to where this view's editing started -- every
        drag, undo, redo and `set` since -- in one step, which `undo` takes
        back. Returns whether there was anything to take back."""
        return self._reset() and self._show({"by": "reset"})

    def _reset(self):
        session = self._editing("reset")
        if json.dumps(session.doc, sort_keys=True, default=str) == self._start:
            return False
        result = session.restore(json.loads(self._start))
        if not result.get("ok", True):
            raise ValueError(f"reset: {result.get('error')}")
        return True

    def redo(self):
        """Put back what `undo` took. Returns whether there was anything."""
        return self._step("redo")

    def _step(self, which):
        session = self._editing(which)
        waiting = session.get_history()[which]
        if not getattr(session, which)()["ok"]:
            return False
        return self._show({"by": which, "step": waiting[-1] if waiting else None})

    def save(self, file):
        """Write an editable view's scene as a ``.magpy.json`` document, as
        the VS Code studio saves one -- and opens."""
        doc = self._editing("save").to_dict()
        text = json.dumps(doc, indent=2) + "\n"
        pathlib.Path(file).write_text(text, encoding="utf-8")

    @traitlets.observe("variables")
    def _variables_assigned(self, change):
        """`variables` assigned -- from a cell, or by a `traitlets.link` from
        another control's trait: every variable given a value other than the
        scene's is set, as `set_variable` sets one, as one edit for them all,
        and the trait then reads the scene back, every variable included. The
        view's own drawing writes the scene's values, and so sets nothing.
        Refused -- a name the scene has no variable of, a value past its
        limits -- it sets nothing, reads the scene back, and raises."""
        from magpylib_studio.session import _plain

        wanted = change["new"] or {}
        if self._session is None:
            if wanted:
                self._editing("variables")  # raises, naming what has a scene
            return
        current = _values_of(self._session)
        unknown = [name for name in wanted if name not in current]
        if unknown:
            self.variables = current
            raise ValueError(
                f"no variable {unknown[0]!r} in the scene: a variable is a "
                "parameter of the scene function, or made with set_variable"
            )
        changed = {
            name: _plain(value)
            for name, value in wanted.items()
            if not _equal(_plain(value), current[name])
        }
        if not changed:
            if wanted != current:
                self.variables = current  # every variable, as the scene has them
            return
        session = self._session
        session.begin_interaction()  # one step to undo, however many
        refused, applied = None, 0
        for name, value in changed.items():
            result = session.set_variable(name, value)
            if not result.get("ok", True):
                refused = f"{name}: {result.get('error')}"
                break
            applied += 1
        session.end_interaction()
        if refused:
            # What went in before the refusal is one step, taken back whole;
            # refused first, the group recorded nothing to take back.
            if applied:
                session.undo()
            self.variables = current
            raise ValueError(refused)
        if len(changed) == 1:
            ((name, value),) = changed.items()
            edit = {"by": "set_variable", "variable": name, "value": value}
        else:
            edit = {"by": "set_variables", "values": changed}
        self._show(edit)

    @traitlets.validate("editable")
    def _something_to_edit(self, proposal):
        # Handles over nothing would reach nothing that keeps an edit: every
        # drag would end in "no answer from Python". And a view made for
        # looking only stays that: whoever made it said so.
        if proposal["value"] and self.editable is None:
            raise traitlets.TraitError(
                "a view made with editable=None is never edited: make another, "
                "with editable=False for the pencil"
            )
        if proposal["value"] and self._session is None and not self._given:
            raise traitlets.TraitError(
                "nothing to edit: SceneWidget(*objects, editable=True), or "
                "point the view at objects first"
            )
        return proposal["value"]

    @traitlets.observe("editable")
    def _editing_asked_for(self, change):
        """The handles asked for after the view was made -- the pencil among
        its tools, or ``view.editable = True``. A view of a session has them
        out from here on, and nothing else changes. A view of the cell's own
        objects copies them into a session now, under the names the cell
        gave them, as it would have at the start; a run it was playing is
        left behind with the capture, and the session draws the objects,
        paths and all."""
        if not change["new"] or self._session is not None:
            return
        with self.hold_sync():
            self._scene = None
            self.frames = 1
            self._edit(_session_of(self._given, self._named))

    def _edit(self, session, handles=True):
        """Make this the view of `session`'s scene, with its handles out --
        or away, until the pencil; or, `handles=None`, for looking only."""
        self._session = session
        #: The document as last drawn, to tell an edit from a gesture or an
        #: undo that changed nothing.
        self._shown = None
        #: The edits of the drag in progress, as the view last sent them.
        self._dragged = None
        # Where editing starts: undo stops here, and `reset` comes back here.
        # What the session did before the view -- a scene function's build,
        # steps made from code -- is its starting point, not edits.
        session.forget_history()
        self._start = json.dumps(session.doc, sort_keys=True, default=str)
        self.editable = handles
        self._show(None)

    def _show(self, edit):
        """Draw the session's scene as it is now, keeping what is selected
        and hidden where those objects still are, and tell the notebook what
        `edit` was. Returns whether anything had changed: a drag that ended
        where it began, or an undo with nothing to undo, is no news."""
        doc = json.dumps(self._session.doc, sort_keys=True, default=str)
        if doc == self._shown:
            return False
        first = self._shown is None
        self._shown = doc
        payload = self._session.get_scene()
        tree = self._session.object_tree()
        ids = {key for key, _ in _positions(tree)}
        with self.hold_sync():
            self.payload = payload
            self.tree = tree
            self.selected = [key for key in self.selected if key in ids]
            self.hidden = [key for key in self.hidden if key in ids]
            self.variables = _values_of(self._session)
            if not first:
                self.last_edit = edit or {}
                self.revision += 1
        return True

    def _editing(self, what):
        """The session, for what only an editable view can do."""
        if self._session is None:
            raise TypeError(
                f"{what} is for a view with a scene of its own: a scene written "
                "in code, a path, SceneWidget(..., editable=True), or the pencil "
                "among the view's tools"
            )
        return self._session

    def _not_editable(self, what):
        if self._session is not None:
            raise TypeError(
                f"a view with a scene of its own is not re-pointed: no {what}(). "
                "Its objects are a studio session's -- a scene written in code, "
                "a path, editable=True, or the pencil among the view's tools -- "
                "so make another view for other objects. A view a notebook "
                "re-points from controls of its own is made with editable=None, "
                "which offers no pencil."
            )

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
        return self._page(title)

    def _page(self, title="magpylib scene", limit=None):
        """`to_html`, with a run past `limit` shown as its first step: for a
        page nobody asked for by name, which should not be hundreds of
        megabytes because a script said `show`."""
        return _PAGE.substitute(
            title=html.escape(title),
            css=(STATIC / "widget.css").read_text(encoding="utf-8"),
            bundle=_packed((STATIC / "widget.js").read_text(encoding="utf-8")),
            data=_packed(json.dumps(self._saved(limit), allow_nan=False)),
        )

    def _saved(self, limit=None):
        """What a saved page holds: the model's state as it is now, and --
        for a run the payload does not carry as motion and changes -- every
        frame of it, which the page answers for itself. Past `limit`, when
        there is one, the page shows the first step, still, instead."""
        frames = self.frames
        run = [] if self._scene is None else threejs.whole_run(self._scene, limit)
        if run is None:
            threejs.too_big_to_carry(frames)
            frames, run = 1, []
        state = threejs.saved_state(
            self.payload,
            self.tree,
            frames,
            self.duration,
            self.repeat,
            selected=self.selected,
            hidden=self.hidden,
            axes=self.axes,
            theme=self.theme,
            height=self.height,
            camera=self._camera,
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
        if kind == "rpc":
            self._answer(content)
        elif kind == "frame" and self._scene is not None:
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

    def _answer(self, content):
        """Answer what an editable view asks of its session -- see
        `VIEW_CALLS` -- as the studio's panel is answered, and tell the
        notebook when an edit is settled."""
        from magpylib_studio import rpc

        method = content.get("method")
        if self._session is None or method not in self.VIEW_CALLS:
            refusal = f"the view may not call {method!r}"
            answer = {
                "id": content.get("id"),
                "error": {"type": "MethodError", "message": refusal},
            }
            self.send({"kind": "rpc", **answer})
            return
        if method == "reset":
            # Not a session call: the view's own start is what it goes back
            # to. Answered first, as below, and the notebook told after.
            try:
                changed = self._reset()
            except ValueError as e:
                answer = {"error": {"type": "ValueError", "message": str(e)}}
            else:
                answer = {"result": {"ok": True, "changed": changed}}
            self.send({"kind": "rpc", "id": content.get("id"), **answer})
            if answer.get("result", {}).get("changed"):
                self._show({"by": "reset"})
            return
        params = content.get("params") or {}
        # A value the pointer is still on: applied, and the view redraws
        # itself; the notebook is told at the release, as for a pose mid-drag.
        preview = bool(content.get("preview"))
        edit = None
        if method in ("undo", "redo"):
            waiting = self._session.get_history()[method]
            edit = {"by": method, "step": waiting[-1] if waiting else None}
        elif method == "end_interaction":
            edit = _drag_news(self._dragged)
            self._dragged = None
        elif method in self._VARIABLE_EDITS and not preview:
            edit = {"by": method, "variable": params.get("name")}
            if method == "set_variable":
                edit["value"] = params.get("value")
        answer = rpc.handle(self._session, content)
        if method == "apply_edits":
            self._dragged = params.get("edits")
        # The scene with the answer, when the view asks for it: a preview
        # wants to redraw, and one message where there were two is half the
        # wait on a host whose every message costs (marimo's, measured in
        # decision 0010). Not a trait: nothing is told per frame.
        if content.get("scene") and isinstance(answer.get("result"), dict):
            answer["result"]["scene"] = self._session.get_scene()
        # The answer first: telling the notebook runs its callbacks, and one
        # that takes a while -- or raises -- must not keep the view waiting
        # for an answer it would give up on.
        self.send({"kind": "rpc", **answer})
        if method in self._SETTLES or (method in self._VARIABLE_EDITS and not preview):
            self._show(edit)


def _equal(value, current):
    """Whether `value` is what `current` already is, a name or a number: a
    choice holds a name ('z'), which `_same` cannot read as a number."""
    if isinstance(value, str) or isinstance(current, str):
        return value == current
    return _same(value, current)


def _same(value, current):
    """Whether `value` is exactly what `current` already is.

    Exactly, not to a tolerance: in SI units a real edit can be a
    nanometre or a nanoampere-metre, and what this is for -- a control
    handing back the number it was given -- gives back the very number."""
    if current is None:
        return False
    try:
        return np.array_equal(
            np.asarray(value, dtype=float), np.asarray(current, dtype=float)
        )
    except (TypeError, ValueError):
        return False


def _values_of(session):
    """The session's variables as resolved, by name: what `variables` holds."""
    return {v["name"]: v["value"] for v in session.get_variables()["variables"]}


def _drag_news(edits):
    """What a drag did, from the edits its view sent last: which objects,
    and what each was left with."""
    if not edits:
        return {"by": "drag", "objects": [], "changed": {}}
    changed = {}
    for edit in edits:
        fields = {
            k: edit[k] for k in ("position", "orientation", "polarization") if k in edit
        }
        if edit.get("shape"):
            fields[edit["shape"]["attr"]] = edit["shape"]["value"]
        changed[edit["objectId"]] = fields
    return {"by": "drag", "objects": list(changed), "changed": changed}


def _names_above():
    """The variables of whoever called the widget's method that called this:
    its own, then its module's. What the objects are named by in a session
    made of them, so the script that comes back out says `ring` where the
    cell did."""
    caller = sys._getframe(2)
    return {**caller.f_globals, **caller.f_locals}


def _is_built(obj):
    """Whether `obj` is a scene written in code (`magpylib_studio.build`)."""
    from magpylib_studio.build import Scene

    return isinstance(obj, Scene)


def _session_of(objects, namespace):
    """A studio session holding `objects`, named from `namespace`."""
    from magpylib_studio import importer

    doc, said = importer.document_from_objects(objects, namespace)
    return _loaded(lambda session: session.load_scene(doc), said, "these objects")


def _session_from(path):
    """A studio session holding the scene `path` holds: a script's, or a
    saved scene's."""
    if path.suffix == ".py":
        return _loaded(lambda session: session.load_script(str(path)), [], path)
    return _loaded(lambda session: session.load_scene(str(path)), [], path)


def _loaded(load, said, what):
    from magpylib_studio.session import MagpylibStudioSession

    session = MagpylibStudioSession()
    loaded = load(session)
    if not loaded.get("ok", True):
        raise ValueError(f"could not load {what}: {loaded.get('error')}")
    # What running a script had to flatten, or naming objects could not
    # name, or a saved step that no longer applies (a mesh file that moved):
    # said once, where the view was asked for.
    skipped = [
        f"a step no longer applies, and is left out: {broken.get('error')}"
        for broken in loaded.get("broken") or []
    ]
    for text in [*said, *(loaded.get("warnings") or []), *skipped]:
        warnings.warn(f"magpylib-studio: {text}", stacklevel=4)
    return session


def _objects_of(panel):
    """The objects magpylib drew in `panel`, where it says (`Panel.objects`,
    newer than the display-backend API itself) -- none where it does not."""
    return getattr(panel, "objects", ())


def display(widget):
    """Put `widget` in the cell's output, in whichever notebook this is.

    marimo first, because it is also importable in a Jupyter kernel and only
    it can say whether it is the one running. Returns whether either took
    it; when neither did, the caller shows it the way a script can -- see
    `backend._outside_a_notebook`.
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

        shell = get_ipython()
        # A terminal IPython -- `ipython script.py`, or its REPL -- has no cell
        # to draw in, and would only print the widget's name.
        if shell is not None and type(shell).__name__ != "TerminalInteractiveShell":
            ipy_display(widget)
            return True
    except ImportError:
        pass
    return False
