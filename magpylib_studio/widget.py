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

#: The ways `SceneWidget.axes` says the scene's scale.
AXES = ("cube", "box", "none")

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
    if (!run[at]) return; // the payload's own step, never asked for
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
    #: How faintly objects are drawn, by the same ids: the share of their own
    #: opacity, from 0.1 to below 1; an object not named is drawn whole.
    #: Written by sliding the legend's eye, assignable from the notebook. A
    #: view setting: the scene's own style is not touched.
    faded = traitlets.Dict(
        value_trait=traitlets.Float(), key_trait=traitlets.Unicode()
    ).tag(sync=True)
    #: The range each sensor's colours span, by its id: ``[low, high]`` of
    #: |field| in SI -- tesla for B -- cut from what its pixels read, its
    #: colormap stretched over it and the field past either end in that end's
    #: colour; a sensor not named spans all it reads. Its pixels and field
    #: lines alike. Written by the colour bar's handles, which show for a
    #: sensor the field colours, assignable from the notebook. A view
    #: setting, as `faded` is, kept by an export.
    color_range = traitlets.Dict(
        value_trait=traitlets.List(traitlets.Float(), minlen=2, maxlen=2),
        key_trait=traitlets.Unicode(),
    ).tag(sync=True)
    #: One colour scale for the sensors that can share one -- the same
    #: colormap and scaling: each coloured over what they read together, or
    #: one cut of `color_range` given to them all, so that their colours
    #: compare. One colour bar stands for them. The bar's switch; a view
    #: setting, kept by an export.
    color_shared = traitlets.Bool(False).tag(sync=True)
    #: How the scene's scale is said: ``"cube"``, the default, a scale bar and
    #: a cube to look from a side by, in a corner; ``"box"``, the graduated box
    #: round it; or ``"none"``. A cell can put it away for a clean picture, and
    #: an export keeps it that way. ``True`` and ``False``, which it took
    #: before there was a choice, are the box and none.
    axes = traitlets.Union(
        [traitlets.Enum(AXES), traitlets.Bool()], default_value="cube"
    ).tag(sync=True)
    #: Whether currents and field lines flow: pulses running along a wire,
    #: down a strip or over a sheet the way the current runs, and along a
    #: field line the way the field points -- whether a run plays or not,
    #: and still for whoever asks the system for less motion. While currents
    #: flow, the arrows magpylib draws to say the same are away, unless a
    #: style asked for them. Off, the arrows are back and the field lines
    #: stand; an export keeps it.
    flow = traitlets.Bool(True).tag(sync=True)
    #: Light or dark. ``"auto"`` wears whatever the view sits on -- the
    #: notebook's output area, which is not always the page's theme -- and
    #: the system's setting when nothing behind it says.
    theme = traitlets.Enum(("auto", "light", "dark"), default_value="auto").tag(
        sync=True
    )
    #: The objects `identify` was given, as their Collection hierarchy: nodes
    #: of ``{id, label, kind, children}``. What the legend draws.
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
    #: Prototype (#45): lines of the field through the pixels of each sensor
    #: that reads it, drawn while a drag moves the magnets. An editable view's.
    #: Its switch in the view is the eye on each sensor's field lines, a row
    #: beneath it in the legend: one shown turns them on, all hidden off.
    field_lines = traitlets.Bool(False).tag(sync=True)
    #: The panel an editable view opens with, docked beside it:
    #: ``"variables"``, a slider per variable, or ``"object"``, the
    #: selection's properties. None, the default, opens neither: the toggles
    #: at the foot of the edit column do.
    open_panel = traitlets.Enum(
        ("variables", "object"), default_value=None, allow_none=True
    ).tag(sync=True)

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
            # a variant from the panel's dropdown: its values, as one edit
            "use_variant",
            "quantity",
            "expression_help",
            # the object panel: the selection's parameters and pose
            "list_objects",
            "get_params",
            "get_transform",
            "read_values",
            "set_param",
            "set_transform",
            # and its style tree: the schema its widgets are built from, the
            # values they show, a property set and one reset
            "get_schema",
            "get_values",
            "apply_edit",
            "reset_style",
            # the legend: an overlap marked as meant, and the gap between two
            # objects selected
            "set_overlap_intended",
            "get_gap",
        }
    )
    #: The calls after which the scene is settled, and the notebook is told.
    _SETTLES = frozenset({"end_interaction", "undo", "redo"})
    #: The object panel's writes: settled each, as `set` from code is.
    _OBJECT_EDITS = frozenset(
        {"set_param", "set_transform", "apply_edit", "reset_style"}
    )
    #: The calls that edit a variable: settled too, unless the message says
    #: the value is a preview -- the pointer still on the slider -- in which
    #: case the release settles, as a drag's does.
    _VARIABLE_EDITS = frozenset({"set_variable", "restore_variable"})
    #: A variant used from the panel: its values set as one edit, settled.
    _VARIANT_EDITS = frozenset({"use_variant"})
    #: An overlap marked as meant, or warned about again: settled.
    _OVERLAP_EDITS = frozenset({"set_overlap_intended"})

    def __init__(self, *objects, animation=False, **kwargs):
        """A view of `objects` -- or of nothing yet, to `update` later.

        Takes what `magpylib.show` takes: ``animation=True`` captures the
        paths so the view can play them, and anything else is passed through.
        And, as any widget does, the starting value of its traits --
        ``height``, ``theme``, ``axes``, ``flow``, ``open_panel``. A keyword
        that names a trait is the widget's; the rest are magpylib's, and the
        two share no names.

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
        ``.magpy.json`` scene the studio saved. A scene function -- under
        ``@scene``, or a plain function whose parameters are the variables --
        is built into a session of its own, and the document it built
        (`magpylib_studio.build.Scene`) is edited as it is, not copied: read
        its field off `objects`, and build it once yourself, ``s =
        ring.build()``, where several cells are to share one session.

        A scene function or its document, or a path, given without
        ``editable`` is shown as it is -- its own session, the handles away --
        and the pencil
        among the view's tools puts them out. On a view of the cell's own
        objects the pencil first copies them into a session, under the names
        the cell gave them, and `editable` reads True from that moment.
        ``view.editable = True`` is the pencil from code. ``editable="never"``
        is a view for looking only, a figure handed to someone else: no
        pencil, and `editable` refuses to turn on; ``None`` says the same.
        """
        traits, kwargs = self._split(kwargs)
        editable = traits.pop("editable", False)
        if editable == "never":
            editable = None  # the word for it; the trait holds None
        super().__init__(**traits)
        #: The captured run, kept only when there is one that motion cannot
        #: play -- see `_adopt`. Every frame holds every trace of the scene
        #: as computed at that step, so this is the megabytes the payload
        #: deliberately does not carry. Frames are served from here one at a
        #: time, as the panel serves them.
        self._scene = None
        self._objects = {}
        #: The parameters of the scene function the view's scene was built
        #: from, by name, or None: what `save_variant` hands back to paste.
        self._parameters = None
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
        # The function itself is its document: `SceneWidget(ring)` builds
        # it, as `ring.build()` would.
        given = [_built(obj) for obj in given]
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
                built_from = given[0]._built_from
                if built_from is not None:
                    self._parameters = [s["name"] for s in built_from.parameters]
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
        if self.field_lines and self._session is None:
            # asked for when the view was made, before there were objects
            self._field_lines_asked_for({"new": True})

    @classmethod
    def _split(cls, kwargs):
        """`kwargs` as the widget's traits, and the rest: magpylib's."""
        names = cls.class_trait_names()
        own = {key: value for key, value in kwargs.items() if key in names}
        return own, {key: value for key, value in kwargs.items() if key not in own}

    @classmethod
    def _from_scene(cls, scene):
        """A view of `scene`: what ``magpy.show(..., backend="widget")`` is.

        Named by the objects magpylib hands over with the scene
        (`Panel.objects`): they are what the legend's nesting and a click's
        object come from, which no trace can carry -- see `identify`. And by
        the names the cell that called `show` gave them, which the pencil
        names them by in the session it copies them into: without them it
        named a cell's `magnet` and `sensor` `obj` and `obj_2`.
        """
        widget = cls()
        widget._adopt(scene)
        objects = [obj for panel in scene.panels for obj in panel.objects]
        if objects:
            widget.identify(*objects)
            widget._keep_names(_names_of_caller())
        return widget

    def _adopt(self, scene, pixels=()):
        """Draw `scene`, in one update -- with `pixels`, its sensors' pixels
        drawn apart from it (`threejs.capture_view`).

        `hold_sync` because these are four traits and the view reads them
        together: sent one at a time, a payload can arrive at a browser that
        still believes the last scene's frame count, and the playback controls
        are drawn from it.
        """
        # A run that is its first frame moved about travels as the motion, and
        # what changes as it goes is carried with it: the view plays it, kernel
        # or none. Only a run too big to carry is kept here, to be served a
        # frame at a time.
        payload, served = threejs.run_payload(scene, pixels)
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
            self._adopt(*threejs.capture_view(objects, animation=animation, **kwargs))
            self.identify(*objects)
            # after `identify`, so that a selection given here is not carried
            for name, value in traits.items():
                setattr(self, name, value)
        self._keep_names(named)

    def _keep_names(self, named):
        """Hold `named`'s names for the objects shown, to name them by when
        they are copied into a session. Only theirs: the rest of the
        namespace is the notebook's, and a view that held it would hold
        everything in it."""
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

        What was selected, hidden or faded carries over to these objects: an object
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
        # its sensors' parts where their pixels are drawn apart: `capture_view`
        apart = {item["object_id"] for item in self.payload.get("pixels", [])}
        tree, objects = threejs.object_tree(objects, apart)
        after = {path: key for key, path in _positions(tree)}

        def moved(key):
            # An id among the new objects is the same object: the old ones
            # are still held in `_objects`, so no new one can have been
            # given an old one's address.
            return key if key in objects else after.get(before.get(key))

        def carried(ids):
            out = []
            for key in map(moved, ids):
                if key is not None and key not in out:
                    out.append(key)
            return out

        # What overlaps, keyed as the payload draws them: a view nobody edits
        # -- a notebook's `show()` -- still says that a magnet sits in another.
        found = _overlaps_of(objects)
        with self.hold_sync():
            self.tree = tree
            self.selected = carried(self.selected)
            self.hidden = carried(self.hidden)
            self.faded = {
                moved(key): level
                for key, level in self.faded.items()
                if moved(key) is not None
            }
            self.color_range = {
                moved(key): cut
                for key, cut in self.color_range.items()
                if moved(key) is not None
            }
            payload = self.payload or {}
            if any(payload.get(key) != value for key, value in found.items()):
                self.payload = {**payload, **found}
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

    def save_variant(self, name):
        """Keep the variables as they are now under `name`: a variant of this
        view's scene, which the sliders panel lists at once and sets them back
        to in one step. Saved over one of the same name, it replaces it.

        Returns its values -- the variables that hold a number or a choice,
        never a formula -- ready to paste into the scene function's
        `@scene(variants=...)`, where it outlives the cell: of a scene a
        function built, its parameters' alone, since the mark holds nothing
        else, and a warning names a variable the view's variant also holds.
        Until it is in the mark it lives in this view's scene as a dragged
        slider does: kept by `save` and a build from that file, gone when
        the cell runs again. Refused, it changes nothing and raises, saying
        why."""
        session = self._editing("save_variant")
        result = session.save_variant(name)
        if not result.get("ok", True):
            raise ValueError(f"{name}: {result.get('error')}")
        self._show({"by": "save_variant", "variant": name})
        values = dict(result["values"])
        if self._parameters is not None:
            left = [key for key in values if key not in self._parameters]
            if left:
                warnings.warn(
                    f"{', '.join(left)}: in the view's variant {name!r}, and "
                    "no parameter of the scene function, so not in what this "
                    "returns for its mark",
                    stacklevel=2,
                )
            values = {k: v for k, v in values.items() if k in self._parameters}
        return values

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
        scene's is set, together (`set_variables`): one rebuild and one edit
        for them all, checked as the combination they make. The trait then
        reads the scene back, every variable included. The view's own drawing
        writes the scene's values, and so sets nothing. Refused -- a name the
        scene has no variable of, a value past its limits -- it sets nothing,
        reads the scene back, and raises."""
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
        # One step to undo -- and none, for values that come to the scene it
        # already was: the group's close takes back a step that changed
        # nothing, and gives back the redo it would have cost.
        session.begin_interaction()
        result = session.set_variables(changed)
        session.end_interaction()
        if not result.get("ok", True):
            self.variables = current
            error = result.get("error")
            # Which one was refused, where the engine's words do not say.
            if len(changed) == 1 or not any(name in error for name in changed):
                error = f"{', '.join(changed)}: {error}"
            raise ValueError(error)
        if len(changed) == 1:
            ((name, value),) = changed.items()
            edit = {"by": "set_variable", "variable": name, "value": value}
        else:
            edit = {"by": "set_variables", "values": changed}
        if not self._show(edit):
            # Nothing came of it -- a formula a variable already had, a
            # number as text: the trait says the scene as it is, not what
            # was assigned.
            self.variables = _values_of(self._session)

    @traitlets.validate("axes")
    def _axes_named(self, proposal):
        # One of AXES, whichever way it was asked for: the view, a saved page
        # and a reader of the trait then meet one value, not two spellings.
        value = proposal["value"]
        if isinstance(value, bool):
            return "box" if value else "none"
        return value

    @traitlets.validate("editable")
    def _something_to_edit(self, proposal):
        # Handles over nothing would reach nothing that keeps an edit: every
        # drag would end in "no answer from Python". And a view made for
        # looking only stays that: whoever made it said so.
        if proposal["value"] and self.editable is None:
            raise traitlets.TraitError(
                'a view made with editable="never" is never edited: make another, '
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
        session = self._copied("editable", "Not editable")
        if session is None:
            return
        with self.hold_sync():
            self._scene = None
            self.frames = 1
            self._edit(session)

    def _copied(self, asked, refusal):
        """The cell's objects copied into a session -- or None when they
        cannot be, with `asked` put back and the view told why, after
        `refusal`. Raised here instead, from a press in the view, the error
        reached the kernel's log and no further, and the view said "Editing"
        with nothing behind it."""
        try:
            return _session_of(self._given, self._named)
        except Exception as error:  # noqa: BLE001 - said in the view, not lost
            setattr(self, asked, False)
            self.send({"kind": "refused", "message": f"{refusal} — {error}"})
            return None

    def _edit(self, session, handles=True):
        """Make this the view of `session`'s scene, with its handles out --
        or away, until the pencil; or, `handles=None`, for looking only."""
        self._session = session
        #: The document as last drawn, to tell an edit from a gesture or an
        #: undo that changed nothing.
        self._shown = None
        #: The edits of the drag in progress, as the view last sent them.
        self._dragged = None
        # Lines asked for when the view was made are part of where editing
        # starts, not an edit; a document that has them on shows them.
        if self.field_lines and not session.field_lines:
            session.set_field_lines(True)
        # Where editing starts: undo stops here, and `reset` comes back here.
        # What the session did before the view -- a scene function's build,
        # steps made from code -- is its starting point, not edits.
        session.forget_history()
        self._start = json.dumps(session.doc, sort_keys=True, default=str)
        self.editable = handles
        self._show(None)

    @traitlets.observe("field_lines")
    def _field_lines_asked_for(self, change):
        """The lines asked for, or put away: the legend's eye, or
        ``view.field_lines``. The document keeps the choice, as one step to
        undo (`set_field_lines`), and the trait follows the document back --
        see `_show`. They are computed by a session, so a view of the cell's
        own objects copies them into one now, as the pencil does, with the
        handles left away -- the view stays one to look at."""
        session = getattr(self, "_session", None)
        if session is not None:
            if bool(change["new"]) != session.field_lines:
                session.set_field_lines(change["new"])
                self._show({"by": "field_lines", "on": bool(change["new"])})
        elif change["new"] and getattr(self, "_given", None):
            if self.editable is None:
                return  # made for looking only: no session, so no lines
            session = self._copied("field_lines", "No field lines")
            if session is None:
                return
            with self.hold_sync():
                self._scene = None
                self.frames = 1
                self._edit(session, handles=False)

    def _show(self, edit):
        """Draw the session's scene as it is now, keeping what is selected,
        hidden and faded where those objects still are, and tell the notebook what
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
            # a scene with paths plays them, a step served at a time
            self.frames = self._session.path_steps()
            self.tree = tree
            self.selected = [key for key in self.selected if key in ids]
            self.hidden = [key for key in self.hidden if key in ids]
            self.faded = {k: v for k, v in self.faded.items() if k in ids}
            self.color_range = {k: v for k, v in self.color_range.items() if k in ids}
            self.variables = _values_of(self._session)
            # an undo or a redo can turn the lines on or off
            self.field_lines = self._session.field_lines
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
                're-points from controls of its own is made with editable="never", '
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
        if self._scene is not None:
            run = threejs.whole_run(self._scene, limit)
        elif frames > 1 and getattr(self, "_session", None) is not None:
            # a session's run, served a step at a time -- but the step its
            # payload draws, which the view draws from that
            step = self.payload.get("step")
            run = [
                None if i == step else self._session.get_scene(frame=i)
                for i in range(frames)
            ]
            if limit is not None and len(json.dumps(run, allow_nan=False)) > limit:
                run = None
        else:
            run = []
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
            faded=self.faded,
            color_range=self.color_range,
            color_shared=self.color_shared,
            axes=self.axes,
            flow=self.flow,
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
        elif kind == "frame" and (
            self._scene is not None or getattr(self, "_session", None) is not None
        ):
            index = content.get("index", 0)
            frame = (
                threejs.frame_payload(self._scene, index)
                if self._scene is not None
                else self._session.get_scene(frame=index)
            )
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
        answer, edit, settles = self._reply(content)
        # The answer first: telling the notebook runs its callbacks, and one
        # that takes a while -- or raises -- must not keep the view waiting
        # for an answer it would give up on.
        self.send({"kind": "rpc", **answer})
        if settles:
            self._show(edit)

    def _reply(self, content):
        """What a call of this view's session comes to -- from the view, or
        from a panel of its own (`ScenePanel`), which sends the answer under
        its own model: ``(answer, edit, settles)``, the answer as the view
        takes it, and whether the notebook is to be told of `edit` once the
        answer is sent (`_show`)."""
        from magpylib_studio import rpc

        method = content.get("method")
        if self._session is None or method not in self.VIEW_CALLS:
            refusal = f"the view may not call {method!r}"
            answer = {
                "id": content.get("id"),
                "error": {"type": "MethodError", "message": refusal},
            }
            return answer, None, False
        if method == "reset":
            # Not a session call: the view's own start is what it goes back
            # to. Answered first, as below, and the notebook told after.
            try:
                changed = self._reset()
            except ValueError as e:
                answer = {"error": {"type": "ValueError", "message": str(e)}}
            else:
                answer = {"result": {"ok": True, "changed": changed}}
            answer = {"id": content.get("id"), **answer}
            return (
                answer,
                {"by": "reset"},
                bool(answer.get("result", {}).get("changed")),
            )
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
        elif method in self._VARIANT_EDITS:
            edit = {"by": method, "variant": params.get("name")}
        elif method in self._OVERLAP_EDITS:
            edit = {
                "by": method,
                "objects": [params.get("a"), params.get("b")],
                "intended": params.get("intended", True),
            }
        elif method in self._OBJECT_EDITS:
            target = params.get("object_id")
            if method == "set_param":
                changed = {params.get("name"): params.get("value")}
            elif method == "apply_edit":
                # a style property, by its path under `style`
                changed = {f"style.{params.get('path')}": params.get("value")}
            elif method == "reset_style":
                # back to magpylib's default, which None is; every path, with
                # no path named
                path = params.get("path")
                changed = {f"style.{path}" if path else "style": None}
            else:
                changed = {
                    k: v for k, v in params.items() if k not in ("object_id", "define")
                }
            edit = {"by": "set", "objects": [target], "changed": {target: changed}}
        answer = rpc.handle(self._session, content)
        if method == "apply_edits":
            self._dragged = params.get("edits")
        # The scene with the answer, when the view asks for it: a preview
        # wants to redraw, and one message where there were two is half the
        # wait on a host whose every message costs (marimo's, measured in
        # decision 0010). Not a trait: nothing is told per frame.
        if content.get("scene") and isinstance(answer.get("result"), dict):
            # a step of a gesture: past its first, only what it moves
            answer["result"]["scene"] = self._session.get_scene(partial=True)
        settles = (
            method in self._SETTLES
            or method in self._OBJECT_EDITS
            or method in self._VARIANT_EDITS
            or method in self._OVERLAP_EDITS
            or (method in self._VARIABLE_EDITS and not preview)
        )
        return answer, edit, settles

    def panel(self, kind="variables"):
        """A panel of this view's editor as a widget of its own, for a host
        that places outputs apart: ``"variables"``, the slider per variable,
        or ``"object"``, the selection's pose, parameters and style. Put it
        beside the view -- an ipywidgets ``HBox``, a marimo column, a sidecar
        -- and it edits the view's scene through the view, which draws and
        tells the notebook as it does for its own panels. For an editable
        view with a scene of its own."""
        self._editing("A panel of its own")
        return ScenePanel(self, kind)


