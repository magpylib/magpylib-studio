# API reference

## A scene function

```{eval-rst}
.. autofunction:: magpylib_studio.scene

.. autoclass:: magpylib_studio.SceneFunction
   :members: build, save
```

## A parameter's kind and bounds

```{eval-rst}
.. autoclass:: magpylib_studio.Length

.. autoclass:: magpylib_studio.Angle

.. autoclass:: magpylib_studio.Count

.. autoclass:: magpylib_studio.Bounds
```

## Studio's words

What a scene function says that plain magpylib cannot: a pattern that stays a
pattern, a value that follows the variables, a curve sampled from a formula.
Called plainly, each does what magpylib would.

```{eval-rst}
.. autofunction:: magpylib_studio.derived

.. autofunction:: magpylib_studio.duplicate_around

.. autofunction:: magpylib_studio.duplicate_along

.. autofunction:: magpylib_studio.mirror

.. autofunction:: magpylib_studio.place

.. autofunction:: magpylib_studio.sampled

.. autofunction:: magpylib_studio.grid

.. autofunction:: magpylib_studio.choose

.. autofunction:: magpylib_studio.name

.. autofunction:: magpylib_studio.hide

.. autofunction:: magpylib_studio.unhide

.. autofunction:: magpylib_studio.remove

.. autoclass:: magpylib_studio.TriangularMesh
   :members: from_file, from_hull, from_superquadric
```

## The notebook view

```{eval-rst}
.. autoclass:: magpylib_studio.widget.SceneWidget
   :members: update, set_variable, save_variant, undo, redo, reset, save, to_html, write_html, panel, objects, picked
```

## The session

```{eval-rst}
.. autoclass:: magpylib_studio.session.MagpylibStudioSession
   :members: load_scene, load_example, list_examples, get_field, sweep, set_variable, set_variables, get_variables, use_variant, save_variant, to_builder_script
```

## The examples

```{eval-rst}
.. automodule:: magpylib_studio.examples

.. autodata:: magpylib_studio.examples.EXAMPLES
   :no-value:

.. autoclass:: magpylib_studio.examples.Example
   :members: scene, title, summary, text, document
```
