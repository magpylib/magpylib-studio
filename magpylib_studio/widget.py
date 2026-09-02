"""The studio's 3D view, in a notebook cell.

The same three.js scene graph the VS Code panel draws, wrapped as an
`anywidget` so that a notebook can hold it::

    import magpylib as magpy
    from magpylib_studio.widget import view

    view(magpy.magnet.Cuboid(polarization=(0, 0, 1), dimension=(1, 1, 1)))

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

import pathlib

import anywidget
import magpylib as magpy
import traitlets

from magpylib_studio import threejs

STATIC = pathlib.Path(__file__).parent / "static"

#: What `view()` gives the scene when nobody says. Tall enough for a scene to
#: be legible in a notebook column, short enough to leave the next cell on
#: screen.
DEFAULT_HEIGHT = 420


def _flatten(objects):
    """Every magpylib object in `objects`, collections opened up.

    The view draws a collection's children, and it is the children that its
    traces are stamped with, so those are what a click has to resolve to.
    """
    for obj in objects:
        if isinstance(obj, list | tuple | set):
            yield from _flatten(obj)
            continue
        yield obj
        yield from getattr(obj, "children_all", ())


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
    #: click in the view and readable from the notebook -- and the other way
    #: about: assigning to it moves the outline.
    selected = traitlets.List(traitlets.Unicode()).tag(sync=True)
    #: id -> what to call it, for the objects `identify` was given.
    labels = traitlets.Dict().tag(sync=True)
    height = traitlets.Int(DEFAULT_HEIGHT).tag(sync=True)
    #: Steps in the run, how long it should take, and whether it starts over
    #: at the end -- magpylib's own animation settings. One frame means there
    #: is nothing to play and the view shows no controls for it.
    frames = traitlets.Int(1).tag(sync=True)
    duration = traitlets.Float(5.0).tag(sync=True)
    repeat = traitlets.Bool(False).tag(sync=True)

    def __init__(self, scene=None, **kwargs):
        super().__init__(**kwargs)
        #: The captured run, kept only when there is one: every frame holds
        #: every trace of the scene as computed at that step, so this is the
        #: megabytes the payload deliberately does not carry. Frames are
        #: served from here one at a time, as the panel serves them.
        self._scene = None
        self._objects = {}
        if scene is not None:
            self._adopt(scene)
        self.on_msg(self._on_message)

    def _adopt(self, scene):
        """Draw `scene`, in one update.

        `hold_sync` because these are four traits and the view reads them
        together: sent one at a time, a payload can arrive at a browser that
        still believes the last scene's frame count, and the playback controls
        are drawn from it.
        """
        with self.hold_sync():
            self._scene = scene if len(scene.frames) > 1 else None
            self.frames = len(scene.frames)
            self.duration = float(scene.animation.time)
            self.repeat = bool(scene.animation.repeat)
            self.payload = threejs.view_payload(scene, index=0)

    def update(self, *objects, animation=False, **kwargs):
        """Point this view at `objects`.

        The alternative to making a new widget, and the reason to prefer it in
        a reactive notebook: a slider re-runs the cell it is read in, so a
        `view()` call there is a *new* widget on every drag -- a new element,
        a bar rebuilt from nothing, and a camera that goes back to the framing
        it started with, losing whatever the user had zoomed in on. Updating
        one that is already on the page replaces the drawn objects and leaves
        the view alone.

        Takes what `view` takes; a scene is re-captured whole, because that is
        what magpylib composes.

        Returns nothing, deliberately. This is the last line of a cell, and a
        cell's value is its last expression: returning `self` -- which is a
        widget, and renders -- draws a *second* live view of the same scene
        under the one being updated, with its own WebGL context.
        """
        # `_capture` is what `scene_payload` uses for the same reason: it is
        # the one path that hands back the `Scene` a display backend is given,
        # with the capabilities this view declares, without a second widget
        # (and a second comm) being made to throw away.
        self._adopt(threejs._capture(objects, animation=animation, **kwargs))
        self.identify(*objects)

    def identify(self, *objects):
        """Name the objects the scene was drawn from, and return self.

        The payload keys traces by ``id(obj)``, which is an address: it says
        which traces belong together, and nothing else. Handing the objects
        back turns it into an identity -- `picked` resolves a click to the
        magpylib object, and the view can say what it is called -- and holding
        them here is also what keeps the address meaning what it meant.

        Anything selected that these objects do not account for is dropped.
        Which is most of the time in a reactive notebook: a slider rebuilds
        the objects, so the new ones are at new addresses and a selection
        cannot survive the rebuild. Better deselected than pointing at a
        number that means nothing.
        """
        self._objects = {str(id(obj)): obj for obj in _flatten(objects)}
        with self.hold_sync():
            self.labels = {
                key: getattr(obj.style, "label", None) or type(obj).__name__
                for key, obj in self._objects.items()
            }
            # What was selected was selected in the scene being replaced. Its
            # ids name nothing now -- the view has no such object to outline
            # and `picked` cannot resolve them -- and an address is reused, so
            # left alone they can start resolving to something never clicked.
            self.selected = [key for key in self.selected if key in self._objects]
        return self

    @property
    def picked(self):
        """The objects that are selected, in the order they were clicked.

        Empty when the widget was not given the objects (`identify`), which is
        the case for a bare ``magpy.show(..., backend="widget")``: the ids are
        still there in `selected`, but there is nothing to resolve them to.
        """
        return [self._objects[key] for key in self.selected if key in self._objects]

    def _on_message(self, _widget, content, _buffers):
        """Serve one frame of the run.

        The view asks per frame rather than being handed the lot, for the
        reason the panel does: the whole run is every trace of every step, and
        one frame is all anyone is looking at.
        """
        if not isinstance(content, dict) or content.get("kind") != "frame":
            return
        if self._scene is None:
            return
        frame = threejs.view_frame_payload(self._scene, content.get("index", 0))
        self.send({"kind": "frame", **frame})


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


def view(*objects, height=DEFAULT_HEIGHT, animation=False, **kwargs):
    """`objects` as a scene widget, ready to be a cell's value.

    Takes what `magpylib.show` takes -- ``animation=True`` captures the paths
    so the view can play them, and anything else is passed through.

    The widget is returned rather than displayed, which is what a notebook
    wants from the last line of a cell. In marimo, wrap it in
    ``mo.ui.anywidget(...)`` to have the cell's value follow the selection.
    """
    widget = magpy.show(
        *objects,
        backend="widget",
        return_fig=True,
        animation=animation,
        **kwargs,
    )
    widget.height = int(height)
    return widget.identify(*objects)