class ScenePanel(anywidget.AnyWidget):
    """A panel of a view's editor as a widget of its own -- the variables,
    or the selection's properties -- for a host that places outputs apart:
    an ipywidgets box beside the view, a marimo column, a sidecar. Made by
    `SceneWidget.panel`. It edits the view's scene through the view: a call
    is answered under this widget's model, and the view draws and tells the
    notebook as it does for its own panels. The view's revision, selection
    and theme are mirrored here, so the panel follows them (decision 0025).
    """

    _esm = STATIC / "panel.js"
    _css = STATIC / "widget.css"

    #: Which panel: ``"variables"`` or ``"object"``.
    kind = traitlets.Enum(("variables", "object")).tag(sync=True)
    #: The view's, mirrored: the panel reads the scene again when it moves.
    revision = traitlets.Int(0).tag(sync=True)
    #: The view's selection, mirrored, which the object panel follows.
    selected = traitlets.List(traitlets.Unicode()).tag(sync=True)
    #: The view's theme choice, mirrored, worn as the view wears it.
    theme = traitlets.Enum(("auto", "light", "dark"), default_value="auto").tag(
        sync=True
    )

    def __init__(self, view, kind="variables", **kwargs):
        super().__init__(kind=kind, **kwargs)
        self._view = view
        for name in ("revision", "selected", "theme"):
            traitlets.dlink((view, name), (self, name))
        self.on_msg(self._on_message)

    def _on_message(self, _widget, content, _buffers):
        if not isinstance(content, dict) or content.get("kind") != "rpc":
            return
        view = self._view
        answer, edit, settles = view._reply(content)
        self.send({"kind": "rpc", **answer})
        if settles:
            view._show(edit)
        elif content.get("preview") and view._session is not None:
            # A value the pointer is still on: the view's own panel redraws
            # from the answer; a panel apart has no view to hand it to, so
            # the view is given the scene. Not told to the notebook: that is
            # the release's, as for a pose mid-drag.
            result = answer.get("result")
            if isinstance(result, dict) and result.get("ok", True):
                view.payload = view._session.get_scene()


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


