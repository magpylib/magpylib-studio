"""The Python half of `gallery.mjs`.

    python harness/gallery.py OUT

writes OUT/NAME-THEME.html for every example the gallery offers, in the light
theme and the dark: the example as it loads, saved as a page
(`SceneWidget.write_html`) dressed as a picture -- no legend, no colour bar,
no frame, the view the whole page -- and prints the names, in the gallery's
order, as JSON.
"""

import json
import pathlib
import sys

#: The picture's height in CSS pixels; `gallery.mjs` takes it 16:10.
HEIGHT = 300

#: What a picture leaves out: the view's overlays, and the page's margin and
#: the view's frame. The view then fills the page, as it fills the screen in
#: full screen, whose rules these are.
DRESS = """<style>
  body { padding: 0 !important; }
  .magpy-scene {
    display: flex !important;
    flex-direction: column;
    height: 100vh !important;
    border: 0 !important;
    border-radius: 0 !important;
  }
  .magpy-scene-stage { flex: 1; min-height: 0; }
  .magpy-scene-view { height: 100% !important; }
  .magpy-scene-legend, .magpy-colorbar, .magpy-scene-tools,
  .magpy-scene-transport, .magpy-scene-counter, .magpy-scene-readout,
  .magpy-scene-notice { display: none !important; }
</style>
</head>"""


def pages(out):
    from magpylib_studio.session import MagpylibStudioSession
    from magpylib_studio.widget import SceneWidget

    names = [e["name"] for e in MagpylibStudioSession().list_examples()["examples"]]
    for name in names:
        session = MagpylibStudioSession()
        session.load_example(name)
        doc = session.to_dict()
        scene = out / f"{name}.magpy.json"
        scene.write_text(json.dumps(doc))
        for theme in ("light", "dark"):
            view = SceneWidget(
                str(scene),
                theme=theme,
                axes=False,
                field_lines=bool(doc.get("field_lines")),
                height=HEIGHT,
            )
            page = view.to_html(name).replace("</head>", DRESS, 1)
            (out / f"{name}-{theme}.html").write_text(page, encoding="utf-8")
    print(json.dumps(names))


if __name__ == "__main__":
    pages(pathlib.Path(sys.argv[1]))