def _names_of_caller():
    """The variables of the code that called magpylib's `show`: its own, then
    its module's -- the first frame out of magpylib and this package, however
    deep `show` goes before it reaches the backend."""
    frame = sys._getframe(1)
    while frame is not None and frame.f_globals.get("__name__", "").startswith(
        ("magpylib.", "magpylib_studio.")
    ):
        frame = frame.f_back
    return {} if frame is None else {**frame.f_globals, **frame.f_locals}


def _is_built(obj):
    """Whether `obj` is a scene written in code (`magpylib_studio.build`)."""
    from magpylib_studio.build import Scene

    return isinstance(obj, Scene)


def _built(obj):
    """`obj`, or the document a scene function builds: `SceneWidget(ring)` is
    `SceneWidget(ring.build())`. A plain function is a scene function here
    without the mark -- handed to the view, it is built the same way. `@scene`
    is for a file, where the mark says which function is the scene, and for
    `build()` without a view."""
    import inspect

    from magpylib_studio.recording import SceneFunction, scene

    if inspect.isfunction(obj):
        obj = scene(obj)
    return obj.build() if isinstance(obj, SceneFunction) else obj


def _session_of(objects, namespace):
    """A studio session holding `objects`, named from `namespace`."""
    from magpylib_studio import importer

    doc, said = importer.document_from_objects(objects, namespace, script=False)
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


def display(widget):
    """Put `widget` in the cell's output, in whichever notebook this is.

    marimo first, because it is also importable in a Jupyter kernel and only
    it can say whether it is the one running. Returns whether either took
    it; when neither did, the caller shows it the way a script can -- see
    `backend._outside_a_notebook`.

    Looked up, not imported: a notebook marimo runs has imported it already,
    and importing it only to hear "no" cost a Jupyter kernel's first view
    some 130 ms wherever marimo is installed.
    """
    marimo = sys.modules.get("marimo")
    if marimo is not None and marimo.running_in_notebook():
        marimo.output.append(widget)
        return True
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


def _overlaps_of(objects):
    """The overlaps among a read-only view's objects, keyed as its payload
    is: ``{"overlaps", "overlap_depths"}``, and the pairs at each step where
    something moves. Nothing when the check fails: a picture is not refused
    for a warning it could not work out."""
    import magpylib as magpy

    from magpylib_studio import collisions

    # a sealed collection's parts under its key, as the payload draws them,
    # and what overlaps inside it left to it
    leaves = [
        (key, each)
        for key, obj in objects.items()
        for each in (obj.children_all if threejs.is_sealed(obj) else (obj,))
        if not isinstance(each, magpy.Collection)
    ]
    plain = [obj for _, obj in leaves]
    try:
        keys = [key for key, _ in leaves]
        found = collisions.find_overlaps(plain, depths=True, groups=keys)
        # a sealed collection overlaps once, however many of its parts do, as
        # a session says it (`Session.get_overlaps`)
        named = {}
        for i, j, depth in found:
            key = (keys[i], keys[j])
            # its parts each meet the other: the deepest says how deep it goes
            if depth is None:
                named.setdefault(key, None)
            else:
                known = named.get(key)
                named[key] = depth if known is None else max(known, depth)
        out = {
            "overlaps": [list(pair) for pair in named],
            "overlap_depths": [None if d is None else float(d) for d in named.values()],
        }
        if collisions.path_length(plain) > 1:
            out["overlaps_by_step"] = [
                [
                    list(pair)
                    for pair in dict.fromkeys((keys[i], keys[j]) for i, j in step)
                ]
                for step in collisions.overlaps_along(plain, groups=keys)
            ]
    except Exception:  # noqa: BLE001 - an optional check must not cost the picture
        return {}
    return out
